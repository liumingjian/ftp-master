import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Building2,
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FileUp,
  HardDrive,
  KeyRound,
  Layers,
  Plus,
  RotateCcw,
  UserPlus,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { DirectorySearch, matchesSearch } from './DirectorySearch'
import { ImportUsersPanel } from './ImportUsersPanel'
import { PageHeading } from './PageHeading'
import { api } from './api/client'
import { avatarInitial } from './avatar'
import type { components } from './api/schema.gen'
import { systemClock } from './clock'
import {
  bytesToQuotaDraft,
  computeOrgAncestorBudget,
  computePlatformStorageSummary,
  formatBinaryBytes,
  parseQuotaInput,
  quotaUsageState,
  type QuotaUnit,
} from './quota'

type Organization = components['schemas']['Organization']
type UserGroup = components['schemas']['UserGroup']
type User = components['schemas']['ManagedUser']
type View = 'organizations' | 'groups' | 'users'
type Editor =
  | {
    kind: 'organization'
    id?: number
    name: string
    parentId: string
    quotaValue: string
    quotaUnit: QuotaUnit
    initialQuotaBytes: number | null
    quotaTouched: boolean
    confirmDelete?: boolean
  }
  | { kind: 'group'; name: string }
  | { kind: 'members'; id: number; ids: number[] }
  | { kind: 'user'; id: number; organizationId: string; groupIds: number[]; confirmDeactivate?: boolean }
  | { kind: 'import' }

interface OrganizationRow {
  organization: Organization
  ancestors: Organization[]
  hasChildren: boolean
}

const views = [
  { id: 'organizations', label: '组织', icon: Building2 },
  { id: 'groups', label: '用户组', icon: Users },
  { id: 'users', label: '用户', icon: UserRound },
] as const

const NO_GROUP_FILTER = '__none__'

function buildOrganizationModel(organizations: Organization[], users: User[]) {
  const byId = new Map<number, Organization>()
  const children = new Map<number | null, Organization[]>()
  for (const organization of organizations) byId.set(organization.id, organization)
  for (const organization of organizations) {
    const parent = organization.parentId !== null && byId.has(organization.parentId) ? organization.parentId : null
    const siblings = children.get(parent) ?? []
    siblings.push(organization)
    children.set(parent, siblings)
  }

  const rows: OrganizationRow[] = []
  const descendantIds = new Map<number, Set<number>>()

  function visit(organization: Organization, ancestors: Organization[]): Set<number> {
    const kids = children.get(organization.id) ?? []
    rows.push({ organization, ancestors, hasChildren: kids.length > 0 })
    const descendants = new Set<number>([organization.id])
    for (const child of kids) {
      for (const id of visit(child, [...ancestors, organization])) descendants.add(id)
    }
    descendantIds.set(organization.id, descendants)
    return descendants
  }

  for (const root of children.get(null) ?? []) visit(root, [])

  const names = new Map(rows.map(({ organization, ancestors }) => [
    organization.id,
    [...ancestors.map(parent => parent.name), organization.name].join(' / '),
  ]))

  const directCounts = new Map<number, number>()
  for (const user of users) {
    directCounts.set(user.organizationId, (directCounts.get(user.organizationId) ?? 0) + 1)
  }

  const subtreeCounts = new Map<number, number>()
  for (const [orgId, ids] of descendantIds) {
    let total = 0
    for (const id of ids) total += directCounts.get(id) ?? 0
    subtreeCounts.set(orgId, total)
  }

  const childCounts = new Map<number, number>()
  for (const organization of organizations) {
    childCounts.set(organization.id, children.get(organization.id)?.length ?? 0)
  }

  return { rows, byId, names, descendantIds, directCounts, subtreeCounts, childCounts }
}

function useCopiedFeedback() {
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const cancelTimer = useRef<(() => void) | null>(null)

  useEffect(() => () => { cancelTimer.current?.() }, [])

  function copyText(id: number, text: string) {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(text).then(() => {
      cancelTimer.current?.()
      setCopiedId(id)
      cancelTimer.current = systemClock.after(1600, () => {
        setCopiedId(null)
        cancelTimer.current = null
      })
    }).catch(() => {})
  }

  return { copiedId, copyText }
}

export function MembershipPanel() {
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [groups, setGroups] = useState<UserGroup[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [view, setView] = useState<View>('organizations')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [selectedOrgId, setSelectedOrgId] = useState<number | null>(null)
  const [includeDescendants, setIncludeDescendants] = useState(true)
  const [collapsedOrgs, setCollapsedOrgs] = useState<Set<number>>(() => new Set())
  const [sidebarCollapsedOrgs, setSidebarCollapsedOrgs] = useState<Set<number>>(() => new Set())
  const [editor, setEditor] = useState<Editor>()
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const { copiedId, copyText } = useCopiedFeedback()

  const orgModel = buildOrganizationModel(organizations, users)
  const { rows: tree, byId: organizationById, names: organizationNames, descendantIds, directCounts, subtreeCounts, childCounts } = orgModel
  const groupById = new Map(groups.map(entry => [entry.id, entry]))
  const userById = new Map(users.map(entry => [entry.id, entry]))

  const groupsByUserId = new Map<number, UserGroup[]>()
  for (const group of groups) {
    for (const userId of group.userIds) {
      const existing = groupsByUserId.get(userId) ?? []
      existing.push(group)
      groupsByUserId.set(userId, existing)
    }
  }

  const activeSelectedOrgId = selectedOrgId !== null && organizationById.has(selectedOrgId) ? selectedOrgId : null
  const activeGroupFilter = groupFilter === NO_GROUP_FILTER || (groupFilter && groupById.has(Number(groupFilter))) ? groupFilter : ''

  async function reload(signal?: AbortSignal) {
    const [orgs, teams, people] = await Promise.all([
      api.GET('/organizations', { signal }),
      api.GET('/user-groups', { signal }),
      api.GET('/managed-users', { signal }),
    ])
    if (signal?.aborted) return
    if (!orgs.data || !teams.data || !people.data) throw Error('Unable to load membership')
    setOrganizations(orgs.data)
    setGroups(teams.data)
    setUsers(people.data)
  }

  async function load(signal?: AbortSignal) {
    setLoading(true)
    setLoadFailed(false)
    try {
      await reload(signal)
    } catch {
      if (!signal?.aborted) setLoadFailed(true)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [])

  function open(next: Editor) {
    setError('')
    setFeedback('')
    setEditor(next)
  }

  function switchView(next: View) {
    if (view === next) return
    setView(next)
    setQuery('')
    setFeedback('')
  }

  function inspectOrganizationUsers(orgId: number, withDescendants: boolean) {
    setSelectedOrgId(orgId)
    setIncludeDescendants(withDescendants)
    setGroupFilter('')
    setStatus('')
    setQuery('')
    setFeedback('')
    setView('users')
  }

  function inspectGroupUsers(groupId: number) {
    setSelectedOrgId(null)
    setGroupFilter(String(groupId))
    setStatus('')
    setQuery('')
    setFeedback('')
    setView('users')
  }

  function toggleCollapsed(orgId: number, setter: typeof setCollapsedOrgs) {
    setter(current => {
      const next = new Set(current)
      if (next.has(orgId)) next.delete(orgId)
      else next.add(orgId)
      return next
    })
  }

  async function run(
    work: () => Promise<{ response: Response; error?: { code?: string; message?: string } }>,
    success: string,
    failure: string,
  ) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const { response, error: apiError } = await work()
      if (!response.ok) {
        if ((apiError?.code === 'quota_conflict' || apiError?.code === 'invalid_quota') && apiError.message) {
          setError(apiError.message)
        } else {
          setError(failure)
        }
        return
      }
      setEditor(undefined)
      setFeedback(success)
      try {
        await reload()
      } catch {
        setFeedback(success + '，列表刷新失败')
        setLoadFailed(true)
      }
    } catch {
      setError('连接失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  function saveOrganization(draft: Extract<Editor, { kind: 'organization' }>) {
    const name = draft.name.trim()
    if (!name) return setError('请输入组织名称')
    let quotaBytes = draft.initialQuotaBytes
    if (draft.quotaTouched) {
      const parsed = parseQuotaInput(draft.quotaValue, draft.quotaUnit)
      if (!parsed.ok) return setError(parsed.error)
      quotaBytes = parsed.bytes
    }
    const body = {
      name,
      parentId: draft.parentId ? Number(draft.parentId) : null,
      quotaBytes,
    }
    void run(() => draft.id
      ? api.PATCH('/organizations/{id}', { params: { path: { id: draft.id } }, body })
      : api.POST('/organizations', { body }), '组织已保存', '无法保存组织，请检查名称和上级组织')
  }

  async function saveUserChanges(draft: Extract<Editor, { kind: 'user' }>, user: User) {
    if (busy) return
    const nextOrgId = Number(draft.organizationId)
    const orgChanged = nextOrgId !== user.organizationId
    const nextGroupSet = new Set(draft.groupIds)
    const changedGroups = groups.filter(group => {
      const had = group.userIds.includes(user.id)
      const wants = nextGroupSet.has(group.id)
      return had !== wants
    })
    if (!orgChanged && !changedGroups.length) return

    setBusy(true)
    setError('')
    try {
      const requests: Promise<{ response: Response }>[] = []
      if (orgChanged) {
        requests.push(api.PUT('/users/{userId}/organization', {
          params: { path: { userId: user.id } },
          body: { organizationId: nextOrgId },
        }))
      }
      for (const group of changedGroups) {
        const wants = nextGroupSet.has(group.id)
        const nextIds = wants
          ? [...group.userIds, user.id]
          : group.userIds.filter(id => id !== user.id)
        requests.push(api.PUT('/user-groups/{id}/members', {
          params: { path: { id: group.id } },
          body: { userIds: nextIds },
        }))
      }
      const results = await Promise.all(requests)
      if (results.some(result => !result.response.ok)) {
        try { await reload() } catch { /* keep error visible */ }
        setError('部分变更未能保存，请检查组织或用户组状态后重试')
        return
      }
      setEditor(undefined)
      const summary = orgChanged && changedGroups.length
        ? '用户所属组织与用户组已更新'
        : orgChanged
          ? '用户所属组织已更新'
          : '用户所属用户组已更新'
      setFeedback(summary)
      try {
        await reload()
      } catch {
        setFeedback(summary + '，列表刷新失败')
        setLoadFailed(true)
      }
    } catch {
      setError('连接失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const parentOrgIds = tree.filter(row => row.hasChildren).map(row => row.organization.id)
  const hasAnyOrgChildren = parentOrgIds.length > 0
  const allOrgsCollapsed = hasAnyOrgChildren && parentOrgIds.every(id => collapsedOrgs.has(id))

  const searching = query.trim().length > 0
  const filteredOrganizations = tree.filter(({ organization, ancestors }) => {
    if (searching) return matchesSearch(query, organizationNames.get(organization.id) ?? organization.name, String(organization.id))
    return !ancestors.some(parent => collapsedOrgs.has(parent.id))
  })
  const filteredGroups = groups.filter(entry => matchesSearch(query, entry.name, String(entry.id)))

  const allowedOrgIds = activeSelectedOrgId !== null
    ? (includeDescendants ? descendantIds.get(activeSelectedOrgId) ?? new Set([activeSelectedOrgId]) : new Set([activeSelectedOrgId]))
    : null

  const filteredUsers = users.filter(entry => {
    if (allowedOrgIds && !allowedOrgIds.has(entry.organizationId)) return false
    if (status && status !== entry.status) return false
    if (activeGroupFilter === NO_GROUP_FILTER) {
      if ((groupsByUserId.get(entry.id)?.length ?? 0) > 0) return false
    } else if (activeGroupFilter) {
      const targetGroup = groupById.get(Number(activeGroupFilter))
      if (!targetGroup || !targetGroup.userIds.includes(entry.id)) return false
    }
    const groupNames = (groupsByUserId.get(entry.id) ?? []).map(group => group.name).join(' ')
    return matchesSearch(query, entry.username, entry.displayName, organizationNames.get(entry.organizationId) ?? '', groupNames)
  })

  const editedUser = editor?.kind === 'user' ? userById.get(editor.id) : undefined
  const editedGroup = editor?.kind === 'members' ? groupById.get(editor.id) : undefined
  const tabCounts: Record<View, number> = {
    organizations: organizations.length,
    groups: groups.length,
    users: users.length,
  }
  const importOrganizations = tree.map(({ organization }) => ({
    id: organization.id,
    path: organizationNames.get(organization.id) ?? organization.name,
  }))

  const selectedOrgRow = activeSelectedOrgId !== null
    ? tree.find(row => row.organization.id === activeSelectedOrgId)
    : undefined
  const hasUserFilters = Boolean(query.trim() || status || activeGroupFilter || activeSelectedOrgId !== null)
  const platformSummary = computePlatformStorageSummary(organizations)

  function openNewOrganization(parentId: string) {
    open({
      kind: 'organization',
      name: '',
      parentId,
      quotaValue: '',
      quotaUnit: 'GB',
      initialQuotaBytes: null,
      quotaTouched: false,
    })
  }

  function openEditOrganization(organization: Organization) {
    const quotaDraft = bytesToQuotaDraft(organization.quotaBytes)
    open({
      kind: 'organization',
      id: organization.id,
      name: organization.name,
      parentId: String(organization.parentId ?? ''),
      quotaValue: quotaDraft.value,
      quotaUnit: quotaDraft.unit,
      initialQuotaBytes: organization.quotaBytes,
      quotaTouched: false,
    })
  }

  return <section className="workspace-page membership-page" aria-label="组织与用户组管理">
    <PageHeading title="组织与用户组管理" />
    <div className="membership-tabs" role="group" aria-label="管理对象">
      {views.map(({ id, label, icon: Icon }) => <button type="button" key={id} className="ghost"
        aria-label={label}
        aria-pressed={view === id} onClick={() => switchView(id)}>
        <Icon size={16} aria-hidden="true" />
        <span>{label}</span>
        {!loading && !loadFailed && <span className="membership-tab-count" aria-hidden="true">{tabCounts[id]}</span>}
      </button>)}
    </div>
    {feedback && <p className="banner success" role="status">{feedback}</p>}
    {loadFailed && <div className="banner error membership-retry" role="alert">
      <span>无法加载管理数据</span><button type="button" onClick={() => void load()}>重试</button>
    </div>}

    {view === 'organizations' && <>
      {!loading && !loadFailed && (
        <div className="membership-quota-summary" role="region" aria-label="平台存储概览">
          <div className="membership-summary-metric">
            <span className="membership-summary-label">
              <HardDrive size={15} aria-hidden="true" />
              平台总存储用量
            </span>
            <strong className="membership-summary-value">{formatBinaryBytes(platformSummary.totalUsedBytes)}</strong>
            {platformSummary.totalReservedBytes > 0 && (
              <span className="membership-summary-sub">含上传预留 {formatBinaryBytes(platformSummary.totalReservedBytes)}</span>
            )}
          </div>
          <div className="membership-summary-divider" aria-hidden="true" />
          <div className="membership-summary-metric">
            <span className="membership-summary-label">
              <Layers size={15} aria-hidden="true" />
              顶层已分配组织配额
            </span>
            <strong className="membership-summary-value">{formatBinaryBytes(platformSummary.topLevelAllocatedBytes)}</strong>
            <span className="membership-summary-sub">已设限组织 {platformSummary.cappedOrgCount} 个</span>
          </div>
        </div>
      )}
      <div className="membership-card">
      <div className="membership-toolbar">
        <DirectorySearch label="搜索组织" value={query} onChange={setQuery} />
        {hasAnyOrgChildren && !searching && <button type="button" className="ghost membership-tree-toggle-all"
          onClick={() => setCollapsedOrgs(allOrgsCollapsed ? new Set() : new Set(parentOrgIds))}>
          {allOrgsCollapsed ? <ChevronsUpDown size={15} aria-hidden="true" /> : <ChevronsDownUp size={15} aria-hidden="true" />}
          {allOrgsCollapsed ? '全部展开' : '全部收起'}
        </button>}
        <div className="membership-toolbar-actions">
          <button type="button" className="primary" disabled={loading || loadFailed}
            onClick={() => openNewOrganization('')}><Plus size={16} aria-hidden="true" />新建组织</button>
        </div>
      </div>
      <div className="membership-table">
        <table aria-label="组织层级">
          <thead>
            <tr>
              <th scope="col">组织</th>
              <th scope="col">上级组织</th>
              <th scope="col">成员人数</th>
              <th scope="col">存储用量与配额</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>{filteredOrganizations.map(({ organization, ancestors, hasChildren }) => {
            const collapsed = collapsedOrgs.has(organization.id)
            const direct = directCounts.get(organization.id) ?? 0
            const total = subtreeCounts.get(organization.id) ?? direct
            const copied = copiedId === organization.id
            const usage = quotaUsageState(organization.usedBytes, organization.quotaBytes)
            const barWidth = organization.quotaBytes === 0
              ? 100
              : Math.min(100, Math.max(organization.usedBytes > 0 ? 4 : 0, usage.percent))
            return <tr key={organization.id}>
              <td>
                <div className="membership-org-cell" style={{ paddingInlineStart: searching ? 0 : Math.min(ancestors.length, 6) * 20 }}>
                  {!searching && hasAnyOrgChildren && (hasChildren
                    ? <button type="button" className="ghost membership-disclosure"
                      aria-expanded={!collapsed}
                      aria-label={(collapsed ? '展开 ' : '收起 ') + organization.name}
                      title={collapsed ? '展开下级组织' : '收起下级组织'}
                      onClick={() => toggleCollapsed(organization.id, setCollapsedOrgs)}>
                      <ChevronRight size={14} className={collapsed ? '' : 'expanded'} aria-hidden="true" />
                    </button>
                    : <span className="membership-disclosure-spacer" aria-hidden="true" />)}
                  <span className="organization-name">
                    <Building2 size={16} aria-hidden="true" />
                    <span className="membership-entity-text">
                      <strong>{organization.name}</strong>
                      <small className="membership-id-line">
                        <span>编号 {organization.id}</span>
                        <button type="button" className="ghost membership-copy-id"
                          aria-label={'复制组织编号 ' + organization.id}
                          title={copied ? '已复制编号' : '复制组织编号'}
                          onClick={() => copyText(organization.id, String(organization.id))}>
                          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                        </button>
                      </small>
                    </span>
                  </span>
                </div>
              </td>
              <td data-label="上级组织" title={ancestors.map(parent => parent.name).join(' / ')}>
                {ancestors.at(-1)?.name ?? '—'}
              </td>
              <td data-label="成员人数">
                <button type="button" className="ghost membership-count-link"
                  title={hasChildren ? '查看该组织及下级成员' : '查看该组织成员'}
                  onClick={() => inspectOrganizationUsers(organization.id, hasChildren)}>
                  {hasChildren && total !== direct
                    ? <>{direct} 直属 <span className="muted">· 共 {total} 人</span></>
                    : <>{direct} 人</>}
                </button>
              </td>
              <td data-label="存储用量与配额" className="membership-quota-cell">
                <div className="membership-quota-stack">
                  <div className="membership-quota-line">
                    <strong>{formatBinaryBytes(organization.usedBytes)}</strong>
                    <span className="muted"> / {organization.quotaBytes !== null ? formatBinaryBytes(organization.quotaBytes) : '不限'}</span>
                    {organization.quotaBytes === 0 && (
                      <span className="membership-quota-tag exceeded">已禁写</span>
                    )}
                    {organization.quotaBytes !== null && organization.quotaBytes > 0 && usage.tone === 'exceeded' && (
                      <span className="membership-quota-tag exceeded">已超额</span>
                    )}
                    {organization.quotaBytes !== null && organization.quotaBytes > 0 && usage.tone === 'warning' && (
                      <span className="membership-quota-tag warning">接近上限</span>
                    )}
                  </div>
                  {organization.quotaBytes !== null && (
                    <div
                      className="membership-quota-bar"
                      role="progressbar"
                      aria-label={organization.name + ' 存储用量'}
                      aria-valuenow={Math.min(100, Math.round(usage.percent))}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <span className={'membership-quota-fill ' + usage.tone} style={{ width: `${barWidth}%` }} />
                    </div>
                  )}
                  {(organization.quotaBytes !== null || organization.allocatedBytes > 0 || organization.reservedBytes > 0) && (
                    <div className="membership-quota-meta">
                      {(organization.quotaBytes !== null || organization.allocatedBytes > 0) && (
                        <span>已分配下级 {formatBinaryBytes(organization.allocatedBytes)}</span>
                      )}
                      {organization.reservedBytes > 0 && (
                        <span>上传预留 {formatBinaryBytes(organization.reservedBytes)}</span>
                      )}
                    </div>
                  )}
                </div>
              </td>
              <td>
                <div className="membership-row-actions">
                  <button type="button" className="ghost membership-row-secondary"
                    aria-label={'新建子组织 ' + organization.name}
                    title="在此组织下新建子组织"
                    onClick={() => openNewOrganization(String(organization.id))}>
                    <Plus size={14} aria-hidden="true" />子组织
                  </button>
                  <button type="button" className="ghost" aria-label={'编辑组织 ' + organization.name}
                    onClick={() => openEditOrganization(organization)}>
                    编辑
                  </button>
                </div>
              </td>
            </tr>
          })}</tbody>
        </table>
      </div>
      {loading && <p className="membership-empty" role="status">正在加载…</p>}
      {!loading && !loadFailed && !filteredOrganizations.length
        && <p className="membership-empty">{searching ? '没有匹配的组织' : '暂无组织'}</p>}
      </div>
    </>}

    {view === 'groups' && <div className="membership-card">
      <div className="membership-toolbar">
        <DirectorySearch label="搜索用户组" value={query} onChange={setQuery} />
        <div className="membership-toolbar-actions">
          <button type="button" className="primary" disabled={loading || loadFailed}
            onClick={() => open({ kind: 'group', name: '' })}><Plus size={16} aria-hidden="true" />新建用户组</button>
        </div>
      </div>
      <div className="membership-table">
        <table aria-label="用户组列表">
          <thead>
            <tr>
              <th scope="col">用户组</th>
              <th scope="col">成员</th>
              <th scope="col">成员预览</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>{filteredGroups.map(group => {
            const resolvedMembers = group.userIds.map(id => userById.get(id)).filter((u): u is User => Boolean(u))
            const previewMembers = resolvedMembers.slice(0, 3)
            const extraCount = group.userIds.length - previewMembers.length
            const allNames = resolvedMembers.map(member => member.displayName).join('、')
            return <tr key={group.id}>
              <td>
                <span className="organization-name">
                  <Users size={16} aria-hidden="true" />
                  <span className="membership-entity-text">
                    <strong>{group.name}</strong>
                    <small>编号 {group.id}</small>
                  </span>
                </span>
              </td>
              <td data-label="成员">
                <button type="button" className="ghost membership-count-link"
                  title="在用户列表中筛选该组成员"
                  onClick={() => inspectGroupUsers(group.id)}>
                  {group.userIds.length} 位
                </button>
              </td>
              <td data-label="成员预览" className="membership-group-preview-cell">
                {group.userIds.length === 0
                  ? <span className="muted">暂无成员</span>
                  : <span className="membership-group-preview" title={allNames || undefined}>
                    {previewMembers.map(member => (
                      <span key={member.id} className={'membership-mini-chip' + (member.status !== 'active' ? ' muted' : '')}>
                        {member.displayName}
                      </span>
                    ))}
                    {extraCount > 0 && <span className="membership-mini-more">+{extraCount}</span>}
                  </span>}
              </td>
              <td>
                <button type="button" className="ghost" aria-label={'管理成员 ' + group.name}
                  onClick={() => open({ kind: 'members', id: group.id, ids: group.userIds })}>
                  管理成员
                </button>
              </td>
            </tr>
          })}</tbody>
        </table>
      </div>
      {loading && <p className="membership-empty" role="status">正在加载…</p>}
      {!loading && !loadFailed && !filteredGroups.length
        && <p className="membership-empty">{searching ? '没有匹配的用户组' : '暂无用户组'}</p>}
    </div>}

    {view === 'users' && <div className="membership-card membership-users-layout">
      <aside className="membership-org-sidebar" aria-label="按组织筛选用户">
        <div className="membership-sidebar-header">
          <span>组织架构</span>
        </div>
        <div className="membership-org-tree" role="tree" aria-label="组织筛选树">
          <button type="button" className={'membership-tree-item' + (activeSelectedOrgId === null ? ' active' : '')}
            onClick={() => setSelectedOrgId(null)}>
            <span className="membership-tree-label">全部用户</span>
            <span className="membership-tree-count">{users.length}</span>
          </button>
          {tree.map(({ organization, ancestors, hasChildren }) => {
            if (ancestors.some(parent => sidebarCollapsedOrgs.has(parent.id))) return null
            const collapsed = sidebarCollapsedOrgs.has(organization.id)
            const total = subtreeCounts.get(organization.id) ?? 0
            const selected = activeSelectedOrgId === organization.id
            return <div key={organization.id} className="membership-tree-row"
              style={{ paddingInlineStart: Math.min(ancestors.length, 5) * 14 }}>
              {hasChildren
                ? <button type="button" className="ghost membership-disclosure"
                  aria-expanded={!collapsed}
                  aria-label={(collapsed ? '展开组织树 ' : '收起组织树 ') + organization.name}
                  title={collapsed ? '展开' : '收起'}
                  onClick={() => toggleCollapsed(organization.id, setSidebarCollapsedOrgs)}>
                  <ChevronRight size={13} className={collapsed ? '' : 'expanded'} aria-hidden="true" />
                </button>
                : <span className="membership-disclosure-spacer compact" aria-hidden="true" />}
              <button type="button" className={'membership-tree-item' + (selected ? ' active' : '')}
                title={organizationNames.get(organization.id)}
                onClick={() => setSelectedOrgId(organization.id)}>
                <span className="membership-tree-label">{organization.name}</span>
                <span className="membership-tree-count">{total}</span>
              </button>
            </div>
          })}
        </div>
      </aside>

      <div className="membership-users-main">
        <div className="membership-toolbar">
          <DirectorySearch label="搜索姓名、用户名或组织" value={query} onChange={setQuery} />
          <select aria-label="用户组筛选" value={activeGroupFilter} onChange={event => setGroupFilter(event.target.value)}>
            <option value="">全部用户组</option>
            <option value={NO_GROUP_FILTER}>未加入任何组</option>
            {groups.map(group => <option key={group.id} value={group.id}>
              {group.name} ({group.userIds.length})
            </option>)}
          </select>
          <select aria-label="用户状态" value={status} onChange={event => setStatus(event.target.value)}>
            <option value="">全部状态</option>
            <option value="active">已激活</option>
            <option value="deactivated">已停用</option>
          </select>
          <div className="membership-toolbar-actions">
            <button type="button" disabled={loading || loadFailed} onClick={() => open({ kind: 'import' })}>
              <FileUp size={16} aria-hidden="true" />批量导入用户
            </button>
          </div>
        </div>

        {(activeSelectedOrgId !== null || activeGroupFilter) && <div className="membership-filter-bar">
          {activeSelectedOrgId !== null && <span className="membership-filter-chip">
            <Building2 size={13} aria-hidden="true" />
            <span>{organizationNames.get(activeSelectedOrgId)}</span>
            <button type="button" className="ghost membership-chip-clear"
              aria-label="清除组织筛选" title="清除组织筛选"
              onClick={() => setSelectedOrgId(null)}>
              <X size={13} aria-hidden="true" />
            </button>
          </span>}
          {activeSelectedOrgId !== null && selectedOrgRow?.hasChildren && (
            <label className="membership-descendant-toggle">
              <input type="checkbox" checked={includeDescendants}
                onChange={event => setIncludeDescendants(event.target.checked)} />
              <span>包含下级组织</span>
            </label>
          )}
          {activeGroupFilter && <span className="membership-filter-chip">
            <Users size={13} aria-hidden="true" />
            <span>{activeGroupFilter === NO_GROUP_FILTER ? '未加入任何组' : groupById.get(Number(activeGroupFilter))?.name}</span>
            <button type="button" className="ghost membership-chip-clear"
              aria-label="清除用户组筛选" title="清除用户组筛选"
              onClick={() => setGroupFilter('')}>
              <X size={13} aria-hidden="true" />
            </button>
          </span>}
          <span className="membership-filter-summary">{filteredUsers.length} 位用户</span>
        </div>}

        <div className="membership-table">
          <table aria-label="用户列表">
            <thead>
              <tr>
                <th scope="col">用户</th>
                <th scope="col">所属组织</th>
                <th scope="col">用户组</th>
                <th scope="col">状态</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>{filteredUsers.map(user => {
              const userGroups = groupsByUserId.get(user.id) ?? []
              const visibleGroups = userGroups.slice(0, 2)
              const hiddenCount = userGroups.length - visibleGroups.length
              const orgPath = organizationNames.get(user.organizationId) ?? '—'
              return <tr key={user.id}>
                <td><UserName user={user} /></td>
                <td data-label="所属组织">
                  <button type="button" className="ghost membership-org-link"
                    title={'筛选组织：' + orgPath}
                    onClick={() => setSelectedOrgId(user.organizationId)}>
                    {orgPath}
                  </button>
                </td>
                <td data-label="用户组">
                  {userGroups.length === 0
                    ? <span className="muted">—</span>
                    : <span className="membership-group-chips" title={userGroups.map(group => group.name).join('、')}>
                      {visibleGroups.map(group => (
                        <button key={group.id} type="button" className="membership-group-chip"
                          title={'筛选用户组：' + group.name}
                          onClick={() => setGroupFilter(String(group.id))}>
                          {group.name}
                        </button>
                      ))}
                      {hiddenCount > 0 && <span className="membership-mini-more">+{hiddenCount}</span>}
                    </span>}
                </td>
                <td>
                  <span className={'pill ' + (user.status === 'active' ? 'positive' : 'neutral')}>
                    {user.status === 'active' ? '已激活' : '已停用'}
                  </span>
                </td>
                <td>
                  <button type="button" className="ghost" aria-label={'管理用户 ' + user.username}
                    onClick={() => open({
                      kind: 'user',
                      id: user.id,
                      organizationId: String(user.organizationId),
                      groupIds: (groupsByUserId.get(user.id) ?? []).map(group => group.id),
                    })}>
                    管理
                  </button>
                </td>
              </tr>
            })}</tbody>
          </table>
        </div>
        {loading && <p className="membership-empty" role="status">正在加载…</p>}
        {!loading && !loadFailed && !filteredUsers.length
          && <p className="membership-empty">{hasUserFilters ? '没有匹配的用户' : '暂无用户'}</p>}
      </div>
    </div>}

    {editor && <MembershipDialog
      title={editor.kind === 'organization' ? (editor.id ? '编辑组织' : '新建组织')
        : editor.kind === 'members' ? editedGroup?.name ?? '用户组成员'
        : editor.kind === 'group' ? '新建用户组'
        : editor.kind === 'user' ? '管理用户'
        : '批量导入用户'}
      wide={editor.kind === 'members'}
      close={() => setEditor(undefined)}
      busy={busy}>
      {error && <p className="banner error" role="alert">{error}</p>}

      {editor.kind === 'organization' && (() => {
        const directUsers = editor.id ? (directCounts.get(editor.id) ?? 0) : 0
        const childOrgs = editor.id ? (childCounts.get(editor.id) ?? 0) : 0
        const deleteBlockers: string[] = []
        if (childOrgs > 0) deleteBlockers.push(`${childOrgs} 个下级组织`)
        if (directUsers > 0) deleteBlockers.push(`${directUsers} 位直属用户`)
        const canDelete = Boolean(editor.id) && deleteBlockers.length === 0
        const orgLabel = editor.id ? (organizationById.get(editor.id)?.name ?? editor.name) : editor.name
        const selectedParentId = editor.parentId ? Number(editor.parentId) : null
        const ancestorBudget = computeOrgAncestorBudget(organizations, editor.id, selectedParentId)
        return <form className="panel-form membership-dialog-form" onSubmit={event => { event.preventDefault(); saveOrganization(editor) }}>
          <label>组织名称<input required maxLength={150} value={editor.name}
            onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
          <label>上级组织<select value={editor.parentId}
            onChange={event => setEditor({ ...editor, parentId: event.target.value })}>
            <option value="">无上级组织</option>
            {tree.filter(({ organization, ancestors }) => organization.id !== editor.id && !ancestors.some(parent => parent.id === editor.id))
              .map(({ organization }) => <option key={organization.id} value={organization.id}>{organizationNames.get(organization.id)}</option>)}
          </select></label>

          <div className="membership-quota-field">
            <span className="membership-field-label">存储配额</span>
            <div className="membership-quota-input-row">
              <input
                type="number"
                min="0"
                step="any"
                aria-label="存储配额"
                placeholder="留空为不限"
                value={editor.quotaValue}
                disabled={busy}
                onChange={event => setEditor({ ...editor, quotaValue: event.target.value, quotaTouched: true })}
              />
              <select
                aria-label="配额单位"
                value={editor.quotaUnit}
                disabled={busy}
                onChange={event => setEditor({ ...editor, quotaUnit: event.target.value as QuotaUnit, quotaTouched: true })}
              >
                <option value="MB">MB</option>
                <option value="GB">GB</option>
                <option value="TB">TB</option>
              </select>
              {editor.quotaValue !== '' && (
                <button
                  type="button"
                  className="ghost membership-quota-clear"
                  disabled={busy}
                  onClick={() => setEditor({ ...editor, quotaValue: '', quotaTouched: true })}
                >
                  清除配额
                </button>
              )}
            </div>
            <div className="membership-quota-budget" role="status">
              {ancestorBudget.ancestor ? (
                <span>
                  约束上级「{ancestorBudget.ancestor.name}」剩余可分配 {formatBinaryBytes(ancestorBudget.ancestorUnallocatedBytes)}
                  {editor.id !== undefined && ancestorBudget.maxAllowedQuotaBytes !== ancestorBudget.ancestorUnallocatedBytes && (
                    <> · 本组织可设上限 {formatBinaryBytes(ancestorBudget.maxAllowedQuotaBytes)}</>
                  )}
                </span>
              ) : (
                <span>上级无配额限制</span>
              )}
              {ancestorBudget.minRequiredQuotaBytes > 0 && (
                <span>下级已分配 {formatBinaryBytes(ancestorBudget.minRequiredQuotaBytes)}</span>
              )}
            </div>
          </div>

          {editor.id && deleteBlockers.length > 0 && (
            <p className="membership-blocker-note">
              当前组织包含 {deleteBlockers.join('和')}，请先迁移后再删除。
            </p>
          )}

          {editor.id && editor.confirmDelete && (
            <div className="membership-confirm-box" role="region" aria-label="确认删除组织">
              <p>删除组织“{orgLabel}”后无法恢复。若该组织仍被权限授权引用，系统将拒绝删除。</p>
              <div className="membership-confirm-actions">
                <button type="button" className="ghost" disabled={busy}
                  onClick={() => setEditor({ ...editor, confirmDelete: false })}>取消</button>
                <button type="button" className="danger-button" disabled={busy}
                  onClick={() => void run(
                    () => api.DELETE('/organizations/{id}', { params: { path: { id: editor.id! } } }),
                    '组织已删除',
                    '无法删除组织，请检查是否仍有权限授权引用',
                  )}>确认删除</button>
              </div>
            </div>
          )}

          <div className="membership-dialog-actions">
            {editor.id && !editor.confirmDelete && <button type="button" className="danger"
              disabled={busy || !canDelete}
              title={canDelete ? '删除此组织' : '请先迁出下级组织和直属用户'}
              onClick={() => setEditor({ ...editor, confirmDelete: true })}>删除组织</button>}
            <button type="button" className="ghost" disabled={busy} onClick={() => setEditor(undefined)}>取消</button>
            <button className="primary" disabled={busy}>保存组织</button>
          </div>
        </form>
      })()}

      {editor.kind === 'group' && <form className="panel-form membership-dialog-form" onSubmit={event => {
        event.preventDefault()
        const name = editor.name.trim()
        if (!name) return setError('请输入用户组名称')
        void run(() => api.POST('/user-groups', { body: { name } }), '用户组已创建', '无法创建用户组，请检查名称是否已存在')
      }}>
        <label>用户组名称<input required maxLength={150} value={editor.name}
          onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
        <div className="membership-dialog-actions">
          <button type="button" className="ghost" disabled={busy} onClick={() => setEditor(undefined)}>取消</button>
          <button className="primary" disabled={busy}>创建用户组</button>
        </div>
      </form>}

      {editor.kind === 'members' && editedGroup && <GroupMembers
        users={users}
        ids={editor.ids}
        group={editedGroup}
        busy={busy}
        tree={tree}
        organizationNames={organizationNames}
        descendantIds={descendantIds}
        onChange={ids => setEditor({ ...editor, ids })}
        cancel={() => setEditor(undefined)}
        save={() => void run(() => api.PUT('/user-groups/{id}/members', {
          params: { path: { id: editor.id } },
          body: { userIds: editor.ids },
        }), '用户组成员已保存', '无法保存成员，请检查成员是否仍存在')} />}

      {editor.kind === 'user' && editedUser && <UserEditor
        user={editedUser}
        draft={editor}
        tree={tree}
        groups={groups}
        organizationNames={organizationNames}
        busy={busy}
        onUpdate={next => setEditor(next)}
        onCancel={() => setEditor(undefined)}
        onSave={() => void saveUserChanges(editor, editedUser)}
        onToggleStatus={() => {
          const deactivating = editedUser.status === 'active'
          void run(() => api.PATCH('/users/{userId}/status', {
            params: { path: { userId: editedUser.id } },
            body: { status: deactivating ? 'deactivated' : 'active' },
          }), deactivating ? '用户已停用' : '用户已激活', '无法更新用户状态')
        }} />}

      {editor.kind === 'import' && <ImportUsersPanel organizations={importOrganizations} onImported={reload} />}
    </MembershipDialog>}
  </section>
}

function MembershipDialog({ title, wide, close, busy, children }: {
  title: string
  wide?: boolean
  close: () => void
  busy: boolean
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return <dialog ref={dialog}
    className={'text-dialog membership-dialog' + (wide ? ' wide' : '')}
    aria-labelledby="membership-dialog-title"
    onClick={event => { if (event.target === dialog.current && !busy) close() }}
    onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <div className="membership-dialog-header">
      <h2 id="membership-dialog-title">{title}</h2>
      <button type="button" className="ghost icon" aria-label="关闭" title="关闭" disabled={busy} onClick={close}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
    <div className="membership-dialog-body">
      {children}
    </div>
  </dialog>
}

function UserName({ user }: { user: User }) {
  return <span className="organization-name">
    <span className="avatar" aria-hidden="true">{avatarInitial(user.displayName)}</span>
    <span className="membership-entity-text">
      <strong>{user.displayName}</strong>
      <small>{user.username}</small>
    </span>
  </span>
}

function UserEditor({ user, draft, tree, groups, organizationNames, busy, onUpdate, onCancel, onSave, onToggleStatus }: {
  user: User
  draft: Extract<Editor, { kind: 'user' }>
  tree: OrganizationRow[]
  groups: UserGroup[]
  organizationNames: Map<number, string>
  busy: boolean
  onUpdate: (next: Extract<Editor, { kind: 'user' }>) => void
  onCancel: () => void
  onSave: () => void
  onToggleStatus: () => void
}) {
  const [groupQuery, setGroupQuery] = useState('')
  const [resetPassword, setResetPassword] = useState('')
  const [resetBusy, setResetBusy] = useState(false)
  const [resetFeedback, setResetFeedback] = useState<{ text: string; ok: boolean }>()
  const selectedGroupSet = new Set(draft.groupIds)
  const orgChanged = Number(draft.organizationId) !== user.organizationId
  const groupsChanged = groups.some(group => group.userIds.includes(user.id) !== selectedGroupSet.has(group.id))
  const hasChanges = orgChanged || groupsChanged
  const matchingGroups = groups.filter(group => matchesSearch(groupQuery, group.name))

  function toggleGroup(groupId: number) {
    const next = selectedGroupSet.has(groupId)
      ? draft.groupIds.filter(id => id !== groupId)
      : [...draft.groupIds, groupId]
    onUpdate({ ...draft, groupIds: next })
  }

  async function submitPasswordReset() {
    if (resetBusy || !resetPassword.trim()) return
    setResetBusy(true)
    setResetFeedback(undefined)
    try {
      const { response } = await api.PUT('/users/{userId}/password', {
        params: { path: { userId: user.id } },
        body: { newPassword: resetPassword },
      })
      if (response.ok) {
        setResetPassword('')
        setResetFeedback({ text: '密码已重置，请通知用户使用新密码登录', ok: true })
      } else {
        setResetFeedback({ text: '重置失败，请检查密码是否符合安全要求', ok: false })
      }
    } catch {
      setResetFeedback({ text: '连接失败，请重试', ok: false })
    } finally {
      setResetBusy(false)
    }
  }

  return <>
    <div className="membership-person">
      <UserName user={user} />
      <span className={'pill ' + (user.status === 'active' ? 'positive' : 'neutral')}>
        {user.status === 'active' ? '已激活' : '已停用'}
      </span>
    </div>

    <form className="panel-form membership-dialog-form" onSubmit={event => { event.preventDefault(); onSave() }}>
      <label>用户所属组织
        <select value={draft.organizationId} onChange={event => onUpdate({ ...draft, organizationId: event.target.value })}>
          {tree.map(({ organization }) => <option key={organization.id} value={organization.id}>
            {organizationNames.get(organization.id)}
          </option>)}
        </select>
      </label>

      <fieldset className="membership-user-groups">
        <legend>
          <span>所属用户组</span>
          <span className="membership-legend-count">已选 {draft.groupIds.length} 个</span>
        </legend>
        {groups.length > 6 && (
          <DirectorySearch label="筛选用户组" value={groupQuery} onChange={setGroupQuery} />
        )}
        {groups.length === 0
          ? <p className="muted membership-inline-empty">暂无可选用户组</p>
          : matchingGroups.length === 0
            ? <p className="muted membership-inline-empty">没有匹配的用户组</p>
            : <ul className="membership-group-checklist">
              {matchingGroups.map(group => {
                const checked = selectedGroupSet.has(group.id)
                return <li key={group.id}>
                  <label className={checked ? 'checked' : undefined}>
                    <input type="checkbox" checked={checked} disabled={busy} onChange={() => toggleGroup(group.id)} />
                    <span className="membership-checklist-name">{group.name}</span>
                    <span className="membership-checklist-meta">{group.userIds.length} 位</span>
                  </label>
                </li>
              })}
            </ul>}
      </fieldset>

      <details className="membership-reset-password">
        <summary><KeyRound size={15} aria-hidden="true" />重置登录密码</summary>
        <div className="membership-reset-body">
          <div className="membership-reset-row">
            <input type="password" aria-label="新登录密码" placeholder="输入新的登录密码" maxLength={1024}
              value={resetPassword} disabled={busy || resetBusy}
              onChange={event => { setResetPassword(event.target.value); setResetFeedback(undefined) }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submitPasswordReset()
                }
              }} />
            <button type="button" disabled={busy || resetBusy || !resetPassword.trim()}
              onClick={() => void submitPasswordReset()}>
              {resetBusy ? '正在重置…' : '重置密码'}
            </button>
          </div>
          {resetFeedback && (
            <p className={`banner ${resetFeedback.ok ? 'success' : 'error'}`} role="status">{resetFeedback.text}</p>
          )}
        </div>
      </details>

      {draft.confirmDeactivate && user.status === 'active' && (
        <div className="membership-confirm-box" role="region" aria-label="确认停用用户">
          <p>停用“{user.username}”后，该用户将无法登录且现有会话会失效。</p>
          <div className="membership-confirm-actions">
            <button type="button" className="ghost" disabled={busy}
              onClick={() => onUpdate({ ...draft, confirmDeactivate: false })}>取消</button>
            <button type="button" className="danger-button" disabled={busy}
              onClick={onToggleStatus}>确认停用</button>
          </div>
        </div>
      )}

      <div className="membership-dialog-actions">
        {!draft.confirmDeactivate && <button type="button"
          className={user.status === 'active' ? 'danger' : undefined}
          disabled={busy}
          onClick={() => {
            if (user.status === 'active') onUpdate({ ...draft, confirmDeactivate: true })
            else onToggleStatus()
          }}>
          {user.status === 'active' ? '停用用户' : '重新激活用户'}
        </button>}
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>取消</button>
        <button className="primary" disabled={busy || !hasChanges}>保存变更</button>
      </div>
    </form>
  </>
}

function GroupMembers({ users, ids, group, busy, tree, organizationNames, descendantIds, onChange, cancel, save }: {
  users: User[]
  ids: number[]
  group: UserGroup
  busy: boolean
  tree: OrganizationRow[]
  organizationNames: Map<number, string>
  descendantIds: Map<number, Set<number>>
  onChange: (ids: number[]) => void
  cancel: () => void
  save: () => void
}) {
  const [query, setQuery] = useState('')
  const [orgFilter, setOrgFilter] = useState('')
  const [hideDeactivated, setHideDeactivated] = useState(true)
  const [memberQuery, setMemberQuery] = useState('')

  const selected = new Set(ids)
  const original = new Set(group.userIds)
  const addedCount = ids.filter(id => !original.has(id)).length
  const removedCount = group.userIds.filter(id => !selected.has(id)).length
  const changed = addedCount > 0 || removedCount > 0

  const orgScope = orgFilter ? (descendantIds.get(Number(orgFilter)) ?? new Set([Number(orgFilter)])) : null
  const matchingCandidates = users.filter(user => {
    if (selected.has(user.id)) return false
    if (orgScope && !orgScope.has(user.organizationId)) return false
    return matchesSearch(query, user.displayName, user.username, organizationNames.get(user.organizationId) ?? '')
  })
  const hiddenDeactivatedCount = hideDeactivated
    ? matchingCandidates.filter(user => user.status !== 'active').length
    : 0
  const visibleCandidates = hideDeactivated
    ? matchingCandidates.filter(user => user.status === 'active')
    : matchingCandidates

  const members = ids.map(id => ({ id, user: users.find(user => user.id === id) }))
  const visibleMembers = memberQuery.trim()
    ? members.filter(({ id, user }) => user
      ? matchesSearch(memberQuery, user.displayName, user.username, organizationNames.get(user.organizationId) ?? '')
      : matchesSearch(memberQuery, String(id)))
    : members

  function addAllVisible() {
    if (!visibleCandidates.length) return
    onChange([...ids, ...visibleCandidates.map(user => user.id)])
  }

  return <div className="member-shuttle">
    <div className="member-shuttle-columns">
      <div className="member-shuttle-pane">
        <div className="member-pane-header">
          <h3>可选用户 <span className="membership-pane-count">{visibleCandidates.length}</span></h3>
          {visibleCandidates.length > 0 && (
            <button type="button" className="ghost membership-batch-add" disabled={busy} onClick={addAllVisible}>
              <UserPlus size={14} aria-hidden="true" />全部添加 ({visibleCandidates.length})
            </button>
          )}
        </div>
        <div className="member-pane-filters">
          <DirectorySearch label="搜索成员姓名或用户名" value={query} onChange={setQuery} />
          <div className="member-pane-subfilters">
            <select aria-label="按组织筛选可选用户" value={orgFilter} onChange={event => setOrgFilter(event.target.value)}>
              <option value="">全部组织（含下级）</option>
              {tree.map(({ organization }) => <option key={organization.id} value={organization.id}>
                {organizationNames.get(organization.id)}
              </option>)}
            </select>
            <label className="membership-descendant-toggle">
              <input type="checkbox" checked={hideDeactivated} onChange={event => setHideDeactivated(event.target.checked)} />
              <span>仅已激活</span>
            </label>
          </div>
        </div>
        <div className="member-pane-list">
          {visibleCandidates.length > 0
            ? <ul className="record-list member-list">{visibleCandidates.map(user => <li key={user.id}>
              <div className="member-row-identity">
                <UserName user={user} />
                <span className="member-row-meta">
                  <span className="ellipsis">{organizationNames.get(user.organizationId) ?? '—'}</span>
                  {user.status !== 'active' && <span className="pill neutral">已停用</span>}
                </span>
              </div>
              <button type="button" className="ghost" disabled={busy} aria-label={'添加 ' + user.username}
                onClick={() => onChange([...ids, user.id])}>
                <Plus size={15} aria-hidden="true" />添加
              </button>
            </li>)}</ul>
            : <p className="muted membership-pane-empty">
              {hiddenDeactivatedCount > 0
                ? `没有匹配的已激活用户（另有 ${hiddenDeactivatedCount} 位已停用）`
                : '没有可添加的匹配用户'}
            </p>}
        </div>
      </div>

      <div className="member-shuttle-pane">
        <div className="member-pane-header">
          <h3>组内成员 <span className="membership-pane-count">{ids.length} 位</span></h3>
          {changed && <button type="button" className="ghost membership-reset-btn" disabled={busy}
            onClick={() => onChange(group.userIds)}>
            <RotateCcw size={13} aria-hidden="true" />重置
          </button>}
        </div>
        {ids.length > 6 && (
          <div className="member-pane-filters">
            <DirectorySearch label="筛选组内成员" value={memberQuery} onChange={setMemberQuery} />
          </div>
        )}
        <div className="member-pane-list">
          {visibleMembers.length > 0
            ? <ul className="record-list member-list">{visibleMembers.map(({ id, user }) => <li key={id}
              className={!original.has(id) ? 'member-row-added' : undefined}>
              <div className="member-row-identity">
                {user ? <UserName user={user} /> : <span>用户 #{id}</span>}
                {user && <span className="member-row-meta">
                  <span className="ellipsis">{organizationNames.get(user.organizationId) ?? '—'}</span>
                  {user.status !== 'active' && <span className="pill neutral">已停用</span>}
                </span>}
              </div>
              <button type="button" className="ghost" disabled={busy} aria-label={'移除 ' + (user?.username ?? '#' + id)}
                onClick={() => onChange(ids.filter(member => member !== id))}>移除</button>
            </li>)}</ul>
            : <p className="muted membership-pane-empty">{ids.length ? '没有匹配的组内成员' : '组内暂无成员'}</p>}
        </div>
      </div>
    </div>

    <div className="membership-dialog-actions member-shuttle-footer">
      <div className="member-diff-summary">
        {changed && <>
          {addedCount > 0 && <span className="pill positive">+{addedCount} 新增</span>}
          {removedCount > 0 && <span className="pill neutral">-{removedCount} 移除</span>}
        </>}
      </div>
      <button type="button" className="ghost" disabled={busy} onClick={cancel}>取消</button>
      <button type="button" className="primary" disabled={busy || !changed} onClick={save}>保存成员</button>
    </div>
  </div>
}
