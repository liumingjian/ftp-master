import { FileSpreadsheet } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from './api/client'

export function ImportUsersPanel({ onImported }: { onImported: () => Promise<void> }) {
  const [file, setFile] = useState<File>()
  const [busy, setBusy] = useState(false)
  const [succeeded, setSucceeded] = useState(false)
  const [message, setMessage] = useState('')
  const [errors, setErrors] = useState<{ row: number; message: string }[]>([])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file || busy) return
    const form = event.currentTarget
    setErrors([])
    setMessage('')
    setSucceeded(false)
    setBusy(true)
    try {
      if (file.size > 2 * 1024 * 1024) { setMessage('文件不能超过 2 MiB'); return }
      const csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      const result = await api.POST('/users/import', { body: { csv } })
      if (result.data) {
        setSucceeded(true)
        setMessage(`成功导入 ${result.data.created} 位用户`)
        setFile(undefined)
        form.reset()
        try { await onImported() } catch {
          setMessage(`成功导入 ${result.data.created} 位用户，列表刷新失败`)
        }
      }
      else if (result.error && 'errors' in result.error) { setErrors(result.error.errors); setMessage('导入失败，未创建任何用户，请修正后重试') }
      else setMessage('导入失败，请重试')
    } catch { setMessage('无法导入：请检查 UTF-8 编码和网络连接') }
    finally { setBusy(false) }
  }
  return <section className="panel" aria-label="批量导入用户">
    <div className="section-heading"><FileSpreadsheet size={18} /><h3>批量导入用户</h3></div>
    <form className="panel-form" onSubmit={event => void submit(event)}>
      <label className="file-field">用户 CSV 文件
        <input type="file" aria-label="用户 CSV 文件" className="visually-hidden" accept=".csv,text/csv" disabled={busy} onChange={event => {
          setFile(event.target.files?.[0]); setErrors([]); setMessage('')
        }} />
        <span className="file-field-control"><span className="button">选择 CSV</span><span className="ellipsis">{file?.name ?? '未选择文件'}</span></span>
        <small>UTF-8 · 最多 1000 位用户，2 MiB</small>
      </label>
      <details className="field-help"><summary>查看 CSV 格式</summary>
        <p><code>username,display_name,password,organization_id</code></p>
        <p>组织编号可在组织层级中查看。通过全部校验后，导入的账户将直接激活。</p>
      </details>
      <div className="form-actions"><button className="primary" disabled={busy || !file}>{busy ? '正在导入…' : '导入用户'}</button></div>
    </form>
    {message && <p className={`banner ${succeeded ? 'success' : 'error'}`} role="status">{message}</p>}
    {errors.length > 0 && <ul className="record-list import-errors" role="alert">{errors.map((error, index) =>
      <li key={index}><strong>第 {error.row} 行</strong><span>{error.message}</span></li>)}</ul>}
  </section>
}
