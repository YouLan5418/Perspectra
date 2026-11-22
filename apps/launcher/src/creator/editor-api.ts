let token = ''
export function setEditorToken(value: string): void {
  token = value
}
let editorWorkspace = ''
export function selectEditorWorkspace(id: string) {
  editorWorkspace = id
}
export async function editorRequest<T>(
  operation: string,
  data: Record<string, unknown> = {},
  workspace = editorWorkspace,
): Promise<T> {
  const response = await fetch('/api/editor', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-editor-token': token },
    body: JSON.stringify({
      ...data,
      operation,
      workspace,
    }),
  })
  const body = await response.json()
  if (!response.ok) throw Object.assign(new Error(body.error ?? '编辑失败'), { details: body, status: response.status })
  return body as T
}
