import { build } from 'esbuild'
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync } from 'node:fs'
import { resolve,join,relative } from 'node:path'
import { createHash } from 'node:crypto'

const root=resolve('.'),base=resolve('output/goal-progress');mkdirSync(base,{recursive:true})
const directory=mkdtempSync(join(base,'comparison-')),sources={}
const entry='tests/experiments/goal-progress-live.ts'
await build({entryPoints:[entry],outfile:join(directory,'run.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',external:['jieba-wasm'],
 banner:{js:"import { createRequire as goalRequire } from 'node:module'; const require = goalRequire(import.meta.url);"},
 plugins:[{name:'isolated-author-search',setup(builder){builder.onLoad({filter:/\.ts$/},args=>{
  const path=relative(root,args.path).split('\\').join('/'),source=readFileSync(args.path,'utf8')
  sources[path]=createHash('sha256').update(source).digest('hex')
  if(path==='packages/interactions-basic/src/home.ts') {
   const contents="import { goalProgressSearchPackage } from '../../../tests/experiments/goal-progress-search.ts'\n"+source.replace('createBasicInteractionPackage(),createHomeInteractionPackage()]','createBasicInteractionPackage(),createHomeInteractionPackage(),goalProgressSearchPackage()]')
   if(contents===source||!contents.includes('createHomeInteractionPackage(),goalProgressSearchPackage()]'))throw new Error('Author package injection failed')
   return {contents,loader:'ts',resolveDir:resolve(args.path,'..')}
  }
  if(path==='tests/experiments/playtest-frozen-runtime.ts')return {contents:source.replace('const prepared = await prepare(request)',
   "(globalThis as unknown as {captureGoalRequest?:(request:PrototypeTurnRequest)=>void}).captureGoalRequest?.(request)\n      const prepared = await prepare(request)"),loader:'ts',resolveDir:resolve(args.path,'..')}
 })}}],logLevel:'silent'})
writeFileSync(join(directory,'build.json'),JSON.stringify({sources,bundleHash:createHash('sha256').update(readFileSync(join(directory,'run.mjs'))).digest('hex'),
 model:'gemini-3.8-flash',thinking:'low',beforeActionExpression:false,continueAfterPublish:false,
 note:'One executable; only recentExecutionEvidence changes between arms. The finite author search package is installed only in this bundle. Capture hook stores host-authorized requests for source audit, never injects them.'},null,2)+'\n')
console.log(directory)
