// PROTOTYPE Grants logic shared by the P1–P4 grant UIs: principals, explanations, scope checks.
// Naive on purpose. The real thing is the Effective Permission module; this only has to feel right.
import { GROUPS, Grant, Node, ORGS, PEOPLE, PrincipalKind, ROOT, User } from './data'
import { LEVELS, level, scopePath } from './perm'
import { pathString } from './store'

export type Principal = { kind: PrincipalKind; id: string; label: string }
export const LV = LEVELS // ['无','查看','下载','编辑','管理']
export const LEVEL_HINT = ['', '能看到、能预览', '+ 下载', '+ 上传、新建、重命名、编辑', '+ 删除、授权']

export const same = (a: Principal, b: Principal) => a.kind === b.kind && a.id === b.id
export const keyOf = (p: Principal) => `${p.kind}:${p.id}`

export function orgChain(id: string): string[] {
  const out: string[] = []
  for (let o = ORGS.find((x) => x.id === id); o; o = ORGS.find((x) => x.id === o!.parent)) out.unshift(o.id)
  return out
}
export const orgName = (id: string) => ORGS.find((o) => o.id === id)?.name ?? id
export const orgPath = (id: string) => orgChain(id).map(orgName).join(' / ')

export function allPrincipals(): (Principal & { sub: string; inactive?: boolean })[] {
  return [
    ...PEOPLE.map((u) => ({ kind: 'user' as const, id: u.id, label: u.name, sub: u.orgLabel + (u.admin ? ' · 管理员' : ''), inactive: u.inactive })),
    ...ORGS.map((o) => ({ kind: 'org' as const, id: o.id, label: o.name, sub: `组织 · ${orgPath(o.id)} · ${members({ kind: 'org', id: o.id, label: '' }).length} 人` })),
    ...GROUPS.map((g) => ({ kind: 'group' as const, id: g.id, label: g.name, sub: `用户组 · ${members({ kind: 'group', id: g.id, label: '' }).length} 人` })),
  ]
}

export function personOf(p: Principal): User | undefined {
  return p.kind === 'user' ? PEOPLE.find((u) => u.id === p.id) : undefined
}

/** Active people a Grant to p would reach. */
export function members(p: Principal): User[] {
  return PEOPLE.filter((u) => !u.inactive && (p.kind === 'user' ? u.id === p.id : p.kind === 'org' ? u.orgs.includes(p.id) : u.groups.includes(p.id)))
}

/** Does Grant g reach principal p? For an Organization: Grants to it or to any ancestor Organization. */
export function reaches(g: Grant, p: Principal): boolean {
  if (p.kind === 'user') {
    const u = personOf(p)
    if (!u) return false
    return (g.kind === 'user' && g.id === u.id) || (g.kind === 'org' && u.orgs.includes(g.id)) || (g.kind === 'group' && u.groups.includes(g.id))
  }
  if (p.kind === 'org') return g.kind === 'org' && orgChain(p.id).includes(g.id)
  return g.kind === 'group' && g.id === p.id
}

export type Source = { grant: Grant; from: Node; why: string }

function why(g: Grant, p: Principal): string {
  if (g.kind === 'user') return '直接给本人'
  if (g.kind === 'group') return p.kind === 'group' ? '给该用户组' : `作为“${g.label}”成员`
  if (p.kind === 'org' && g.id === p.id) return '给该组织'
  return p.kind === 'org' ? `上级组织“${g.label}”` : `所在组织${g.label === orgName(personOf(p)?.orgs.at(-1) ?? '') ? '' : '的上级'}“${g.label}”`
}

/** Every Grant on n or its ancestors that reaches p, strongest first. */
export function sources(p: Principal, n: Node): Source[] {
  return scopePath(n)
    .flatMap((from) => from.grants.map((grant) => ({ grant, from })))
    .filter(({ grant }) => reaches(grant, p))
    .map(({ grant, from }) => ({ grant, from, why: why(grant, p) }))
    .sort((a, b) => b.grant.level - a.grant.level)
}

/** Effective level of a principal on n. Users go through the real rule (admin, inactive). */
export function levelOf(p: Principal, n: Node): number {
  const u = personOf(p)
  if (u) return level(u, n)
  return Math.max(0, ...sources(p, n).map((s) => s.grant.level))
}

/** What p would hold on n without its own direct Grant on n: the floor a direct Grant must beat (no deny). */
export function floorOf(p: Principal, n: Node): { level: number; src?: Source } {
  const u = personOf(p)
  if (u?.admin) return { level: 4, src: undefined }
  const s = sources(p, n).filter((x) => !(x.from === n && x.grant.kind === p.kind && x.grant.id === p.id))
  return { level: s[0]?.grant.level ?? 0, src: s[0] }
}

export function direct(n: Node, p: Principal): Grant | undefined {
  return n.grants.find((g) => g.kind === p.kind && g.id === p.id)
}

/** A plain-language explanation of p's Effective Permission on n. */
export function explain(p: Principal, n: Node): { level: number; lines: string[]; best?: Source } {
  const u = personOf(p)
  if (u?.inactive) return { level: 0, lines: [`${u.name} 的账号已停用：授权保留但不生效。`] }
  if (u?.admin) return { level: 4, lines: [`${u.name} 是管理员，在所有位置都拥有“管理”。`] }
  const s = sources(p, n)
  if (!s.length) return { level: 0, lines: [`没有任何授权覆盖“${n.name}”。`] }
  const lines = s.map((x) => `${x.why}：在“${x.from === n ? n.name : x.from.name}”上授予“${LV[x.grant.level]}”${x.from === n ? '' : '（向下继承）'}`)
  return { level: s[0].grant.level, lines, best: s[0] }
}

/** Can actor change Grants on n at all? Manage within scope; Administrators everywhere except the root itself. */
export function canManage(actor: User, n: Node) {
  return n !== ROOT && level(actor, n) >= 4
}

/** Highest level actor may hand out on n. Manage is the ceiling for everyone; kept as a function so the rule is visible. */
export const maxGrantable = (actor: User, n: Node) => (canManage(actor, n) ? 4 : 0)

/** Would actor lose Manage on n if direct Grant `g` on n changed to `next` (0 = revoke)? */
export function wouldLockOut(actor: User, n: Node, g: Grant, next: number): boolean {
  if (actor.admin) return false
  const before = level(actor, n)
  if (before < 4) return false
  const saved = g.level
  const i = n.grants.indexOf(g)
  if (next === 0) n.grants.splice(i, 1)
  else g.level = next
  const after = level(actor, n)
  if (next === 0) n.grants.splice(i, 0, g)
  else g.level = saved
  return after < 4
}

/** Grants beneath n (not on n): "this folder also has N more specific Grants inside". */
export function grantsBelow(n: Node): { node: Node; grant: Grant }[] {
  const out: { node: Node; grant: Grant }[] = []
  const walk = (x: Node) => {
    for (const c of x.children ?? []) {
      c.grants.forEach((grant) => out.push({ node: c, grant }))
      walk(c)
    }
  }
  walk(n)
  return out
}

/** All nodes under (and including) n in tree order, with depth. */
export function subtree(n: Node, depth = 0, out: { node: Node; depth: number }[] = []) {
  out.push({ node: n, depth })
  for (const c of n.children ?? []) subtree(c, depth + 1, out)
  return out
}

export const principalOfGrant = (g: Grant): Principal => ({ kind: g.kind, id: g.id, label: g.label })
export const where = (n: Node) => (n === ROOT ? '/' : pathString(n))
