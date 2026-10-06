import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, basename, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCoreWorker } from './hindsight-python.ts'

const roots: string[] = []
const workers: ReturnType<typeof createCoreWorker>[] = []
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('core-worker-test-')) throw new Error('unexpected root')
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'core-worker-test-')); roots.push(root)
  const path = join(root, 'worker.mjs')
  writeFileSync(path, `import { createInterface } from 'node:readline';
let count=0;
for await (const line of createInterface({input:process.stdin})) {
 const input=JSON.parse(line);count++;
 if(input.operation==='slow') await new Promise(done=>setTimeout(done,5000));
 const reply=input.operation==='reject'?{error:true}:{result:{pid:process.pid,count,scope:input.scope??null}};
 process.stdout.write(JSON.stringify(reply)+'\\n');
}`)
  const worker = createCoreWorker({}, { executable: process.execPath, args: [path] }); workers.push(worker)
  return worker
}
it('reuses one process for different role-scoped requests and propagates rejected work', async () => {
  const worker = fixture()
  const a = await worker.run({ operation: 'build', scope: { characterId: 'character:a' } }, AbortSignal.timeout(5000))
  const b = await worker.run({ operation: 'recall', scope: { characterId: 'character:b' } }, AbortSignal.timeout(5000))
  expect(b.pid).toBe(a.pid); expect(b.count).toBe(2)
  expect(b.scope).toEqual({ characterId: 'character:b' })
  await expect(worker.run({ operation: 'reject' }, AbortSignal.timeout(5000))).rejects.toThrow('记忆处理失败')
  expect((await worker.run({ operation: 'recall' }, AbortSignal.timeout(5000))).pid).toBe(a.pid)
})
it('cancels active work, waits for process exit, then starts a clean worker on the next request', async () => {
  const worker = fixture()
  const a = await worker.run({ operation: 'recall' }, AbortSignal.timeout(5000))
  const cancel = new AbortController()
  const pending = worker.run({ operation: 'slow' }, cancel.signal)
  await expect(worker.run({ operation: 'recall' }, AbortSignal.timeout(5000))).rejects.toThrow('等待')
  cancel.abort()
  await expect(pending).rejects.toThrow('记忆处理失败')
  const b = await worker.run({ operation: 'recall' }, AbortSignal.timeout(5000))
  expect(b.pid).not.toBe(a.pid); expect(b.count).toBe(1)
  await worker.close()
  await expect(worker.run({ operation: 'recall' }, AbortSignal.timeout(5000))).rejects.toThrow('已关闭')
})
it('closing a session rejects unfinished work and reaps its child', async () => {
  const worker = fixture()
  const first = await worker.run({ operation: 'recall' }, AbortSignal.timeout(5000))
  const pending = worker.run({ operation: 'slow' }, AbortSignal.timeout(5000))
  const rejected = expect(pending).rejects.toThrow('记忆处理失败')
  await worker.close(); await rejected
  expect(() => process.kill(Number(first.pid), 0)).toThrow()
})
