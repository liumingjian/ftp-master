import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, Building2, Check, ChevronRight, Lock, SearchCheck, Shield, TriangleAlert, UserRound, UserRoundPlus, Users, X } from 'lucide-react'
import { DirectorySearch, matchesSearch } from './DirectorySearch'
import { api } from './api/client'
import { FileIcon } from './FileIcon'
import { loadAncestors, loadBranches } from './treePath'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']
type Grant = components['schemas']['TreeGrantInput']
type Source = components['schemas']['SourcedGrant']
type PrincipalKind = Grant['principalKind']
type Principal = { id: number; name: string; detail?: string }
const presets = [[1, '仅浏览'], [3, '只读'], [15, '读写'], [31, '读写删除'], [63, '完全控制'], [4, '投递箱']] as const
export const rights = [[1, '浏览'], [2, '下载'], [4, '上传'], [8, '修改'], [16, '删除'], [32, '授权']] as const
const readRights = [[1, '浏览'], [2, '下载']] as const
const writeRights = [[4, '上传'], [8, '修改'], [16, '删除']] as const
const adminRights = [[32, '授权']] as const
const principalLabels = { user: '用户', organization: '组织', user_group: '用户组' }
const principalKinds = ['user_group', 'organization', 'user'] as const
const principalIcons = { user: UserRound, organization: Building2, user_group: Users }
const principalOrder = (grant: Grant) => grant.creator ? -1 : principalKinds.indexOf(grant.principalKind)
const individualGrantWarningThreshold = 10

type Organization = components['schemas']['Organization']
type ManagedUser = components['schemas']['ManagedUser']

function useManagedUsers(administrator: boolean) {
  const [users, setUsers] = useState<ManagedUser[]>()
  useEffect(() => {
    if (!administrator) return
    const controller = new AbortController()
    void api.GET('/managed-users', { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) setUsers(data)
    }).catch(() => {})
    return () => controller.abort()
  }, [administrator])
  return administrator ? users : undefined
}

function buildOrgCoverage(organizations: Organization[], managedUsers: ManagedUser[] | undefined) {
  const byId = new Map(organizations.map(org => [org.id, org]))
  const children = new Map<number | null, Organization[]>()
  for (const org of organizations) {
    const parent = org.parentId !== null && byId.has(org.parentId) ? org.parentId : null
    const list = children.get(parent) ?? []
    list.push(org)
    children.set(parent, list)
  }

  const paths = new Map<number, string>()
  const descendants = new Map<number, Set<number>>()

  function visit(org: Organization, prefix: string[]): Set<number> {
    const fullPath = [...prefix, org.name]
    paths.set(org.id, fullPath.join(' / '))
    const ids = new Set<number>([org.id])
    for (const child of children.get(org.id) ?? []) {
      for (const id of visit(child, fullPath)) ids.add(id)
    }
    descendants.set(org.id, ids)
    return ids
  }
  for (const root of children.get(null) ?? []) visit(root, [])

  const activeByOrg = new Map<number, number>()
  for (const user of managedUsers ?? []) {
    if (user.status === 'active') activeByOrg.set(user.organizationId, (activeByOrg.get(user.organizationId) ?? 0) + 1)
  }

  const options: Principal[] = organizations.map(org => {
    const subtree = descendants.get(org.id) ?? new Set([org.id])
    const subOrgCount = subtree.size - 1
    let activeUsers = 0
    for (const id of subtree) activeUsers += activeByOrg.get(id) ?? 0
    const parts: string[] = []
    if (subOrgCount > 0) parts.push(`含 ${subOrgCount} 个下级组织`)
    if (managedUsers) parts.push(`覆盖 ${activeUsers} 位已激活用户`)
    return {
      id: org.id,
      name: paths.get(org.id) ?? org.name,
      detail: parts.length ? parts.join(' · ') : undefined,
    }
  })
  return options
}

function toggleRight(value: number, bit: number, checked: boolean) {
  if (checked) {
    if (bit === 32) return 63
    if (bit === 8) return value | bit | 3
    if (bit === 2 || bit === 16) return value | bit | 1
    return value | bit
  }
  const dependent = bit === 1 ? 58 : bit === 2 ? 40 : 32
  return value & ~bit & ~dependent
}

export function GrantsPanel({ node, close, administrator, onDirtyChange }: {
  node: Node; close: () => void; administrator: boolean; onDirtyChange: (dirty: boolean) => void
}) {
  const [path, setPath] = useState<Node[]>([])
  const [branches, setBranches] = useState<Record<number, Node[]>>({ 0: [node] })
  const [selected, setSelected] = useState(node)
  const [activeView, setActiveView] = useState<'ledger' | 'add' | 'inspect'>('ledger')
  const [sources, setSources] = useState<Source[]>([])
  const [added, setAdded] = useState<Grant[]>([])
  const [changes, setChanges] = useState<Record<number, Grant | null>>({})
  const [impact, setImpact] = useState<components['schemas']['GrantImpact']>()
  const [value, setValue] = useState(3)
  const [scope, setScope] = useState<Grant['scope']>('subtree')
  const [principalKind, setPrincipalKind] = useState<PrincipalKind>('user_group')
  const [principalId, setPrincipalId] = useState<number>()
  const [principals, setPrincipals] = useState<Partial<Record<PrincipalKind, Principal[]>>>({})
  const [showInherited, setShowInherited] = useState(true)
  const [message, setMessage] = useState('')
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [parentCanGrant, setParentCanGrant] = useState(administrator)
  const grantTree = useRef<HTMLDivElement>(null)
  const managedUsers = useManagedUsers(administrator)
  const users = managedUsers?.map<Principal>(user => ({
    id: user.id,
    name: user.displayName + '（' + user.username + '）',
    detail: user.status === 'deactivated' ? '已停用' : undefined,
  }))
  const [rawOrgs, setRawOrgs] = useState<Organization[]>([])
  const [rawGroups, setRawGroups] = useState<components['schemas']['UserGroup'][]>([])
  const [transferSource, setTransferSource] = useState<Source>()
  const [successor, setSuccessor] = useState<number>()
  const [handover, setHandover] = useState<{ source: Source; userId: number }>()
  const dirty = !!handover || added.length > 0 || Object.keys(changes).length > 0
  const options = principalKind === 'user' ? users : principals[principalKind]
  const canGrant = !!(selected.rights & 32)
  const direct = sources.filter(entry => !entry.inherited).sort((a, b) => principalOrder(a.grant) - principalOrder(b.grant))
  const inherited = sources.filter(entry => entry.inherited)
  const individualGrants = [...direct.map(source => source.grant.id in changes ? changes[source.grant.id] : source.grant), ...added]
    .filter(grant => grant?.principalKind === 'user' && !grant.creator).length
  const effectiveView = canGrant ? activeView : 'inspect'

  useEffect(() => { onDirtyChange(dirty || saving) }, [dirty, saving, onDirtyChange])

  useLayoutEffect(() => {
    const tree = grantTree.current
    const current = tree?.querySelector('[aria-current="location"]')
    if (!tree || !current) return
    const view = tree.getBoundingClientRect()
    const row = current.getBoundingClientRect()
    if (row.top < view.top) tree.scrollTop += row.top - view.top - 8
    if (row.bottom > view.bottom) tree.scrollTop += row.bottom - view.bottom + 8
  }, [branches, selected.id])

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      const directories = await loadAncestors(selected, controller.signal)
      const listings = await loadBranches([...directories, selected], controller.signal, { includeGrantCounts: true })
      if (controller.signal.aborted) return
      setPath(directories)
      setParentCanGrant(administrator || !!((directories.at(-1)?.rights ?? 0) & 32))
      setBranches(listings)
    }
    void load().catch(() => { if (!controller.signal.aborted) setMessage('无法加载授权目录树') })
    return () => controller.abort()
  }, [selected, administrator, revision])

  useEffect(() => {
    const controller = new AbortController()
    setSources([])
    if (!canGrant) return
    setBusy(true)
    void api.GET('/tree/{id}/grant-draft', { params: { path: { id: selected.id } }, signal: controller.signal })
      .then(({ data, response }) => {
        if (controller.signal.aborted) return
        if (data) setSources(data)
        else setMessage(`HTTP ${response.status}`)
      }).catch(() => {
        if (!controller.signal.aborted) setMessage('无法加载授权')
      }).finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [selected.id, canGrant, revision])

  useEffect(() => {
    if (!administrator) return
    const controller = new AbortController()
    const requestOptions = { signal: controller.signal }
    void Promise.all([api.GET('/organizations', requestOptions), api.GET('/user-groups', requestOptions)])
      .then(([organizations, groups]) => {
        if (controller.signal.aborted) return
        setRawOrgs(organizations.data ?? [])
        setRawGroups(groups.data ?? [])
      }).catch(() => {
        if (!controller.signal.aborted) {
          setRawOrgs([])
          setRawGroups([])
        }
      })
    return () => controller.abort()
  }, [administrator])

  useEffect(() => {
    if (!administrator) return
    const activeUserIds = managedUsers ? new Set(managedUsers.filter(u => u.status === 'active').map(u => u.id)) : null
    setPrincipals({
      organization: buildOrgCoverage(rawOrgs, managedUsers),
      user_group: rawGroups.map(group => {
        const total = group.userIds.length
        const active = activeUserIds ? group.userIds.filter(id => activeUserIds.has(id)).length : total
        const detail = activeUserIds && active !== total
          ? `${active} 位已激活 / 共 ${total} 位成员`
          : `${total} 位有效成员`
        return { id: group.id, name: group.name, detail }
      }),
    })
  }, [administrator, rawOrgs, rawGroups, managedUsers])

  function principalEntry(grant: Grant) {
    return (grant.principalKind === 'user' ? users : principals[grant.principalKind])?.find(entry => entry.id === grant.principalId)
  }

  function principalName(grant: Grant) {
    return principalEntry(grant)?.name
      ?? principalLabels[grant.principalKind] + ' #' + grant.principalId
  }

  function principalCell(grant: Grant, extraTag?: { label: string; tone?: 'accent' | 'danger' }) {
    const Icon = principalIcons[grant.principalKind]
    const entry = principalEntry(grant)
    const roleLabel = grant.creator ? '创建者' : principalLabels[grant.principalKind]
    const subline = !grant.creator && entry?.detail ? `${roleLabel} · ${entry.detail}` : roleLabel
    return <span className="grant-principal">
      <span className={grant.creator ? 'grant-principal-badge is-creator' : 'grant-principal-badge'} aria-hidden="true">
        <Icon size={15} />
      </span>
      <span className="grant-principal-text">
        <strong>
          <span>{principalName(grant)}</span>
          {grant.creator && <span className="grant-tag accent">创建者</span>}
          {extraTag && <span className={`grant-tag ${extraTag.tone ?? ''}`}>{extraTag.label}</span>}
        </strong>
        <small>{subline}</small>
      </span>
    </span>
  }

  function draft() {
    return {
      add: [...added, ...(handover ? [{
        principalKind: 'user' as const, principalId: handover.userId, rights: 63, scope: 'subtree' as const, creator: true,
      }] : []), ...Object.values(changes).filter((grant): grant is Grant => grant !== null)],
      remove: [...Object.keys(changes).map(Number), ...(handover ? [handover.source.grant.id] : [])],
    }
  }

  useEffect(() => {
    setImpact(undefined)
    if (!dirty) return
    const controller = new AbortController()
    void api.POST('/tree/{id}/grant-draft/preview', {
      params: { path: { id: selected.id } }, body: draft(), signal: controller.signal,
    }).then(({ data, response }) => {
      if (controller.signal.aborted) return
      setImpact(data)
      if (!data) setMessage(`预览失败 HTTP ${response.status}`)
    }).catch(() => {
      if (!controller.signal.aborted) setMessage('无法预览授权影响')
    })
    return () => controller.abort()
  }, [selected.id, changes, added, handover, dirty])

  function discard() {
    setTransferSource(undefined)
    setSuccessor(undefined)
    setHandover(undefined)
    setChanges({})
    setAdded([])
    setImpact(undefined)
  }

  function pick(next: Node) {
    if (next.id === selected.id || saving) return
    if (dirty && !window.confirm('有未保存的更改，确定切换项目？')) return
    discard()
    setPrincipalId(undefined)
    setMessage('')
    setBusy(false)
    setActiveView('ledger')
    setSelected(next)
  }

  async function save() {
    setSaving(true)
    try {
      const { response } = await api.POST('/tree/{id}/grant-draft', {
        params: { path: { id: selected.id } }, body: draft(),
      })
      setMessage(response.ok ? '授权已保存' : `保存失败 HTTP ${response.status}`)
      if (response.ok) {
        discard()
        try {
          const { data } = await api.GET('/tree/{id}', { params: { path: { id: selected.id } } })
          if (data) setSelected(data)
        } finally {
          setRevision(value => value + 1)
        }
      }
    } catch {
      setMessage('无法保存授权')
    } finally {
      setSaving(false)
    }
  }

  function change(original: Source['grant'], grant: Grant | null) {
    setChanges(previous => {
      const next = { ...previous }
      if (grant && original.rights === grant.rights && original.scope === grant.scope) delete next[original.id]
      else next[original.id] = grant
      return next
    })
    setMessage('')
  }

  function renderTree(parent: number, depth: number) {
    return branches[parent]?.map(entry => {
      const isSelected = entry.id === selected.id
      const expanded = !entry.isFile && (isSelected || path.some(ancestor => ancestor.id === entry.id))
      const individualCount = entry.directIndividualGrantCount ?? 0
      return <div key={entry.id}>
        <button className="sidebar-link" style={{ paddingInlineStart: 10 + depth * 14 }}
          aria-current={isSelected ? 'location' : undefined} onClick={() => pick(entry)}>
          <ChevronRight size={12} className={expanded ? 'grant-tree-chevron expanded' : 'grant-tree-chevron'} style={{ visibility: entry.isFile ? 'hidden' : 'visible' }} />
          <FileIcon node={entry} size={16} /><span className="ellipsis">{entry.name}</span>
          {!!entry.directGrantCount && <span className="pill">{entry.directGrantCount}</span>}
          {individualCount >= individualGrantWarningThreshold && <TriangleAlert size={14} className="grant-tree-warn" role="img"
            aria-label={`${individualCount} 条个人授权`}><title>{individualCount} 条个人授权</title></TriangleAlert>}
        </button>
        {expanded && renderTree(entry.id, depth + 1)}
      </div>
    })
  }

  const creatorSource = direct.find(entry => entry.grant.creator) ?? inherited.find(entry => entry.grant.creator)
  const creatorLabel = creatorSource ? principalName(creatorSource.grant) : '—'

  return <section aria-label="权限管理" className="grants-page">
    <nav className="grant-tree" aria-label="授权目录树">
      <div className="grant-tree-head">
        <h1>授权目录结构</h1>
        <button type="button" className="ghost grant-tree-back" disabled={saving} onClick={() => {
          if (dirty && !window.confirm('有未保存的更改，确定返回目录？')) return
          discard()
          close()
        }}><ArrowLeft size={14} aria-hidden="true" />返回目录</button>
      </div>
      <div className="grant-tree-scroll" ref={grantTree}>
        {renderTree(0, 0)}
      </div>
      <div className="grant-tree-foot">
        <span>权限台账视图</span>
        <span>数字为直接授权数</span>
      </div>
    </nav>

    <div className="grant-body">
      <header className="grant-topbar">
        <div className="grant-heading">
          <FileIcon node={selected} tile />
          <div style={{ minWidth: 0 }}>
            <h2>{selected.name}</h2>
            <nav className="grant-path" aria-label="授权目录路径">
              <span>全部文件</span><ChevronRight size={12} aria-hidden="true" />
              {path.map(entry => <button key={entry.id} type="button" className="ghost" onClick={() => pick(entry)}>{entry.name}<ChevronRight size={12} aria-hidden="true" /></button>)}
              <span aria-current="location">{selected.name}</span>
            </nav>
          </div>
        </div>

        <div className="grant-view-tabs" role="tablist" aria-label="权限视图切换">
          {canGrant && (
            <button type="button" role="tab" className="grant-view-tab"
              aria-selected={effectiveView === 'ledger'} onClick={() => setActiveView('ledger')}>
              <Shield size={14} aria-hidden="true" />授权台账
            </button>
          )}
          {canGrant && (
            <button type="button" role="tab" className="grant-view-tab"
              aria-selected={effectiveView === 'add'} onClick={() => setActiveView('add')}>
              <UserRoundPlus size={14} aria-hidden="true" />添加授权
            </button>
          )}
          <button type="button" role="tab" className="grant-view-tab"
            aria-selected={effectiveView === 'inspect'} onClick={() => setActiveView('inspect')}>
            <SearchCheck size={14} aria-hidden="true" />有效权限查询
          </button>
        </div>
      </header>

      {canGrant && (
        <div className="grant-kpi-strip">
          <div className="grant-kpis">
            <div className="grant-kpi">
              <span>直接授权</span>
              <strong>{direct.length + added.length}</strong>
            </div>
            <div className="grant-kpi">
              <span>上层继承</span>
              <strong>{inherited.length}</strong>
            </div>
            <div className="grant-kpi">
              <span>创建者归属</span>
              <strong className="grant-kpi-creator">{creatorLabel}</strong>
            </div>
          </div>
          <span className="grant-kpi-hint">权限按「只读访问 / 内容变更 / 管理控制」三组审计列示</span>
        </div>
      )}

      <div className="grant-scroll">
        {!canGrant && <p className="grant-inline-notice">当前项目没有授权权限，可查看自己的有效权限。</p>}
        {selected.isFile && canGrant && <p className="grant-inline-notice">{parentCanGrant
          ? '您可以移除或转移创建者授权。'
          : '只能分享给已能看到父目录的人。移除或转移创建者授权需要父目录的授权权限。'}</p>}
        {canGrant && individualGrants >= individualGrantWarningThreshold && (
          <p className="grant-inline-notice grant-nudge">此处有 {individualGrants} 条个人授权。可将同一职责的人员加入用户组，再统一授权。</p>
        )}
        {message && <p className={'banner ' + (message === '授权已保存' ? 'success' : 'error')}
          role={message === '授权已保存' ? 'status' : 'alert'}>{message}</p>}

        {transferSource && <fieldset className="grant-handover-card">
          <legend>转移创建者</legend>
          <p>{selected.name} · 原创建者 {principalName(transferSource.grant)}</p>
          {administrator ? <GrantPrincipalPicker kind="user" options={users?.filter(user => !user.detail && user.id !== transferSource.grant.principalId)}
            selected={successor} onPick={setSuccessor} disabled={saving} />
            : <label className="grant-manual-id">接任者用户 ID<input type="number" min="1" onChange={event => setSuccessor(event.target.valueAsNumber)} /></label>}
          <div className="form-actions">
            <button type="button" onClick={() => setTransferSource(undefined)}>取消移交</button>
            <button type="button" className="primary" disabled={saving || !Number.isSafeInteger(successor) || !successor || successor < 1 || successor === transferSource.grant.principalId}
              onClick={() => { setHandover({ source: transferSource, userId: successor! }); setTransferSource(undefined) }}>加入移交草稿</button>
          </div>
        </fieldset>}

        {effectiveView === 'ledger' && canGrant && (
          <div className="grant-table" tabIndex={0} role="region" aria-label="权限矩阵">
            <table>
              <colgroup>
                <col className="col-principal" />
                <col className="col-preset" />
                {rights.map(([bit]) => <col key={bit} className="col-bit" />)}
                <col className="col-scope" />
                <col className="col-action" />
              </colgroup>
              <thead>
                <tr className="grant-tier-1">
                  <th colSpan={2} style={{ textAlign: 'left', paddingLeft: 24 }}>主体与策略预设</th>
                  <th colSpan={2} className="grant-grp-start">只读访问</th>
                  <th colSpan={3} className="grant-grp-start">内容变更</th>
                  <th colSpan={1} className="grant-grp-start">管理</th>
                  <th colSpan={2} className="grant-grp-start" style={{ textAlign: 'right', paddingRight: 24 }}>作用域与操作</th>
                </tr>
                <tr className="grant-tier-2">
                  <th scope="col">对象</th>
                  <th scope="col">预设</th>
                  {rights.map(([bit, label]) => (
                    <th scope="col" key={bit} className={bit === 1 || bit === 4 || bit === 32 ? 'grant-grp-start' : undefined}>{label}</th>
                  ))}
                  <th scope="col" className="grant-grp-start">范围／来源</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr className="grant-group"><td colSpan={10}>直接授权 · {direct.length}</td></tr>
                {!direct.length && !added.length && (
                  <tr>
                    <td colSpan={10} style={{ padding: 0 }}>
                      <div className="grant-empty-cell">
                        <strong>{busy ? '正在加载…' : '此处没有直接授权'}</strong>
                        {!busy && <>
                          <span>当前目录访问权限由上层目录继承，可点击下方按钮补充专项权限策略。</span>
                          <div style={{ marginTop: 4 }}>
                            <button type="button" className="primary" onClick={() => setActiveView('add')}>
                              <UserRoundPlus size={15} aria-hidden="true" />添加授权
                            </button>
                          </div>
                        </>}
                      </div>
                    </td>
                  </tr>
                )}
                {direct.map(source => {
                  const original = source.grant
                  const changed = original.id in changes
                  const grant = changed ? changes[original.id] : original
                  const locked = original.creator
                  const inheritedRights = inherited.filter(entry => entry.grant.principalKind === original.principalKind
                    && entry.grant.principalId === original.principalId).reduce((acc, entry) => acc | entry.grant.rights, 0)
                  return <tr key={original.id} className={changed ? 'draft-row' : undefined}>
                    <td>{principalCell(original, !grant ? { label: '待移除', tone: 'danger' } : changed ? { label: '已改', tone: 'accent' } : undefined)}</td>
                    <td>{grant && (locked ? <span className="grant-tag accent">完全控制</span> : <Preset value={grant.rights} disabled={saving} setValue={nextRights => change(original, { ...grant, rights: nextRights })} />)}</td>
                    {rights.map(([bit, label]) => {
                      const groupStart = bit === 1 || bit === 4 || bit === 32
                      const bitLocked = locked || !!(inheritedRights & bit)
                      const checked = !!(grant && (grant.rights & bit))
                      return <td key={bit} className={groupStart ? 'grant-grp-start' : undefined} title={inheritedRights & bit ? '已从上级继承' : undefined}>
                        {bitLocked ? (
                          <span className="grant-bit-lock">
                            <Lock size={12} aria-label={`${label}（锁定）`} />
                          </span>
                        ) : grant ? (
                          <button type="button" role="checkbox" aria-checked={checked}
                            aria-label={`${principalName(grant)} ${label}`}
                            className="grant-bit-tile" disabled={saving}
                            onClick={() => {
                              const nextRights = toggleRight(grant.rights, bit, !checked)
                              change(original, nextRights ? { ...grant, rights: nextRights } : null)
                            }}>
                            <Check size={14} strokeWidth={2.4} aria-hidden="true" />
                          </button>
                        ) : (
                          <span className="grant-bit-empty" aria-hidden="true">—</span>
                        )}
                      </td>
                    })}
                    <td className="grant-grp-start">{grant && (selected.isFile ? '此文件' : <Scope value={grant.scope} disabled={saving || locked}
                      onChange={nextScope => change(original, { ...grant, scope: nextScope })} />)}</td>
                    <td>
                      <div className="grant-row-actions">
                        {grant && locked && parentCanGrant && (
                          <button type="button" className="ghost" disabled={saving || !!handover}
                            onClick={() => { setSuccessor(undefined); setTransferSource(source) }}>转移创建者</button>
                        )}
                        <button type="button" className={changed ? 'ghost' : 'ghost grant-delete-btn'}
                          disabled={saving || transferSource?.grant.id === original.id || handover?.source.grant.id === original.id || (locked && !parentCanGrant)}
                          onClick={() => change(original, changed ? original : null)}>{changed ? '撤销草稿' : '删除授权'}</button>
                      </div>
                    </td>
                  </tr>
                })}
                {added.map((grant, index) => <tr className="draft-row" key={index}>
                  <td>{principalCell(grant, { label: '草稿', tone: 'accent' })}</td>
                  <td><span className="pill">{presets.find(([presetVal]) => presetVal === grant.rights)?.[1] ?? '自定义'} · 待保存</span></td>
                  {rights.map(([bit, label]) => {
                    const groupStart = bit === 1 || bit === 4 || bit === 32
                    return <td key={bit} className={groupStart ? 'grant-grp-start' : undefined}>
                      {grant.rights & bit ? (
                        <span className="grant-bit-tile is-static" aria-checked="true" aria-label={label}>
                          <Check size={14} strokeWidth={2.4} aria-hidden="true" />
                        </span>
                      ) : (
                        <span className="grant-bit-empty" aria-hidden="true">·</span>
                      )}
                    </td>
                  })}
                  <td className="grant-grp-start">{selected.isFile ? '此文件' : grant.scope === 'subtree' ? '本层及以下' : '仅本层'}</td>
                  <td>
                    <div className="grant-row-actions">
                      <button type="button" className="ghost" onClick={() => setAdded(entries => entries.filter((_, i) => i !== index))}>移除草稿</button>
                    </div>
                  </td>
                </tr>)}
                {!!inherited.length && <tr className="grant-group"><td colSpan={10}><button type="button" className="ghost" aria-expanded={showInherited}
                  onClick={() => setShowInherited(prev => !prev)}><ChevronRight className={showInherited ? 'grant-expanded' : undefined} size={15} />
                  从上层继承 · {inherited.length}</button></td></tr>}
                {showInherited && inherited.map(source => <tr key={source.grant.id} className="muted">
                  <td>{principalCell(source.grant)}</td>
                  <td><span className="grant-tag">{presets.find(([presetVal]) => presetVal === source.grant.rights)?.[1] ?? '自定义'}</span></td>
                  {rights.map(([bit, label]) => {
                    const groupStart = bit === 1 || bit === 4 || bit === 32
                    return <td key={bit} className={groupStart ? 'grant-grp-start' : undefined}>
                      {source.grant.rights & bit ? (
                        <span className="grant-bit-lock">
                          <Lock size={12} aria-label={`${label}（继承）`} />
                        </span>
                      ) : (
                        <span className="grant-bit-empty" aria-hidden="true">·</span>
                      )}
                    </td>
                  })}
                  <td colSpan={2} className="grant-grp-start" style={{ textAlign: 'right', paddingRight: 24 }}>
                    {path.some(entry => entry.id === source.sourceId) ? <button type="button" className="ghost grant-source" onClick={() => {
                      const parent = path.find(entry => entry.id === source.sourceId)
                      if (parent) pick(parent)
                    }}>{source.sourcePath}</button> : source.sourcePath}
                  </td>
                </tr>)}
              </tbody>
            </table>
          </div>
        )}

        {effectiveView === 'add' && canGrant && (
          <form className="grant-add-grid" key={selected.id} onSubmit={event => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            const id = options ? principalId : Number(form.get('principal'))
            if (!id || !Number.isSafeInteger(id) || id < 1) return
            setAdded(previous => [...previous, {
              principalKind,
              principalId: id,
              rights: value,
              scope: selected.isFile ? 'subtree' : scope,
            }])
            setPrincipalId(undefined)
            setMessage('')
            setActiveView('ledger')
          }}>
            <div className="grant-composer-card">
              <div className="grant-step-kicker">
                <strong>1. 选定授权主体</strong>
                <span>用户组 / 组织 / 个人</span>
              </div>
              <div className="grant-picker">
                <div className="grant-principal-tabs" role="group" aria-label="授权对象类型">
                  {principalKinds.map(kind => {
                    const Icon = principalIcons[kind]
                    return <button type="button" key={kind} aria-pressed={principalKind === kind} onClick={() => {
                      if (principalKind === kind) return
                      setPrincipalKind(kind)
                      setPrincipalId(undefined)
                    }}><Icon size={15} aria-hidden="true" />{principalLabels[kind]}</button>
                  })}
                </div>
                {options ? <GrantPrincipalPicker key={principalKind} kind={principalKind} options={options}
                  selected={principalId} onPick={setPrincipalId} disabled={saving} />
                  : <label className="grant-manual-id">{principalLabels[principalKind]}编号<input key={principalKind} name="principal" type="number" min="1" required disabled={saving} /></label>}
              </div>
            </div>

            <div className="grant-composer-card">
              <div className="grant-step-kicker">
                <strong>2. 策略预设与分组细项</strong>
                <span>勾选细项时自动补全依赖权限</span>
              </div>

              <div className="grant-field-block">
                <span>快捷预设</span>
                <div className="grant-preset-strip">
                  {presets.map(([presetVal, label]) => (
                    <button key={presetVal} type="button" className="grant-preset-pill"
                      aria-pressed={value === presetVal} disabled={saving}
                      onClick={() => setValue(presetVal)}>{label}</button>
                  ))}
                </div>
              </div>

              <div className="grant-tier-groups" role="group" aria-label="权限细项">
                {([
                  ['只读访问', readRights],
                  ['内容变更', writeRights],
                  ['管理控制', adminRights],
                ] as const).map(([title, groupRights]) => (
                  <div className="grant-tier-card" key={title}>
                    <div className="grant-tier-card-head">{title}</div>
                    {groupRights.map(([bit, label]) => {
                      const checked = !!(value & bit)
                      return <label key={bit} className="grant-right-toggle" data-checked={checked ? 'true' : undefined}>
                        <input type="checkbox" disabled={saving} checked={checked}
                          onChange={event => setValue(toggleRight(value, bit, event.target.checked))} />
                        <span>{label}</span>
                      </label>
                    })}
                  </div>
                ))}
              </div>

              {!selected.isFile && (
                <label className="grant-field-block grant-scope-field">
                  <span>生效范围</span>
                  <Scope name="scope" value={scope} disabled={saving} onChange={setScope} />
                </label>
              )}

              <div className="grant-composer-foot">
                <button type="button" onClick={() => setActiveView('ledger')}>返回台账</button>
                <button className="primary" disabled={!value || busy || saving || (!!options && !principalId)}>添加到草稿</button>
              </div>
            </div>
          </form>
        )}

        {effectiveView === 'inspect' && (
          <div className="grant-inspect-pane">
            <PermissionInspection key={`${selected.id}-${revision}`} node={selected} administrator={administrator} />
          </div>
        )}
      </div>

      {dirty && <div className="grant-save">
        <div className="grant-save-summary">
          {handover && <p>移交「{selected.name}」：{principalName(handover.source.grant)} → {principalName({ ...handover.source.grant, principalId: handover.userId })}
            <button type="button" className="ghost" style={{ marginLeft: 8, minHeight: 26, padding: '0 8px' }} disabled={saving} onClick={() => setHandover(undefined)}>撤销移交</button></p>}
          {impact && <div aria-label="授权影响预览">
            <p>权限变化：{impact.changedUsers} 位用户，覆盖 {impact.coveredItems} 个项目。</p>
            {impact.warnings.map(warning => <p role="alert" key={warning}>{warning === 'self_grant_loss'
              ? '保存后您将失去此项目的授权权限。' : '此授权将向大型组织或用户组开放整个大型子树，请确认范围。'}</p>)}
          </div>}
        </div>
        <button type="button" className="ghost" disabled={saving} onClick={discard}>放弃更改</button>
        <button type="button" className="primary" disabled={!impact || saving || !!transferSource} onClick={() => void save()}>保存全部授权</button>
      </div>}
    </div>
  </section>
}

function GrantPrincipalPicker({ kind, options, selected, onPick, disabled }: {
  kind: PrincipalKind
  options?: Principal[]
  selected?: number
  onPick: (id?: number) => void
  disabled: boolean
}) {
  const [query, setQuery] = useState('')
  const picked = options?.find(entry => selected === entry.id)
  const matches = options?.filter(entry => matchesSearch(query, entry.name)) ?? []
  if (picked) return <div className="grant-picked">
    <span><strong>{picked.name}</strong>{picked.detail && <small>{picked.detail}</small>}</span>
    <button type="button" className="ghost icon" aria-label="重新选择授权对象" disabled={disabled}
      onClick={() => onPick(undefined)}><X size={16} /></button>
  </div>
  return <>
    <DirectorySearch label={'搜索' + principalLabels[kind]} value={query} onChange={setQuery} />
    <ul className="record-list grant-matches">{matches.slice(0, 6).map(entry => <li key={entry.id}>
      <button type="button" className="record-link" onClick={() => onPick(entry.id)} disabled={disabled}>
        <span>{entry.name}{entry.detail && <small>{entry.detail}</small>}</span><ChevronRight size={14} />
      </button>
    </li>)}</ul>
    {matches.length > 6 && <small className="muted">继续搜索以缩小范围</small>}
    {!matches.length && <small className="muted">{query.trim() ? '没有匹配的结果' : '暂无可选对象'}</small>}
  </>
}

function Preset({ value, setValue, disabled }: { value: number; setValue: (value: number) => void; disabled?: boolean }) {
  return <select aria-label="权限预设" value={value} disabled={disabled} onChange={event => setValue(Number(event.target.value))}>
    {!presets.some(([id]) => id === value) && <option value={value}>自定义</option>}
    {presets.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
  </select>
}

function Scope({ name, value, disabled, onChange }: {
  name?: string; value?: Grant['scope']; disabled?: boolean; onChange?: (scope: Grant['scope']) => void
}) {
  return <select aria-label="范围" name={name} value={value} disabled={disabled} onChange={event =>
    onChange?.(event.target.value as Grant['scope'])}>
    <option value="subtree">本层及以下</option><option value="this_level_only">仅本层</option>
  </select>
}

export function PermissionInspection({ node, administrator }: { node: Node; administrator: boolean }) {
  const managedUsers = useManagedUsers(administrator)
  const users = managedUsers?.map<Principal>(user => ({
    id: user.id,
    name: user.displayName + '（' + user.username + '）',
    detail: user.status === 'deactivated' ? '已停用' : undefined,
  }))
  const [person, setPerson] = useState<number>()
  const [inspection, setInspection] = useState<components['schemas']['PermissionInspection']>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function inspect(userId?: number) {
    if (busy) return
    setBusy(true)
    setMessage('')
    setInspection(undefined)
    try {
      const { data, response } = await api.GET('/tree/{id}/permission', {
        params: { path: { id: node.id }, query: { userId } },
      })
      if (data) setInspection(data)
      else setMessage(`查询失败（HTTP ${response.status}）`)
    } catch {
      setMessage('无法连接服务器')
    } finally {
      setBusy(false)
    }
  }

  return <section className="permission-query" aria-label="有效权限查询">
    <div className="form-actions"><button type="button" className="primary" disabled={busy} onClick={() => void inspect()}>查询我的有效权限</button></div>
    {administrator && <form onSubmit={event => {
      event.preventDefault()
      if (person) void inspect(person)
    }}>
      <GrantPrincipalPicker kind="user" options={users} selected={person} onPick={setPerson} disabled={busy} />
      <div><button disabled={busy || !person}>查询用户有效权限</button></div>
    </form>}
    {busy && <p className="muted" role="status">正在查询…</p>}
    {message && <p className="banner error" role="alert">{message}</p>}
    {inspection && <div className="grant-inspect-result">
      <div className="section-heading"><h3>{users?.find(user => user.id === inspection.userId)?.name ?? '用户 #' + inspection.userId}</h3>
        {inspection.administrator && <span className="pill">管理员</span>}</div>
      <div className="chip-list">
        {rights.filter(([bit]) => inspection.rights & bit).map(([bit, label]) => <span key={bit} className="pill">{label}</span>)}
        {!inspection.rights && <span className="pill neutral">{inspection.traversable ? '仅可穿越祖先目录' : '无权限'}</span>}
      </div>
      {!!inspection.sources.length && <ul className="record-list permission-sources">{inspection.sources.map(source =>
        <li key={source.grant.id}>
          <strong>{source.inherited ? '继承自' : '直接授权于'} {source.sourcePath}</strong>
          <small className="muted">{principalLabels[source.grant.principalKind]} #{source.grant.principalId} · {
            rights.filter(([bit]) => source.grant.rights & bit).map(([, name]) => name).join('、')
          }</small>
        </li>)}</ul>}
    </div>}
  </section>
}
