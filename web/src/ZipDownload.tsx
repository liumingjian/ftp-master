import { useState } from 'react'
import { Download } from 'lucide-react'
import { formatSize } from './FileIcon'
import { api } from './api/client'

export function ZipDownload({ selected }: { selected: number[] }) {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [started, setStarted] = useState(false)
  const [summary, setSummary] = useState('')
  async function check() {
    const ids = selected.join(',')
    setChecking(true)
    setError('')
    setStarted(false)
    try {
      const { response } = await api.GET('/tree/zip', { params: { query: { ids, preflight: true } } })
      if (!response.ok) {
        setError(response.status === 413 ? '所选可下载文件超过 10 GB，请减少选择后重试。'
          : response.status === 403 ? '所选项目没有可下载的文件。' : '无法打包下载，请重试。')
        return
      }
      const count = response.headers.get('X-File-Count')
      const bytes = response.headers.get('X-Total-Bytes')
      if (count === '0') setError('所选项目没有可下载的文件。')
      else if (count === null || bytes === null) setError('无法读取打包范围，请刷新后重试。')
      else setSummary(`可下载 ${count} 个文件，共 ${formatSize(Number(bytes))}`)
    } catch {
      setError('无法连接服务，请重试。')
    } finally {
      setChecking(false)
    }
  }
  return <section aria-label="打包下载">
    {summary ? <>
      <span>{summary}</span> <a className="button primary" download="download.zip" href={`/api/tree/zip?ids=${selected.join(',')}`} onClick={() => setStarted(true)}>下载 ZIP</a>
    </> : <button className="primary" disabled={checking} onClick={() => void check()}>
      <Download size={16} />{checking ? '正在检查…' : '打包下载所选项目'}
    </button>}
    {error && <p className="bad" role="alert">{error}</p>}
    {started && <p className="muted" role="status">已交给浏览器下载</p>}
  </section>
}
