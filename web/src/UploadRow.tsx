import { useState } from 'react'
import { api } from './api/client'
import { systemClock, type Clock } from './clock'

type Row = { name: string; bytes: number; total: number; speed: number; status: string }
function putPart(url: string, bytes: Blob, progress: (loaded: number) => void) {
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
export function UploadRow({ parentId, completed, clock = systemClock }: { parentId: number; completed: () => void; clock?: Clock }) {
  const [row, setRow] = useState<Row>()
  const [busy, setBusy] = useState(false)
  async function upload(file: File) {
    setBusy(true)
    const start = clock.now()
    let sent = 0
    setRow({ name: file.name, total: file.size, bytes: 0, speed: 0, status: '验证中' })
    try {
      const init = await api.POST('/uploads', { body: { parentId, name: file.name, size: file.size } })
      if (!init.data) throw new Error(init.error?.message ?? '上传被拒绝')
      const session = init.data
      for (let n = 1; n <= session.partCount; n++) {
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
      if (!finish.data) throw new Error(finish.error?.message ?? '发布失败')
      setRow({ name: file.name, total: file.size, bytes: file.size, speed: file.size / Math.max((clock.now() - start) / 1000, 0.001), status: '上传完成' })
      completed()
    } catch (error) {
      setRow(previous => previous && ({ ...previous, status: error instanceof Error ? error.message : '上传失败' }))
    } finally { setBusy(false) }
  }
  return <>
    <label>上传文件<input type="file" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = '' }} /></label>
    {row && <div role="status" aria-label="上传进度" className="upload-row">
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
