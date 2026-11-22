import { variableCandidates } from '@perspectra/world-pack/editor-fields'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGraph, type EditorGraph } from './activity-graph.ts'
import { readProject, writeGraph } from './project.ts'

export type EditorAgent = 'codex' | 'claude' | 'dsh'
const runners: Record<EditorAgent, { command: string; args: string[] }> = {
  codex: { command: 'codex', args: ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '-'] },
  claude: { command: 'claude', args: ['-p', '--tools', '', '--no-session-persistence', '--output-format', 'text'] },
  dsh:
    process.platform === 'win32'
      ? {
          command: 'cmd.exe',
          args: [
            '/d',
            '/c',
            'dsh.cmd',
            '--profile',
            'headless',
            '--permission-mode',
            'read-only',
            '--approval-policy',
            'never',
            '-',
          ],
        }
      : {
          command: 'dsh',
          args: ['--profile', 'headless', '--permission-mode', 'read-only', '--approval-policy', 'never', '-'],
        },
}

/** Run the installed CLI in an empty directory. Only the authored context goes to its standard input. */
export async function runEditorAgent(provider: EditorAgent, prompt: string, signal?: AbortSignal): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'perspectra-author-agent-'))
  try {
    return await new Promise<string>((resolve, reject) => {
      signal?.throwIfAborted()
      const launcher = runners[provider]
      const child = spawn(launcher.command, launcher.args, {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
      const chunks: Buffer[] = []
      let bytes = 0,
        error: Error | undefined
      function stop(reason: string) {
        if (error) return
        error = new TypeError(reason)
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          killer.on('error', () => child.kill())
          killer.once('exit', code => {
            if (code !== 0) child.kill()
          })
        } else if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }
      }
      const cancel = () => stop('助手请求已取消，草稿已保留。')
      signal?.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(() => stop('助手超时，可保留草稿后重试。'), 150_000)
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 256 * 1024) stop('助手返回内容过长')
        else chunks.push(chunk)
      })
      // Provider diagnostics may include endpoint or login details; consume them without storing them in the project.
      child.stderr.resume()
      child.stdin.on('error', () => {})
      child.on('error', () => {
        clearTimeout(timer)
        reject(new TypeError('无法启动 ' + provider + '，请检查本机 CLI 安装。'))
      })
      child.on('close', code => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        if (error) reject(error)
        else if (code !== 0)
          reject(
            new TypeError(provider + ' 未完成请求（退出码 ' + String(code) + '）。请检查该 CLI 的登录、连接和额度。'),
          )
        else resolve(Buffer.concat(chunks).toString('utf8').trim())
      })
      child.stdin.end(prompt, 'utf8')
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function patchObject(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k)))
    throw new TypeError('助手补丁格式不正确')
  return value as Record<string, unknown>
}
export function applyAgentReply(base: EditorGraph, reply: string): EditorGraph {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(reply.trim())
  let raw: unknown
  try {
    raw = JSON.parse(fenced?.[1] ?? reply)
  } catch {
    throw new TypeError('助手未返回可读取的 JSON 修改，草稿已保留。')
  }
  const update = patchObject(raw, ['title', 'opening', 'choices', 'remove', 'variables'])
  const choices = new Map(base.choices.map(c => [c.id, c]))
  if (update.remove !== undefined) {
    if (!Array.isArray(update.remove)) throw new TypeError('移除选项需要标识列表')
    for (const id of update.remove)
      if (typeof id !== 'string' || !choices.delete(id)) throw new TypeError('移除的选项不存在')
  }
  if (update.choices !== undefined) {
    if (!Array.isArray(update.choices)) throw new TypeError('助手的选项修改格式无效')
    const touched = new Set<string>()
    for (const item of update.choices) {
      const change = patchObject(item, ['id', 'label', 'condition', 'result', 'speech', 'next', 'effect', 'ruling'])
      if (typeof change.id !== 'string' || touched.has(change.id)) throw new TypeError('选项标识缺失或重复')
      touched.add(change.id)
      const old = choices.get(change.id) ?? {
        id: change.id,
        label: '',
        condition: { kind: 'always' },
        result: '',
        speech: '',
        next: 'end',
      }
      const checked = parseGraph({ ...base, layout: undefined, choices: [{ ...old, ...change }] }).choices[0]!
      choices.set(change.id, checked)
    }
  }
  return parseGraph({
    key: base.key,
    variables: update.variables ?? base.variables,
    title: update.title ?? base.title,
    opening: update.opening ?? base.opening,
    choices: [...choices.values()],
    layout: base.layout?.filter(n => n.title || n.id === 'start' || choices.has(n.id)),
  })
}

export async function assistActivity(
  source: string,
  body: Record<string, unknown>,
  run = runEditorAgent,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const provider = body.provider
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'dsh') throw new TypeError('请选择本机创作助手')
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 4000)
    throw new TypeError('创作要求须为 1–4000 字')
  const project = readProject(source)
  const base = project.graphs.find(g => g.key === body.key)
  if (!base) throw new TypeError('请先保存所选活动')
  if (body.expected !== undefined && JSON.stringify(parseGraph(body.expected)) !== JSON.stringify(base))
    throw new TypeError('所选活动已变化，请重新读取')
  const selected = typeof body.selected === 'string' ? body.selected : ''
  if (selected && !base.choices.some(c => c.id === selected)) throw new TypeError('所选节点已变化')
  const prompt = [
    '你正在为 Perspectra 作者编辑一个活动。仅输出一个 JSON 修改对象，无其他文字。所需上下文已经给齐，无需工具或文件。',
    '可选字段 title、opening、choices（按 id 增加或更新，仅返回要改的字段）、remove（要删除的选项 id 数组）。保留无关内容。',
    '新选项需要唯一的小写英文 id 和 label。condition 使用 {"kind":"always"}、{"kind":"present","ref":"角色ID"} 或 {"kind":"held","ref":"物品ID"}。引用只用候选中的 ID。',
    '地点用 {kind:"location",ref:地点ID}，地点和 present 可加 negate:true。独自在场用 {kind:"alone"}。随队且同场用 {kind:"party",ref:角色ID}，只选 partyCharacters 中的角色。多项条件用 {kind:"all",conditions:[条件1,条件2]} 表示全部满足，或 kind:"any" 表示满足任一项，至少两项且平铺。',
    'variables 是本活动变量声明，可保存 key,label,type,initial,scope(shared/private/internal),options。变量条件或可选的 effect 赋值使用 {kind:"world"或"local",ref:变量键,value:类型匹配的值}。每个位置只能用其候选。',
    '可配置 ruling 为 {kind:"cost",target:{kind:"local"或"world",ref:变量键},amount:正整数,rejectReason:精力不足的提示}，或 {kind:"script",target,script:脚本键,parameters:按声明填写}。必须选择同时可读写的变量，不能与 effect 指向同一变量。',
    'result 是已发生的选择结果。speech 是玩家自己说的话。next 取 end 或 stay。求助只写玩家发出请求，角色自行决定回应。',
    JSON.stringify({
      rulingScripts: project.adjudications,
      conditionCandidates: variableCandidates(project.rules.variables, base.variables ?? [], base.key, 'condition'),
      effectCandidates: variableCandidates(project.rules.variables, base.variables ?? [], base.key, 'effect'),
      activity: base,
      selected,
      characters: project.characters,
      locations: project.locations,
      partyCharacters: project.partyCharacters,
      items: project.items,
      request: body.prompt,
    }),
  ].join('\n')
  const reply = await run(provider, prompt, signal)
  signal?.throwIfAborted()
  const proposal = applyAgentReply(base, reply)
  return { provider, ...applyAssistantChanges(source, base, proposal) }
}

export function applyAssistantChanges(source: string, base: EditorGraph, proposal: EditorGraph) {
  const { previous, saved } = writeGraph(source, base, proposal)
  if (!previous) throw new TypeError('原活动已不存在')
  const changed = saved.choices
    .filter(c => JSON.stringify(c) !== JSON.stringify(previous.choices.find(b => b.id === c.id)))
    .map(c => c.id)
  const removed = previous.choices.filter(c => !saved.choices.some(p => p.id === c.id)).map(c => c.id)
  return { saved, changed, removed, undo: { base: saved, graph: previous } }
}
