import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type CharacterView, type WorldJsonObject } from '@harness-world/contracts'
import { rolePreset, type RolePreset, type TextRule } from '../../packages/provider-chat/src/preset.ts'
import { presetMacros } from '../../packages/provider-chat/src/preset-macros.ts'
import { presetCall, presetContext, presetOutput, presetDisplay, processPresetText } from '../../packages/provider-chat/src/preset-runtime.ts'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import { WorldStore } from '@harness-world/store-sqlite'
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const rule = (stage: TextRule['stage'], patch: Partial<TextRule> = {}): TextRule => ({ id: stage, name: stage, enabled: true, stage, target: 'both', pattern: '<draft>[\\s\\S]*?</draft>', flags: 'g', replacement: '', ...patch })
it('validates native node/rule data without accepting credentials or execution fields', () => {
  const node = { id: 'n', name: '风格', role: 'user', position: 'afterContext', content: '简短', enabled: true }
  expect(rolePreset({ nodes: [node], textRules: [rule('output')] })).toMatchObject({ nodes: [node] })
  for (const value of [{ nodes: [node, node] }, { nodes: [{ ...node, role: ['user'] }] },
    { nodes: [{ ...node, tool: 'shell' }] }, { textRules: [rule('output', { pattern: '[' })] },
    { textRules: [rule('output', { flags: 'gg' })] }, { apiKey: 'secret' }, { textRules: [{ ...rule('output'), stage: 'world' }] }]) {
    expect(() => rolePreset(value)).toThrow()
  }
})
it('keeps contract/schema and evaluates enabled nodes in list order before positioning', () => {
  const preset = rolePreset({ nodes: [
    { id: 'a', name: '赋值', enabled: true, role: 'system', position: 'afterContext', content: '{{setvar::style::简洁}}' },
    { id: 'b', name: '风格', enabled: true, role: 'user', position: 'beforeContext', content: '{{char}}，{{getvar::style}}表达' },
    { id: 'c', name: '关闭', enabled: false, role: 'assistant', position: 'afterContext', content: '{{unknown}}' },
    { id: 'd', name: '末尾', enabled: true, role: 'assistant', position: 'afterContext', content: '保留语气' },
  ] })
  const call = { messages: [{ role: 'system', content: '契约' }, { role: 'user', content: '授权材料' }], schema: { type: 'object' }, description: '工具' }
  const prepared = presetCall(call, preset, { context: { character: { name: '甲' } }, continuation: false }, '玩家')
  expect(prepared.messages).toEqual([{ role: 'system', content: '契约' }, { role: 'user', content: '甲，简洁表达' }, { role: 'user', content: '授权材料' }, { role: 'assistant', content: '保留语气' }])
  expect(prepared.schema).toBe(call.schema)
  expect(prepared.description).toBe(call.description)
  expect(presetCall(call, preset, { context: { character: { name: '乙' } }, continuation: true }, '玩家').messages[1]!.content).toBe('乙，简洁表达')
})
it('keeps variables private to a request and supports comments, trim, random and bounded dice', () => {
  const expand = presetMacros({ char: '甲' }, () => 0)
  expect(expand(' {{//说明}}{{setvar::x::值}}{{char}} {{getvar::x}} {{random::红::蓝}} {{roll::2d6}}{{trim}} ')).toBe('甲 值 红 2')
  expect(presetMacros({})('{{getvar::x}}')).toBe('')
  expect(() => expand('{{world.gold}}')).toThrow('不支持')
  expect(() => expand('{{roll::99d6}}')).toThrow()
})
it('processes ordered rules only at the selected stage/field and terminates pathological regex', async () => {
  const rules = [rule('display', { pattern: '(你好)', replacement: '$1！', target: 'speech' }), rule('display', { id: 'second', pattern: '！', replacement: '。' }), rule('output', { pattern: '.', replacement: '错误' })]
  expect((await processPresetText([{ text: '你好', stage: 'display', target: 'speech', rules, inspect: true }]))[0]).toMatchObject({ text: '你好。', trace: [{ name: 'display', text: '你好！' }, { name: 'display', text: '你好。' }] })
  expect((await processPresetText([{ text: '你好', stage: 'display', target: 'narration', rules }]))[0]!.text).toBe('你好')
  const started = Date.now()
  await expect(processPresetText([{ text: 'a'.repeat(10000) + '!', stage: 'output', target: 'speech', rules: [rule('output', { pattern: '(a+)+$' })] }])).rejects.toThrow('超时')
  expect(Date.now() - started).toBeLessThan(5000)
})
it('transforms authorized expression copies and latest player input without rewriting facts or original history', async () => {
  const record = (sourceSeq: number, characterId: string) => ({ sourceSeq, value: { content: { speech: { characterId, text: '原文', narration: '动作' }, playerInput: { actorId: characterId, sourceText: '原文', sourceSpans: [{start:0,end:2}], note:'原始输入' }, resultDescription: '世界事实' } } })
  const request = { context: { observations: [record(1, 'player'), record(2, 'npc'), record(3, 'player')], affordances: [{ bindingId: '原文' }] }, continuation: false }
  const processed = await presetContext(request, { textRules: [rule('input', { pattern: '原文', replacement: '输入包装', target: 'speech' }), rule('history', { pattern: '原文', replacement: '历史转换', target: 'speech' })] }, 'player')
  expect(processed.context.observations.map(o => o.value.content.speech.text)).toEqual(['历史转换', '历史转换', '输入包装'])
  expect(processed.context.observations[2]!.value.content.playerInput.sourceText).toBe('输入包装')
  expect(processed.context.observations[2]!.value.content.resultDescription).toBe('世界事实')
  expect(processed.context.affordances).toEqual(request.context.affordances)
  expect(request.context.observations.every(o => o.value.content.speech.text === '原文')).toBe(true)
})
it('cleans publish fields before public use and refuses to repair malformed or empty decisions', async () => {
  const preset = { textRules: [rule('output')] }
  expect(await presetOutput({ decision: 'publish', speech: '<draft>私密</draft>你好', narration: '微笑' }, preset)).toEqual({ decision: 'publish', speech: '你好', narration: '微笑' })
  const operation = { decision: 'perform', actionType: 'move', parameters: { locationId: '<draft>目的地</draft>' } }
  expect(await presetOutput(operation, preset)).toBe(operation)
  for (const raw of [{ decision: 'publish', speech: '<draft>全部</draft>' }, { decision: 'publish', speech: 'x'.repeat(2001) }, { decision: 'publish', speech: 1 }, { decision: 'publish', speech: '你好', parameters: {} }]) await expect(presetOutput(raw, preset)).rejects.toThrow()
})
it('applies the speaker preset to display copies while retaining published text', async () => {
  const view = { observations: [{ value: { content: { speech: { characterId: '甲', text: '原文', narration: '原文' } } } }, { value: { content: { speech: { characterId: '乙', text: '原文' } } } }] } as unknown as CharacterView
  const projected = await presetDisplay(view, new Map<string, RolePreset>([['甲', { textRules: [rule('display', { pattern: '原文', replacement: '展示', target: 'speech' })] }]]))
  expect(JSON.stringify(projected)).toContain('展示')
  expect(JSON.stringify(projected)).toContain('原文')
  expect(JSON.stringify(view)).not.toContain('展示')
})
it('publishes cleaned text through the real Core, isolates role prompts, projects display and restores it on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preset-content-')); roots.push(dir)
  const requests: Record<string, unknown>[] = [], answered = new Set<string>()
  vi.stubGlobal('fetch', (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] }
    requests.push(body)
    const data = body.messages.map(m => { try { return JSON.parse(m.content) as { context?: { character: { characterId: string } } } } catch { return {} } }).find(m => m.context)
    const actor = data!.context!.character.characterId
    const decision = answered.has(actor) ? { decision: 'abstain' } : { decision: 'publish', speech: '<draft>未发布草稿</draft>已发布表达', narration: '微笑' }
    answered.add(actor)
    return new Response(JSON.stringify({ message: { content: JSON.stringify(decision) } }))
  }) as typeof fetch)
  const options = { packPath: resolve('examples/world-packs/prototype-g1'), dataDirectory: join(dir, 'world'), provider: 'ollama' as const, model: 'fixture',
    presetMapping: { characters: { 'character:companion': { nodes: [{ id: 'n', name: '表达', enabled: true, role: 'system' as const, position: 'afterContext' as const, content: '甲专属 {{char}}' }], textRules: [rule('output'), rule('display', { pattern: '已发布表达', replacement: '展示表达', target: 'speech' })] }, 'character:friend': { textRules: [rule('output')] } } } }
  const runtime = await FrozenWorldPlaytestRuntime.create(options)
  try {
    await runtime.submit('你好')
    expect((await runtime.state()).transcript.some(line => line.text.includes('展示表达'))).toBe(true)
    expect((await runtime.state()).transcript.some(line => line.text.includes('未发布草稿'))).toBe(false)
    const store = new WorldStore(join(options.dataDirectory, 'world.sqlite'))
    try {
      const address = runtime.address
      const events = store.readEvents(address)
      const speech = events.filter(e => e.eventType === 'character.speak').map(e => e.data as WorldJsonObject)
      expect(JSON.stringify(speech)).toContain('已发布表达')
      expect(JSON.stringify(speech)).not.toContain('未发布草稿')
      expect(JSON.stringify(speech)).not.toContain('展示表达')
    } finally { store.close() }
    expect(JSON.stringify(requests)).toContain('甲专属')
    expect(JSON.stringify(requests)).not.toContain('未发布草稿')
    const friendCalls = requests.filter(r => JSON.stringify(r).includes('character:friend') && (r.messages as {content:string}[]).some(m => { try { return JSON.parse(m.content).context?.character?.characterId === 'character:friend' } catch { return false } }))
    expect(friendCalls.length).toBeGreaterThan(0)
    expect(JSON.stringify(friendCalls)).not.toContain('甲专属')
  } finally { await runtime.close() }
  const restored = await FrozenWorldPlaytestRuntime.create(options)
  try { expect((await restored.state()).transcript.some(line => line.text.includes('展示表达'))).toBe(true) } finally { await restored.close() }
})

it('does not turn invalid activity speech into a valid choice or change an accepted choice', async () => {
  const preset = {textRules:[rule('output',{pattern:'甲|非法',replacement:'乙',target:'speech'})]}
  const expression = {speech:'choices',speechChoices:['甲','乙'],narration:false}
  await expect(presetOutput({decision:'publish',speech:'非法'},preset,undefined,expression)).rejects.toThrow('原始对白')
  await expect(presetOutput({decision:'publish',speech:'甲'},preset,undefined,expression)).rejects.toThrow('不能改写')
  await expect(presetOutput({decision:'publish',narration:'微笑'},preset,undefined,expression)).rejects.toThrow('禁止')
})

it('checks enabled macro syntax without evaluating request variables',()=>{
 const node={id:'n',name:'语法节点',enabled:true,role:'system',position:'beforeContext'}
 for(const content of ['{{unknown}}','{{roll::99d6}}','{{random::{{char}}}}'])expect(()=>rolePreset({nodes:[{...node,content}]})).toThrow('语法节点')
 expect(()=>rolePreset({nodes:[{...node,content:'{{char}} {{getvar::missing}} {{roll::2d6}} {{random::甲::乙}}'}]})).not.toThrow()
 expect(()=>rolePreset({nodes:[{...node,enabled:false,content:'{{unknown}}'}]})).not.toThrow()
})
it('reports request-dependent preset expansion failure without calling the provider',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'preset-expansion-'));roots.push(directory)
 const node={name:'展开',enabled:true,role:'system' as const,position:'beforeContext' as const}
 const preset=rolePreset({nodes:[{...node,id:'set',content:'{{setvar::x::'+'字'.repeat(15000)+'}}'},{...node,id:'use',content:'{{getvar::x}}'.repeat(5)}]})
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
 const runtime=await FrozenWorldPlaytestRuntime.create({packPath:resolve('examples/world-packs/prototype-g1'),dataDirectory:directory,provider:'local',model:'fixture',preset})
 try{
  const state=await runtime.submit('/narrate 我抬手示意。')
  expect(state.error).toBe(true);expect(state.notice).toContain('角色预设处理失败');expect(state.notice).not.toContain('模型服务')
  expect(state.debug.activationCycle).toMatchObject({activations:[{result:{failure:'preset_failed'}}]});expect(fetch).not.toHaveBeenCalled()
 }finally{await runtime.close()}
})
