// PROTOTYPE round 6: FTP-convention rights on top of Grants.
// Six rights, named after what FTP servers (Serv-U / FileZilla Server) and NTFS split out, merged where a web UI
// does not need the distinction (Append ≈ new version, Create ≈ upload, Rename/Remove dirs ≈ files).
// Grants still only ever allow; a User's rights on an item are the union over every Grant that reaches it.
import { Grant, Node, Right, User } from './data'
import { Principal, personOf, reaches, same } from './grants'
import { applies, matchesUser, scopePath } from './perm'

export const RIGHTS: Right[] = ['list', 'read', 'write', 'modify', 'delete', 'grant']
export const RL: Record<Right, string> = { list: '浏览', read: '下载', write: '上传', modify: '修改', delete: '删除', grant: '授权' }
export const RHINT: Record<Right, string> = {
  list: '看到文件夹内容、预览文件（FTP: List）',
  read: '下载、打包下载（FTP: Read）',
  write: '上传新文件、新建文件夹；同名上传生成新版本（FTP: Write / Create / Append）',
  modify: '重命名、移动、在线编辑、恢复历史版本（FTP: Rename）',
  delete: '删除到回收站（FTP: Delete / Remove）',
  grant: '给他人授权，自动包含以上全部（≈ NTFS 完全控制）',
}

export const PRESETS: { key: string; label: string; hint: string; rights: Right[] }[] = [
  { key: 'browse', label: '仅浏览', hint: '能看、能预览，不能下载', rights: ['list'] },
  { key: 'read', label: '只读', hint: '浏览 + 下载', rights: ['list', 'read'] },
  { key: 'rw', label: '读写', hint: '只读 + 上传、修改；不能删除', rights: ['list', 'read', 'write', 'modify'] },
  { key: 'rwd', label: '读写删', hint: '读写 + 删除', rights: ['list', 'read', 'write', 'modify', 'delete'] },
  { key: 'full', label: '完全控制', hint: '全部权限，并可再授权', rights: [...RIGHTS] },
  { key: 'drop', label: '投递箱', hint: '只能上传，看不到别人的文件', rights: ['write'] },
]

const FROM_LEVEL: Right[][] = [[], ['list'], ['list', 'read'], ['list', 'read', 'write', 'modify'], [...RIGHTS]]
export const rightsOf = (g: Grant): Right[] => g.rights ?? FROM_LEVEL[g.level] ?? []
export function toLevel(rs: Right[]): number {
  if (rs.includes('grant')) return 4
  if (rs.includes('modify') || (rs.includes('write') && rs.includes('list'))) return 3
  if (rs.includes('read')) return 2
  return rs.length ? 1 : 0 // PROTOTYPE: a drop box shows as 浏览 in the older file-browser views
}
export const presetOf = (rs: Right[]) => (rs.length ? PRESETS.find((p) => p.rights.length === rs.length && p.rights.every((r) => rs.includes(r)))?.key ?? 'custom' : 'none')

/** Toggle one right and keep the set coherent (the dependencies FTP admins otherwise learn the hard way). */
export function toggle(rs: Right[], r: Right, on: boolean): Right[] {
  const s = new Set(rs)
  if (on) {
    s.add(r)
    if (r === 'grant') RIGHTS.forEach((x) => s.add(x))
    if (r === 'read' || r === 'modify' || r === 'delete') s.add('list')
    if (r === 'modify') s.add('read')
  } else {
    s.delete(r)
    if (r === 'list') ['read', 'modify', 'delete', 'grant'].forEach((x) => s.delete(x as Right))
    if (r === 'read') s.delete('modify')
    s.delete('grant')
  }
  return RIGHTS.filter((x) => s.has(x))
}

/** Effective rights of a User on n. */
export function userRights(u: User, n: Node): Set<Right> {
  if (u.inactive) return new Set()
  if (u.admin) return new Set(RIGHTS)
  const s = new Set<Right>()
  for (const x of scopePath(n)) for (const g of x.grants) if (matchesUser(u, g) && applies(g, x, n)) rightsOf(g).forEach((r) => s.add(r))
  return s
}

/** Rights a principal holds on n from Grants that reach it (a User goes through the full rule). */
export function principalRights(p: Principal, n: Node): Set<Right> {
  const u = personOf(p)
  if (u) return userRights(u, n)
  const s = new Set<Right>()
  for (const x of scopePath(n)) for (const g of x.grants) if (reaches(g, p) && applies(g, x, n)) rightsOf(g).forEach((r) => s.add(r))
  return s
}

/** For one row of the table: which rights this exact principal inherits on n, and from where. */
export function inheritedFor(p: Principal, n: Node): Map<Right, Node> {
  const m = new Map<Right, Node>()
  for (const x of scopePath(n)) {
    if (x === n) continue
    for (const g of x.grants) if (same({ kind: g.kind, id: g.id, label: '' }, p) && applies(g, x, n)) rightsOf(g).forEach((r) => m.has(r) || m.set(r, x))
  }
  return m
}

export const creatorOf = (n: Node) => n.grants.find((g) => g.origin === 'creator')
