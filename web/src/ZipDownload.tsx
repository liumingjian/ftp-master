import { useState } from 'react'
import { Download } from 'lucide-react'
import { api } from './api/client'

export function ZipDownload({ selected }: { selected: number[] }) {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [started, setStarted] = useState(false)
  async function download() {
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
      const link = document.createElement('a')
      link.href = `/api/tree/zip?ids=${ids}`
      link.download = 'download.zip'
      link.click()
      setStarted(true)
    } catch {
      setError('无法连接服务，请重试。')
    } finally {
      setChecking(false)
    }
  }
  return <section aria-label="打包下载">
    <button className="primary" disabled={checking} onClick={() => void download()}>
      <Download size={16} />{checking ? '正在检查…' : '打包下载所选项目'}
    </button>
    {error && <p className="bad" role="alert">{error}</p>}
    {started && <p className="muted" role="status">已交给浏览器下载</p>}
  </section>
}
