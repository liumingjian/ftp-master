import { useEffect, useRef, useState } from 'react'
import { api } from './api/client'
import { systemClock, type Clock } from './clock'

type Session = { id: string; partCount: number; partSize: number; name: string; size: number }
type Row = { name: string; bytes: number; total: number; speed: number; status: string; complete?: true }
export const UPLOAD_COMPLETE_MESSAGE_MS = 3000
export type FileUploadState = 'idle' | 'uploading' | 'resume' | 'conflict'
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
export function UploadRow({ parentId, visible, dropZone, completed, clock = systemClock, onTaskChange, onActivityChange, onStatusChange }: { onTaskChange?: (label: string) => void; onActivityChange?: (state: FileUploadState) => void; onStatusChange?: (visible: boolean) => void; parentId: number; visible: boolean; dropZone?: HTMLElement | null; completed: () => void; clock?: Clock }) {
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
  useEffect(() => {
    if (!row?.complete) return
    return clock.after(UPLOAD_COMPLETE_MESSAGE_MS, () => {
      setRow(current => current === row ? undefined : current)
    })
  }, [clock, row])
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<string>()
  useEffect(() => {
    if (!busy) return
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [busy])
  const taskCallback = useRef(onTaskChange)
  taskCallback.current = onTaskChange
  const taskLabel = row ? `${row.name} · ${row.status}` : savedSession?.name ?? ''
  useEffect(() => { taskCallback.current?.(taskLabel) }, [taskLabel])
 const activityCallback = useRef(onActivityChange); activityCallback.current=onActivityChange
 const state = busy ? 'uploading' : conflict ? 'conflict' : savedSession ? 'resume' : 'idle'
 useEffect(() => { activityCallback.current?.(state) }, [state])
  const statusCallback = useRef(onStatusChange)
  statusCallback.current = onStatusChange
  const hasStatus = offline || !!row || (!!savedSession && !busy && !conflict)
  useEffect(() => { statusCallback.current?.(hasStatus) }, [hasStatus])
  useEffect(() => {
    if (!dropZone) return
    const dragover = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      const items = Array.from(event.dataTransfer?.items ?? [])
      if (items.length !== 1 || items[0]?.webkitGetAsEntry()?.isDirectory) return
      const file = items[0]?.getAsFile()
      if (!file) return
      event.preventDefault()
      if (!running.current && !busy && !conflict) void upload(file)
    }
    dropZone.addEventListener('dragover', dragover)
    dropZone.addEventListener('drop', drop)
    return () => {
      dropZone.removeEventListener('dragover', dragover)
      dropZone.removeEventListener('drop', drop)
    }
  })
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
      setRow({
        name: file.name, total: file.size, bytes: file.size,
        speed: file.size / Math.max((clock.now() - start) / 1000, 0.001),
        status: '上传完成', complete: true,
      })
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
      setRow(previous => previous && ({ ...previous, status: '上传完成', complete: true }))
      completed()
    } catch (error) { setRow(previous => previous && ({ ...previous, status: error instanceof Error ? error.message : '上传失败' })) }
    finally { setBusy(false) }
  }
  return <>
    {offline && <p role="alert">网络已中断，已保存的分片会保留；网络恢复后自动继续上传。</p>}
    {visible && state === 'resume' && <div className="upload-resume">
      <span>{savedSession?.name}<small>重新选择原文件以继续上传</small></span>
      <label className="button">重新选择文件<input id={`resume-file-${parentId}`} className="visually-hidden" type="file" onChange={event => {
        const file = event.target.files?.[0]
        if (file) void upload(file)
        event.target.value = ''
      }} /></label>
    </div>}
    {visible && <label className="visually-hidden">上传文件<input id={`upload-file-${parentId}`} type="file" disabled={busy || !!conflict || !!savedSession} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = '' }} /></label>}
    {row && <div role="status" aria-label="上传进度" className="upload-row">
      {conflict && <><span>存为新版本会更新原文件；保留两者会另存为独立文件。</span><button disabled={busy} onClick={() => void resolve('new_version')}>存为新版本</button><button disabled={busy} onClick={() => void resolve('keep_both')}>保留两者</button></>}
      {!busy && !row.complete && !conflict && fileRef.current && <button onClick={() => void upload(fileRef.current!)}>重试上传</button>}
      <span className="transfer-name">{row.name} · {row.status}</span>
      {row.status === '上传中' && busy && <>
      <progress aria-label="文件上传进度" value={row.bytes} max={row.total || 1} />
      <span>{Math.round(row.bytes / (row.total || 1) * 100)}% · {(row.speed / 1024 / 1024).toFixed(1)} MB/s · 剩余 {row.speed > 0 ? Math.ceil((row.total - row.bytes) / row.speed) : '—'} 秒</span></>}
    </div>}
  </>
}
