/** Native loading/layout smoke only; does not claim actual E5 inference or portable release acceptance. */
import { build } from 'esbuild'
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const root = await mkdtemp(join(tmpdir(), 'perspectra-node-e5-'))
try {
  await build({ entryPoints: ['packages/memory-core/src/node/e5-worker.ts'], outfile: join(root, 'e5-worker.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['onnxruntime-node'] })
  for (const name of ['onnxruntime-node', 'onnxruntime-common']) {
    const source = resolve('node_modules', name), dest = join(root, 'node_modules', name)
    await mkdir(dest, { recursive: true })
    for (const part of ['package.json', 'dist']) await cp(join(source, part), join(dest, part), { recursive: true })
    if (name === 'onnxruntime-node') await cp(join(source, 'bin/napi-v6', process.platform, process.arch), join(dest, 'bin/napi-v6', process.platform, process.arch), {recursive: true})
  }
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {Worker} from 'node:worker_threads'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
    const worker=new Worker(pathToFileURL(resolve('e5-worker.mjs')),{workerData:{directory:process.cwd()+'/missing-assets'},env:{},execArgv:[]});
    const timeout=setTimeout(()=>{worker.terminate();process.exitCode=1},5000);
    worker.on('error',()=>{clearTimeout(timeout);process.exitCode=1});
    worker.on('message',async reply=>{clearTimeout(timeout);if(reply.error!=='Local E5 request failed; verify frozen assets and native runtime')process.exitCode=1;else console.log('native CPU worker loaded outside checkout; missing assets refused');await worker.terminate()});
    worker.postMessage({texts:['离线本地'],query:true});
  `], {cwd:root,env:{PATH:process.env.PATH},encoding:'utf8',timeout:10000})
  console.log(output.trim())
  for (const file of ['onnxruntime_binding.node','onnxruntime.dll']) await stat(resolve('node_modules/onnxruntime-node/bin/napi-v6/win32/x64',file))
  console.log('Windows x64 binding/DLL present in pinned npm package; execution NOT verified')
} finally { await rm(root, {recursive:true,force:true}) }
