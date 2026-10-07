import { namedPreset, type LibraryPreset, type NamedPreset } from '../packages/provider-chat/src/preset-library.ts'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rolePreset, rolePresetMapping, characterPreset, type RolePreset, type RolePresetMapping } from '../packages/provider-chat/src/preset.ts'
export interface PresetChoice extends RolePresetMapping { mode:'auto'|'global'|'custom'; override:RolePreset }
export const presetChoice=(value:unknown,checkMacros=true):PresetChoice=>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('实例预设无效。')
 const r=value as Record<string,unknown>
 if(Object.keys(r).some(key=>!['mode','override','characters','groups','memberships'].includes(key))||!['auto','global','custom'].includes(r.mode as string))throw new Error('实例预设模式无效。')
 const {mode,override,...mapping}=r
 return {mode:mode as PresetChoice['mode'],override:rolePreset(override,checkMacros),...rolePresetMapping(mapping,checkMacros)}
}
export async function packPreset(path:string):Promise<RolePreset>{
 try{return rolePreset(JSON.parse(await readFile(join(path,'model-preset.json'),'utf8')))}
 catch(error:unknown){if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return {};throw new Error('游戏包 model-preset.json 无效。')}
}
export class ModelPresets {
 global:RolePreset={}
 instances:Record<string,PresetChoice>={}
 library:LibraryPreset[]=[]
 constructor(readonly root:string){}
 /** Keep structurally valid stored drafts editable; new writes/imports check macro syntax. */
 async load(){
  try{
   const r=JSON.parse(await readFile(join(this.root,'preset-settings.json'),'utf8')) as Record<string,unknown>
   if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='global,instances'||!r.instances||typeof r.instances!=='object'||Array.isArray(r.instances))throw new Error('presets')
   this.global=rolePreset(r.global,false)
   this.instances=Object.fromEntries(Object.entries(r.instances).map(([id,value])=>{if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('id');return [id,presetChoice(value,false)]}))
  }catch(error:unknown){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw new Error('预设设置损坏；未覆盖已有数据。')}
 }
 async loadLibrary(){
  try {
   const value:unknown=JSON.parse(await readFile(join(this.root,'preset-library.json'),'utf8'))
   if(!Array.isArray(value))throw new Error('library')
   const ids=new Set<string>(),names=new Set<string>()
   this.library=value.map(entry=>{
    if(!entry || typeof entry!=='object' || Object.keys(entry).sort().join(',')!=='id,name,preset' || typeof entry.id!=='string' || !/^[a-f0-9-]{36}$/.test(entry.id) || ids.has(entry.id))throw new Error('entry')
    const clean=namedPreset({name:entry.name,preset:entry.preset},false)
    if(names.has(clean.name))throw new Error('name')
    ids.add(entry.id);names.add(clean.name);return {id:entry.id,...clean}
   })
  }catch(error:unknown){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw new Error('预设库损坏；未覆盖已有数据。')}
 }
 async saveLibrary(entries:LibraryPreset[]){
  await mkdir(this.root,{recursive:true})
  const path=join(this.root,'preset-library.'+randomUUID()+'.tmp')
  await writeFile(path,JSON.stringify(entries,null,2)+'\n');await rename(path,join(this.root,'preset-library.json'))
  this.library=entries
 }
 async addLibrary(values:NamedPreset[]){
  const clean=values.map(value=>namedPreset(value)),entries=[...this.library],names=new Set(entries.map(e=>e.name))
  for(const value of clean){
   let name=value.name,n=2
   while(names.has(name)){name=value.name.slice(0,70)+' ('+n+')';n++}
   names.add(name);entries.push({id:randomUUID(),name,preset:value.preset})
  }
  await this.saveLibrary(entries)
 }
 async updateLibrary(id:string,value:unknown){
  if(!this.library.some(e=>e.id===id))throw new Error('预设不存在。')
  const clean=namedPreset(value)
  if(this.library.some(e=>e.id!==id&&e.name===clean.name))throw new Error('已有同名预设，请使用其他名称。')
  await this.saveLibrary(this.library.map(e=>e.id===id?{id,...clean}:e))
 }
 async removeLibrary(id:string){
  if(!this.library.some(e=>e.id===id))throw new Error('预设不存在。')
  await this.saveLibrary(this.library.filter(e=>e.id!==id))
 }
 effective(instanceId:string,recommended:RolePreset):RolePreset{
  const choice=this.instances[instanceId]
  return rolePreset(choice?.mode==='custom'?choice.override:choice?.mode==='global'?this.global:{...this.global,...recommended},false)
 }
 effectiveCharacter(instanceId:string,recommended:RolePreset,id:string):RolePreset{
  return characterPreset(this.effective(instanceId,recommended),this.instances[instanceId]??{},id)
 }
 async save(global:RolePreset,instances:Record<string,PresetChoice>){
  await mkdir(this.root,{recursive:true})
  const path=join(this.root,'preset-settings.'+randomUUID()+'.tmp')
  await writeFile(path,JSON.stringify({global,instances},null,2)+'\n')
  await rename(path,join(this.root,'preset-settings.json'))
  this.global=global;this.instances=instances
 }
}
