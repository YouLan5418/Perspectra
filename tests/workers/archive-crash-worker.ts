import { WorldArchiveService } from '@harness-world/store-sqlite'
import type { WorldHash } from '@harness-world/contracts'

const [mode, sourcePath, targetPath, expectedHash] = process.argv.slice(2)
if ((mode !== 'backup' && mode !== 'restore') || sourcePath === undefined || targetPath === undefined) {
  throw new Error('usage: archive-crash-worker <backup|restore> <source> <target> [expected-hash]')
}
const archives = new WorldArchiveService(sourcePath)
if (mode === 'backup') {
  await archives.backup(targetPath, 'crash:backup')
} else {
  if (expectedHash === undefined) throw new Error('restore requires expected hash')
  archives.restore(sourcePath, targetPath, expectedHash as WorldHash, 'crash:restore')
}
process.send?.({ type: 'fault-reached', point: `archive.after-${mode}` })
await new Promise<never>(() => undefined)
