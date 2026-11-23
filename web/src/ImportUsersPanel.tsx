import { Check, Copy, Download, FileSpreadsheet } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from './api/client'
import { systemClock } from './clock'

export interface ImportOrganizationOption {
  id: number
  path: string
}

const CSV_HEADER = 'username,display_name,password,organization_id\n'

export function ImportUsersPanel({ onImported, organizations = [] }: {
  onImported: () => Promise<void>
  organizations?: ImportOrganizationOption[]
}) {
  const [file, setFile] = useState<File>()
  const [busy, setBusy] = useState(false)
  const [succeeded, setSucceeded] = useState(false)
  const [message, setMessage] = useState('')
  const [errors, setErrors] = useState<{ row: number; message: string }[]>([])
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const cancelTimer = useRef<(() => void) | null>(null)

  useEffect(() => () => { cancelTimer.current?.() }, [])

  function downloadTemplate() {
    const blob = new Blob([CSV_HEADER], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'users-import-template.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  function copyOrgId(id: number) {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(String(id)).then(() => {
      cancelTimer.current?.()
      setCopiedId(id)
      cancelTimer.current = systemClock.after(1500, () => {
        setCopiedId(null)
        cancelTimer.current = null
      })
    }).catch(() => {})
  }

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

  const exampleOrgId = organizations[0]?.id ?? 1

  return <section className="panel import-users-panel" aria-label="批量导入用户">
    <div className="section-heading"><FileSpreadsheet size={18} aria-hidden="true" /><h3>批量导入用户</h3></div>
    <form className="panel-form membership-dialog-form" onSubmit={event => void submit(event)}>
      <label className="file-field">用户 CSV 文件
        <input type="file" aria-label="用户 CSV 文件" className="visually-hidden" accept=".csv,text/csv" disabled={busy} onChange={event => {
          setFile(event.target.files?.[0]); setErrors([]); setMessage('')
        }} />
        <span className="file-field-control">
          <span className="button">选择 CSV</span>
          <span className="ellipsis">{file?.name ?? '未选择文件'}</span>
        </span>
        <small>UTF-8 编码 · 单次最多 1000 位用户，不超过 2 MiB</small>
      </label>

      <div className="import-helper-row">
        <button type="button" className="ghost import-template-btn" onClick={downloadTemplate}>
          <Download size={15} aria-hidden="true" />下载 CSV 模板
        </button>
      </div>

      <details className="field-help">
        <summary>查看 CSV 格式与示例</summary>
        <p><code>username,display_name,password,organization_id</code></p>
        <p className="import-example"><code>zhangsan,张三,ChangeMe123!,{exampleOrgId}</code></p>
        <p>全部行校验通过后一次性创建并直接激活账户；任一行失败将回滚且不创建任何用户。</p>
      </details>

      {organizations.length > 0 && (
        <details className="field-help import-org-reference">
          <summary>组织编号速查（{organizations.length} 个组织）</summary>
          <ul className="import-org-list">
            {organizations.map(org => {
              const copied = copiedId === org.id
              return <li key={org.id}>
                <span className="ellipsis" title={org.path}>{org.path}</span>
                <span className="import-org-id-group">
                  <code>{org.id}</code>
                  <button type="button" className="ghost membership-copy-id"
                    aria-label={'复制组织编号 ' + org.id}
                    title={copied ? '已复制编号' : '复制组织编号'}
                    onClick={() => copyOrgId(org.id)}>
                    {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                  </button>
                </span>
              </li>
            })}
          </ul>
        </details>
      )}

      <div className="membership-dialog-actions">
        <button className="primary" disabled={busy || !file}>{busy ? '正在导入…' : '导入用户'}</button>
      </div>
    </form>
    {message && <p className={`banner ${succeeded ? 'success' : 'error'}`} role="status">{message}</p>}
    {errors.length > 0 && <ul className="record-list import-errors" role="alert">{errors.map((error, index) =>
      <li key={index}><strong>第 {error.row} 行</strong><span>{error.message}</span></li>)}</ul>}
  </section>
}
