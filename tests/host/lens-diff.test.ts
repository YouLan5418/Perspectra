import { expect, it } from 'vitest'
import { diffLensViews } from '../../desktop/lens/diff.ts'
import type { LensField, LensItem, LensView } from '../../desktop/lens/view.ts'

const item = (id: string, fields: LensField[], pointer = '/a/0'): LensItem => ({
  id,
  section: 'characters',
  title: `T-${id}`,
  fields,
  source: { kind: 'json', file: 'a.json', pointer },
})
const view = (...items: LensItem[]): LensView => ({ packId: 'p', packVersion: '1', title: 'P', items })
const field = (key: string, value: LensField['value']): LensField => ({ key, label: `L-${key}`, value })

it('reports added items', () => {
  const changes = diffLensViews(view(item('a', [])), view(item('a', []), item('b', [])))
  expect(changes).toEqual([{ kind: 'added', id: 'b' }])
})

it('reports removed items with title and section', () => {
  const changes = diffLensViews(view(item('a', []), item('b', [])), view(item('a', [])))
  expect(changes).toEqual([{ kind: 'removed', id: 'b', title: 'T-b', section: 'characters' }])
})

it('reports a changed field value', () => {
  const changes = diffLensViews(view(item('a', [field('n', 1)])), view(item('a', [field('n', 2)])))
  expect(changes).toEqual([{ kind: 'changed', id: 'a', fields: [{ key: 'n', label: 'L-n', before: 1, after: 2 }] }])
})

it('compares array fields as sets', () => {
  const same = diffLensViews(view(item('a', [field('t', ['x', 'y'])])), view(item('a', [field('t', ['y', 'x'])])))
  expect(same).toEqual([])
  const changed = diffLensViews(view(item('a', [field('t', ['x', 'y'])])), view(item('a', [field('t', ['x', 'z'])])))
  expect(changed).toHaveLength(1)
})

it('reports fields that appear or disappear as null on one side', () => {
  const changes = diffLensViews(view(item('a', [field('n', 1)])), view(item('a', [field('m', 2)])))
  expect(changes).toEqual([
    {
      kind: 'changed',
      id: 'a',
      fields: [
        { key: 'n', label: 'L-n', before: 1, after: null },
        { key: 'm', label: 'L-m', before: null, after: 2 },
      ],
    },
  ])
})

it('ignores source-only changes', () => {
  const changes = diffLensViews(view(item('a', [field('n', 1)], '/a/0')), view(item('a', [field('n', 1)], '/a/5')))
  expect(changes).toEqual([])
})
