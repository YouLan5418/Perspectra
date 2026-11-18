// An isolated test process exits after consumer A returns but before executeWorldRound can save its receipt.
import { join } from 'node:path'
import { WorldStore, WriterLeaseService } from '@perspectra/core/store'
import { executeWorldRound } from '@perspectra/core'
import { loadHostPlugins } from '../../apps/host/src/host-plugins.ts'
import { WorldEventRuntime } from '../../apps/host/src/runtime/world-events.ts'

const [path, root, serializedAddress, packId] = process.argv.slice(2)
const address = JSON.parse(serializedAddress)
const session = await loadHostPlugins([
  { id: 'isolated-a', path: join(root, 'story-a.mjs'), enabled: true, nativeAllowed: true },
])
const book = { rules: [], grants: [{ plugin: 'story-a', type: 'power.outage@1', mode: 'durable' }] }
const store = new WorldStore(path)
const runtime = new WorldEventRuntime(
  store,
  address,
  packId,
  book,
  session.seams.worldEventConsumers,
  undefined,
  new Set(),
)
runtime.select()
await executeWorldRound(
  { store, leases: new WriterLeaseService(path), address, owner: 'test:crashing-consumer', leaseTtlMs: 150 },
  snapshot => {
    const result = runtime.settle(snapshot, 'test:next-cycle', snapshot.head.headSeq)
    if (result?.authority.receipts.length !== 1 || result.events.length) throw new Error('expected no-effect receipt')
    process.exit(86)
  },
)
