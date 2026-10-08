import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'

const config=JSON.parse(process.argv[2]!) as { phase: string; dataDirectory:string; packPath:string; endpoint:string; tailId:string; candidateId?:string }
const originalRename=fs.renameSync,originalCopy=fs.copyFileSync
function halt(path:string):never {
  fs.writeSync(1,'CRASH_POINT '+config.phase+' '+path+'\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)
  throw new Error('fault point resumed')
}
const runtime=await FrozenWorldPlaytestRuntime.create({dataDirectory:config.dataDirectory,packPath:config.packPath,
  provider:'ollama',model:'fixture',utilityEndpoint:config.endpoint,timeoutMs:5000})
fs.copyFileSync=(...args:Parameters<typeof fs.copyFileSync>)=>{
  originalCopy(...args)
  if(config.phase==='candidate-copy'&&String(args[1]).includes('results')&&basename(String(args[1]))==='world.sqlite'){
    const bytes=fs.readFileSync(args[1]);fs.writeFileSync(args[1],bytes.subarray(0,Math.floor(bytes.length/2)))
    halt(String(args[1]))
  }
}
fs.renameSync=(...args:Parameters<typeof fs.renameSync>)=>{
  const target=String(args[1])
  if(basename(target)==='current-world.json'){
    const selection=JSON.parse(fs.readFileSync(args[0],'utf8'))
    if((selection.directory!=='.'||config.candidateId)&&['switch-before','select-before'].includes(config.phase))halt(target)
    originalRename(...args)
    if((selection.directory!=='.'||config.candidateId)&&['switch-after','select-after'].includes(config.phase))halt(target)
    return
  }
  originalRename(...args)
}
syncBuiltinESMExports()
if(config.candidateId) await runtime.selectCandidate(config.tailId,config.candidateId,'request:crash')
else await runtime.regenerate(config.tailId,'request:crash')
throw new Error('fault point not reached')
