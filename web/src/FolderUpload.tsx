import { useEffect, useRef, useState } from 'react'
import {api} from './api/client'
import {putPart} from './UploadRow'
import {systemClock} from './clock'
type DirectoryHandle={kind:'directory';name:string;values:()=>AsyncIterable<DirectoryHandle|{kind:'file';name:string;getFile:()=>Promise<File>}>}
type Manifest = {name:string; files:{path:string;size:number;id:string;partSize:number;partCount:number}[]}
export function FolderUpload({parentId,completed,onActivityChange}:{parentId:number;completed:()=>void;onActivityChange?:(active:boolean)=>void}) {
 const key=`ftp-folder:${parentId}`
 const [manifest,setManifest]=useState<Manifest|undefined>(()=>JSON.parse(localStorage.getItem(key)??'null')??undefined)
 const [status,setStatus]=useState('')
 const [busy,setBusy]=useState(false)
 const selected=useRef<File[]>([])
 const running=useRef(false)
 useEffect(()=>{if(!busy)return;const leave=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave)},[busy])
 useEffect(()=>{const online=()=>{if(selected.current.length&&!running.current)void upload(selected.current)};window.addEventListener('online',online);return()=>window.removeEventListener('online',online)})
 const activityCallback = useRef(onActivityChange); activityCallback.current=onActivityChange
 const active= busy || !!manifest
 useEffect(()=>{activityCallback.current?.(active)},[active])
 async function upload(files:File[],directories:string[]=[],folderName?:string) {
  if(!files.length&&!folderName)return
  const root=folderName??files[0]!.webkitRelativePath.split('/')[0]!
  const paths=files.map(f=>f.webkitRelativePath.split('/').slice(1).join('/'))
  if(manifest&&(manifest.name!==root||manifest.files.length!==files.length||manifest.files.some((m,i)=>m.path!==paths[i]||m.size!==files[i]!.size))){setStatus('文件名称或大小不匹配，请重新选择原文件夹');return}
  selected.current=files;running.current=true;setBusy(true)
  const start=systemClock.now();let bytes=0
  try {
   let active=manifest
   if(!active){const result=await api.POST('/upload-batches',{body:{parentId,name:root,directories,files:files.map((f,i)=>({path:paths[i]!,size:f.size}))}});if(!result.data)throw Error(result.error?.message??'无法创建上传');active={name:root,files:result.data.map((s,i)=>({...s,path:paths[i]!,size:files[i]!.size}))};localStorage.setItem(key,JSON.stringify(active));setManifest(active)}
   for(let i=0;i<files.length;i++) {
    const f=files[i]!,s=active.files[i]!
    const stored=await api.GET('/uploads/{id}/parts',{params:{path:{id:s.id}}});if(!stored.data)throw Error(stored.error?.message??'无法恢复上传')
    const saved=new Set(stored.data.map(p=>p.number))
    for(let n=1;n<=s.partCount;n++) {
     const part=f.slice((n-1)*s.partSize,n*s.partSize)
     if(saved.has(n)){bytes+=part.size;continue}
     const signed=await api.POST('/uploads/{id}/parts',{params:{path:{id:s.id}},body:{numbers:[n]}});if(!signed.data)throw Error('无法获取上传地址')
     await putPart(signed.data[0]!.url,part,loaded=>{
      const total=files.reduce((sum,file)=>sum+file.size,0),done=bytes+loaded
      const speed=done/Math.max((systemClock.now()-start)/1000,0.001)
      setStatus(`${i}/${files.length} 个文件 · ${done}/${total} 字节 · ${(speed/1048576).toFixed(1)} MB/s · 剩余 ${Math.ceil((total-done)/speed)} 秒`)
     });bytes+=part.size
    }
    const finish=await api.POST('/uploads/{id}/complete',{params:{path:{id:s.id}}});if(!finish.data)throw Error(finish.error?.message??'发布失败')
    const speed=bytes/Math.max((systemClock.now()-start)/1000,0.001)
    setStatus(`${i+1}/${files.length} 个文件 · ${(speed/1048576).toFixed(1)} MB/s · 剩余 ${Math.ceil((files.reduce((a,f)=>a+f.size,0)-bytes)/speed)} 秒`)
   }
   setStatus(`${files.length}/${files.length} 个文件 · 上传完成`);localStorage.removeItem(key);setManifest(undefined);selected.current=[];completed()
  }catch(e){setStatus(navigator.onLine?(e instanceof Error?e.message:'上传失败'):'网络已中断，已保存分片会保留；恢复后自动继续')}
  finally{running.current=false;setBusy(false)}
 }
 // FileList omits empty directories. Prefer directory handles when supported.
 async function chooseDirectory(pick:()=>Promise<DirectoryHandle>) {
  try {
   const root=await pick(),files:File[]=[],directories:string[]=[]
   async function walk(dir:DirectoryHandle,prefix:string):Promise<void>{
    for await(const entry of dir.values()){
     const relative=prefix+entry.name
     if(entry.kind==='directory'){directories.push(relative);await walk(entry,relative+'/')}
     else {const file=await entry.getFile();Object.defineProperty(file,'webkitRelativePath',{value:root.name+'/'+relative});files.push(file)}
    }
   }
   await walk(root,'');await upload(files.sort((a,b)=>a.webkitRelativePath.localeCompare(b.webkitRelativePath)),directories,root.name)
  }catch(error){if(!(error instanceof DOMException&&error.name==='AbortError'))setStatus(error instanceof Error?error.message:'无法读取文件夹')}
 }
 async function drop(items:DataTransferItemList) {
  const files:File[]=[];const directories:string[]=[];let root:string|undefined
  async function walk(entry:FileSystemEntry,prefix=''):Promise<void> {
   const name=prefix+entry.name
   if(entry.isFile){const f=await new Promise<File>((resolve,reject)=>(entry as FileSystemFileEntry).file(resolve,reject));Object.defineProperty(f,'webkitRelativePath',{value:name});files.push(f)}
   else {if(!prefix)root=entry.name;else directories.push(name.split('/').slice(1).join('/'));const reader=(entry as FileSystemDirectoryEntry).createReader();for(;;){const entries=await new Promise<FileSystemEntry[]>((resolve,reject)=>reader.readEntries(resolve,reject));if(!entries.length)break;for(const child of entries)await walk(child,name+'/')}}
  }
  for(const item of Array.from(items)){const entry=item.webkitGetAsEntry();if(entry?.isDirectory)await walk(entry)}
  if(root)void upload(files.sort((a,b)=>a.webkitRelativePath.localeCompare(b.webkitRelativePath)),directories,root)
 }
 return <div><div onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void drop(e.dataTransfer.items)}}><label onClick={event=>{const pick=(window as Window&{showDirectoryPicker?:()=>Promise<DirectoryHandle>}).showDirectoryPicker;if(pick&&!busy){event.preventDefault();void chooseDirectory(()=>pick.call(window))}}}>{manifest?'重新选择文件夹':'选择文件夹'}<input type="file" multiple {...{webkitdirectory:''}} disabled={busy} onChange={e=>{void upload(Array.from(e.target.files??[]).sort((a,b)=>a.webkitRelativePath.localeCompare(b.webkitRelativePath)));e.target.value=''}}/></label>{(manifest||status)&&<p role="status" aria-label="文件夹上传进度">{manifest?.name} · {status||'重新选择文件夹'}</p>}</div></div>
}
