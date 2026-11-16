import { expect, it } from 'vitest'
import { Script, runInNewContext } from 'node:vm'
import { defaultFrontendAssets } from '@perspectra/frontend'
import { officialCardsStageRenderer } from './stage-renderer.ts'
it('bundles a self-contained trusted renderer without external closures, private truth, or executable pack assets', () => {
  const assets = defaultFrontendAssets([officialCardsStageRenderer])
  expect(() => new Script(assets.script)).not.toThrow()
  class Node {
    textContent = ''
    className = ''
    disabled = false
    onclick?: () => void
    children: Node[] = []
    get childNodes() {
      return this.children
    }
    classList = { add() {} }
    setAttribute() {}
    append(...nodes: Node[]) {
      this.children.push(...nodes)
    }
    replaceChildren(...nodes: Node[]) {
      this.children = nodes
    }
  }
  const root = new Node(),
    sent: unknown[] = []
  const create = runInNewContext('({' + officialCardsStageRenderer.create.toString() + '}).create', {
    document: { createElement: () => new Node() },
  })
  const stage = create(root)
  stage.update(
    {
      title: '纸灯',
      round: 1,
      turnOwner: null,
      seats: [{ id: 's', label: '甲' }],
      zones: { deck: { count: 3 } },
      details: {},
      log: [],
      request: { id: 'q1', kind: 'sealed-bid', submitted: [] },
      own: [{ seat: 's', choices: [{ id: 'bid:3', label: '密封报价3' }] }],
    },
    {
      actions: [{ id: 'opt:1', label: '提交牌桌选择' }],
      disabled: false,
      reading: false,
      notice: '',
      dialogue: '',
      perform: (...args: unknown[]) => sent.push(args),
      read() {},
    },
  )
  const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)]
  const button = all(root).find(node => node.textContent === '密封报价3')!
  button.onclick!()
  expect(sent).toEqual([['opt:1', { request: 'q1', seat: 's', choice: 'bid:3' }]])
  expect(all(root).some(node => node.textContent.includes('各席同时选择'))).toBe(true)
})
