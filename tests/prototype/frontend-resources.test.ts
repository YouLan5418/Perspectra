import { mkdtemp, mkdir, writeFile, open, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { FRONTEND_RESOURCE_LIMITS, loadPackWeb } from '../experiments/playtest-pack-web.ts'

const roots:string[]=[]
afterEach(async()=>{
  for(const root of roots.splice(0)){
    if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw new Error('unexpected temporary directory')
    await rm(root,{recursive:true,force:true})
  }
})
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'frontend-resources-'));roots.push(root)
  const directory=join(root,'frontend');await mkdir(directory)
  await writeFile(join(directory,'index.html'),'<p>test</p>')
  await writeFile(join(directory,'manifest.json'),JSON.stringify({apiVersion:1,capabilities:['view']}))
  return {root,directory}
}
it('loads a pack with over 100 files and over 16 MiB of portrait assets',async()=>{
  const {root,directory}=await fixture(),portrait=Buffer.alloc(3*1024*1024)
  await Promise.all(Array.from({length:7},(_,i)=>writeFile(join(directory,`portrait-${i}.png`),portrait)))
  await Promise.all(Array.from({length:120},(_,i)=>writeFile(join(directory,`script-${i}.js`),'export {}')))
  const pack=await loadPackWeb(root)
  expect(pack?.assets.size).toBe(129)
  expect(pack?.assets.get('/frontend/custom/portrait-6.png')?.bytes.length).toBe(3*1024*1024)
})
it('still rejects oversized individual assets and excessive file counts',async()=>{
  const large=await fixture(),file=await open(join(large.directory,'large.wav'),'w')
  try{await file.truncate(FRONTEND_RESOURCE_LIMITS.fileBytes+1)}finally{await file.close()}
  await expect(loadPackWeb(large.root)).rejects.toThrow('单文件 64 MiB')
  const many=await fixture()
  // index + manifest + these files exceed the total file count by one.
  for(let start=0;start<FRONTEND_RESOURCE_LIMITS.files-1;start+=128)
    await Promise.all(Array.from({length:Math.min(128,FRONTEND_RESOURCE_LIMITS.files-1-start)},(_,i)=>writeFile(join(many.directory,`f-${start+i}.js`),'')))
  await expect(loadPackWeb(many.root)).rejects.toThrow('2048')
})
