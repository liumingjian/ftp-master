import { useEffect, useState } from 'react'
import { ChevronRight, FolderOpen } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { api } from './api/client'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']

export function DirectoryPicker({ label, submitLabel, administrator, excludeId, allowRoot = true, busy, choose, close }: {
  label: string
  submitLabel: string
  administrator: boolean
  excludeId?: number
  allowRoot?: boolean
  busy?: boolean
  choose: (id: number | null) => void
  close: () => void
}) {
  const [directories, setDirectories] = useState<Node[]>([])
  const [path, setPath] = useState<Node[]>([])
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const parent = path.at(-1)
  const visible = directories.filter(entry => !entry.isFile && entry.id !== excludeId)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    void api.GET('/tree', { params: { query: { parentId: parent?.id } }, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        setDirectories(data ?? [])
        setStatus(data ? 'ready' : 'error')
      }).catch(() => { if (!controller.signal.aborted) setStatus('error') })
    return () => controller.abort()
  }, [parent?.id])

  return <section aria-label={label} className="directory-picker">
    <div className="section-heading"><FolderOpen size={18} /><h3>{label}</h3></div>
    <nav aria-label="目标路径" className="picker-path">
      <button className="ghost" disabled={busy} onClick={() => setPath([])}>根目录</button>
      {path.map((entry, index) => <span className="crumb" key={entry.id}><ChevronRight size={13} />
        <button className="ghost" disabled={busy} onClick={() => setPath(path.slice(0, index + 1))}>{entry.name}</button>
      </span>)}
    </nav>
    {status === 'loading' && <p role="status" className="muted">正在加载目录…</p>}
    {status === 'error' && <p role="alert">无法加载目录</p>}
    {status === 'ready' && (visible.length ? <ul className="record-list scroll-list">{visible.map(entry =>
      <li key={entry.id}><button type="button" className="record-link" disabled={busy} onClick={() => {
        setStatus('loading')
        setPath([...path, entry])
      }}><FileIcon node={entry} size={16} /><span>{entry.name}</span><ChevronRight size={14} /></button></li>
    )}</ul> : <p className="muted">没有子目录</p>)}
    <div className="form-actions">
      <button className="primary" disabled={busy || status !== 'ready' || (parent ? !(parent.rights & 4) : !administrator || !allowRoot)}
        onClick={() => choose(parent?.id ?? null)}>{submitLabel}</button>
      <button disabled={busy} onClick={close}>取消</button>
    </div>
  </section>
}
