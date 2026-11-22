import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LensSimulation } from '../simulation/simulation.ts'
import { FrontendActions } from '../runtime/frontend-adapter.ts'
import { loadPackWeb } from '../runtime/pack-frontend.ts'
import { createHostServer } from '../runtime/http-server.ts'
import { listenOnSafePort } from '../safe-port.ts'
import { buildSource } from './export.ts'

export async function openPageTrial(
  root: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  requirePage = false,
  withFrontend = requirePage,
) {
  const key = body.key
  if (typeof key !== 'string' || !key) throw new TypeError('请选择活动')
  return openTrial(root, body, key, requirePage, withFrontend, signal)
}
async function openTrial(
  root: string,
  body: Record<string, unknown>,
  key: string | undefined,
  requirePage: boolean,
  withFrontend: boolean,
  signal?: AbortSignal,
) {
  const scenes = body.scenes ?? {}
  if (typeof scenes !== 'object' || Array.isArray(scenes) || !Object.values(scenes).every(s => typeof s === 'string'))
    throw new TypeError('请选择活动和有效的试玩起点')
  const dir = mkdtempSync(join(tmpdir(), 'perspectra-activity-page-'))
  let sim: LensSimulation | undefined
  try {
    await buildSource(realpathSync(root), dir)
    const web = withFrontend ? await loadPackWeb(dir) : undefined
    if (requirePage && (!key || !web?.activityPages || !Object.hasOwn(web.activityPages, key)))
      throw new TypeError('请先为活动保存 HTML 页面')
    signal?.throwIfAborted()
    sim = await LensSimulation.open(dir, { scenes: scenes as Record<string, string> })
    const api = new FrontendActions(sim.previewRuntime)
    let view = await api.view()
    if (key && view.activity?.key !== key) {
      const start = view.actions.find(
        o =>
          o.target?.id === key &&
          o.target.kind === 'activity' &&
          (o.action.parameters.definitionRef as { id?: string })?.id === 'host:activity-start' &&
          !o.participantSelection,
      )
      if (start)
        view = await api.perform({
          requestId: randomUUID(),
          actionId: randomUUID(),
          operation: 'perform',
          payload: { optionId: start.id },
        })
      else if (!view.activity?.active) {
        await sim.step({ kind: 'wait' })
        view = await api.view()
      }
    }
    signal?.throwIfAborted()
    return { sim, view, web }
  } catch (e) {
    await sim?.close()
    throw e
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}

export async function previewActivityPage(
  root: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  requirePage = true,
) {
  return serveTrial(await openPageTrial(root, body, signal, requirePage, true), body.key, signal)
}
export async function previewInteractions(root: string, body: Record<string, unknown>, signal?: AbortSignal) {
  return serveTrial(await openTrial(root, body, undefined, false, true, signal), undefined, signal)
}
async function serveTrial(
  { sim, view, web }: Awaited<ReturnType<typeof openTrial>>,
  key: unknown,
  signal?: AbortSignal,
) {
  let server: ReturnType<typeof createHostServer> | undefined
  async function close() {
    if (server?.listening) {
      const active = server
      const closed = new Promise<void>(done => active.close(() => done()))
      active.closeAllConnections()
      await closed
    }
    await sim?.close()
  }
  try {
    const token = randomBytes(32).toString('hex')
    server = createHostServer(sim.previewRuntime, token, web, undefined, {}, null)
    let lastActivity = Date.now()
    server.on('request', () => {
      lastActivity = Date.now()
    })
    const port = await listenOnSafePort(server)
    signal?.throwIfAborted()
    return {
      url: 'http://127.0.0.1:' + port + '/#token=' + token,
      started: key === undefined || view.activity?.key === key,
      lastActivity: () => lastActivity,
      close,
    }
  } catch (e) {
    await close()
    throw e
  }
}
