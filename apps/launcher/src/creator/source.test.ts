import { describe, expect, it, vi } from 'vitest'
import { creatorSource } from './source.ts'

const TOKEN = 'a'.repeat(64)
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('creator page data source', () => {
  it('sends token header and query', async () => {
    const fetcher = vi.fn(async () => ok({ ok: true }))
    await creatorSource(TOKEN, fetcher).debug({ characterId: 'a' })
    expect(fetcher).toHaveBeenCalledWith('/api/creator-debug?characterId=a', { headers: { 'x-playtest-token': TOKEN } })
  })

  it('throws readable error on non-ok', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 }))
    await expect(creatorSource(TOKEN, fetcher).history()).rejects.toThrow('创作者数据读取失败（401）')
  })

  it('reads meta and toggles request capture with the same token', async () => {
    const fetcher = vi.fn(async () => ok({ enabled: true, requests: [] }))
    const source = creatorSource(TOKEN, fetcher)
    await source.requests(true)
    expect(fetcher).toHaveBeenCalledWith('/api/request-inspector', {
      method: 'POST',
      headers: { 'x-playtest-token': TOKEN, 'content-type': 'application/json' },
      body: '{"enabled":true}',
    })
    await source.meta()
    expect(fetcher).toHaveBeenLastCalledWith('/api/creator-meta', { headers: { 'x-playtest-token': TOKEN } })
  })

  it('falls back to preview data without a token', async () => {
    const source = creatorSource('')
    expect(source.preview).toBe(true)
    expect((await source.meta()).title).toBeTruthy()
  })
})

describe('creator store connection state', () => {
  it('stops reporting preview once a real token is attached, even if read before attaching', async () => {
    const { createPinia, setActivePinia } = await import('pinia')
    const { useCreatorStore } = await import('./store.ts')
    setActivePinia(createPinia())
    const store = useCreatorStore()
    expect(store.preview).toBe(true)
    store.attach(TOKEN)
    expect(store.preview).toBe(false)
  })
})
