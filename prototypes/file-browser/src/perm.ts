// PROTOTYPE permission helpers: Effective Permission and Traversable Ancestors, naively computed.
import { Grant, Node, ROOT, User } from './data'

export const LEVELS = ['无', '查看', '下载', '编辑', '管理']
export const OFFICE_EXT = ['doc', 'docx', 'wps', 'xls', 'xlsx']
export const OFFICE_LIMIT = 25 * 1024 * 1024

export function ancestors(n: Node): Node[] {
  const out: Node[] = []
  for (let p = n.parent; p; p = p.parent) out.unshift(p)
  return out
}

export function pathOf(n: Node): Node[] {
  return [...ancestors(n), n]
}

function matches(u: User, g: Grant) {
  return (g.kind === 'user' && g.id === u.id) || (g.kind === 'org' && u.orgs.includes(g.id)) || (g.kind === 'group' && u.groups.includes(g.id))
}

/** Path that Grants are inherited along: stops at the nearest isolated (C2 restricted) ancestor-or-self. */
export function scopePath(n: Node): Node[] {
  const p = pathOf(n)
  let i = p.length - 1
  while (i > 0 && !p[i].isolated) i--
  return p.slice(i)
}

export function level(u: User, n: Node): number {
  if (u.inactive) return 0
  if (u.admin) return 4
  let m = 0
  for (const x of scopePath(n)) for (const g of x.grants) if (matches(u, g)) m = Math.max(m, g.level)
  return m
}

export function traversable(u: User, n: Node): boolean {
  return level(u, n) === 0 && (n.children ?? []).some((c) => visible(u, c))
}

export function visible(u: User, n: Node): boolean {
  return level(u, n) > 0 || traversable(u, n)
}

export function kids(u: User, n: Node): Node[] {
  const list = (n.children ?? []).filter((c) => visible(u, c))
  return list.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1))
}

/** Grants that apply to n, with the item they are inherited from. */
export function grantSources(n: Node): { grant: Grant; from: Node }[] {
  return scopePath(n).flatMap((x) => x.grants.map((grant) => ({ grant, from: x })))
}

/** Topmost items the user holds a real Permission Level on: their natural entry points. */
export function entryPoints(u: User): Node[] {
  const out: Node[] = []
  const walk = (n: Node) => {
    if (n !== ROOT && level(u, n) > 0) return void out.push(n)
    for (const c of n.children ?? []) walk(c)
  }
  walk(ROOT)
  return out
}

export function allVisible(u: User): Node[] {
  const out: Node[] = []
  const walk = (n: Node) => {
    for (const c of kids(u, n)) {
      out.push(c)
      walk(c)
    }
  }
  walk(ROOT)
  return out
}

export function ext(n: Node) {
  return n.name.split('.').pop()!.toLowerCase()
}

export function officeEditable(u: User, n: Node, plugin: boolean) {
  return plugin && n.type === 'file' && OFFICE_EXT.includes(ext(n)) && n.size <= OFFICE_LIMIT && level(u, n) >= 3
}

export function fmtSize(b: number) {
  if (!b) return '—'
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export function icon(n: Node) {
  if (n.type === 'dir') return '📁'
  const e = ext(n)
  if (['doc', 'docx', 'wps'].includes(e)) return '📝'
  if (['xls', 'xlsx'].includes(e)) return '📊'
  if (e === 'pdf') return '📕'
  if (['png', 'jpg'].includes(e)) return '🖼️'
  if (['zip', 'gz'].includes(e)) return '🗜️'
  if (e === 'pptx') return '📽️'
  return '📄'
}

/** Actions available at a given level; stubs only. */
export function actionsFor(u: User, n: Node, plugin: boolean) {
  const l = level(u, n)
  const isDir = n.type === 'dir'
  return [
    { key: 'preview', label: '预览', ok: !isDir && l >= 1 },
    { key: 'download', label: '下载', ok: l >= 2 },
    { key: 'upload', label: '上传', ok: isDir && l >= 3 },
    { key: 'mkdir', label: '新建文件夹', ok: isDir && l >= 3 },
    { key: 'office', label: '在 WPS 中编辑', ok: officeEditable(u, n, plugin) },
    { key: 'rename', label: '重命名', ok: l >= 3 },
    { key: 'move', label: '移动', ok: l >= 3 },
    { key: 'delete', label: '删除', ok: l >= 4 },
    { key: 'grant', label: '授权', ok: l >= 4 },
  ]
}

export function stub(label: string, n?: Node) {
  alert(`PROTOTYPE：${label}${n ? ` → ${n.name}` : ''}（未实现）`)
}

/**
 * A folder's contents with Traversable Ancestors hidden: anything the User can only pass through
 * is skipped, and the permitted items beneath it are hoisted up, carrying the hidden path as `via`.
 */
export type Entry = { node: Node; via: Node[] }
export function listing(u: User, dir: Node): Entry[] {
  const out: Entry[] = []
  const walk = (n: Node, via: Node[]) => {
    for (const c of kids(u, n)) traversable(u, c) ? walk(c, [...via, c]) : out.push({ node: c, via })
  }
  walk(dir, [])
  return out
}
