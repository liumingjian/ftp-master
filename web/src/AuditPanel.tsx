import { Check, ChevronRight, Copy, Download, RefreshCw, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PageHeading } from './PageHeading'
import { actionNames, AuditFilterDialog, auditCategories, auditRanges, defaultAuditFilters, withAuditRange,
  type AuditFilters, type HistoricalDirectory } from './AuditFilters'
import { api } from './api/client'
import type { components } from './api/schema.gen'
import { systemClock } from './clock'
import { formatSize } from './FileIcon'
import { redirectToSignIn } from './navigation'
import { useRequestOnMount } from './requestOnMount'
import { usePanelDismissal } from './usePanelDismissal'

type Event = {
  id: number
  time: string
  userId: number | null
  username: string
  sourceIp: string
  action: string
  outcome: string
  itemId: number | null
  path: string
  detail: unknown
}
type Results = {
  events: Event[]
  total: number
  page: number
  directories: HistoricalDirectory[]
}

const detailFieldLabels: Record<string, string> = {
  reason: '原因',
  error: '错误信息',
  code: '错误码',
  name: '名称',
  oldName: '原名称',
  newName: '新名称',
  oldPath: '原路径',
  newPath: '新路径',
  fromPath: '源路径',
  toPath: '目标路径',
  targetPath: '目标路径',
  parentId: '目标目录编号',
  targetParentId: '目标父目录编号',
  principalKind: '授权对象类型',
  principalId: '授权对象编号',
  rights: '权限位',
  scope: '作用范围',
  organizationId: '组织编号',
  organization_id: '组织编号',
  groupId: '用户组编号',
  targetUserId: '目标用户编号',
  target_user_id: '目标用户编号',
  username: '用户名',
  operation: '操作类型',
  result: '变更结果',
  change: '变更内容',
  nodeId: '节点编号',
  status: '状态',
  size: '文件大小',
  versionId: '版本编号',
  baseVersionId: '基础版本编号',
  sourceVersionId: '源版本编号',
  versionNumber: '版本号',
  newVersion: '覆盖生成新版本',
  permitId: '编辑凭证',
  staleSave: '过期保存',
  format: '文件格式',
  created: '导入人数',
  count: '数量',
  enabled: '启用状态',
  blockedExtensions: '禁止扩展名',
  extension: '扩展名',
}

const rightBitLabels = [[1, '浏览'], [2, '下载'], [4, '上传'], [8, '修改'], [16, '删除'], [32, '授权']] as const
const principalKindLabels: Record<string, string> = {
  user: '用户',
  organization: '组织',
  user_group: '用户组',
}
const scopeLabels: Record<string, string> = {
  subtree: '本层及以下',
  this_level_only: '仅本层',
}

function formatDetailValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (key === 'rights' && typeof value === 'number') {
    const names = rightBitLabels.filter(([bit]) => value & bit).map(([, label]) => label)
    return names.length ? `${names.join('、')} (${value})` : String(value)
  }
  if (key === 'principalKind' && typeof value === 'string') return principalKindLabels[value] ?? value
  if (key === 'scope' && typeof value === 'string') return scopeLabels[value] ?? value
  if (key === 'size' && typeof value === 'number') return formatSize(value)
  if (key === 'status' && typeof value === 'string') {
    return value === 'active' ? '已激活' : value === 'deactivated' ? '已停用' : value
  }
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) {
    if (!value.length) return '无'
    if (value.every(item => typeof item === 'string' || typeof item === 'number')) {
      return value.join('、')
    }
    return `共 ${value.length} 项`
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function structuredDetailEntries(detail: unknown): { label: string; value: string }[] {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return []
  return Object.entries(detail as Record<string, unknown>)
    .filter(([key, value]) => key !== 'files' && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ({
      label: detailFieldLabels[key] ?? key,
      value: formatDetailValue(key, value),
    }))
}

function archivePaths(event: Event): string[] {
  if (event.action !== 'zip_download' || !event.detail || typeof event.detail !== 'object' || !('files' in event.detail)) return []
  const files: unknown = event.detail.files
  if (!Array.isArray(files)) return []
  return files.flatMap((file: unknown) =>
    file && typeof file === 'object' && 'path' in file && typeof file.path === 'string' ? [file.path] : [])
}

export function AuditPanel() {
  const [filters, setFilters] = useState(defaultAuditFilters)
  const [dialog, setDialog] = useState<'more' | 'custom'>()
  const [result, setResult] = useState<Results>()
  const [detail, setDetail] = useState<Event>()
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const cancelCopyTimer = useRef<(() => void) | null>(null)
  const detailTrigger = useRef<HTMLButtonElement>(null)
  const detailClose = useRef<HTMLButtonElement>(null)
  const detailPanel = usePanelDismissal(!!detail, closeDetail)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [serverTime, setServerTime] = useState('')
  const people = useRequestOnMount<components['schemas']['ManagedUser'][]>([], async () => {
    const { data } = await api.GET('/managed-users')
    return data ?? []
  })
  const organizations = useRequestOnMount<components['schemas']['Organization'][]>([], async () => {
    const { data } = await api.GET('/organizations')
    return data ?? []
  })
  const userList = Array.isArray(people) ? people : []
  const organizationList = Array.isArray(organizations) ? organizations : []

  useEffect(() => () => { cancelCopyTimer.current?.() }, [])
  useEffect(() => { if (detail) detailClose.current?.focus() }, [detail])

  function closeDetail(restoreFocus = true) {
    setDetail(undefined)
    if (restoreFocus) detailTrigger.current?.focus()
    detailTrigger.current = null
  }

  function copyAuditSummary(event: Event) {
    if (!navigator.clipboard) return
    const lines = [
      `审计记录 #${event.id}`,
      `时间：${formatAuditLocalTime(event.time)}（UTC ${formatAuditUtcTime(event.time)}）`,
      `用户：${event.username || '—'}`,
      `来源 IP：${event.sourceIp || '—'}`,
      `操作：${actionNames[event.action] ?? event.action}`,
      `结果：${event.outcome === 'success' ? '成功' : '失败'}`,
      event.path ? `当时路径：${event.path}` : '',
    ].filter(Boolean).join('\n')
    void navigator.clipboard.writeText(lines).then(() => {
      cancelCopyTimer.current?.()
      setCopiedId(event.id)
      cancelCopyTimer.current = systemClock.after(1600, () => {
        setCopiedId(null)
        cancelCopyTimer.current = null
      })
    }).catch(() => {})
  }

  useEffect(() => {
    const controller = new AbortController()
    void query(defaultAuditFilters, { refreshTime: true, signal: controller.signal })
    return () => controller.abort()
  }, [])

  async function query(next: AuditFilters, { page = 1, csv = false, refreshTime = false, signal }: {
    page?: number; csv?: boolean; refreshTime?: boolean; signal?: AbortSignal
  } = {}) {
    setBusy(true)
    setError('')
    try {
      if (refreshTime) {
        const health = await api.GET('/health', { signal })
        if (signal?.aborted) return false
        const timestamp = (health.data ?? health.error)?.checkedAt
        if (!timestamp) {
          setError('无法读取服务器时间，请重试')
          return false
        }
        setServerTime(timestamp)
        next = withAuditRange(next, next.range, timestamp)
      }
      const response = await fetch('/api/audit/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: next.from + ':00Z',
          to: next.to + ':00Z',
          userIds: next.userIds,
          organizationId: next.organizationId,
          directory: next.directory,
          action: next.action,
          category: next.category || undefined,
          includeSubdirectories: next.recursive,
          failuresOnly: next.failures,
          itemId: next.itemId,
          page,
          export: csv,
        }),
        signal,
      })
      if (response.status === 401) {
        redirectToSignIn()
        return false
      }
      if (!response.ok) {
        setError(response.status === 400 ? '结束时间须晚于开始时间，且范围不超过 180 天（精确到分钟）'
          : '查询失败（' + response.status + '）')
        return false
      }
      if (csv) {
        const url = URL.createObjectURL(await response.blob())
        const download = document.createElement('a')
        download.href = url
        download.download = 'audit.csv'
        download.click()
        URL.revokeObjectURL(url)
      } else {
        const nextResult = (await response.json()) as Results
        if (signal?.aborted) return false
        setResult(nextResult)
        setFilters(next)
        closeDetail(false)
      }
      return true
    } catch {
      if (!signal?.aborted) setError('无法连接服务')
      return false
    } finally {
      if (!signal?.aborted) setBusy(false)
    }
  }

  function openFilters(mode: 'more' | 'custom') {
    setError('')
    setDialog(mode)
  }

  const context = [
    filters.userIds.length ? '人员 · ' + filters.userIds.map(id => userList.find(user => user.id === id)?.username ?? '#' + id).join('、') : '',
    filters.organizationId ? '组织 · ' + (organizationList.find(org => org.id === filters.organizationId)?.name ?? '#' + filters.organizationId) : '',
    filters.directory ? filters.directory + (filters.recursive ? '（含子目录）' : '（仅本层）') : '',
    filters.action ? actionNames[filters.action] ?? filters.action : '',
    filters.failures ? '只看失败' : '',
    filters.itemId !== undefined ? '项目 #' + filters.itemId : '',
  ].filter(Boolean)
  const filtered = context.length > 0 || filters.range !== 'week' || !!filters.category
  const parsedDetailEntries = detail ? structuredDetailEntries(detail.detail) : []

  return <section aria-label="审计记录" className="audit-panel">
    <PageHeading title="审计日志" actions={
      <>
        <button type="button" className="ghost" disabled={busy} onClick={() => void query(filters, {
          refreshTime: !filters.from || filters.range !== 'custom',
        })}><RefreshCw size={16} aria-hidden="true" />刷新</button>
        <button type="button" disabled={busy || !result} onClick={() => void query(filters, { csv: true })}>
          <Download size={16} aria-hidden="true" />导出 CSV
        </button>
      </>
    } />
    <div className="audit-toolbar" role="group" aria-label="审计筛选">
      <select aria-label="时间范围" value={filters.range} disabled={busy || !filters.from} onChange={event => {
        const range = event.target.value as AuditFilters['range']
        if (range === 'custom') openFilters('custom')
        else void query(withAuditRange(filters, range, serverTime), { refreshTime: true })
      }}>
        {Object.entries(auditRanges).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <select aria-label="操作类别" value={filters.category} disabled={busy || !filters.from} onChange={event =>
        void query({ ...filters, category: event.target.value as AuditFilters['category'], action: '' })}>
        <option value="">全部操作类别</option>
        {Object.entries(auditCategories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <button type="button" aria-haspopup="dialog" disabled={busy || !filters.from} onClick={() => openFilters('more')}>
        <SlidersHorizontal size={16} aria-hidden="true" />更多筛选
      </button>
      {filtered && <button className="ghost audit-reset" type="button" disabled={busy} onClick={() =>
        void query(defaultAuditFilters, { refreshTime: true })}>重置</button>}
    </div>
    {context.length > 0 && <ul className="audit-applied" aria-label="已应用的筛选">
      {context.map((value, index) => <li key={index} title={value}>{value}</li>)}
    </ul>}
    {dialog && <AuditFilterDialog filters={dialog === 'custom' ? { ...filters, range: 'custom' } : filters}
      serverTime={serverTime} people={userList} organizations={organizationList} directories={result?.directories ?? []}
      busy={busy} error={error} close={() => { setDialog(undefined); setError('') }}
      apply={query} />}
    {error && !dialog && <p className="banner error audit-feedback" role="alert">{error}</p>}
    {!result && busy && <p className="audit-feedback muted" role="status">正在加载审计记录…</p>}
    {result && <div className="audit-result-meta">
      <p role="status">共 {result.total.toLocaleString('zh-CN')} 条记录</p>
      <span title={`${filters.from.replace('T', ' ')} 至 ${filters.to.replace('T', ' ')} UTC`}>
        {formatAuditLocalRange(filters.from, filters.to)}
      </span>
    </div>}
    <div className={detail ? 'audit-results has-detail' : 'audit-results'}>
      {result && <div className="audit-list" aria-busy={busy}>
        <div className="audit-table" tabIndex={0} role="region" aria-label="审计记录表">
          <table>
            <thead><tr>
              <th scope="col">时间（本地）</th><th scope="col">用户</th><th scope="col">来源 IP</th><th scope="col">操作</th>
              <th scope="col" title="操作发生时的对象路径">操作对象</th><th scope="col">结果</th><th scope="col"><span className="visually-hidden">详情</span></th>
            </tr></thead>
            <tbody>
              {result.events.map(event => {
                const failed = event.outcome !== 'success'
                const rowClass = [detail?.id === event.id ? 'selected' : '', failed ? 'audit-failed' : ''].filter(Boolean).join(' ') || undefined
                const localTime = formatAuditLocalTime(event.time)
                const utcTime = formatAuditUtcTime(event.time)
                return <tr key={event.time + '-' + event.id} className={rowClass}>
                  <td className="audit-time-cell"><time dateTime={event.time} title={`本地 ${localTime} · UTC ${utcTime}`}>{localTime.slice(5)}</time></td>
                  <td>{event.username || '—'}</td>
                  <td className="audit-time-cell">{event.sourceIp || '—'}</td>
                  <td title={event.action}>{actionNames[event.action] ?? event.action}</td>
                  <td className="audit-object"><span title={event.path}>{event.path || (event.action === 'zip_download' ? archivePaths(event).length + ' 个文件' : '—')}</span></td>
                  <td>
                    <span className={failed ? 'pill audit-outcome-bad' : 'pill audit-outcome-ok'}>
                      {failed ? '失败' : '成功'}
                    </span>
                  </td>
                  <td><button className="ghost icon" data-panel-trigger aria-label="查看详情" title="查看详情"
                    aria-expanded={detail?.id === event.id} onClick={click => {
                      detailTrigger.current = click.currentTarget
                      setDetail(event)
                    }}>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button></td>
                </tr>
              })}
              {!result.events.length && <tr><td colSpan={7} className="audit-empty">没有符合当前条件的记录</td></tr>}
            </tbody>
          </table>
        </div>
        {result.total > 50 && <div className="audit-pagination">
          <span className="muted">第 {result.page} / {Math.ceil(result.total / 50)} 页</span>
          <button disabled={busy || result.page <= 1} onClick={() => void query(filters, { page: result.page - 1 })}>上一页</button>
          <button disabled={busy || result.page * 50 >= result.total} onClick={() => void query(filters, { page: result.page + 1 })}>下一页</button>
        </div>}
      </div>}
      {detail && <aside ref={detailPanel} className="audit-details panel" aria-label="审计详情">
        <div className="drawer-heading"><h2>审计详情</h2>
          <button ref={detailClose} className="ghost icon" aria-label="关闭详情" title="关闭详情" onClick={() => closeDetail()}><X size={16} aria-hidden="true" /></button>
        </div>
        <dl className="audit-detail-dl">
          <dt>时间</dt><dd><time dateTime={detail.time}>{formatAuditLocalTime(detail.time)}</time><small className="audit-utc-sub">UTC {formatAuditUtcTime(detail.time)}</small></dd>
          <dt>用户</dt><dd>{detail.username || '—'}</dd>
          <dt>来源 IP</dt><dd>{detail.sourceIp || '—'}</dd>
          <dt>操作</dt><dd>{actionNames[detail.action] ?? detail.action}</dd>
          <dt>结果</dt><dd>
            <span className={detail.outcome === 'success' ? 'pill audit-outcome-ok' : 'pill audit-outcome-bad'}>
              {detail.outcome === 'success' ? '成功' : '失败'}
            </span>
          </dd>
          <dt>记录编号</dt><dd>#{detail.id}</dd>
          {detail.itemId !== null && <><dt>项目编号</dt><dd>#{detail.itemId}</dd></>}
          {detail.path && <><dt>当时路径</dt><dd>{detail.path}</dd></>}
        </dl>

        {detail.action === 'zip_download' && (
          <div className="audit-detail-section">
            <h3>压缩包文件（{archivePaths(detail).length}）</h3>
            <ul className="audit-archive-list">{archivePaths(detail).map(path => <li key={path}>{path}</li>)}</ul>
          </div>
        )}

        {parsedDetailEntries.length > 0 && (
          <div className="audit-detail-section">
            <h3>变更与上下文</h3>
            <dl className="audit-detail-kv">
              {parsedDetailEntries.map(entry => <div key={entry.label} className="audit-kv-row">
                <dt>{entry.label}</dt><dd>{entry.value}</dd>
              </div>)}
            </dl>
          </div>
        )}

        {detail.detail !== null && detail.detail !== undefined && (
          <details className="audit-raw-json">
            <summary>查看原始报文</summary>
            <pre>{JSON.stringify(detail.detail, null, 2)}</pre>
          </details>
        )}

        <div className="audit-detail-actions">
          {detail.userId !== null && <button disabled={busy} onClick={() => void query({
            ...filters, userIds: [detail.userId!], organizationId: undefined, itemId: undefined,
          })}>仅此人员</button>}
          {detail.path && <button disabled={busy} onClick={() => void query({
            ...filters, directory: detail.path.slice(0, detail.path.lastIndexOf('/')) || '/', itemId: undefined,
          })}>仅此目录</button>}
          {detail.itemId !== null && <button disabled={busy} onClick={() => void query({
            ...defaultAuditFilters, range: filters.range, from: filters.from, to: filters.to, itemId: detail.itemId!,
          })}>此项目完整历史</button>}
          <button type="button" className="ghost" onClick={() => copyAuditSummary(detail)}>
            {copiedId === detail.id ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copiedId === detail.id ? '已复制摘要' : '复制摘要'}
          </button>
        </div>
      </aside>}
    </div>
  </section>
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function formatAuditLocalTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function formatAuditUtcTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

function formatAuditLocalRange(from: string, to: string) {
  if (!from || !to) return ''
  const start = formatAuditLocalTime(from + ':00Z').slice(0, 16)
  const end = formatAuditLocalTime(to + ':00Z').slice(0, 16)
  return `${start} 至 ${end}（本地时间）`
}
