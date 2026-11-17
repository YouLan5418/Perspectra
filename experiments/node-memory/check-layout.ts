/** Isolated Node CPU layout; optional fixed assets exercise real inference, never a full Host release. */
import { build } from 'esbuild'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const assetDirectory = process.argv[2] ? resolve(process.argv[2]) : undefined
const root = await mkdtemp(join(tmpdir(), 'perspectra-node-e5-'))
try {
  const bundled = await build({ entryPoints: ['packages/memory-core/src/node/e5-worker.ts'], outfile: join(root, 'e5-worker.mjs'), write: false, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['onnxruntime-node'] })
  await writeFile(join(root, 'e5-worker.mjs'), bundled.outputFiles[0]!.contents)
  for (const name of ['onnxruntime-node', 'onnxruntime-common']) {
    const source = resolve('node_modules', name), dest = join(root, 'node_modules', name)
    await mkdir(dest, { recursive: true })
    for (const part of ['package.json', 'dist']) await cp(join(source, part), join(dest, part), { recursive: true })
    if (name === 'onnxruntime-node') await cp(join(source, 'bin/napi-v6', process.platform, process.arch), join(dest, 'bin/napi-v6', process.platform, process.arch), {recursive: true})
  }
  if (assetDirectory) {
    const manifest = JSON.parse(await readFile('packages/memory-core/python/core/e5-assets.json', 'utf8')) as { files: Record<string, string> }
    await mkdir(join(root, 'assets/onnx'), { recursive: true })
    for (const name of Object.keys(manifest.files)) await cp(join(assetDirectory, name), join(root, 'assets', name))
  }
  await writeFile(join(root, 'check.mjs'), `
    import assert from 'node:assert/strict';
    import {Worker} from 'node:worker_threads';
    const real = process.argv[2] === 'real';
    const worker = new Worker(new URL('./e5-worker.mjs', import.meta.url), {workerData:{directory:process.cwd()+(real?'/assets':'/missing-assets')},env:{},execArgv:[]});
    const timeout = setTimeout(()=>{worker.terminate();process.exitCode=1},120000);
    worker.once('error',error=>{clearTimeout(timeout);console.error(error);process.exitCode=1});
    worker.once('message',async reply=>{
      clearTimeout(timeout);
      try {
        if (!real) assert.equal(reply.error,'Local E5 request failed; verify frozen assets and native runtime');
        else {
          assert.ok(!reply.error);
          assert.equal(reply.result.vectors.length,2);
          for(const vector of reply.result.vectors) {
            assert.equal(vector.length,384);
            assert.ok(vector.every(Number.isFinite));
            assert.ok(Math.abs(Math.hypot(...vector)-1)<1e-5);
          }
          assert.equal(reply.result.tokens[0][0],0);
          assert.equal(reply.result.tokens[0].at(-1),2);
        }
        console.log(real?'isolated real E5 CPU inference passed; no Python copied':'isolated native CPU worker loaded; missing assets refused');
      } catch(error) {console.error(error);process.exitCode=1}
      finally {await worker.terminate()}
    });
    worker.postMessage({texts:['我答应明天来修收音机。','👩🏽‍🔧 café é'],query:true});
  `)
  for (const mode of assetDirectory ? ['missing', 'real'] : ['missing']) {
    console.log(execFileSync(process.execPath, ['check.mjs', mode], { cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP }, encoding: 'utf8', timeout: 130_000, windowsHide: true }).trim())
  }
  for (const file of ['onnxruntime_binding.node','onnxruntime.dll']) await stat(resolve('node_modules/onnxruntime-node/bin/napi-v6/win32/x64',file))
  const report = { platform: process.platform, arch: process.arch, isolatedNativeLoading: true, missingAssetsRefused: true, realE5Inference: Boolean(assetDirectory), pythonCopied: false, fullHostRelease: false }
  await mkdir('.tmp/node-memory', { recursive: true })
  await writeFile('.tmp/node-memory/layout.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await rm(root, {recursive:true,force:true}) }
