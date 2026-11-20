import { useEffect, useRef, useState } from 'react'
import { api } from './api/client'
import { systemClock, type Clock } from './clock'

type Session = { id: string; partCount: number; partSize: number; name: string; size: number }
type Row = { name: string; bytes: number; total: number; speed: number; status: string }
export function putPart(url: string, bytes: Blob, progress: (loaded: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.withCredentials = false
    xhr.upload.onprogress = event => progress(event.loaded)
    xhr.onload = () => xhr.status === 200 ? resolve() : reject(new Error(`存储服务 HTTP ${xhr.status}`))
    xhr.onerror = () => reject(new Error('网络中断，请重试'))
    xhr.send(bytes)
  })
}
export function UploadRow({ parentId, completed, clock = systemClock, onActivityChange }: { onActivityChange?: (active: boolean) => void; parentId: number; completed: () => void; clock?: Clock }) {
  const key = `ftp-upload:${parentId}`
  const [savedSession, setSession] = useState<Session | undefined>(() => { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined } catch { return undefined } })
  const fileRef = useRef<File>(undefined)
  const running = useRef(false)
  const [offline, setOffline] = useState(!navigator.onLine)
  useEffect(() => {
    const off = () => setOffline(true)
    const on = () => { setOffline(false); if (fileRef.current && !running.current) void upload(fileRef.current) }
    window.addEventListener('offline', off); window.addEventListener('online', on)
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on) }
  })
  const [row, setRow] = useState<Row>()
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<string>()
  useEffect(() => {
    if (!busy) return
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [busy])
 const activityCallback = useRef(onActivityChange); activityCallback.current=onActivityChange
 const active= busy || !!savedSession || !!conflict
 useEffect(()=>{activityCallback.current?.(active)},[active])
  function clear() { localStorage.removeItem(key); setSession(undefined); fileRef.current = undefined }
  async function upload(file: File) {
    if (savedSession && (savedSession.name !== file.name || savedSession.size !== file.size)) {
      setRow({ name: savedSession.name, total: savedSession.size, bytes: 0, speed: 0, status: '文件名称或大小不匹配，请重新选择原文件' }); return
    }
    fileRef.current = file
    running.current = true
    setBusy(true)
    const start = clock.now()
    let sent = 0
    setRow({ name: file.name, total: file.size, bytes: 0, speed: 0, status: '验证中' })
    try {
      let active: Session | undefined = savedSession
      if (!active) {
        const init = await api.POST('/uploads', { body: { parentId, name: file.name, size: file.size } })
        if (!init.data) throw new Error(init.error?.message ?? '上传被拒绝')
        active = { ...init.data, name: file.name, size: file.size }
        localStorage.setItem(key, JSON.stringify(active)); setSession(active)
      }
      const stored = await api.GET('/uploads/{id}/parts', { params: { path: { id: active.id } } })
      if (!stored.data) throw new Error(stored.error?.message ?? '无法读取已保存分片')
      const saved = new Set(stored.data.map(part => part.number))
      const session = active
      for (let n = 1; n <= session.partCount; n++) {
        if (saved.has(n)) { sent += file.slice((n-1)*session.partSize,n*session.partSize).size; continue }
        const signed = await api.POST('/uploads/{id}/parts', { params: { path: { id: session.id } }, body: { numbers: [n] } })
        if (!signed.data) throw new Error(signed.error?.message ?? '无法获取上传地址')
        const part = file.slice((n - 1) * session.partSize, n * session.partSize)
        await putPart(signed.data[0]!.url, part, loaded => {
          const bytes = sent + loaded
          setRow({ name: file.name, total: file.size, bytes, speed: bytes / Math.max((clock.now() - start) / 1000, 0.001), status: '上传中' })
        })
        sent += part.size
      }
      const finish = await api.POST('/uploads/{id}/complete', { params: { path: { id: session.id } } })
      if (!finish.data) {
        if (finish.error?.message === 'upload_name_conflict') { setConflict(session.id); setRow(previous => previous && ({ ...previous, status: '同名文件已存在' })); return }
        throw new Error(finish.error?.message ?? '发布失败')
      }
      setRow({ name: file.name, total: file.size, bytes: file.size, speed: file.size / Math.max((clock.now() - start) / 1000, 0.001), status: '上传完成' })
      clear()
      completed()
    } catch (error) {
      setRow(previous => previous && ({ ...previous, status: error instanceof Error ? error.message : '上传失败' }))
    } finally { running.current = false; setBusy(false) }
  }
  async function resolve(collision: 'new_version' | 'keep_both') {
    if (!conflict) return
    setBusy(true)
    try {
      const finish = await api.POST('/uploads/{id}/complete', { params: { path: { id: conflict }, query: { collision } } })
      if (!finish.data) throw new Error(finish.error?.message ?? '发布失败')
      clear()
      setConflict(undefined)
      setRow(previous => previous && ({ ...previous, status: '上传完成' }))
      completed()
    } catch (error) { setRow(previous => previous && ({ ...previous, status: error instanceof Error ? error.message : '上传失败' })) }
    finally { setBusy(false) }
  }
  return <>
    {offline && <p role="alert">网络已中断，已保存的分片会保留；网络恢复后自动继续上传。</p>}
    {savedSession && !busy && !conflict && <label>重新选择文件<input type="file" onChange={event => { const file = event.target.files?.[0]; if(file) void upload(file); event.target.value='' }} /></label>}
    <label>上传文件<input type="file" disabled={busy || !!conflict || !!savedSession} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = '' }} /></label>
    {row && <div role="status" aria-label="上传进度" className="upload-row">
      {conflict && <><button disabled={busy} onClick={() => void resolve('new_version')}>存为新版本</button><button disabled={busy} onClick={() => void resolve('keep_both')}>保留两者</button></>}
      <span>{row.name} · {row.status}</span>
      <progress aria-label="文件上传进度" value={row.bytes} max={row.total || 1} />
      <span>{Math.round(row.bytes / (row.total || 1) * 100)}% · {(row.speed / 1024 / 1024).toFixed(1)} MB/s · 剩余 {row.speed > 0 ? Math.ceil((row.total - row.bytes) / row.speed) : '—'} 秒</span>
    </div>}
  </>
}

export function UploadPolicyEditor() {
  const [message, setMessage] = useState('')
  const [extensions, setExtensions] = useState('')
  async function load() { const {data} = await api.GET('/upload-policy'); if(data) setExtensions(data.blockedExtensions.join(', ')) }
  async function save() {
    const { response, error } = await api.PUT('/upload-policy', { body: { blockedExtensions: extensions.split(',').map(value => value.trim()).filter(Boolean) } })
    setMessage(response.ok ? '上传限制已保存' : error?.message ?? '保存失败')
  }
  return <details onToggle={event => {if(event.currentTarget.open) void load()}}><summary>上传扩展名限制</summary><label>禁止扩展名（逗号分隔）<input value={extensions} onChange={event => setExtensions(event.target.value)} /></label><button onClick={() => void save()}>保存上传限制</button><p role="status">{message}</p></details>
}
