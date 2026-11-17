import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, basename, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { coreRunnerGroups, createCoreWorker } from '../../packages/memory-core/src/node/worker-client.ts'

const roots: string[] = []
const workers: ReturnType<typeof createCoreWorker>[] = []
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('core-worker-test-'))
      throw new Error('unexpected root')
    rmSync(root, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

function fixture(options: { recallTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'core-worker-test-'))
  roots.push(root)
  const path = join(root, 'worker.mjs')
  writeFileSync(
    path,
    `import { parentPort, threadId, workerData } from 'node:worker_threads';
let count=0;
parentPort.on('message', async message => {
 if(message.type==='close'){parentPort.postMessage({type:'closed'});parentPort.close();return;}
 if(message.type!=='run') return;
 count++;
 if(message.input.operation==='exit') process.exit(0);
 if(message.input.operation==='slow') await new Promise(done=>setTimeout(done,250));
 if(message.input.operation==='reject') parentPort.postMessage({type:'result',id:message.id,error:{message:'Core fixture rejected'}});
 else parentPort.postMessage({type:'result',id:message.id,result:{threadId,count,scope:message.input.scope??null,config:workerData.runtimeConfig,secret:process.env.CORE_WORKER_TEST_SECRET??null}});
});`,
  )
  const worker = createCoreWorker(
    {
      HCW_LOCAL_MODEL: 'fixture',
      HCW_LOCAL_ENDPOINT: 'http://127.0.0.1:9/v1/chat/completions',
      HCW_MODEL_PROTOCOL: 'openai',
      HCW_LOCAL_API_KEY: 'MEMORY_KEY_BASE',
      HCW_HINDSIGHT_ONNX_DIR: root,
      UNRELATED_SECRET: 'MUST_NOT_CROSS',
    },
    { entry: path, ...options },
  )
  workers.push(worker)
  return worker
}

it('reuses one thread for role-scoped requests and transfers only the selected model config', async () => {
  vi.stubEnv('CORE_WORKER_TEST_SECRET', 'PARENT_ENV_SECRET')
  const worker = fixture(),
    a = await worker.run({ operation: 'build', scope: { characterId: 'character:a' } }, AbortSignal.timeout(5000)),
    b = await worker.run({ operation: 'recall', scope: { characterId: 'character:b' } }, AbortSignal.timeout(5000))
  expect(b.threadId).toBe(a.threadId)
  expect(b.count).toBe(2)
  expect(b.scope).toEqual({ characterId: 'character:b' })
  expect(b.secret).toBeNull()
  expect(b.config).toMatchObject({
    model: {
      protocol: 'openai',
      model: 'fixture',
      apiKey: 'MEMORY_KEY_BASE',
    },
    assetDirectory: expect.any(String),
  })
  expect(JSON.stringify(b.config)).not.toContain('MUST_NOT_CROSS')
  await worker.close()
})

it('loads source TypeScript workers with transform-types enabled', async () => {
  const worker = createCoreWorker()
  workers.push(worker)
  await expect(worker.run({ operation: 'reproject', archive: {} }, AbortSignal.timeout(5000))).rejects.toThrow(
    'Invalid memory object',
  )
})

it('rejects concurrent work and a failed operation without corrupting the reusable worker', async () => {
  const worker = fixture(),
    pending = worker.run({ operation: 'slow' }, AbortSignal.timeout(5000))
  await expect(worker.run({ operation: 'recall' }, AbortSignal.timeout(5000))).rejects.toThrow('等待')
  await expect(worker.run({ operation: 'reject' }, AbortSignal.timeout(5000))).rejects.toThrow('等待')
  // The first operation is still active; after it settles, a failure response leaves the thread usable.
  await pending
  await expect(worker.run({ operation: 'reject' }, AbortSignal.timeout(5000))).rejects.toThrow('fixture rejected')
  const next = await worker.run({ operation: 'recall' }, AbortSignal.timeout(5000))
  expect(next.count).toBe(3)
})

it('cancels and reaps an active thread before starting a clean worker on the next request', async () => {
  const worker = fixture(),
    first = await worker.run({ operation: 'recall' }, AbortSignal.timeout(5000)),
    cancel = new AbortController(),
    pending = worker.run({ operation: 'slow' }, cancel.signal)
  await expect(worker.run({ operation: 'recall' }, AbortSignal.timeout(5000))).rejects.toThrow('等待')
  cancel.abort()
  await expect(pending).rejects.toThrow('已取消')
  const restarted = await Promise.allSettled([
    worker.run({ operation: 'recall' }, AbortSignal.timeout(5000)),
    worker.run({ operation: 'recall' }, AbortSignal.timeout(5000)),
  ])
  expect(restarted.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(restarted.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(restarted.find(result => result.status === 'rejected')).toMatchObject({
    reason: expect.objectContaining({ message: expect.stringContaining('等待') }),
  })
  const next = restarted.find(
    (result): result is PromiseFulfilledResult<import('@perspectra/sdk/contracts').WorldJsonObject> =>
      result.status === 'fulfilled',
  )!.value
  expect(next.threadId).not.toBe(first.threadId)
  expect(next.count).toBe(1)
})

it('rejects a request immediately when its worker exits cleanly before replying', async () => {
  const worker = fixture()
  await expect(worker.run({ operation: 'exit' }, AbortSignal.timeout(5000))).rejects.toThrow('意外退出')
  const next = await worker.run({ operation: 'recall' }, AbortSignal.timeout(5000))
  expect(next.count).toBe(1)
})

it('enforces operation timeouts and close rejects in-flight and future requests', async () => {
  const worker = fixture({ recallTimeoutMs: 25 }),
    timed = worker.run({ operation: 'slow' }, AbortSignal.timeout(10000))
  await expect(timed).rejects.toThrow('超时')
  const pending = worker.run({ operation: 'slow' }, AbortSignal.timeout(5000)),
    rejected = expect(pending).rejects.toThrow('已关闭')
  await worker.close()
  await rejected
  await expect(worker.run({ operation: 'recall' }, AbortSignal.timeout(5000))).rejects.toThrow('已关闭')
})

it('makes runner groups terminal after close and closes each model group once', async () => {
  const started: NodeJS.ProcessEnv[] = []
  let closes = 0
  const groups = coreRunnerGroups('D:/memory-data', environment => {
      started.push(environment)
      return {
        recall: async () => ({}),
        build: async () => ({}),
        close: async () => {
          closes++
        },
      }
    }),
    model = { protocol: 'openai', endpoint: 'http://127.0.0.1', model: 'fixture' }
  groups.runnersFor(model)
  await Promise.all([groups.close(), groups.close()])
  expect(started).toHaveLength(1)
  expect(closes).toBe(1)
  expect(() => groups.runnersFor({ ...model, model: 'later' })).toThrow('closed')
})
