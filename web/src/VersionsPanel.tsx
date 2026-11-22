import { useEffect, useState } from 'react'
import { ArrowLeft, Download } from 'lucide-react'
import { api } from './api/client'
import type { components } from './api/schema.gen'
import { formatSize } from './FileIcon'

type Node = components['schemas']['TreeNode']

type Version = components['schemas']['FileVersion']

export function VersionsPanel({ node, close, restored }: { node: Node; close: () => void; restored: () => void }) {
  const [versions, setVersions] = useState<Version[]>([])
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<number>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [restoreTarget, setRestoreTarget] = useState<Version>()

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
      const { data, response } = await api.POST('/tree/{id}/versions/{versionId}/restore', { params: { path: { id: node.id, versionId } } })
      if (data) {
        setRestoreTarget(undefined)
        setMessage(`已将版本 ${versionId} 恢复为新版本 ${data.versionId}`)
        setRevision(v => v + 1)
        restored()
      } else setError(response.status === 403 ? '当前账户无权恢复此版本' : '无法恢复版本，请重试')
    } catch {
      setError('无法连接服务器')
    } finally {
      setRestoring(undefined)
    }
  }

  return <section aria-label="文件版本" className="versions">
    <div className="section-heading"><h3>版本历史</h3>
      <button className="ghost" disabled={restoring !== undefined} onClick={close}><ArrowLeft size={16} />返回文件详情</button>
    </div>
    {error && <p className="banner error" role="alert">{error}{!restoreTarget && <button className="ghost" onClick={() => {
      setError('')
      setRevision(v => v + 1)
    }}>重试</button>}</p>}
    {message && <p className="banner success" role="status">{message}</p>}
    {loading && !versions.length && <p className="muted" role="status">正在加载…</p>}
    {!loading && !error && !versions.length && <p className="muted">暂无版本记录</p>}
    <ol className="record-list versions-list">{versions.map((version, index) => <li key={version.id}>
      <div className="version-title"><strong>版本 {version.id} · {version.username}</strong>{index === 0 && <span className="version-current">当前版本</span>}</div>
      <small className="muted"><time dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleString('zh-CN', { hour12: false })}</time> · {formatSize(version.size)}</small>
      <div className="form-actions">
        {!!(node.rights & 2) && <a className="button" href={`/api/tree/${node.id}/download?versionId=${version.id}`} download><Download size={14} />下载此版本</a>}
        {!!(node.rights & 8) && index !== 0 && restoreTarget?.id !== version.id && <button className="ghost" disabled={restoring !== undefined}
          onClick={() => { setError(''); setRestoreTarget(version) }}>
          恢复此版本
        </button>}
      </div>
      {restoreTarget?.id === version.id && <div className="version-restore">
        <p>将版本 {version.id} 的内容保存为新版本。现有版本记录会保留。</p>
        <div className="form-actions">
          <button className="primary" disabled={restoring !== undefined} onClick={() => void restore(version.id)}>
            {restoring === version.id ? '正在恢复…' : '恢复为新版本'}
          </button>
          <button className="ghost" disabled={restoring !== undefined} onClick={() => { setError(''); setRestoreTarget(undefined) }}>取消</button>
        </div>
      </div>}
    </li>)}</ol>
  </section>
}
