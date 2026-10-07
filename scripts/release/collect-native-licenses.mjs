import {execFileSync} from 'node:child_process'
import {mkdir,readdir,writeFile,copyFile,stat} from 'node:fs/promises'
import {resolve,join} from 'node:path'
const output=resolve(process.argv[2]);await mkdir(output,{recursive:true})
const metadata=JSON.parse(execFileSync('cargo',['metadata','--manifest-path','apps/launcher/src-tauri/Cargo.toml','--format-version','1','--locked','--offline','--filter-platform','x86_64-pc-windows-msvc'],{encoding:'utf8',maxBuffer:20*1024*1024,windowsHide:true}))
const inventory=[]
for(const p of metadata.packages){if(!p.source)continue;const folder=resolve(p.manifest_path,'..'),files=[];for(const name of await readdir(folder)){if(!/^(license|notice|copying)/i.test(name)||!(await stat(join(folder,name))).isFile())continue;const target=join(output,p.name+'-'+p.version);await mkdir(target,{recursive:true});await copyFile(join(folder,name),join(target,name));files.push(name)}inventory.push({name:p.name,version:p.version,license:p.license,source:p.source,files})}
await writeFile(join(output,'inventory.json'),JSON.stringify(inventory,null,2));console.log('Native dependency license inventory: '+inventory.length+' packages (includes build and platform dependencies)')
