import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

const repositoryRequire = createRequire(resolve('package.json'))
const nativePlatform = process.platform
const nativeArchitecture = process.arch
const nativeLibrary =
  nativePlatform === 'win32'
    ? 'onnxruntime.dll'
    : nativePlatform === 'linux'
      ? 'libonnxruntime.so.1'
      : nativePlatform === 'darwin'
        ? 'libonnxruntime.1.22.0.dylib'
        : undefined
if (!nativeLibrary) throw new Error(`Unsupported Node native runtime platform: ${nativePlatform}/${nativeArchitecture}`)

async function packageInfo(name, fromRequire) {
  const entry = fromRequire.resolve(name)
  let folder = dirname(entry)
  for (;;) {
    try {
      const metadata = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
      if (metadata.name === name) return { folder: await realpath(folder), metadata, name }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    const parent = dirname(folder)
    if (parent === folder) throw new Error(`Cannot locate package ${name}`)
    folder = parent
  }
}

function keepRuntimeFile(name, packageRoot, source) {
  const path = relative(packageRoot, source).replaceAll('\\', '/')
  if (!path) return true
  const directories =
    name === 'onnxruntime-node'
      ? [
          'dist',
          'bin',
          'bin/napi-v6',
          `bin/napi-v6/${nativePlatform}`,
          `bin/napi-v6/${nativePlatform}/${nativeArchitecture}`,
        ]
      : ['dist', 'dist/cjs', 'dist/esm']
  if (directories.includes(path)) return true
  const required =
    name === 'onnxruntime-node'
      ? [
          'package.json',
          'dist/index.js',
          'dist/backend.js',
          'dist/binding.js',
          'dist/version.js',
          `bin/napi-v6/${nativePlatform}/${nativeArchitecture}/onnxruntime_binding.node`,
          `bin/napi-v6/${nativePlatform}/${nativeArchitecture}/${nativeLibrary}`,
        ]
      : ['package.json', 'dist/cjs/package.json', 'dist/esm/package.json']
  const exact = required.includes(path)
  const jsRuntime = name === 'onnxruntime-common' && path.startsWith('dist/') && path.endsWith('.js')
  return exact || jsRuntime
}

async function copyRuntimePackage({ name, folder, metadata }, runtime) {
  const destination = join(runtime, 'node_modules', name)
  await mkdir(dirname(destination), { recursive: true })
  await cp(folder, destination, {
    recursive: true,
    dereference: true,
    filter: path => keepRuntimeFile(name, folder, path),
  })
  return { folder, name, version: metadata.version, license: metadata.license }
}

/** Bundle the Node Core and copy only the external CPU runtime needed by the shipped worker. */
export async function copyMemoryRuntime(runtime) {
  const nodeDirectory = join(runtime, 'memory-core/node')
  await mkdir(nodeDirectory, { recursive: true })
  for (const [entry, output] of [
    ['packages/memory-core/src/node/core-worker.ts', 'core-worker.mjs'],
    ['packages/memory-core/src/node/e5-worker.ts', 'e5-worker.mjs'],
  ]) {
    await build({
      entryPoints: [entry],
      outfile: join(nodeDirectory, output),
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      legalComments: 'eof',
      external: ['onnxruntime-node'],
      banner: {
        js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);",
      },
    })
  }
  const onnx = await packageInfo('onnxruntime-node', repositoryRequire)
  const dependencyRequire = createRequire(join(onnx.folder, 'package.json'))
  const common = await packageInfo('onnxruntime-common', dependencyRequire)
  const dependencies = []
  for (const item of [onnx, common]) dependencies.push(await copyRuntimePackage(item, runtime))
  return dependencies
}

/** Copy six frozen E5 assets to the stable runtime/models/e5-small location. */
export async function copyMemoryAssets(
  runtime,
  source = process.env.HCW_HINDSIGHT_ONNX_DIR ?? '.tmp/hindsight-e5-small',
) {
  const manifest = JSON.parse(await readFile('packages/memory-core/e5-assets.json', 'utf8'))
  const assetRoot = resolve(source)
  for (const [file, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(resolve(assetRoot, file))
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) throw new Error('Model asset hash mismatch: ' + file)
    const destination = join(runtime, 'models/e5-small', file)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
  }
  return manifest
}
