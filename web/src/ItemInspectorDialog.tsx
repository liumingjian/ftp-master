import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Folder, ShieldCheck, X } from 'lucide-react'
import { api } from './api/client'
import { FileIcon, fileTypeLabel, formatSize } from './FileIcon'
import { rights } from './GrantsPanel'
import type { InspectorTab } from './ItemActionMenu'
import { VersionsPanel } from './VersionsPanel'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']
type Inspection = components['schemas']['PermissionInspection']

const BROWSE = 1
const UPLOAD = 4
const GRANT = 32

const fullTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const principalLabels = {
  user: '用户',
  organization: '组织',
  user_group: '用户组',
} as const

function fileFormatDetails(node: Node) {
  if (!node.isFile || !node.latestVersion) return undefined
  const dot = node.name.lastIndexOf('.')
  const ext = dot > 0 ? node.name.slice(dot + 1).toLowerCase() : ''
  const actual = node.latestVersion.format.toLowerCase()
  const mismatched = Boolean(ext && actual && ext !== actual)
  return {
    ext: ext.toUpperCase(),
    actual: actual.toUpperCase(),
    display: (actual || ext).toUpperCase() || '—',
    mismatched,
  }
}

function folderStateLabel(node: Node): string | undefined {
  if (node.isFile) return undefined
  if (!(node.rights & BROWSE) && (node.rights & UPLOAD)) return '投递箱'
  if (node.traversable && !node.rights) return '仅通行'
  return undefined
}

export function ItemInspectorDialog({
  node,
  initialTab,
  location,
  onClose,
  onRestored,
  onManageGrants,
}: {
  node: Node
  initialTab: InspectorTab
  location?: { label: string; href: string; open: () => void }
  onClose: () => void
  onRestored: () => void
  onManageGrants: (node: Node) => void
}) {
  const hasVersions = node.isFile && Boolean(node.rights & BROWSE)
  const canGrant = Boolean(node.rights & GRANT)
  const tabs: { id: InspectorTab; label: string }[] = hasVersions
    ? [{ id: 'overview', label: '概览' }, { id: 'versions', label: '版本历史' }, { id: 'permission', label: '我的权限' }]
    : [{ id: 'overview', label: '概览' }, { id: 'permission', label: '我的权限' }]

  const [tab, setTab] = useState<InspectorTab>(() => (initialTab === 'versions' && !hasVersions ? 'overview' : initialTab))
  const dialogRef = useRef<HTMLDialogElement>(null)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  useEffect(() => {
    setTab(initialTab === 'versions' && !hasVersions ? 'overview' : initialTab)
  }, [initialTab, hasVersions, node.id])

  function dismiss() {
    dialogRef.current?.close()
    onClose()
  }

  const grantedRightNames = rights.filter(([bit]) => node.rights & bit).map(([, label]) => label)
  const folderState = folderStateLabel(node)
  const formatDetails = fileFormatDetails(node)

  return <dialog ref={dialogRef} className="item-inspector" data-kind={node.isFile ? 'file' : 'folder'} aria-labelledby="item-inspector-title"
    onCancel={event => {
      if (event.target !== event.currentTarget) return
      event.preventDefault()
      dismiss()
    }}
    onClick={event => { if (event.target === event.currentTarget) dismiss() }}>
    <header className="inspector-header">
      <FileIcon node={node} size={18} tile />
      <h2 id="item-inspector-title" title={node.name}>{node.name}</h2>
      <button type="button" className="ghost icon dialog-close" title="关闭" aria-label="关闭详情" autoFocus onClick={dismiss}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>

    <div className="inspector-tabs" role="tablist" aria-label="项目详情视图"
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const index = tabs.findIndex(item => item.id === tab)
        const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
        if (next) {
          setTab(next.id)
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus()
        }
      }}>
      {tabs.map(item => (
        <button key={item.id} type="button" role="tab" data-tab={item.id}
          aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => setTab(item.id)}>
          {item.label}
        </button>
      ))}
    </div>

    <div className="inspector-body" role="tabpanel">
      {tab === 'overview' && <div className="inspector-overview">
        {node.isFile && node.latestVersion && <div className="inspector-summary" aria-label="文件概要">
          <div className="inspector-metric">
            <span className="inspector-metric-label">文件大小</span>
            <strong className="inspector-metric-value">{formatSize(node.latestVersion.size)}</strong>
          </div>
          <div className="inspector-metric">
            <span className="inspector-metric-label">当前版本</span>
            <strong className="inspector-metric-value">#{node.latestVersion.id}</strong>
          </div>
          <div className="inspector-metric">
            <span className="inspector-metric-label">文件格式</span>
            <strong className="inspector-metric-value">
              {formatDetails?.mismatched ? (
                <span className="inspector-format-mismatch" title={`扩展名为 .${formatDetails.ext.toLowerCase()}，实际内容格式为 ${formatDetails.actual}`}>
                  {formatDetails.actual}
                </span>
              ) : (formatDetails?.display ?? '—')}
            </strong>
          </div>
        </div>}

        <dl className="inspector-meta">
          <div className="inspector-meta-row">
            <dt>类型</dt>
            <dd className="inspector-type-value">
              <span>{fileTypeLabel(node)}</span>
              {formatDetails?.mismatched && (
                <span className="pill warning">实际格式 {formatDetails.actual}</span>
              )}
            </dd>
          </div>

          {folderState && <div className="inspector-meta-row">
            <dt>状态</dt>
            <dd><span className="pill">{folderState}</span></dd>
          </div>}

          {node.isFile && node.latestVersion?.createdAt && <div className="inspector-meta-row">
            <dt>修改时间</dt>
            <dd><time dateTime={node.latestVersion.createdAt}>{fullTimeFormat.format(new Date(node.latestVersion.createdAt))}</time></dd>
          </div>}

          {node.isFile && node.latestVersion?.username && <div className="inspector-meta-row">
            <dt>修改人</dt>
            <dd>{node.latestVersion.username}</dd>
          </div>}

          {location && <div className="inspector-meta-row">
            <dt>所在目录</dt>
            <dd>
              <a className="inspector-location-link" href={location.href} onClick={event => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                event.preventDefault()
                dismiss()
                location.open()
              }}>
                <Folder size={16} aria-hidden="true" /><span>{location.label}</span>
              </a>
            </dd>
          </div>}

          <div className="inspector-meta-row inspector-meta-rights">
            <dt>我的权限</dt>
            <dd>
              <div className="chip-list">
                {grantedRightNames.length
                  ? grantedRightNames.map(label => <span key={label} className="pill inspector-right-chip">{label}</span>)
                  : <span className="pill neutral">{node.traversable ? '仅通行' : '无权限'}</span>}
              </div>
            </dd>
          </div>
        </dl>
      </div>}

      {tab === 'versions' && hasVersions && (
        <VersionsPanel node={node} embedded restored={onRestored} close={dismiss} />
      )}

      {tab === 'permission' && (
        <MyPermissionView node={node} />
      )}
    </div>

    {tab === 'permission' && canGrant && <footer className="inspector-dialog-footer">
      <button type="button" onClick={() => {
        dismiss()
        onManageGrants(node)
      }}>
        <ShieldCheck size={16} aria-hidden="true" />管理权限
      </button>
    </footer>}
  </dialog>
}

function MyPermissionView({ node }: { node: Node }) {
  const [inspection, setInspection] = useState<Inspection>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void api.GET('/tree/{id}/permission', { params: { path: { id: node.id } }, signal: controller.signal })
      .then(({ data, response }) => {
        if (controller.signal.aborted) return
        if (data) setInspection(data)
        else setError(`无法读取权限信息（HTTP ${response.status}）`)
      })
      .catch(() => { if (!controller.signal.aborted) setError('无法连接服务器') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [node.id, attempt])

  if (loading && !inspection) return <p className="muted inspector-status" role="status">正在加载…</p>
  if (error) return <p className="banner error" role="alert">
    {error}<button type="button" className="ghost" onClick={() => setAttempt(v => v + 1)}>重试</button>
  </p>
  if (!inspection) return null

  const granted = rights.filter(([bit]) => inspection.rights & bit)

  return <div className="my-permission">
    <section className="permission-section" aria-label="有效权限">
      <h3>有效权限</h3>
      <div className="chip-list">
        {inspection.administrator && <span className="pill positive">管理员</span>}
        {granted.map(([bit, label]) => <span key={bit} className="pill inspector-right-chip">{label}</span>)}
        {!granted.length && <span className="pill neutral">{inspection.traversable ? '仅可穿越祖先目录' : '无权限'}</span>}
      </div>
    </section>

    <section className="permission-section permission-origin" aria-label="授权来源">
      <h3>授权来源</h3>
      {inspection.sources.length ? (
        <ul className="record-list permission-sources">
          {inspection.sources.map(source => {
            const grant = source.grant
            const principal = grant.principalKind === 'user' && grant.principalId === inspection.userId
              ? '本人'
              : `${principalLabels[grant.principalKind]} #${grant.principalId}`
            const grantRights = rights.filter(([bit]) => grant.rights & bit).map(([, label]) => label).join('、')
            const scopeLabel = !node.isFile || source.inherited
              ? (grant.scope === 'this_level_only' ? '仅本层' : '本层及以下')
              : undefined

            return <li key={grant.id} className="permission-source-card">
              <div className="permission-source-title">
                <strong>
                  {source.inherited
                    ? <>继承自 <span className="permission-source-path">{source.sourcePath}</span></>
                    : '直接授权于当前项目'}
                </strong>
                {grant.creator && <span className="pill positive">创建者</span>}
              </div>
              <small className="muted permission-source-meta">
                <span>{principal}</span>
                <span aria-hidden="true">·</span>
                <span>{grantRights}</span>
                {scopeLabel && <>
                  <span aria-hidden="true">·</span>
                  <span>{scopeLabel}</span>
                </>}
              </small>
            </li>
          })}
        </ul>
      ) : (
        <p className="muted permission-empty">
          {inspection.administrator
            ? '来自管理员全局权限'
            : inspection.traversable
              ? '仅因通往下级已授权项目而可见，当前目录无直接权限'
              : '暂无授权来源'}
        </p>
      )}
    </section>
  </div>
}
