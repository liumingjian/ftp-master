import { useEffect, useState, type FormEvent } from 'react'
import { ImportUsersPanel } from './ImportUsersPanel'
import { api } from './api/client'
import type { components } from './api/schema.gen'

type Organization = components['schemas']['Organization']
type UserGroup = components['schemas']['UserGroup']

/** Administrator workspace for Organization hierarchy and User Group membership. */
export function MembershipPanel() {
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [groups, setGroups] = useState<UserGroup[]>([])
  const [users, setUsers] = useState<components['schemas']['ManagedUser'][]>([])
  const [userId, setUserId] = useState('')
  const [userOrganization, setUserOrganization] = useState('')
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [selected, setSelected] = useState('')
  const [groupName, setGroupName] = useState('')
  const [group, setGroup] = useState('')
  const [members, setMembers] = useState('')
  async function reload() {
    const [o, g, u] = await Promise.all([api.GET('/organizations'), api.GET('/user-groups'), api.GET('/managed-users')])
    if (u.data) setUsers(u.data)
    if (o.data) setOrganizations(o.data)
    if (g.data) setGroups(g.data)
    if (o.error || g.error) setError('无法读取组织或用户组')
  }
  useEffect(() => { void reload().catch(() => setError('连接失败')) }, [])
  async function run(work: () => Promise<{ error?: unknown }>) {
    try { const result = await work(); if (result.error) { setError('操作失败：请检查组织层级、现有成员和用户编号'); return }; setError(''); await reload() }
    catch { setError('连接失败') }
  }
  function saveOrganization(event: FormEvent) {
    event.preventDefault()
    const body = { name, parentId: parent ? Number(parent) : null }
    void run(() => selected ? api.PATCH('/organizations/{id}', { params: { path: { id: Number(selected) } }, body }) : api.POST('/organizations', { body }))
  }
  return <section aria-label="组织与用户组管理">
    <h2>组织与用户组管理</h2>
    {error && <p role="alert">{error}</p>}
    <ImportUsersPanel onImported={reload} />
    <h3>用户状态与组织</h3>
    <label>选择用户<select aria-label="选择用户" value={userId} onChange={e => { setUserId(e.target.value); setUserOrganization(users.find(u => u.id === Number(e.target.value))?.organizationId.toString() ?? '') }}><option value="">请选择</option>{users.map(u => <option key={u.id} value={u.id}>{u.displayName}（{u.username}，{u.status === 'active' ? '已激活' : '已停用'}）</option>)}</select></label>
    {userId && <>
      <button type="button" onClick={() => void run(() => api.PATCH('/users/{userId}/status', { params: { path: { userId: Number(userId) } }, body: { status: users.find(u => u.id === Number(userId))?.status === 'active' ? 'deactivated' : 'active' } }))}>{users.find(u => u.id === Number(userId))?.status === 'active' ? '停用用户' : '重新激活用户'}</button>
      <label>用户所属组织<select aria-label="用户所属组织" value={userOrganization} onChange={e => setUserOrganization(e.target.value)}>{organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
      <button type="button" onClick={() => void run(() => api.PUT('/users/{userId}/organization', { params: { path: { userId: Number(userId) } }, body: { organizationId: Number(userOrganization) } }))}>移动用户</button>
    </>}
    <h3>组织层级</h3>
    <ul>{organizations.map(o => <li key={o.id}>{o.name}（编号：{o.id}，上级：{organizations.find(p => p.id === o.parentId)?.name ?? '无'}）</li>)}</ul>
    <form onSubmit={saveOrganization}>
      <label>编辑组织<select aria-label="编辑组织" value={selected} onChange={e => { const id = e.target.value; setSelected(id); const o = organizations.find(o => o.id === Number(id)); setName(o?.name ?? ''); setParent(o?.parentId?.toString() ?? '') }}><option value="">新建组织</option>{organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
      <label>组织名称<input required maxLength={150} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>上级组织<select aria-label="上级组织" value={parent} onChange={e => setParent(e.target.value)}><option value="">无</option>{organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
      <button>保存组织</button>
      {selected && <button type="button" onClick={() => void run(() => api.DELETE('/organizations/{id}', { params: { path: { id: Number(selected) } } }))}>删除组织</button>}
    </form>
    <h3>用户组</h3>
    <form onSubmit={e => { e.preventDefault(); void run(() => api.POST('/user-groups', { body: { name: groupName } })) }}>
      <label>用户组名称<input required maxLength={150} value={groupName} onChange={e => setGroupName(e.target.value)} /></label><button>新建用户组</button>
    </form>
    <form onSubmit={e => { e.preventDefault(); void run(() => api.PUT('/user-groups/{id}/members', { params: { path: { id: Number(group) } }, body: { userIds: members.trim() ? members.split(',').map(n => Number(n.trim())) : [] } })) }}>
      <label>选择用户组<select aria-label="选择用户组" required value={group} onChange={e => { setGroup(e.target.value); setMembers(groups.find(g => g.id === Number(e.target.value))?.userIds.join(',') ?? '') }}><option value="">请选择</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
      <label>成员用户编号（逗号分隔，清空移除全部）<input value={members} onChange={e => setMembers(e.target.value)} pattern="[0-9, ]*" /></label><button>保存成员</button>
    </form>
  </section>
}
