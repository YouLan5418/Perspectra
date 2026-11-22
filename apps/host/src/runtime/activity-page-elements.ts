import { NodeTypes, parse, type TemplateChildNode } from '@vue/compiler-dom'
import type { PageElement } from './activity-page-rules.ts'

/** Inspect literal HTML, excluding inert templates and Host-replaced children. */
export function readPageElements(html: string) {
  const rows = new Map<string, { id: string; tag: string; label: string }>(),
    duplicate = new Set<string>()
  const buttons: { id: string | undefined; operation: string }[] = []
  const seen = new Set<string>()
  const excludedTags = new Set(['script', 'style', 'template', 'head', 'title', 'noscript', 'textarea'])
  const replacedChildren = new Set([
    'data-activity-actions',
    'data-activity-title',
    'data-activity-phase',
    'data-activity-field',
    'data-stage-field',
  ])
  const tree = parse(html, { parseMode: 'html', onError: () => {} })
  function visit(nodes: TemplateChildNode[], parentAvailable = true) {
    for (const node of nodes) {
      if (node.type !== NodeTypes.ELEMENT) continue
      const tag = node.tag.toLowerCase()
      const available = parentAvailable && !excludedTags.has(tag)
      const attrs = Object.fromEntries(
        node.props.flatMap(p => (p.type === NodeTypes.ATTRIBUTE ? [[p.name.toLowerCase(), p.value?.content]] : [])),
      )
      const id = attrs.id
      if (available && tag === 'button' && Object.hasOwn(attrs, 'data-activity-operation')) {
        buttons.push({ id, operation: attrs['data-activity-operation'] ?? '' })
      }
      if (id) {
        if (seen.has(id)) duplicate.add(id)
        seen.add(id)
        if (available)
          rows.set(id, {
            id,
            tag,
            label:
              attrs['aria-label'] ||
              attrs.title ||
              node.children
                .flatMap(n => (n.type === NodeTypes.TEXT ? n.content : []))
                .join(' ')
                .trim()
                .slice(0, 60) ||
              id,
          })
      }
      // Template contents are a separate document fragment. Hidden live IDs still count toward uniqueness.
      if (tag !== 'template') visit(node.children, available && !Object.keys(attrs).some(a => replacedChildren.has(a)))
    }
  }
  visit(tree.children)
  return { targets: [...rows.values()].filter(e => !duplicate.has(e.id)), buttons }
}
export function checkPageTargets(layout: ReturnType<typeof readPageElements>, elements: PageElement[]) {
  const targets = new Map(layout.targets.map(t => [t.id, t]))
  for (const row of elements) {
    const el = targets.get(row.id)
    if (!el) throw new TypeError('HTML 中需要一个具有唯一 id 的元素：' + row.id)
    if (row.operation && el.tag !== 'button') throw new TypeError('点击操作需要绑定到 button：' + row.id)
  }
}
