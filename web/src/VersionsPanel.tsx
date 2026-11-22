import { useEffect, useState } from 'react'
import { ArrowLeft, Download, History } from 'lucide-react'
import { api } from './api/client'
import type { components } from './api/schema.gen'
import { formatSize } from './FileIcon'

type Node = components['schemas']['TreeNode']

export function VersionsPanel({ node, close }: { node: Node; close: () => void }) {
  const [versions, setVersions] = useState<components['schemas']['FileVersion'][]>([])
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<number>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void api.GET('/tree/{id}/versions', { params: { path: { id: node.id } }, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        if (data) setVersions(data)
        else setError('无法读取文件版本')
      }).catch(() => {
        if (!controller.signal.aborted) setError('无法连接服务器')
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [node.id, revision])

  async function restore(versionId: number) {
    if (restoring !== undefined) return
    setRestoring(versionId)
    setMessage('')
    setError('')
    try {
      const { response } = await api.POST('/tree/{id}/versions/{versionId}/restore', { params: { path: { id: node.id, versionId } } })
      if (response.ok) { setMessage('已恢复为新版本'); setRevision(v => v + 1) }
      else setError(`无法恢复版本（HTTP ${response.status}）`)
    } catch {
      setError('无法连接服务器')
    } finally {
      setRestoring(undefined)
    }
  }

  return <section aria-label="文件版本" className="versions">
    <div className="section-heading"><History size={18} /><h3>文件版本</h3>
      <button className="ghost" disabled={restoring !== undefined} onClick={close}><ArrowLeft size={14} />返回目录</button>
    </div>
    {error && <p className="banner error" role="alert">{error}</p>}
    {message && <p className="banner success" role="status">{message}</p>}
    {loading && !versions.length && <p className="muted" role="status">正在加载…</p>}
    {!loading && !error && !versions.length && <p className="muted">暂无版本记录</p>}
    <ol className="record-list versions-list">{versions.map((version, index) => <li key={version.id}>
      <div className="version-title"><strong>版本 {version.id} · {version.username}</strong>{index === 0 && <span className="pill">当前版本</span>}</div>
      <small className="muted"><time dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleString('zh-CN')}</time> · {formatSize(version.size)}</small>
      <div className="form-actions">
        {!!(node.rights & 2) && <a className="button" href={`/api/tree/${node.id}/download?versionId=${version.id}`} download><Download size={14} />下载此版本</a>}
        {!!(node.rights & 8) && <button disabled={restoring !== undefined} onClick={() => void restore(version.id)}>
          {restoring === version.id ? '正在恢复…' : '恢复为新版本'}
        </button>}
      </div>
    </li>)}</ol>
  </section>
}
