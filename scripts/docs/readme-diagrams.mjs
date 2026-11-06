// Draws the README diagrams as self-contained SVG files, in Chinese and English.
// Run from the repository root: node scripts/docs/readme-diagrams.mjs
// Each image carries its own light background, so it reads the same on GitHub's light and dark themes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'docs/current/assets/readme'
const C = {
  bg: '#f7f8fb', panel: '#ffffff', ink: '#1d2433', muted: '#5b6478', line: '#d5dae4',
  core: '#0d8478', coreBg: '#dcf1ee', mech: '#4f46e5', mechBg: '#e7e6fb', host: '#a85106', hostBg: '#f8ead8',
  author: '#b5185a', authorBg: '#f9e3ec', model: '#5b6478', modelBg: '#eceff4', warn: '#b42318', warnBg: '#fdecea',
}
const FONT = `-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Noto Sans", sans-serif`
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function svg(w, h, body, label) {
  // A browser shows a standalone SVG only if it is well-formed XML; a repeated attribute breaks the whole image.
  for (const tag of body.match(/<[a-z][^>]*>/g) ?? []) {
    const names = [...tag.matchAll(/s([a-z-]+)="/g)].map(m => m[1])
    if (new Set(names).size !== names.length) throw new Error(`repeated attribute in ${tag.slice(0, 60)}`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
<defs>
<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.ink}"/></marker>
<marker id="m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.muted}"/></marker>
</defs>
<style>text{font-family:${FONT};fill:${C.ink}} .s{font-size:12.5px;fill:${C.muted}} .t{font-size:14px} .b{font-size:15px;font-weight:700} .h{font-size:16px;font-weight:700} .n{font-size:13px;font-weight:700;fill:#fff} .mono{font-family:Consolas,"SFMono-Regular",monospace;font-size:12px;fill:${C.muted}}</style>
<rect width="${w}" height="${h}" rx="12" fill="${C.bg}"/>
${body}
</svg>
`
}
const rect = (x, y, w, h, fill, stroke, extra = '', rx = 8) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.4" ${extra}/>`
const text = (x, y, s, cls = 't', anchor = 'start', extra = '') =>
  `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}" ${extra}>${esc(s)}</text>`
const lines = (x, y, list, cls = 's', gap = 18, anchor = 'start') => list.map((s, i) => text(x, y + i * gap, s, cls, anchor)).join('')
const arrow = (d, muted = false, dash = false) =>
  `<path d="${d}" fill="none" stroke="${muted ? C.muted : C.ink}" stroke-width="1.5" ${dash ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#${muted ? 'm' : 'a'})"/>`

// ---- 1. One question, two ways ----
function keys(L) {
  const W = 960, H = 430
  let b = ''
  // Left: one shared transcript.
  b += text(24, 38, L.leftTitle, 'h')
  b += rect(24, 54, 380, 252, C.panel, C.line)
  const chat = L.chat
  chat.forEach((row, i) => {
    const y = 78 + i * 44
    b += rect(40, y, 348, 34, row.secret ? C.warnBg : C.modelBg, row.secret ? C.warn : C.line)
    b += text(52, y + 22, row.text, row.secret ? 't' : 't')
  })
  b += lines(24, 330, L.leftNote)

  // Right: a world log, and three separate views.
  const x0 = 440
  b += text(x0, 38, L.rightTitle, 'h')
  b += rect(x0, 54, 496, 92, C.coreBg, C.core)
  b += text(x0 + 16, 78, L.logTitle, 'b')
  b += lines(x0 + 16, 102, L.log, 's', 20)
  const cards = L.cards
  cards.forEach((c, i) => {
    const x = x0 + i * 170, y = 190
    b += rect(x, y, 156, 116, C.panel, c.secret ? C.warn : C.line)
    b += text(x + 12, y + 24, c.name, 'b')
    b += text(x + 12, y + 44, c.place, 's')
    b += lines(x + 12, y + 70, c.knows, 's', 18)
    b += arrow(`M${x + 78} 146V${y - 2}`, true)
  })
  b += text(x0 + 254, 172, L.only, 's', 'middle', `style="paint-order:stroke;stroke:${C.bg};stroke-width:5px"`)
  b += lines(x0, 330, L.rightNote)
  return svg(W, H, b, L.aria)
}

// ---- 2. One round ----
function round(L) {
  const W = 960, H = 320
  let b = ''
  const steps = L.steps, w = 136, gap = 20, y = 64, bh = 156
  steps.forEach((s, i) => {
    const x = 24 + i * (w + gap)
    const fill = s.kind === 'core' ? C.coreBg : s.kind === 'model' ? C.mechBg : s.kind === 'end' ? C.hostBg : C.panel
    const stroke = s.kind === 'core' ? C.core : s.kind === 'model' ? C.mech : s.kind === 'end' ? C.host : C.line
    b += rect(x, y, w, bh, fill, stroke)
    b += `<circle cx="${x + 20}" cy="${y + 22}" r="11" fill="${stroke === C.line ? C.muted : stroke}"/>` + text(x + 20, y + 27, String(i + 1), 'n', 'middle')
    b += lines(x + 12, y + 58, s.title, 'b', 19)
    b += lines(x + 12, y + 70 + s.title.length * 19, s.lines, 's', 17)
    if (i < steps.length - 1) b += arrow(`M${x + w} ${y + 22}H${x + w + gap - 2}`)
  })
  // Character actions go back through the same gate.
  const back = 24 + 4 * (w + gap) + w / 2, to = 24 + 1 * (w + gap) + w / 2
  b += arrow(`M${back} ${y + bh}V${y + bh + 34}H${to}V${y + bh + 2}`, true, true)
  b += text((back + to) / 2, y + bh + 28, L.loop, 's', 'middle')
  b += lines(24, 32, [L.top], 'h')
  b += lines(24, H - 40, L.note)
  return svg(W, H, b, L.aria)
}

// ---- 3. Code layers ----
function layers(L) {
  const W = 960, H = 470
  let b = ''
  const bands = L.bands, x = 24, w = 680
  bands.forEach((band, i) => {
    const y = 24 + i * 108
    b += rect(x, y, w, 92, band.bg, band.stroke)
    b += text(x + 16, y + 26, band.name, 'h')
    b += text(x + 16, y + 46, band.who, 's')
    const chips = band.chips
    let cx = x + 16
    chips.forEach(c => {
      const cw = Math.max(60, c.length * (/[一-鿿]/.test(c) ? 14 : 7.4) + 16)
      if (cx + cw > x + w - 12) throw new Error(`chips leave the band: ${band.name}`)
      b += rect(cx, y + 56, cw, 26, C.panel, band.stroke, '', 13)
      b += text(cx + cw / 2, y + 74, c, 's', 'middle')
      cx += cw + 6
    })
    b += text(x + w - 16, y + 26, band.path, 'mono', 'end')
    if (i < bands.length - 1) b += arrow(`M${x + 120} ${y + 92}V${y + 108}`)
  })
  b += text(x + 132, 24 + 108 + 103, L.noWrite, 's')
  b += text(x + 132, 24 + 3 * 108 - 5, L.onlyCore, 's')
  // Side: what runs where.
  const sx = 728, sw = 208
  b += text(sx, 44, L.sideTitle, 'h')
  L.side.forEach((s, i) => {
    const y = 60 + i * 98
    b += rect(sx, y, sw, 84, C.panel, C.line)
    b += text(sx + 12, y + 24, s.name, 'b')
    b += lines(sx + 12, y + 46, s.lines, 's', 17)
  })
  return svg(W, H, b, L.aria)
}

const ZH = {
  keys: {
    aria: '玩家问谁看见了钥匙：常见 AI 角色扮演把所有内容放进一段共享聊天记录；Perspectra 由世界记录事实，每个角色只看到自己能看到的。',
    leftTitle: '常见做法：一段共享的聊天记录',
    chat: [
      { text: '玩家：谁看见我的钥匙了？' },
      { text: 'A：好像在桌上吧。' },
      { text: '（旁白）C 刚才在厨房把钥匙放进了口袋。', secret: true },
      { text: 'B：……' },
      { text: '模型接着往下写' },
    ],
    leftNote: ['所有角色共用这一段文字。钥匙在哪、谁知道 C 的秘密，', '都要靠模型自己记住、自己分辨。'],
    rightTitle: 'Perspectra：世界记账，角色各看各的',
    logTitle: '世界记录（经规则裁定）',
    log: ['钥匙在 C 的口袋里（C 自己拿的，只有 C 看见）', '玩家在客厅问了一句话（客厅里的人听得见）'],
    only: '每人只拿到自己看到、听到的',
    cards: [
      { name: '角色 A', place: '在客厅', knows: ['听见了玩家的问题', '不知道钥匙被拿走'] },
      { name: '角色 B', place: '在客厅', knows: ['听见了玩家的问题', '不知道钥匙被拿走'] },
      { name: '角色 C', place: '在厨房', knows: ['没听见这个问题', '知道钥匙在自己身上'], secret: true },
    ],
    rightNote: ['每个角色单独调用模型，自己决定说什么、做什么。A 可能答错，', 'C 可以隐瞒；但钥匙的去向由规则记录，谁说错了也改不了它。'],
  },
  round: {
    aria: '一轮里发生的事：玩家行动，规则裁定并记录，按位置分发给能看到的角色，角色各自决定，角色的行动再经裁定，回合结束时处理状态、活动和剧情节奏。',
    top: '一轮里发生了什么',
    steps: [
      { title: ['玩家行动'], lines: ['说一句话，', '或选一个操作'] },
      { title: ['规则裁定', '并记录'], lines: ['只有这一步能', '改变世界，比如', '物品归谁'], kind: 'core' },
      { title: ['按位置', '分发'], lines: ['谁在场，谁才', '看得到、听得到'], kind: 'core' },
      { title: ['角色各自', '决定'], lines: ['每人调用一次', '模型：回应、', '行动或沉默'], kind: 'model' },
      { title: ['行动再经', '裁定'], lines: ['角色说“我拿走', '钥匙”不算数，', '要真的去拿'] },
      { title: ['回合结束'], lines: ['数值变化、活动', '开始、偶尔来一', '件小插曲'], kind: 'end' },
    ],
    loop: '角色的新行动又成为别人的新见闻，直到没人要回应或次数用完',
    note: ['模型只负责扮演角色；世界里重要的事实由规则维护。代价是每个角色要单独调用模型，一轮往往要等十几秒到几十秒。'],
  },
  layers: {
    aria: 'Perspectra 的代码分层：世界包、可替换的机制、宿主、核心；另有启动器、舞台、模型服务和 Python 记忆在不同进程里运行。',
    bands: [
      { name: '世界包', who: '作者写，随作品分发，不需要改程序', path: 'examples/world-packs/', bg: C.authorBg, stroke: C.author, chips: ['人物与地点', '物品与状态', '活动', '剧情节奏', '舞台界面'] },
      { name: '可替换的机制', who: '官方提供默认实现，玩家可在启动器里换成别的插件', path: 'packages/official-*', bg: C.mechBg, stroke: C.mech, chips: ['调度', '角色循环', '记忆', '知识', '状态', '活动', '剧情节奏', '模型通道'] },
      { name: '宿主', who: '一局游戏的总装配：读脚本、绑定真实角色、交给核心提交', path: 'desktop/host/', bg: C.hostBg, stroke: C.host, chips: ['HTTP 接口', '各机制的适配', '存档与重新生成'] },
      { name: '核心', who: '不可替换：世界事实和信息边界都在这里保证', path: 'packages/application · store-sqlite', bg: C.coreBg, stroke: C.core, chips: ['世界事件日志', '原子提交', '角色视图', '存档与分支'] },
    ],
    noWrite: '机制只算结果，不能直接写世界',
    onlyCore: '只有核心能改世界',
    sideTitle: '各自在哪里运行',
    side: [
      { name: '启动器', lines: ['Tauri + Vue 桌面程序', 'apps/launcher'] },
      { name: '游戏舞台', lines: ['在系统浏览器里打开', 'packages/frontend'] },
      { name: '模型服务', lines: ['你自己的 OpenAI 兼容、', 'Anthropic 或 Gemini 接口'] },
      { name: '长期记忆', lines: ['Python 子进程，', '可用 --memory-none 关掉'] },
    ],
  },
}

const EN = {
  keys: {
    aria: 'The player asks who saw the keys. Common AI roleplay puts everything in one shared chat log; Perspectra records facts in the world and gives each character only what it can see.',
    leftTitle: 'The usual way: one shared chat log',
    chat: [
      { text: 'Player: Has anyone seen my keys?' },
      { text: 'A: On the table, I think.' },
      { text: '(Narration) C slipped the keys into a pocket.', secret: true },
      { text: 'B: ...' },
      { text: 'The model writes what comes next' },
    ],
    leftNote: ['Every character shares this one text. Where the keys are and', 'who knows C’s secret is left to the model to remember.'],
    rightTitle: 'Perspectra: the world keeps the record',
    logTitle: 'World record (checked by rules)',
    log: ['The keys are in C’s pocket (C took them; only C saw)', 'The player spoke in the living room (heard there)'],
    only: 'Each gets only what it saw or heard',
    cards: [
      { name: 'Character A', place: 'Living room', knows: ['Heard the question', 'Doesn’t know C took', 'the keys'] },
      { name: 'Character B', place: 'Living room', knows: ['Heard the question', 'Doesn’t know C took', 'the keys'] },
      { name: 'Character C', place: 'Kitchen', knows: ['Didn’t hear it', 'Knows the keys are', 'in its own pocket'], secret: true },
    ],
    rightNote: ['Each character calls the model on its own and decides what to say or do. A may', 'answer wrongly and C may hide the truth, but the keys stay where the rules put them.'],
  },
  round: {
    aria: 'What happens in a round: the player acts, rules check and record it, it reaches the characters who could see it, each decides on its own, their actions are checked again, and the round ends with values, activities and story pacing.',
    top: 'What happens in one round',
    steps: [
      { title: ['Player acts'], lines: ['Says something', 'or picks an', 'action'] },
      { title: ['Rules check', 'and record'], lines: ['Only this step', 'changes the world,', 'e.g. who holds what'], kind: 'core' },
      { title: ['Reach who', 'was there'], lines: ['Only those present', 'see or hear it'], kind: 'core' },
      { title: ['Each', 'decides'], lines: ['One model call', 'each: reply, act', 'or stay silent'], kind: 'model' },
      { title: ['Actions', 'checked again'], lines: ['Saying “I took', 'the keys” isn’t', 'enough; take them'] },
      { title: ['Round ends'], lines: ['Values change,', 'activities start,', 'small events'], kind: 'end' },
    ],
    loop: 'A character’s action is new to the others, until nobody needs to respond or the limits are reached',
    note: ['The model plays the characters; rules keep the facts that matter. The cost: a model call per character, so a round often takes ten to tens of seconds.'],
  },
  layers: {
    aria: 'Perspectra code layers: world packs, replaceable mechanisms, host, core; the launcher, stage, model service and Python memory run in separate processes.',
    bands: [
      { name: 'World pack', who: 'Written by creators and shipped with the work; no code changes needed', path: 'examples/world-packs/', bg: C.authorBg, stroke: C.author, chips: ['Cast & places', 'Items & state', 'Activities', 'Story pacing', 'Stage UI'] },
      { name: 'Replaceable mechanisms', who: 'Official defaults; players can swap in other plugins from the launcher', path: 'packages/official-*', bg: C.mechBg, stroke: C.mech, chips: ['Scheduler', 'Turn loop', 'Memory', 'Knowledge', 'State', 'Activities', 'Pacing', 'Model'] },
      { name: 'Host', who: 'Assembles a game: reads scripts, binds real characters, hands results to the core', path: 'desktop/host/', bg: C.hostBg, stroke: C.host, chips: ['HTTP API', 'Mechanism adapters', 'Saves & regeneration'] },
      { name: 'Core', who: 'Not replaceable: world facts and information boundaries are guaranteed here', path: 'packages/application · store-sqlite', bg: C.coreBg, stroke: C.core, chips: ['World event log', 'Atomic commits', 'Character views', 'Saves & branches'] },
    ],
    noWrite: 'Mechanisms compute results; they cannot write the world',
    onlyCore: 'Only the core changes the world',
    sideTitle: 'Where things run',
    side: [
      { name: 'Launcher', lines: ['Tauri + Vue desktop app', 'apps/launcher'] },
      { name: 'Game stage', lines: ['Opens in your browser', 'packages/frontend'] },
      { name: 'Model service', lines: ['Your own OpenAI-compatible,', 'Anthropic or Gemini API'] },
      { name: 'Long-term memory', lines: ['A Python subprocess;', '--memory-none turns it off'] },
    ],
  },
}

mkdirSync(OUT, { recursive: true })
for (const [lang, L] of [['zh', ZH], ['en', EN]]) {
  writeFileSync(join(OUT, `keys.${lang}.svg`), keys(L.keys))
  writeFileSync(join(OUT, `round.${lang}.svg`), round(L.round))
  writeFileSync(join(OUT, `layers.${lang}.svg`), layers(L.layers))
}
console.log('wrote', OUT)
