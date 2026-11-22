import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, Building2, ChevronRight, Lock, TriangleAlert, UserRound, UserRoundPlus, Users, X } from 'lucide-react'
import { DirectorySearch, matchesSearch } from './DirectorySearch'
import { PageHeading } from './PageHeading'
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
const principalLabels = { user: '用户', organization: '组织', user_group: '用户组' }
const principalKinds = ['user_group', 'organization', 'user'] as const
const principalIcons = { user: UserRound, organization: Building2, user_group: Users }
const principalOrder = (grant: Grant) => grant.creator ? -1 : principalKinds.indexOf(grant.principalKind)
const individualGrantWarningThreshold = 10

function useUserOptions(administrator: boolean) {
  const [users, setUsers] = useState<Principal[]>()
  useEffect(() => {
    if (!administrator) return
    const controller = new AbortController()
    void api.GET('/managed-users', { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) setUsers(data?.map(user => ({
        id: user.id, name: user.displayName + '（' + user.username + '）',
        detail: user.status === 'deactivated' ? '已停用' : undefined,
      })))
    }).catch(() => {})
    return () => controller.abort()
  }, [administrator])
  return administrator ? users : undefined
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
  const [sources, setSources] = useState<Source[]>([])
  const [added, setAdded] = useState<Grant[]>([])
  const [changes, setChanges] = useState<Record<number, Grant | null>>({})
  const [impact, setImpact] = useState<components['schemas']['GrantImpact']>()
  const [value, setValue] = useState(3)
  const [principalKind, setPrincipalKind] = useState<PrincipalKind>('user_group')
  const [principalId, setPrincipalId] = useState<number>()
  const [principals, setPrincipals] = useState<Partial<Record<PrincipalKind, Principal[]>>>({})
  const [showInherited, setShowInherited] = useState(true)
  const [message, setMessage] = useState('')
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [parentCanGrant, setParentCanGrant] = useState(administrator)
  const grantTree = useRef<HTMLElement>(null)
  const users = useUserOptions(administrator)
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
    const options = { signal: controller.signal }
    void Promise.all([api.GET('/organizations', options), api.GET('/user-groups', options)])
      .then(([organizations, groups]) => {
        if (controller.signal.aborted) return
        setPrincipals({
          organization: organizations.data,
          user_group: groups.data?.map(group => ({ id: group.id, name: group.name, detail: group.userIds.length + ' 位成员' })),
        })
      }).catch(() => {
        if (!controller.signal.aborted) setPrincipals({})
      })
    return () => controller.abort()
  }, [administrator])

  function principalName(grant: Grant) {
    return (grant.principalKind === 'user' ? users : principals[grant.principalKind])?.find(entry => entry.id === grant.principalId)?.name
      ?? principalLabels[grant.principalKind] + ' #' + grant.principalId
  }

  function principalCell(grant: Grant) {
    const Icon = principalIcons[grant.principalKind]
    return <span className="grant-principal"><Icon size={16} aria-hidden="true" />
      <span><strong>{principalName(grant)}</strong><small>{grant.creator ? '创建者' : principalLabels[grant.principalKind]}</small></span>
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
        <button className="sidebar-link" style={{ paddingInlineStart: 8 + depth * 12 }}
          aria-current={isSelected ? 'location' : undefined} onClick={() => pick(entry)}>
          <ChevronRight size={12} className={expanded ? 'expanded' : undefined} style={{ visibility: entry.isFile ? 'hidden' : 'visible' }} />
          <FileIcon node={entry} size={16} /><span className="ellipsis">{entry.name}</span>
          {!!entry.directGrantCount && <span className="pill">{entry.directGrantCount}</span>}
          {individualCount >= individualGrantWarningThreshold && <TriangleAlert size={14} role="img"
            aria-label={`${individualCount} 条个人授权`}><title>{individualCount} 条个人授权</title></TriangleAlert>}
        </button>
        {expanded && renderTree(entry.id, depth + 1)}
      </div>
    })
  }

  return <section aria-label="权限管理" className="grants-page">
    <PageHeading title="权限管理" actions={
      <button className="ghost" disabled={saving} onClick={() => {
        if (dirty && !window.confirm('有未保存的更改，确定返回目录？')) return
        discard()
        close()
      }}><ArrowLeft size={16} />返回目录</button>
    } />
    <div className="tree-layout">
      <nav className="grant-tree panel" aria-label="授权目录树" ref={grantTree}>
        <h2>授权目录</h2>{renderTree(0, 0)}
      </nav>
      <div className="grant-body panel">
        <div className="grant-heading">
          <FileIcon node={selected} tile /><div><h2>{selected.name}</h2>
            <nav className="grant-path" aria-label="授权目录路径">
              <span>共享目录</span><ChevronRight size={12} />
              {path.map(entry => <button key={entry.id} className="ghost" onClick={() => pick(entry)}>{entry.name}<ChevronRight size={12} /></button>)}
              <span aria-current="location">{selected.name}</span>
            </nav>
          </div>
        </div>
        {!canGrant && <p className="notice">当前项目没有授权权限，可查看自己的有效权限。</p>}
        {selected.isFile && canGrant && <p className="notice">{parentCanGrant
          ? '您可以移除或转移创建者授权。'
          : '只能分享给已能看到父目录的人。移除或转移创建者授权需要父目录的授权权限。'}</p>}
        {canGrant && <details className="grant-add" key={selected.id}><summary><UserRoundPlus size={16} />添加人员、组织或用户组<ChevronRight className="grant-disclosure" size={16} /></summary>
        <form className="grant-form" onSubmit={event => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          const id = options ? principalId : Number(form.get('principal'))
          if (!id || !Number.isSafeInteger(id) || id < 1) return
          setAdded(previous => [...previous, {
            principalKind,
            principalId: id, rights: value,
            scope: selected.isFile ? 'subtree' : form.get('scope') as Grant['scope'],
          }])
          setPrincipalId(undefined)
          setMessage('')
        }}>
          <div className="grant-picker">
            <div className="membership-tabs" role="group" aria-label="授权对象类型">
              {principalKinds.map(kind => {
                const Icon = principalIcons[kind]
                return <button type="button" key={kind} className="ghost" aria-pressed={principalKind === kind} onClick={() => {
                  if (principalKind === kind) return
                  setPrincipalKind(kind)
                  setPrincipalId(undefined)
                }}><Icon size={16} />{principalLabels[kind]}</button>
              })}
            </div>
            {options ? <GrantPrincipalPicker key={principalKind} kind={principalKind} options={options}
              selected={principalId} onPick={setPrincipalId} disabled={saving} />
              : <label>{principalLabels[principalKind]}编号<input key={principalKind} name="principal" type="number" min="1" required disabled={saving} /></label>}
          </div>
          <div className="grant-config">
            <label>权限预设<Preset value={value} setValue={setValue} disabled={saving} /></label>
            {!selected.isFile && <label>范围<Scope name="scope" disabled={saving} /></label>}
            <button className="primary" disabled={!value || busy || saving || (!!options && !principalId)}>添加到草稿</button>
          </div>
          <fieldset><legend>权限细项</legend>{rights.map(([bit, label]) =>
            <label key={bit}><input type="checkbox" disabled={saving} checked={!!(value & bit)} onChange={event =>
              setValue(toggleRight(value, bit, event.target.checked))} />{label}</label>)}</fieldset>
        </form></details>}
        {canGrant && individualGrants >= individualGrantWarningThreshold && <p className="notice grant-nudge">此处有 {individualGrants} 条个人授权。可将同一职责的人员加入用户组，再统一授权。</p>}
        {canGrant && <div className="grant-table" tabIndex={0} role="region" aria-label="权限矩阵">
          <table><thead><tr><th scope="col">对象</th><th scope="col">预设</th>{rights.map(([bit, label]) => <th scope="col" key={bit}>{label}</th>)}<th scope="col">范围／来源</th><th scope="col">操作</th></tr></thead>
            <tbody>
              <tr className="grant-group"><td colSpan={10}>直接授权 · {direct.length}</td></tr>
              {!direct.length && !added.length && <tr><td colSpan={10} className="muted">{busy ? '正在加载…' : '此处没有直接授权'}</td></tr>}
              {direct.map(source => {
                const original = source.grant
                const changed = original.id in changes
                const grant = changed ? changes[original.id] : original
                const locked = original.creator
                const inheritedRights = inherited.filter(entry => entry.grant.principalKind === original.principalKind
                  && entry.grant.principalId === original.principalId).reduce((value, entry) => value | entry.grant.rights, 0)
                return <tr key={original.id} className={changed ? 'draft-row' : undefined}>
                  <td>{principalCell(original)}{!grant && <small className="muted">待移除</small>}</td>
                  <td>{grant && (locked ? '完全控制' : <Preset value={grant.rights} disabled={saving} setValue={rights => change(original, { ...grant, rights })} />)}</td>
                  {rights.map(([bit, label]) => <td key={bit} title={inheritedRights & bit ? '已从上级继承' : undefined}>
                    {locked || !!(inheritedRights & bit) ? <Lock size={13} aria-label={`${label}（锁定）`} /> : grant &&
                      <input type="checkbox" aria-label={`${principalName(grant)} ${label}`}
                        checked={!!(grant.rights & bit)} disabled={saving} onChange={event => {
                          const rights = toggleRight(grant.rights, bit, event.target.checked)
                          change(original, rights ? { ...grant, rights } : null)
                        }} />}
                  </td>)}
                  <td>{grant && (selected.isFile ? '此文件' : <Scope value={grant.scope} disabled={saving || locked}
                    onChange={scope => change(original, { ...grant, scope })} />)}</td>
                  <td><button className="ghost" disabled={saving || transferSource?.grant.id === original.id || handover?.source.grant.id === original.id || (locked && !parentCanGrant)}
                    onClick={() => change(original, changed ? original : null)}>{changed ? '撤销草稿' : '删除授权'}</button>
                    {grant && locked && parentCanGrant && <button disabled={saving || !!handover} onClick={() => { setSuccessor(undefined); setTransferSource(source) }}>转移创建者</button>}</td>
                </tr>
              })}
              {added.map((grant, index) => <tr className="draft-row" key={index}>
                <td>{principalCell(grant)}</td>
                <td><span className="pill">{presets.find(([value]) => value === grant.rights)?.[1] ?? '自定义'} · 待保存</span></td>
                {rights.map(([bit, label]) => <td key={bit}>{grant.rights & bit ? <span aria-label={label}>✓</span> : ''}</td>)}
                <td>{selected.isFile ? '此文件' : grant.scope === 'subtree' ? '本层及以下' : '仅本层'}</td>
                <td><button className="ghost" onClick={() => setAdded(entries => entries.filter((_, i) => i !== index))}>移除草稿</button></td>
              </tr>)}
              {!!inherited.length && <tr className="grant-group"><td colSpan={10}><button className="ghost" aria-expanded={showInherited}
                onClick={() => setShowInherited(value => !value)}><ChevronRight className={showInherited ? 'grant-expanded' : undefined} size={16} />
                从上层继承 · {inherited.length}</button></td></tr>}
              {showInherited && inherited.map(source => <tr key={source.grant.id} className="muted">
                <td>{principalCell(source.grant)}</td>
                <td>{presets.find(([value]) => value === source.grant.rights)?.[1] ?? '自定义'}</td>
                {rights.map(([bit, label]) => <td key={bit}>{source.grant.rights & bit ? <Lock size={13} aria-label={`${label}（继承）`} /> : ''}</td>)}
                <td colSpan={2}>{path.some(entry => entry.id === source.sourceId) ? <button className="ghost grant-source" onClick={() => {
                  const parent = path.find(entry => entry.id === source.sourceId)
                  if (parent) pick(parent)
                }}>{source.sourcePath}</button> : source.sourcePath}</td>
              </tr>)}
            </tbody>
          </table>
        </div>}
        {transferSource && <fieldset className="stack">
          <legend>转移创建者</legend>
          <p>{selected.name} · 原创建者 {principalName(transferSource.grant)}</p>
          {administrator ? <GrantPrincipalPicker kind="user" options={users?.filter(user => !user.detail && user.id !== transferSource.grant.principalId)}
            selected={successor} onPick={setSuccessor} disabled={saving} />
            : <label>接任者用户 ID<input type="number" min="1" onChange={event => setSuccessor(event.target.valueAsNumber)} /></label>}
          <div className="form-actions">
            <button onClick={() => setTransferSource(undefined)}>取消移交</button>
            <button disabled={saving || !Number.isSafeInteger(successor) || !successor || successor < 1 || successor === transferSource.grant.principalId}
              onClick={() => { setHandover({source: transferSource, userId: successor!}); setTransferSource(undefined) }}>加入移交草稿</button>
          </div>
        </fieldset>}
        {dirty && <div className="grant-save">
          {handover && <p>移交「{selected.name}」：{principalName(handover.source.grant)} → {principalName({ ...handover.source.grant, principalId: handover.userId })}
            <button disabled={saving} onClick={() => setHandover(undefined)}>撤销移交</button></p>}
          {impact && <div aria-label="授权影响预览">
            <p>权限变化：{impact.changedUsers} 位用户，覆盖 {impact.coveredItems} 个项目。</p>
            {impact.warnings.map(warning => <p role="alert" key={warning}>{warning === 'self_grant_loss'
              ? '保存后您将失去此项目的授权权限。' : '此授权将向大型组织或用户组开放整个大型子树，请确认范围。'}</p>)}
          </div>}
          <button type="button" className="ghost" disabled={saving} onClick={discard}>放弃更改</button>
          <button type="button" className="primary" disabled={!impact || saving || !!transferSource} onClick={() => void save()}>保存全部授权</button>
        </div>}
        <details className="permission-inspection"><summary>有效权限查询</summary>
          <PermissionInspection key={`${selected.id}-${revision}`} node={selected} administrator={administrator} />
        </details>
        {message && <p className={'banner ' + (message === '授权已保存' ? 'success' : 'error')}
          role={message === '授权已保存' ? 'status' : 'alert'}>{message}</p>}
      </div>
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
  const users = useUserOptions(administrator)
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
    <div className="form-actions"><button className="primary" disabled={busy} onClick={() => void inspect()}>查询我的有效权限</button></div>
    {administrator && <form onSubmit={event => {
      event.preventDefault()
      if (person) void inspect(person)
    }}>
      <GrantPrincipalPicker kind="user" options={users} selected={person} onPick={setPerson} disabled={busy} />
      <button disabled={busy || !person}>查询用户有效权限</button>
    </form>}
    {busy && <p className="muted" role="status">正在查询…</p>}
    {message && <p className="banner error" role="alert">{message}</p>}
    {inspection && <div>
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
