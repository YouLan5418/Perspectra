import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { command, object, packPath, settings, snapshot, takeRecord } from '../experiments/hidden-cure.ts'

it('compiles the experiment and preserves private knowledge and exclusive document custody', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hidden-cure-')), inputs: unknown[] = []
  // Mechanical regression only. NPC abstention here is never used as real-model behavior evidence.
  const server = createServer((req,res) => {
    let body=''; req.on('data',chunk=>{body+=String(chunk)})
    req.on('end',()=>{
      inputs.push(JSON.parse(JSON.parse(body).messages.at(-1).content))
      res.writeHead(200,{'content-type':'application/json'})
      res.end(JSON.stringify({message:{content:JSON.stringify({decision:'abstain'})}}))
    })
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  let runtime: WorldHostRuntime | undefined
  try {
    runtime=await WorldHostRuntime.create({dataDirectory:directory,packPath,
      provider:'ollama',model:'mechanical-abstention',playSettings:settings,
      utilityEndpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/chat`,timeoutMs:5000})
    const initial=snapshot(runtime)
    expect(initial.record).toMatchObject({holderId:null,locationId:'location:archive'})
    expect(JSON.stringify(initial.views['character:priestess'])).not.toContain('灰钟梦兆')
    expect(JSON.stringify(initial.views['character:priestess'])).not.toContain('独占议程')
    expect(JSON.stringify(initial.views['character:rival'])).not.toContain('灰钟梦兆')
    const rejected=await runtime.submit(takeRecord)
    expect(rejected.error).toBe(false)
    expect(snapshot(runtime).record).toEqual(initial.record)
    expect(snapshot(runtime).actions.at(-1)).toMatchObject({actorId:'character:player',accepted:false})
    await runtime.submit(command('speak',{text:'银杏灯约定：请先核实治疗风险。',scope:'private',addresseeIds:['character:priestess']}))
    expect(inputs.filter(input=>object(object(object(input).context).character).characterId==='character:rival')).not.toHaveLength(0)
    expect(JSON.stringify(inputs.filter(input=>object(object(object(input).context).character).characterId==='character:rival'))).not.toContain('银杏灯约定')
    await runtime.submit(command('move',{locationId:'location:archive'}))
    await runtime.submit(takeRecord)
    const held=snapshot(runtime)
    expect(held.record).toMatchObject({holderId:'character:player',locationId:null})
    expect(object(held.views['character:rival']!.items).current).toEqual([])
    expect(held.integrity.headSeq).toBe(held.seq)
    expect(held.integrity.eventCount).toBe(held.events.length)
    await runtime.submit(command('move',{locationId:'location:inn'}))
    expect(snapshot(runtime).record).toMatchObject({holderId:'character:player',locationId:null})
  } finally {
    await runtime?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))
    rmSync(directory,{recursive:true,force:true})
  }
},30000)
