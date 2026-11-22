import { afterEach, expect, it, vi } from 'vitest'
import { editorRequest, selectEditorWorkspace } from './editor-api.ts'

afterEach(() => {
  selectEditorWorkspace('')
  vi.unstubAllGlobals()
})
it('saves into the displayed project when the URL changes or a different project is being opened', async () => {
  const writes: string[] = []
  vi.stubGlobal('location', { search: '?workspace=first' })
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    writes.push(JSON.parse(String(init.body)).workspace)
    return Response.json({})
  })
  selectEditorWorkspace('second')
  await editorRequest('records', {}, 'first')
  await editorRequest('record-save', { kind: 'character' })
  expect(writes).toEqual(['first', 'second'])
})
