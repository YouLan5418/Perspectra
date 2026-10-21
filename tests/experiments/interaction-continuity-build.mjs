// Build isolated comparison executables from one playtest driver without switching the dirty worktree.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve('.'), output = resolve('output/interaction-continuity')
mkdirSync(output, {recursive:true})
const directory = mkdtempSync(join(output,'comparison-'))
const git = (...args) => execFileSync('git',['-c',`safe.directory=${root.split('\\').join('/')}`,...args],{cwd:root,encoding:'utf8'})
const revision = git('rev-parse','HEAD').trim()
const publishLoop=process.argv.includes('--publish-loop')
const decisionThinking=process.argv.includes('--decision-thinking')
const intentClarity=process.argv.includes('--intent-clarity')
const actionSemantics=process.argv.includes('--action-semantics')
const beforeAction=process.argv.includes('--before-action')
if([publishLoop,decisionThinking,intentClarity,actionSemantics,beforeAction].filter(Boolean).length>1)throw new Error('Compare one mechanism at a time')
const changed = [
  'packages/application/src/character-turn.ts',
  'packages/provider-chat/src/character-context-text.ts',
  'packages/provider-chat/src/character-turn-call.ts',
  'desktop/host/gateway-turn-call.ts',
  'desktop/host/pack-activity.ts',
  'desktop/host/world-runtime.ts',
  'desktop/host/tail-runtime.ts',
]
const digest = value => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries(changed.map(path=>{
  const current=readFileSync(join(root,path),'utf8')
  const baseline=actionSemantics ? path==='packages/provider-chat/src/character-context-text.ts'
    ? current.replace('const explanations = (request.canPerform ?? !request.continuation) ? characterActionExplanations(context) : []',
      'const explanations: WorldJsonObject[] = []').replace(' + characterActionExplanationsNote','') : current
    : intentClarity ? path==='packages/provider-chat/src/character-turn-call.ts'
    ? current.replace(/  \+ characterActionIntentPrinciples\r?\n/,'') : current
    : decisionThinking ? path==='packages/provider-chat/src/character-turn-call.ts'
    ? current.replace('content: characterDecisionPrinciples + characterContextNote','content: characterContextNote') : current
    : publishLoop||beforeAction?current:git('show',`${revision}:${path}`)
  if(intentClarity&&path==='packages/provider-chat/src/character-turn-call.ts'&&baseline===current)throw new Error('Intent paragraph not removed from baseline')
  if(actionSemantics&&path==='packages/provider-chat/src/character-context-text.ts'&&baseline===current)throw new Error('Semantic rendering not disabled in baseline')
  return [path,{baseline,experiment:current}]
}))
const entry = 'tests/experiments/hidden-cure-next.ts'
let driver = readFileSync(entry,'utf8')
const replace = (before,after) => {
  if(!driver.includes(before))throw new Error('Expected playtest driver segment missing: '+before)
  driver=driver.replace(before,after)
}
replace('  buildNextPacks()', '  Math.random = () => 0.5 // Same scheduling tie order in both arms; NPC choices remain model decisions.\n  buildNextPacks()')
replace("resolve('output/hidden-cure-next')", "resolve(process.env.CONTINUITY_OUTPUT_ROOT ?? 'output/hidden-cure-next')")
replace('object(array(wire.messages).at(-1))', "object(array(wire.messages).findLast(message => object(message).role === 'user'))")
replace('autonomous: context.autonomy !== undefined, continuation: input.continuation === true,',
  "autonomous: context.autonomy !== undefined, continuation: input.continuation === true, formatRepair: array(wire.messages).some(message => String(object(message).content).startsWith('上一次返回不符合本次工具 JSON schema。')),")
if(publishLoop) {
  replace('timeoutMs: 60000, playSettings: settings',"timeoutMs: 60000, playSettings: settings, continueAfterPublish: process.env.CONTINUITY_PUBLISH_LOOP === 'on'")
  replace("memoryMode: 'native', dynamicScheduling: true", "continueAfterPublish: process.env.CONTINUITY_PUBLISH_LOOP === 'on', memoryMode: 'native', dynamicScheduling: true")
}
if(beforeAction) {
  replace("'decision','segments','scope','addresseeIds','actionType','parameters','query'", "'decision','segments','scope','addresseeIds','actionType','parameters','query','before'")
}
if(decisionThinking||intentClarity||actionSemantics||beforeAction) {
  replace('  buildNextPacks()',"  const selectedThinking = process.env.DECISION_THINKING_LEVEL ?? 'low'\n  if(!['low','medium','high'].includes(selectedThinking))throw new Error('Invalid thinking level')\n  buildNextPacks()")
  if([...driver.matchAll(/thinkingLevel: 'low'/g)].length!==2)throw new Error('Expected two thinking assignments')
  driver=driver.replaceAll("thinkingLevel: 'low'",'thinkingLevel: selectedThinking')
  const beforeFlag=beforeAction?", beforeActionExpression: process.env.CONTINUITY_BEFORE_ACTION === 'on'":''
  replace('timeoutMs: 60000, playSettings: settings','timeoutMs: 60000, playSettings: settings, preset: {maxOutputTokens:32768}, continueAfterPublish: false'+beforeFlag)
  replace("memoryMode: 'native', dynamicScheduling: true","maximumOutputTokens:32768, continueAfterPublish:false"+beforeFlag+", memoryMode: 'native', dynamicScheduling: true")
}
const executions=[]
const arms=decisionThinking?[
  {mode:'baseline',prompt:'previous',thinking:'low'},
  {mode:'low',prompt:'improved',thinking:'low'},
  {mode:'medium',prompt:'improved',thinking:'medium'},
  {mode:'high',prompt:'improved',thinking:'high'},
]:beforeAction?[{mode:'baseline',prompt:'action-semantics',thinking:'low'},{mode:'experiment',prompt:'action-semantics',thinking:'low'}]
  :actionSemantics?[{mode:'baseline',prompt:'intent-clarity',thinking:'low'},{mode:'experiment',prompt:'action-semantics',thinking:'low'}]
  :intentClarity?[{mode:'baseline',prompt:'independent',thinking:'low'},{mode:'experiment',prompt:'intent-clarity',thinking:'low'}]
  :[{mode:'baseline'},{mode:'experiment'}]
for(const arm of arms) {
  const {mode}=arm
  const used=new Set()
  const outfile=join(directory,mode+'.mjs')
  await build({entryPoints:[entry],outfile,bundle:true,platform:'node',format:'esm',target:'node24',external:['jieba-wasm'],
    banner:{js:"import { createRequire as comparisonRequire } from 'node:module'; const require = comparisonRequire(import.meta.url);"},
    plugins:[{name:'comparison-sources',setup(builder){
      builder.onLoad({filter:/\.ts$/},args=>{
        const path=relative(root,args.path).split('\\').join('/')
        if(path===entry)return {contents:driver,loader:'ts',resolveDir:resolve(root,'tests/experiments')}
        if(path==='tests/experiments/hidden-cure.ts') {
          const source=readFileSync(args.path,'utf8')
          const contents=source.replace(/if \(process\.argv\[1\].*await run\(\)\s*$/,'')
          if(contents===source)throw new Error('Dependent driver main guard not found')
          return {contents,loader:'ts',resolveDir:resolve(args.path,'..')}
        }
        if(Object.hasOwn(sources,path)) {
          used.add(path)
          return {contents:sources[path][mode==='baseline'?'baseline':'experiment'],loader:'ts',resolveDir:resolve(args.path,'..')}
        }
      })
    }}],logLevel:'silent'})
  if(used.size!==changed.length)throw new Error('Incomplete comparison source overrides: '+[...used])
  executions.push({...arm,outfile,bundleHash:digest(readFileSync(outfile))})
}
writeFileSync(join(directory,'build.json'),JSON.stringify({revision,model:'gemini-3.8-flash',endpoint:'http://127.0.0.1:8045/v1/chat/completions',
  cases:publishLoop||decisionThinking||intentClarity||actionSemantics||beforeAction?['D3','E']:['D2','D3','E'],publishLoop,decisionThinking,intentClarity,actionSemantics,beforeAction,scheduleTieRandom:0.5,driverHash:digest(driver),
  auxiliarySources:{'packages/provider-chat/src/character-action-explanations.ts':digest(readFileSync('packages/provider-chat/src/character-action-explanations.ts'))},
  sources:Object.fromEntries(Object.entries(sources).map(([path,versions])=>[path,Object.fromEntries(Object.entries(versions).map(([mode,value])=>[mode,digest(value)]))])),executions},null,2)+'\n')
console.log(JSON.stringify({directory,revision,executions}))
