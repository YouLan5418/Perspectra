import {build} from 'esbuild'
import {cp,mkdir,readFile,writeFile,readdir,stat,access} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const output=resolve(process.argv[2]??'dist/portable/Perspectra-0.1.0-test1-win-x64')
try{await access(output);throw Error('Output already exists; choose a new directory.')}catch(error){if(error.code!=='ENOENT')throw error}
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Windows x64 build required')
const pythonHome=process.env.PERSPECTRA_BUILD_PYTHON_HOME??readFileSyncConfig()
function readFileSyncConfig(){const text=execFileSync(process.execPath,['-e',"process.stdout.write(require('fs').readFileSync('.tmp/hindsight-vector-venv/pyvenv.cfg','utf8'))"],{encoding:'utf8'});const match=text.match(/^home = (.+)$/m);if(!match)throw Error('Python base not found');return match[1].trim()}
const runtime=join(output,'runtime');await mkdir(runtime,{recursive:true})
const filter=path=>!path.split(/[\\/]/).some(p=>p==='__pycache__'||p==='.cache')
await cp(process.execPath,join(runtime,'node.exe'))
await cp(resolve('.tmp/portable-release-assets/webview2'),join(runtime,'webview2'),{recursive:true,dereference:true})
await cp(resolve('.tmp/portable-release-assets/NODE-LICENSE.txt'),join(runtime,'NODE-LICENSE.txt'))
await cp(pythonHome,join(runtime,'python'),{recursive:true,dereference:true,filter:path=>filter(path)&&!path.split(/[\\/]/).includes('site-packages')})
const crt=resolve(process.env.PERSPECTRA_BUILD_CRT_DIR??'.tmp/portable-release-assets/msvc-crt')
for(const file of await readdir(crt)){if(!file.endsWith('.dll'))continue;for(const directory of [output,runtime,join(runtime,'python')])await cp(join(crt,file),join(directory,file))}

await cp(resolve('.tmp/hindsight-vector-venv/Lib/site-packages'),join(runtime,'python/Lib/site-packages'),{recursive:true,dereference:true,filter})
const inputs=new Set()
for(const [entry,file] of [['desktop/launcher-entry.ts','launcher.mjs'],['tests/experiments/playtest-web-entry.ts','playtest.mjs']]){
const result=await build({entryPoints:[entry],outfile:join(runtime,file),bundle:true,platform:'node',target:'node24',format:'esm',external:['jieba-wasm'],legalComments:'eof',metafile:true,banner:{js:"import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);"}})
for(const path of Object.keys(result.metafile.inputs))inputs.add(resolve(path))
}
await cp(resolve('node_modules/jieba-wasm'),join(runtime,'node_modules/jieba-wasm'),{recursive:true,dereference:true})
for(const [folder,files] of [ ['hindsight-core',['core.py','episode_core.py','projections.py','queries.py','retrieval_text.py','vector_core.py','vendor']],['activity-memory',['core_bridge.py','activity_delivery.py','candidate_admission.py','minimal_delivery.py']] ]){
await mkdir(join(runtime,'experiments',folder),{recursive:true});for(const file of files)await cp(resolve('experiments',folder,file),join(runtime,'experiments',folder,file),{recursive:true,dereference:true,filter})
}
const assets=JSON.parse(await readFile('experiments/hindsight-core/e5-assets.json','utf8'))
for(const [file,expected]of Object.entries(assets.files)){
const source=resolve('.tmp/hindsight-e5-small',file),bytes=await readFile(source)
if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Model asset hash mismatch: '+file)
await mkdir(dirname(join(runtime,'models/e5-small',file)),{recursive:true});await writeFile(join(runtime,'models/e5-small',file),bytes)
}
await mkdir(join(output,'licenses'),{recursive:true})
await cp(resolve('.tmp/portable-release-assets/MSVC-RUNTIME-LICENSE.docx'),join(output,'licenses/MSVC-RUNTIME-LICENSE.docx'))
await cp(resolve('.tmp/portable-release-assets/E5-MODEL-CARD.md'),join(output,'licenses/E5-MODEL-CARD.md'))
await cp(resolve('.tmp/portable-release-assets/E5-BASE-MODEL-CARD.md'),join(output,'licenses/E5-BASE-MODEL-CARD.md'))
await cp(resolve('experiments/hindsight-core/vendor/LICENSE'),join(output,'licenses/HINDSIGHT-LICENSE.txt'))
const packages=new Map()
for(const file of inputs){if(!file.includes('node_modules'))continue;let folder=dirname(file);for(;;){try{const data=JSON.parse(await readFile(join(folder,'package.json'),'utf8'));packages.set(data.name,{folder,name:data.name,version:data.version,license:data.license});break}catch{}const parent=dirname(folder);if(parent===folder)break;folder=parent}}
for(const data of packages.values()){
const target=join(output,'licenses',data.name.replaceAll('/','_'));await mkdir(target,{recursive:true});for(const file of await readdir(data.folder))if(/^(license|notice|copying)/i.test(file)&&(await stat(join(data.folder,file))).isFile())await cp(join(data.folder,file),join(target,file))
}
await writeFile(join(output,'licenses/node-dependencies.json'),JSON.stringify([...packages.values()].map(({folder,...data})=>data),null,2))
await cp(resolve('apps/launcher/src-tauri/target/release/perspectra-launcher.exe'),join(output,'Perspectra.exe'))
await cp(resolve('examples/world-packs/prototype-g1'),join(output,'examples/前室与后室'),{recursive:true,dereference:true,filter})
await cp(resolve('examples/world-packs/launcher-demo'),join(output,'examples/测试示例'),{recursive:true,dereference:true,filter})
await cp(resolve('scripts/release/README.zh-CN.md'),join(output,'开始试玩.md'))
await cp(resolve('scripts/release/feedback-template.zh-CN.md'),join(output,'反馈模板.md'))
await cp(resolve('scripts/release/clean-windows-checklist.zh-CN.md'),join(output,'干净系统验收.md'))
execFileSync(process.execPath,['scripts/release/collect-native-licenses.mjs',join(output,'licenses/native-dependencies')],{stdio:'inherit',windowsHide:true})
await writeFile(join(output,'build-info.json'),JSON.stringify({product:'Perspectra',version:'0.1.0-test1',platform:'win-x64',webview2:'154.0.4258.62',node:process.version,python:execFileSync(join(runtime,'python/python.exe'),['--version'],{encoding:'utf8'}).trim(),msvc:'14.50.35710',model:assets.repoId,baseModel:'intfloat/multilingual-e5-small',modelRevision:assets.revision,buildTime:new Date().toISOString()},null,2))
console.log('Portable build ready: '+output)
