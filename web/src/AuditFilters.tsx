import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { DirectorySearch, matchesSearch } from './DirectorySearch'
import type { components } from './api/schema.gen'

export const auditRanges = { today: '今天', week: '近 7 天', month: '近 30 天', custom: '自定义' }
export const auditCategories = {
  read: '查看与下载',
  write: '上传与修改',
  delete: '删除与恢复',
  grant: '授权变更',
  session: '会话',
  account: '账户',
}
export const actionNames: Record<string, string> = {
  sign_in: '登录', sign_out: '退出', upload: '上传', download: '下载', zip_download: '打包下载',
  directory_create: '创建目录', rename: '重命名', move: '移动', delete: '删除', restore: '恢复',
  purge: '永久删除', automatic_purge: '自动清理回收站', grant_change: '变更授权',
  account_change: '变更账户', account_import: '导入账户', open_for_edit: '打开 Office 编辑',
  office_save: '保存 Office 文件', text_open: '打开文本编辑', text_save: '保存文本',
  restore_version: '恢复版本', upload_policy_change: '变更上传设置', office_edit_policy_change: '变更 Office 编辑设置',
}

export type AuditFilters = {
  range: keyof typeof auditRanges
  from: string
  to: string
  userIds: number[]
  organizationId?: number
  directory: string
  recursive: boolean
  category: keyof typeof auditCategories | ''
  action: string
  failures: boolean
  itemId?: number
}

export type HistoricalDirectory = { path: string; exists: boolean }

export const defaultAuditFilters: AuditFilters = {
  range: 'week', from: '', to: '', userIds: [], directory: '', recursive: true,
  category: '', action: '', failures: false,
}

export function withAuditRange(filters: AuditFilters, range: AuditFilters['range'], timestamp: string): AuditFilters {
  if (range === 'custom' || !timestamp) return { ...filters, range }
  const end = new Date(Math.floor(Date.parse(timestamp) / 60000) * 60000 + 60000)
  const start = range === 'today'
    ? new Date(timestamp.slice(0, 10) + 'T00:00:00Z')
    : new Date(end.getTime() - (range === 'week' ? 7 : 30) * 86400000)
  return { ...filters, range, from: start.toISOString().slice(0, 16), to: end.toISOString().slice(0, 16) }
}

type User = components['schemas']['ManagedUser']
type Organization = components['schemas']['Organization']
type Audience = 'all' | 'people' | 'organization'

export function AuditFilterDialog({
  filters, serverTime, people, organizations, directories, busy, error, close, apply,
}: {
  filters: AuditFilters
  serverTime: string
  people: User[]
  organizations: Organization[]
  directories: HistoricalDirectory[]
  busy: boolean
  error: string
  close: () => void
  apply: (filters: AuditFilters) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(filters)
  const [audience, setAudience] = useState<Audience>(filters.organizationId ? 'organization' : filters.userIds.length ? 'people' : 'all')
  const [peopleQuery, setPeopleQuery] = useState('')
  const [customAction, setCustomAction] = useState(!!filters.action && !Object.hasOwn(actionNames, filters.action))
  const dialog = useRef<HTMLDialogElement>(null)
  const matchedPeople = people.filter(person => matchesSearch(peopleQuery, person.displayName, person.username))
  const unknownSelectedPeople = draft.userIds.filter(id => !people.some(person => person.id === id))

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  function changeAudience(next: Audience) {
    setAudience(next)
    setDraft(previous => ({ ...previous, userIds: [], organizationId: undefined }))
  }

  function toggleUser(id: number, checked: boolean) {
    setDraft(previous => ({
      ...previous,
      userIds: checked ? [...previous.userIds, id] : previous.userIds.filter(userId => userId !== id),
    }))
  }

  function dismiss() {
    dialog.current?.close()
    close()
  }

  return <dialog ref={dialog} className="text-dialog audit-filter-dialog" aria-labelledby="audit-filter-heading"
    onCancel={event => { event.preventDefault(); if (!busy) dismiss() }}>
    <div className="drawer-heading">
      <h2 id="audit-filter-heading">筛选审计日志</h2>
      <button type="button" className="ghost icon" aria-label="关闭筛选" disabled={busy} onClick={dismiss}><X size={16} /></button>
    </div>
    <form className="audit-filter-form" onSubmit={async event => {
      event.preventDefault()
      if (await apply({ ...draft, directory: draft.directory.trim(), action: draft.action.trim() })) dismiss()
    }}>
      <fieldset disabled={busy}>
        <legend>时间</legend>
        <label>时间范围
          <select value={draft.range} onChange={event => setDraft(withAuditRange(draft, event.target.value as AuditFilters['range'], serverTime))}>
            {Object.entries(auditRanges).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        {draft.range === 'custom' && <div className="audit-custom-time">
          <label>开始时间（UTC）<input type="datetime-local" required value={draft.from}
            onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
          <label>结束时间（UTC）<input type="datetime-local" required value={draft.to}
            onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
        </div>}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>人员与目录</legend>
        <label>人员范围
          <select value={audience} onChange={event => changeAudience(event.target.value as Audience)}>
            <option value="all">全部人员</option><option value="people">指定人员</option><option value="organization">按组织</option>
          </select>
        </label>
        {audience === 'organization' && <label>组织（含下级）
          <select required value={draft.organizationId ?? ''} onChange={event =>
            setDraft({ ...draft, organizationId: Number(event.target.value) || undefined })}>
            <option value="">选择组织</option>
            {organizations.map(organization => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
          </select>
        </label>}
        {audience === 'people' && <div className="audit-person-picker">
          <DirectorySearch label="搜索姓名或用户名" value={peopleQuery} onChange={setPeopleQuery} />
          <div className="audit-person-list" role="group" aria-label="人员">
            {unknownSelectedPeople.map(id => <label className="audit-check" key={id}>
              <input type="checkbox" checked onChange={event => toggleUser(id, event.target.checked)} />用户 #{id}
            </label>)}
            {matchedPeople.map(person => <label className="audit-check" key={person.id}>
              <input type="checkbox" checked={draft.userIds.includes(person.id)}
                onChange={event => toggleUser(person.id, event.target.checked)} />
              <span>{person.displayName}{person.displayName !== person.username && <small> {person.username}</small>}</span>
            </label>)}
            {!matchedPeople.length && <p className="muted">没有匹配的人员</p>}
          </div>
          <small className="muted">{draft.userIds.length ? '已选 ' + draft.userIds.length + ' 人' : '未勾选时查询全部人员'}</small>
        </div>}
        <label>历史目录
          <input list="audit-directories" placeholder="全部目录" value={draft.directory}
            onChange={event => setDraft({ ...draft, directory: event.target.value })} />
        </label>
        <datalist id="audit-directories">
          {directories.map(directory => <option key={directory.path} value={directory.path}>
            {directory.exists ? '当前目录' : '已不存在'}
          </option>)}
        </datalist>
        {draft.directory.trim() && <label className="audit-check"><input type="checkbox" checked={draft.recursive}
          onChange={event => setDraft({ ...draft, recursive: event.target.checked })} />包含子目录</label>}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>事件</legend>
        <div className="audit-custom-time">
          <label>操作类别
            <select value={draft.category} onChange={event => {
              setCustomAction(false)
              setDraft({ ...draft, category: event.target.value as AuditFilters['category'], action: '' })
            }}>
              <option value="">全部类别</option>
              {Object.entries(auditCategories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label>精确操作
            <select value={customAction ? '__custom__' : draft.action} onChange={event => {
              setCustomAction(event.target.value === '__custom__')
              setDraft({ ...draft, category: '', action: event.target.value === '__custom__' ? '' : event.target.value })
            }}>
              <option value="">全部操作</option>
              {Object.entries(actionNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              <option value="__custom__">其他操作代码</option>
            </select>
          </label>
        </div>
        {customAction && <label>操作代码<input required value={draft.action}
          onChange={event => setDraft({ ...draft, action: event.target.value })} /></label>}
        <label className="audit-check"><input type="checkbox" checked={draft.failures}
          onChange={event => setDraft({ ...draft, failures: event.target.checked })} />只看失败</label>
      </fieldset>
      {error && <p className="banner error" role="alert">{error}</p>}
      <div className="audit-dialog-actions">
        <button type="button" disabled={busy} onClick={dismiss}>取消</button>
        <button className="primary" disabled={busy}>{busy ? '正在查询…' : '应用筛选'}</button>
      </div>
    </form>
  </dialog>
}
