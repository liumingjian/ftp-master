import { useEffect, useState } from 'react'
import { ArchiveRestore, RefreshCw } from 'lucide-react'
import { api } from './api/client'
import type { operations } from './api/schema.gen'
import { DirectoryPicker } from './DirectoryPicker'
import { AppIcon } from './icons/AppIcon'
import { PageHeading } from './PageHeading'

type Entry = operations['listRecycleBin']['responses'][200]['content']['application/json'][number]

export function RecycleBin({ administrator, changed }: { administrator: boolean; changed: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number>()
  const [action, setAction] = useState<{ id: number; kind: 'restore' | 'purge' }>()
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function load(signal?: AbortSignal) {
    setLoading(true)
    setError('')
    try {
      const { data } = await api.GET('/recycle-bin', { signal })
      if (signal?.aborted) return
      if (data) setEntries(data)
      else setError('无法加载回收站')
    } catch {
      if (!signal?.aborted) setError('无法连接服务器')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [])

  async function process(id: number, kind: 'restore' | 'purge', parentId?: number) {
    if (busy !== undefined) return
    setBusy(id)
    setMessage('')
    setError('')
    try {
      const params = { path: { id } }
      const { response } = kind === 'restore'
        ? await api.POST('/tree/{id}/restore', { params, body: { parentId } })
        : await api.DELETE('/tree/{id}/purge', { params })
      if (response.ok) {
        setEntries(current => current.filter(entry => entry.id !== id))
        setAction(undefined)
        setMessage(kind === 'restore' ? '项目已恢复' : '项目已永久删除')
        changed()
      } else if (response.status === 409) {
        setError(administrator ? '恢复位置不可用或已存在同名项目，请选择其他目录' : '原位置不可用或已存在同名项目，请联系管理员')
      } else setError(`操作失败（HTTP ${response.status}）`)
    } catch {
      setError('无法连接服务器')
    } finally {
      setBusy(undefined)
    }
  }

  return <section className="workspace-page" aria-label="回收站">
    <PageHeading title="回收站"
      actions={<button disabled={loading || busy !== undefined} onClick={() => void load()}>
        <RefreshCw size={15} className={loading ? 'spin' : undefined} aria-hidden="true" />刷新列表
      </button>} />
    {error && <p className="banner error" role="alert">{error}</p>}
    {message && <p className="banner success" role="status">{message}</p>}
    <section className="panel" aria-labelledby="deleted-heading">
      <div className="section-heading"><h2 id="deleted-heading">已删除项目</h2>{!loading && <span className="pill">{entries.length} 项</span>}</div>
      {loading && <p className="panel-empty" role="status">正在加载回收站…</p>}
      {!loading && !error && !entries.length && <div className="panel-empty"><AppIcon name="empty-recycle" size={60} /><span>回收站为空</span></div>}
      <ul className="record-list recycle-list">{entries.map(entry => <li key={entry.id}>
        <div className="identity-row"><AppIcon name="file-deleted" size={28} /><span>
          <strong>{entry.originalPath.split('/').at(-1)}</strong>
          <small>{entry.originalPath}</small>
        </span><time dateTime={entry.deletedAt}>{new Date(entry.deletedAt).toLocaleString('zh-CN')}</time></div>
        {action?.id === entry.id && action.kind === 'restore'
          ? <DirectoryPicker label="选择恢复位置" submitLabel="恢复到此目录" administrator={administrator} allowRoot={false} busy={busy !== undefined}
              choose={id => { if (id !== null) void process(entry.id, 'restore', id) }}
              close={() => setAction(undefined)} />
          : <div className="form-actions">
            {action?.id === entry.id && action.kind === 'purge' ? <>
              <span>永久删除后无法恢复。</span>
              <button className="danger" disabled={busy !== undefined} onClick={() => void process(entry.id, 'purge')}>确认永久删除</button>
              <button disabled={busy !== undefined} onClick={() => setAction(undefined)}>取消</button>
            </> : <>
              <button disabled={busy !== undefined} onClick={() => void process(entry.id, 'restore')}><ArchiveRestore size={15} />恢复原位置</button>
              {administrator && <>
                <button className="ghost" disabled={busy !== undefined} onClick={() => setAction({ id: entry.id, kind: 'restore' })}>恢复到指定目录</button>
                <button className="danger ghost" disabled={busy !== undefined} onClick={() => setAction({ id: entry.id, kind: 'purge' })}>永久删除</button>
              </>}
            </>}
          </div>}
      </li>)}</ul>
    </section>
  </section>
}
