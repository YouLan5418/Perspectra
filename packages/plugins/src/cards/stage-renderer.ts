import type { ActivityStageRenderer } from '@perspectra/sdk/contracts'
/** Trusted finite-data renderer. Rules and hidden state remain outside the browser. */
export const officialCardsStageRenderer: ActivityStageRenderer = {
  id: 'official-cards.table',
  moduleId: 'official-cards',
  style: `.card-table{position:fixed;inset:0;overflow:auto;padding:24px;background:var(--ink-0,#faf9f6);color:var(--text,#222);z-index:1000;box-sizing:border-box}.card-table h2{margin-top:0}.card-table section{padding:12px;border:1px solid #8885;border-radius:12px;margin:12px 0}.card-table button{min-height:44px;padding:8px 14px;margin:5px;border-radius:8px}.card-table pre{white-space:pre-wrap;overflow-wrap:anywhere}.card-table .card-meta{opacity:.7;font-size:13px}.card-table .card-hand{display:flex;gap:8px;flex-wrap:wrap}.card-table .card-face{padding:16px;border:1px solid #8887;border-radius:8px}@media(max-width:540px){.card-table{padding:14px}.card-table button{width:100%;margin:4px 0}}`,
  create(root) {
    root.classList.add('card-table')
    return {
      update(payload, context) {
        const dom = {
          el(tag: string, text: string) {
            const node = document.createElement(tag)
            node.textContent = text
            return node
          },
        }
        const own = payload.own as unknown as {
          seat: string
          role?: string
          ownBid?: number | null
          choices: { id: string; label: string }[]
        }[]
        const req = payload.request as { id: string; kind: string; submitted: string[]; sealed: boolean } | null
        const seats = payload.seats as unknown as { id: string; label: string }[]
        const labels = new Map(seats.map(seat => [seat.id, seat.label]))
        const owner = labels.get(String(payload.turnOwner))
        const kinds: Record<string, string> = {
          action: '选择行动',
          defense: '等待防御',
          aid: '等待援助',
          color: '选择颜色',
          'sealed-bid': '密封报价',
        }
        const header = dom.el('h2', String(payload.title))
        const meta = dom.el(
          'p',
          `第 ${payload.round} 轮 · ${kinds[req?.kind ?? ''] ?? '已结束'} · ${owner ? `主行动：${owner}` : '各席同时选择'}`,
        )
        meta.className = 'card-meta'
        const zones = dom.el('section', '')
        const rows = payload.zones as Record<string, { count: number; cards?: { title: string }[] }>
        for (const [id, zone] of Object.entries(rows)) {
          const titles: Record<string, string> = {
            deck: '牌堆',
            discard: '弃牌',
            paid: '已支付',
            lot: '本轮拍品',
            awarded: '已归属',
          }
          const title = id.startsWith('hand:') ? `${labels.get(id.slice(5)) ?? '席位'}的手牌` : (titles[id] ?? id)
          const row = dom.el('div', `${title} · ${zone.count} 张`)
          row.className = 'card-hand'
          for (const card of zone.cards ?? []) {
            const face = dom.el('span', card.title)
            face.className = 'card-face'
            row.append(face)
          }
          zones.append(row)
        }
        const choices = dom.el('section', '')
        for (const seat of own) {
          if (seat.role) choices.append(dom.el('p', `你的身份：${seat.role}`))
          if (seat.ownBid != null) choices.append(dom.el('p', `你的密封报价：${seat.ownBid}`))
          const action = context.actions.find(row => row.label === '提交牌桌选择')
          for (const choice of seat.choices) {
            const button = dom.el('button', choice.label) as HTMLButtonElement
            button.disabled = context.disabled || context.reading || !action
            button.onclick = () => {
              if (action && req) context.perform(action.id, { request: req.id, seat: seat.seat, choice: choice.id })
            }
            choices.append(button)
          }
        }
        if (!choices.childNodes.length)
          choices.append(dom.el('p', '等待其他席位提交；可使用默认界面的重试、暂停或退出。'))
        const details = dom.el('section', '')
        const info = payload.details as Record<string, unknown>
        if (info.hp)
          for (const seat of seats)
            details.append(
              dom.el(
                'p',
                `${seat.label} · 灯火 ${(info.hp as Record<string, number>)[seat.id]}${(info.ward as Record<string, boolean>)[seat.id] ? ' · 护光可用' : ''}`,
              ),
            )
        if (info.color)
          details.append(dom.el('p', `当前颜色 ${info.color} · ${(info.direction as number) > 0 ? '顺向' : '逆向'}`))
        if (req?.sealed) details.append(dom.el('p', `已密封 ${req.submitted.length} 席；收齐后揭晓。`))
        const log = dom.el('p', (payload.log as string[]).slice(-5).join('\n'))
        const read = dom.el(
          'button',
          context.reading ? context.dialogue + '\n点击继续阅读' : '已读完',
        ) as HTMLButtonElement
        read.disabled = !context.reading
        read.onclick = context.read
        const notice = dom.el('p', context.notice)
        notice.setAttribute('role', 'status')
        root.replaceChildren(header, meta, zones, choices, details, log, read, notice)
      },
    }
  },
}
