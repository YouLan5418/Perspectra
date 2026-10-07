import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {access,writeFile} from 'node:fs/promises'
import {resolve,join,basename} from 'node:path'
const root=resolve(process.argv[2]),zip=root+'.zip'
await access(join(root,'验收记录.md'))
try{await access(zip);throw Error('Archive already exists; choose a new release path.')}catch(e){if(e.code!=='ENOENT')throw e}
const source=String.raw`import os,sys,zipfile,stat
from pathlib import Path
root=Path(sys.argv[1]); target=Path(sys.argv[2]); files=[]
for folder,dirs,names in os.walk(root,followlinks=False):
 dirs[:]=[d for d in dirs if d!='__pycache__']
 for name in dirs+names:
  p=Path(folder)/name;s=p.lstat()
  if stat.S_ISLNK(s.st_mode) or getattr(s,'st_file_attributes',0)&1024: raise RuntimeError('Link rejected: '+str(p))
 for name in names: files.append(Path(folder)/name)
with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True,strict_timestamps=False) as archive:
 for p in files: archive.write(p,str(Path(root.name)/p.relative_to(root)))
with zipfile.ZipFile(target) as archive:
 bad=archive.testzip()
 if bad: raise RuntimeError('CRC failed: '+bad)
print('ZIP CRC verified; '+str(len(files))+' files')`
const child=spawn(join(root,'runtime/python/python.exe'),['-I','-B','-c',source,root,zip],{windowsHide:true,stdio:'inherit',env:{...process.env,PYTHONHOME:undefined,PYTHONPATH:undefined}})
const code=await new Promise((done,reject)=>{child.on('error',reject);child.once('exit',done)});if(code!==0)throw Error('Archive failed')
const hash=createHash('sha256');for await(const bytes of createReadStream(zip))hash.update(bytes)
await writeFile(zip+'.sha256',hash.digest('hex')+'  '+basename(zip)+'\n');console.log('SHA-256 written: '+zip+'.sha256')
