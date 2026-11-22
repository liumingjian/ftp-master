import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Building2, ChevronRight, FileUp, Plus, UserRound, Users, X } from 'lucide-react'
import { DirectorySearch, matchesSearch } from './DirectorySearch'
import { ImportUsersPanel } from './ImportUsersPanel'
import { PageHeading } from './PageHeading'
import { api } from './api/client'
import type { components } from './api/schema.gen'

type Organization = components['schemas']['Organization']
type UserGroup = components['schemas']['UserGroup']
type User = components['schemas']['ManagedUser']
type View = 'organizations' | 'groups' | 'users'
type Editor =
  | { kind: 'organization'; id?: number; name: string; parentId: string }
  | { kind: 'group'; name: string }
  | { kind: 'members'; id: number; ids: number[] }
  | { kind: 'user'; id: number; organizationId: string }
  | { kind: 'import' }

const views = [
  { id: 'organizations', label: '组织', icon: Building2 },
  { id: 'groups', label: '用户组', icon: Users },
  { id: 'users', label: '用户', icon: UserRound },
] as const

function organizationRows(organizations: Organization[]) {
  const children = new Map<number | null, Organization[]>()
  for (const organization of organizations) {
    const parent = organization.parentId ?? null
    const siblings = children.get(parent) ?? []
    siblings.push(organization)
    children.set(parent, siblings)
  }
  const rows: { organization: Organization; ancestors: Organization[] }[] = []
  function visit(organization: Organization, ancestors: Organization[]) {
    rows.push({ organization, ancestors })
    for (const child of children.get(organization.id) ?? []) visit(child, [...ancestors, organization])
  }
  for (const root of children.get(null) ?? []) visit(root, [])
  return rows
}

export function MembershipPanel() {
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [groups, setGroups] = useState<UserGroup[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [view, setView] = useState<View>('organizations')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [editor, setEditor] = useState<Editor>()
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const tree = organizationRows(organizations)
  const organizationById = new Map(organizations.map(entry => [entry.id, entry]))
  const groupById = new Map(groups.map(entry => [entry.id, entry]))
  const userById = new Map(users.map(entry => [entry.id, entry]))
  const organizationNames = new Map(tree.map(({ organization, ancestors }) =>
    [organization.id, [...ancestors.map(parent => parent.name), organization.name].join(' / ')]))
  const memberCounts = new Map<number, number>()
  for (const user of users) memberCounts.set(user.organizationId, (memberCounts.get(user.organizationId) ?? 0) + 1)

  async function reload(signal?: AbortSignal) {
    const [orgs, teams, people] = await Promise.all([
      api.GET('/organizations', { signal }), api.GET('/user-groups', { signal }), api.GET('/managed-users', { signal }),
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

  async function run(work: () => Promise<{ response: Response }>, success: string, failure: string) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const { response } = await work()
      if (!response.ok) {
        setError(failure)
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
    const body = { name: draft.name.trim(), parentId: draft.parentId ? Number(draft.parentId) : null }
    if (!body.name) return setError('请输入组织名称')
    void run(() => draft.id
      ? api.PATCH('/organizations/{id}', { params: { path: { id: draft.id } }, body })
      : api.POST('/organizations', { body }), '组织已保存', '无法保存组织，请检查名称和上级组织')
  }

  const filteredOrganizations = tree.filter(({ organization }) => matchesSearch(query, organizationNames.get(organization.id) ?? organization.name))
  const filteredGroups = groups.filter(entry => matchesSearch(query, entry.name))
  const filteredUsers = users.filter(entry => (!status || status === entry.status)
    && matchesSearch(query, entry.username, entry.displayName, organizationNames.get(entry.organizationId) ?? ''))
  const editedUser = editor?.kind === 'user' ? userById.get(editor.id) : undefined
  const editedGroup = editor?.kind === 'members' ? groupById.get(editor.id) : undefined

  return <section className="workspace-page membership-page" aria-label="组织与用户组管理">
    <PageHeading title="组织与用户组管理" />
    <div className="membership-tabs" role="group" aria-label="管理对象">
      {views.map(({ id, label, icon: Icon }) => <button type="button" key={id} className="ghost"
        aria-pressed={view === id} onClick={() => { if (view !== id) { setView(id); setQuery(''); setFeedback('') } }}>
        <Icon size={16} />{label}
      </button>)}
    </div>
    {feedback && <p className="banner success" role="status">{feedback}</p>}
    {loadFailed && <div className="banner error membership-retry" role="alert">
      <span>无法加载管理数据</span><button onClick={() => void load()}>重试</button>
    </div>}
    <div className="membership-card">
      <div className="membership-toolbar">
        <DirectorySearch label={view === 'users' ? '搜索姓名、用户名或组织' : view === 'groups' ? '搜索用户组' : '搜索组织'}
          value={query} onChange={setQuery} />
        {view === 'users' && <select aria-label="用户状态" value={status} onChange={event => setStatus(event.target.value)}>
          <option value="">全部状态</option><option value="active">已激活</option><option value="deactivated">已停用</option>
        </select>}
        <div className="membership-toolbar-actions">
          {view === 'organizations' && <button className="primary" disabled={loading || loadFailed}
            onClick={() => open({ kind: 'organization', name: '', parentId: '' })}><Plus size={16} />新建组织</button>}
          {view === 'groups' && <button className="primary" disabled={loading || loadFailed}
            onClick={() => open({ kind: 'group', name: '' })}><Plus size={16} />新建用户组</button>}
          {view === 'users' && <button disabled={loading || loadFailed} onClick={() => open({ kind: 'import' })}>
            <FileUp size={16} />批量导入用户
          </button>}
        </div>
      </div>
      <div className="membership-table">
        {view === 'organizations' && <table aria-label="组织层级">
          <thead><tr><th scope="col">组织</th><th scope="col">上级组织</th><th scope="col">直属用户</th><th scope="col">操作</th></tr></thead>
          <tbody>{filteredOrganizations.map(({ organization, ancestors }) => <tr key={organization.id}>
            <td><span className="organization-name" style={{ paddingInlineStart: query.trim() ? 0 : Math.min(ancestors.length, 6) * 16 }}>
              <Building2 size={16} /><span><strong>{organization.name}</strong><small>编号 {organization.id}</small></span>
            </span></td>
            <td data-label="上级组织" title={ancestors.map(parent => parent.name).join(' / ')}>{ancestors.at(-1)?.name ?? '—'}</td>
            <td data-label="直属用户">{memberCounts.get(organization.id) ?? 0}</td>
            <td><button className="ghost" aria-label={'编辑组织 ' + organization.name}
              onClick={() => open({ kind: 'organization', id: organization.id, name: organization.name, parentId: String(organization.parentId ?? '') })}>
              编辑<ChevronRight size={14} />
            </button></td>
          </tr>)}</tbody>
        </table>}
        {view === 'groups' && <table aria-label="用户组列表">
          <thead><tr><th scope="col">用户组</th><th scope="col">成员</th><th scope="col">操作</th></tr></thead>
          <tbody>{filteredGroups.map(group => <tr key={group.id}>
            <td><span className="organization-name"><Users size={16} /><span><strong>{group.name}</strong><small>编号 {group.id}</small></span></span></td>
            <td data-label="成员">{group.userIds.length} 位</td>
            <td><button className="ghost" aria-label={'管理成员 ' + group.name}
              onClick={() => open({ kind: 'members', id: group.id, ids: group.userIds })}>管理成员<ChevronRight size={14} /></button></td>
          </tr>)}</tbody>
        </table>}
        {view === 'users' && <table aria-label="用户列表">
          <thead><tr><th scope="col">用户</th><th scope="col">所属组织</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
          <tbody>{filteredUsers.map(user => <tr key={user.id}>
            <td><UserName user={user} /></td>
            <td data-label="所属组织">{organizationNames.get(user.organizationId) ?? '—'}</td>
            <td><span className={'pill ' + (user.status === 'active' ? 'positive' : 'neutral')}>
              {user.status === 'active' ? '已激活' : '已停用'}
            </span></td>
            <td><button className="ghost" aria-label={'管理用户 ' + user.username}
              onClick={() => open({ kind: 'user', id: user.id, organizationId: String(user.organizationId) })}>管理<ChevronRight size={14} /></button></td>
          </tr>)}</tbody>
        </table>}
      </div>
      {loading && <p className="membership-empty" role="status">正在加载…</p>}
      {!loading && !loadFailed && !(view === 'organizations' ? filteredOrganizations.length : view === 'groups' ? filteredGroups.length : filteredUsers.length)
        && <p className="membership-empty">{query.trim() || (view === 'users' && status) ? '没有匹配的记录' : view === 'organizations'
          ? '暂无组织' : view === 'groups' ? '暂无用户组' : '暂无用户'}</p>}
    </div>
    {editor && <MembershipDialog title={editor.kind === 'organization' ? (editor.id ? '编辑组织' : '新建组织')
      : editor.kind === 'members' ? editedGroup?.name ?? '用户组成员' : editor.kind === 'group' ? '新建用户组'
      : editor.kind === 'user' ? '管理用户' : '批量导入用户'} close={() => setEditor(undefined)} busy={busy}>
      {error && <p className="banner error" role="alert">{error}</p>}
      {editor.kind === 'organization' && <form className="panel-form" onSubmit={event => { event.preventDefault(); saveOrganization(editor) }}>
        <label>组织名称<input required maxLength={150} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
        <label>上级组织<select value={editor.parentId} onChange={event => setEditor({ ...editor, parentId: event.target.value })}>
          <option value="">无上级组织</option>
          {tree.filter(({ organization, ancestors }) => organization.id !== editor.id && !ancestors.some(parent => parent.id === editor.id))
            .map(({ organization }) => <option key={organization.id} value={organization.id}>{organizationNames.get(organization.id)}</option>)}
        </select></label>
        <div className="membership-dialog-actions">
          {editor.id && <button type="button" className="danger" disabled={busy} onClick={() => {
            const id = editor.id!
            if (window.confirm('删除组织“' + (organizationById.get(id)?.name ?? editor.name) + '”？')) {
              void run(() => api.DELETE('/organizations/{id}', { params: { path: { id } } }), '组织已删除', '无法删除组织，请检查是否有下级组织、成员或授权引用')
            }
          }}>删除组织</button>}
          <button className="primary" disabled={busy}>保存组织</button>
        </div>
      </form>}
      {editor.kind === 'group' && <form className="panel-form" onSubmit={event => {
        event.preventDefault()
        const name = editor.name.trim()
        if (!name) return setError('请输入用户组名称')
        void run(() => api.POST('/user-groups', { body: { name } }), '用户组已创建', '无法创建用户组，请检查名称是否已存在')
      }}>
        <label>用户组名称<input required maxLength={150} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
        <div className="membership-dialog-actions"><button className="primary" disabled={busy}>创建用户组</button></div>
      </form>}
      {editor.kind === 'members' && editedGroup && <GroupMembers users={users} ids={editor.ids} group={editedGroup} busy={busy}
        onChange={ids => setEditor({ ...editor, ids })} organizationNames={organizationNames}
        save={() => void run(() => api.PUT('/user-groups/{id}/members', {
          params: { path: { id: editor.id } }, body: { userIds: editor.ids },
        }), '用户组成员已保存', '无法保存成员，请检查成员是否仍存在')} />}
      {editor.kind === 'user' && editedUser && <>
        <div className="membership-person"><UserName user={editedUser} />
          <span className="pill neutral">{editedUser.status === 'active' ? '已激活' : '已停用'}</span>
        </div>
        <form className="panel-form" onSubmit={event => {
          event.preventDefault()
          void run(() => api.PUT('/users/{userId}/organization', {
            params: { path: { userId: editedUser.id } }, body: { organizationId: Number(editor.organizationId) },
          }), '用户所属组织已更新', '无法移动用户，请检查目标组织')
        }}>
          <label>用户所属组织<select value={editor.organizationId} onChange={event => setEditor({ ...editor, organizationId: event.target.value })}>
            {tree.map(({ organization }) => <option key={organization.id} value={organization.id}>{organizationNames.get(organization.id)}</option>)}
          </select></label>
          <div className="membership-dialog-actions">
            <button type="button" className={editedUser.status === 'active' ? 'danger' : undefined} disabled={busy} onClick={() => {
              const deactivating = editedUser.status === 'active'
              if (deactivating && !window.confirm('停用“' + editedUser.username + '”？该用户将无法登录。')) return
              void run(() => api.PATCH('/users/{userId}/status', {
                params: { path: { userId: editedUser.id } }, body: { status: deactivating ? 'deactivated' : 'active' },
              }), deactivating ? '用户已停用' : '用户已激活', '无法更新用户状态')
            }}>{editedUser.status === 'active' ? '停用用户' : '重新激活用户'}</button>
            <button className="primary" disabled={busy || Number(editor.organizationId) === editedUser.organizationId}>移动用户</button>
          </div>
        </form>
      </>}
      {editor.kind === 'import' && <ImportUsersPanel onImported={reload} />}
    </MembershipDialog>}
  </section>
}

function MembershipDialog({ title, close, busy, children }: {
  title: string
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
  return <dialog ref={dialog} className="text-dialog membership-dialog" aria-labelledby="membership-dialog-title"
    onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <div className="drawer-heading"><h2 id="membership-dialog-title">{title}</h2>
      <button className="ghost icon" aria-label="关闭" disabled={busy} onClick={close}><X size={18} /></button>
    </div>
    {children}
  </dialog>
}

function UserName({ user }: { user: User }) {
  return <span className="organization-name">
    <span className="avatar" aria-hidden="true">{Array.from(user.displayName)[0]}</span>
    <span><strong>{user.displayName}</strong><small>{user.username}</small></span>
  </span>
}

function GroupMembers({ users, ids, group, busy, organizationNames, onChange, save }: {
  users: User[]
  ids: number[]
  group: UserGroup
  busy: boolean
  organizationNames: Map<number, string>
  onChange: (ids: number[]) => void
  save: () => void
}) {
  const [query, setQuery] = useState('')
  const selected = new Set(ids)
  const original = new Set(group.userIds)
  const changed = original.size !== selected.size || ids.some(id => !original.has(id))
  const members = ids.map(id => ({ id, user: users.find(user => user.id === id) }))
  const matches = users.filter(user => !selected.has(user.id)
    && matchesSearch(query, user.displayName, user.username, organizationNames.get(user.organizationId) ?? ''))
  return <div className="member-editor">
    <div>
      <h3>组内成员 · {ids.length} 位</h3>
      {members.length ? <ul className="record-list member-list">{members.map(({ id, user }) => <li key={id}>
        {user ? <UserName user={user} /> : <span>用户 #{id}</span>}
        <button className="ghost" disabled={busy} aria-label={'移除 ' + (user?.username ?? '#' + id)}
          onClick={() => onChange(ids.filter(member => member !== id))}>移除</button>
      </li>)}</ul> : <p className="muted">组内暂无成员</p>}
    </div>
    <div>
      <h3>添加成员</h3>
      <DirectorySearch label="搜索成员姓名或用户名" value={query} onChange={setQuery} />
      <ul className="record-list member-list">{matches.slice(0, 8).map(user => <li key={user.id}>
        <UserName user={user} />
        <button className="ghost" disabled={busy} aria-label={'添加 ' + user.username}
          onClick={() => onChange([...ids, user.id])}><Plus size={16} />添加</button>
      </li>)}</ul>
      {matches.length > 8 && <p className="muted">继续搜索以缩小范围</p>}
      {!matches.length && <p className="muted">没有可添加的匹配用户</p>}
    </div>
    <div className="membership-dialog-actions"><button className="primary" disabled={busy || !changed} onClick={save}>保存成员</button></div>
  </div>
}
