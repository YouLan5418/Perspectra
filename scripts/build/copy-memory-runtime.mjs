import { cp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// One payload list for the bundled backend, portable builds and isolated layout verification.
export async function copyMemoryRuntime(runtime) {
  for (const [folder, files] of [
    [
      'core',
      ['core.py', 'episode_core.py', 'projections.py', 'queries.py', 'retrieval_text.py', 'vector_core.py', 'vendor'],
    ],
    ['bridge', ['core_bridge.py', 'activity_delivery.py', 'candidate_admission.py', 'minimal_delivery.py']],
  ]) {
    const destination = join(runtime, 'memory-core/python', folder)
    await mkdir(destination, { recursive: true })
    for (const file of files)
      await cp(resolve('desktop/host/memory/python', folder, file), join(destination, file), {
        recursive: true,
        dereference: true,
        filter: path => !path.split(/[\\/]/).some(part => ['__pycache__', '.cache'].includes(part)),
      })
  }
}
