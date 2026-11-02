import type { LensSnapshot } from '../../../../desktop/lens/session.ts'

/** 透视页面与本机透视服务的通信。令牌由 `#token=` 传入，没有令牌时是浏览器预览。 */
let token = ''
export function setLensToken(value: string): void {
  token = value
}
export function lensConnected(): boolean {
  return token !== ''
}

async function read<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...init.headers, 'x-lens-token': token } })
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? '透视操作失败。')
  return body
}

export function lensRequest(operation: string, data: Record<string, unknown> = {}): Promise<LensSnapshot> {
  return read<LensSnapshot>('/api/lens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation, ...data }),
  })
}

export function lensStatus(): Promise<{ stale: boolean; watching: boolean }> {
  return read('/api/lens/status')
}
