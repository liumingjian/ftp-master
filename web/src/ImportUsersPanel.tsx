import { useState, type FormEvent } from 'react'
import { api } from './api/client'

export function ImportUsersPanel({ onImported }: { onImported: () => Promise<void> }) {
  const [file, setFile] = useState<File>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [errors, setErrors] = useState<{ row: number; message: string }[]>([])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!file || busy) return
    setErrors([]); setMessage(''); setBusy(true)
    try {
      if (file.size > 2 * 1024 * 1024) { setMessage('文件不能超过 2 MiB'); return }
      const csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      const result = await api.POST('/users/import', { body: { csv } })
      if (result.data) { setMessage(`成功导入 ${result.data.created} 位用户`); await onImported() }
      else if (result.error && 'errors' in result.error) { setErrors(result.error.errors); setMessage('导入失败，未创建任何用户，请修正后重试') }
      else setMessage('导入失败，请重试')
    } catch { setMessage('无法导入：请检查 UTF-8 编码和网络连接') }
    finally { setBusy(false) }
  }
  return <section aria-label="批量导入用户">
    <h3>批量导入用户</h3>
    <p>上传 UTF-8 CSV（最多 1000 位用户，2 MiB）。首行：username,display_name,password,organization_id。组织编号见下方列表。所有行验证通过后才创建已激活用户。</p>
    <form onSubmit={e => void submit(e)}>
      <label>用户 CSV 文件<input type="file" accept=".csv,text/csv" required disabled={busy} onChange={e => setFile(e.target.files?.[0])} /></label>
      <button disabled={busy || !file}>{busy ? '正在导入…' : '导入用户'}</button>
    </form>
    {message && <p role="status">{message}</p>}
    {errors.length > 0 && <ul role="alert">{errors.map((error, i) => <li key={i}>第 {error.row} 行：{error.message}</li>)}</ul>}
  </section>
}
