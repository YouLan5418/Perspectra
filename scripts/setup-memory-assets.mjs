// Explicit developer setup only. The runtime itself never downloads model assets.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = resolve(
  process.argv[2] ?? process.env.HCW_HINDSIGHT_ONNX_DIR ?? resolve(root, '.tmp/hindsight-e5-small'),
)
const manifest = JSON.parse(await readFile(new URL('../packages/memory-core/e5-assets.json', import.meta.url), 'utf8'))
for (const [name, digest] of Object.entries(manifest.files)) {
  const target = resolve(directory, name)
  let bytes
  try {
    bytes = await readFile(target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (bytes) {
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('E5 asset hash mismatch: ' + name)
    continue
  }
  const response = await fetch(`https://huggingface.co/${manifest.repoId}/resolve/${manifest.revision}/${name}`, {
    signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok) throw new Error(`E5 download failed (${response.status}): ${name}`)
  bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('E5 download hash mismatch: ' + name)
  await mkdir(dirname(target), { recursive: true })
  const temporary = target + '.' + process.pid + '.tmp'
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
console.log(
  JSON.stringify({
    model: manifest.repoId,
    revision: manifest.revision,
    verifiedFiles: Object.keys(manifest.files).length,
  }),
)
