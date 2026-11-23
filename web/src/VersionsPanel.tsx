import { useEffect, useState } from 'react'
import { ArrowLeft, Download, RotateCcw } from 'lucide-react'
import { api } from './api/client'
import type { components } from './api/schema.gen'
import { formatSize } from './FileIcon'

type Node = components['schemas']['TreeNode']
type Version = components['schemas']['FileVersion']

const versionTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function VersionsPanel({ node, close, restored, embedded = false }: {
  node: Node
  close: () => void
  restored: () => void
  embedded?: boolean
}) {
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
    setError('')
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
        setMessage(`已将版本 #${versionId} 恢复为新版本 #${data.versionId}`)
        setRevision(v => v + 1)
        restored()
      } else setError(response.status === 403 ? '当前账户无权恢复此版本' : '无法恢复版本，请重试')
    } catch {
      setError('无法连接服务器')
    } finally {
      setRestoring(undefined)
    }
  }

  return <section aria-label="文件版本" className={embedded ? 'versions versions-embedded' : 'versions'}>
    {!embedded && <div className="section-heading"><h3>版本历史</h3>
      <button className="ghost" disabled={restoring !== undefined} onClick={close}><ArrowLeft size={16} />返回文件详情</button>
    </div>}
    {error && <p className="banner error" role="alert">{error}{!restoreTarget && <button className="ghost" onClick={() => {
      setError('')
      setRevision(v => v + 1)
    }}>重试</button>}</p>}
    {message && <p className="banner success" role="status">{message}</p>}
    {loading && !versions.length && <p className="muted inspector-status" role="status">正在加载…</p>}
    {!loading && !error && !versions.length && <p className="muted inspector-status">暂无版本记录</p>}
    <ol className="record-list versions-list">{versions.map((version, index) => <li key={version.id} data-current={index === 0 || undefined}>
      <div className="version-row">
        <div className="version-info">
          <div className="version-title">
            <strong>版本 #{version.id}</strong>
            {index === 0 && <span className="pill positive">当前版本</span>}
          </div>
          <small className="muted version-meta">
            <time dateTime={version.createdAt}>{versionTimeFormat.format(new Date(version.createdAt))}</time>
            {' · '}{version.username}{' · '}{formatSize(version.size)}
          </small>
        </div>
        <div className="version-actions">
          {!!(node.rights & 2) && <a className="button ghost" href={`/api/tree/${node.id}/download?versionId=${version.id}`}
            download title={`下载版本 #${version.id}`} aria-label={`下载版本 #${version.id}`}>
            <Download size={16} aria-hidden="true" />下载
          </a>}
          {!!(node.rights & 8) && index !== 0 && restoreTarget?.id !== version.id && <button type="button" className="ghost"
            disabled={restoring !== undefined} onClick={() => { setError(''); setRestoreTarget(version) }}>
            <RotateCcw size={16} aria-hidden="true" />恢复
          </button>}
        </div>
      </div>
      {restoreTarget?.id === version.id && <div className="version-restore">
        <p>将版本 #{version.id} 保存为新版本，现有版本记录会保留。</p>
        <div className="form-actions version-restore-actions">
          <button type="button" className="ghost" disabled={restoring !== undefined} onClick={() => { setError(''); setRestoreTarget(undefined) }}>取消</button>
          <button type="button" className="primary" disabled={restoring !== undefined} onClick={() => void restore(version.id)}>
            {restoring === version.id ? '正在恢复…' : '确认恢复'}
          </button>
        </div>
      </div>}
    </li>)}</ol>
  </section>
}
