// PROTOTYPE in-memory mutations over the mock Shared Tree. Reload the page to reset.
import { useEffect, useState } from 'react'
import { GROUPS, Node, PEOPLE, RECYCLE_BIN, ROOT } from './data'
import { record } from './audit'

export type BinItem = { name: string; from: string; by: string; at: string; purgeIn: string; node?: Node; parent?: Node }

export const bin: BinItem[] = [...RECYCLE_BIN]
const listeners = new Set<() => void>()

/** Re-render the calling component whenever the tree is mutated. */
export function useStore() {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick((x) => x + 1)
    listeners.add(f)
    return () => void listeners.delete(f)
  }, [])
}

function changed() {
  listeners.forEach((f) => f())
}

const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ')
let seq = 1000

export function rename(n: Node, name: string) {
  record('rename', n, { detail: `→ ${name}` })
  n.name = name
  changed()
}

export function move(n: Node, to: Node) {
  if (to === n || to === n.parent || isAncestor(n, to)) return false
  record('move', n, { detail: `→ ${pathString(to)}` })
  detach(n)
  to.children!.push(n)
  n.parent = to
  changed()
  return true
}

function isAncestor(a: Node, b: Node) {
  for (let p: Node | undefined = b; p; p = p.parent) if (p === a) return true
  return false
}

function detach(n: Node) {
  const p = n.parent!
  p.children = p.children!.filter((c) => c !== n)
}

export function remove(nodes: Node[], by: string): BinItem[] {
  const items = nodes.map((n) => {
    record('delete', n)
    const item: BinItem = { name: n.name, from: pathString(n.parent!), by, at: now(), purgeIn: '30 天', node: n, parent: n.parent }
    detach(n)
    bin.unshift(item)
    return item
  })
  changed()
  return items
}

export function restore(items: BinItem[]) {
  for (const it of items) {
    if (it.node && it.parent) {
      it.parent.children!.push(it.node)
      it.node.parent = it.parent
      record('restore', it.node)
    }
    bin.splice(bin.indexOf(it), 1)
  }
  changed()
}

/** Upload: a same-named file becomes a new File Version instead of asking. */
export function upload(dir: Node, name: string, size: number, by: string): { node: Node; newVersion: boolean } {
  const existing = dir.children!.find((c) => c.type === 'file' && c.name === name)
  if (existing) {
    const v = (existing.versions?.[0]?.v ?? 0) + 1
    existing.versions = [{ v, at: now(), by, size }, ...(existing.versions ?? [])]
    existing.size = size
    existing.modified = now()
    existing.modifiedBy = by
    record('upload', existing, { detail: `同名上传 → v${v}` })
    changed()
    return { node: existing, newVersion: true }
  }
  const node: Node = {
    id: `u${seq++}`, name, type: 'file', size, modified: now(), modifiedBy: by, parent: dir,
    // the uploader becomes the file's creator: a real Grant with every right, marked so the UI can pin and lock it
    grants: PEOPLE.filter((u) => u.name === by).map((u) => ({ kind: 'user' as const, id: u.id, label: u.name, level: 4, origin: 'creator' as const })),
    versions: [{ v: 1, at: now(), by, size }], audit: [{ at: now(), who: by, what: '上传', ok: true, ip: '10.2.3.14' }],
  }
  dir.children!.push(node)
  record('upload', node)
  changed()
  return { node, newVersion: false }
}

export function mkdir(dir: Node, by: string): Node {
  let name = '新建文件夹'
  for (let i = 2; dir.children!.some((c) => c.name === name); i++) name = `新建文件夹 ${i}`
  const node: Node = { id: `u${seq++}`, name, type: 'dir', size: 0, modified: now(), modifiedBy: by, grants: [], children: [], parent: dir }
  dir.children!.push(node)
  changed()
  return node
}

export function restoreVersion(n: Node, v: number, by: string) {
  const src = n.versions!.find((x) => x.v === v)!
  const next = n.versions![0].v + 1
  n.versions = [{ v: next, at: now(), by, size: src.size }, ...n.versions!]
  n.modified = now()
  n.modifiedBy = by
  record('version_restore', n, { detail: `恢复 v${v} → 生成 v${next}` })
  changed()
  return next
}

export function addGrant(n: Node, g: Node['grants'][number]) {
  n.grants = [...n.grants.filter((x) => !(x.kind === g.kind && x.id === g.id)), g]
  changed()
}

export function pathString(n: Node) {
  const parts: string[] = []
  for (let p: Node | undefined = n; p && p !== ROOT; p = p.parent) parts.unshift(p.name)
  return '/' + parts.join('/')
}

/** Fake upload names for simulated drops. */
const SAMPLE = [['会议纪要-1116.docx', 0.3], ['现场照片.png', 3.8], ['报价单.xlsx', 0.6], ['接口规范 v3.docx', 2.3]] as const
let sampleI = 0
export function nextSample(): [string, number] {
  const [n, mb] = SAMPLE[sampleI++ % SAMPLE.length]
  return [n, mb * 1024 * 1024]
}

/** Set (or with level 0, revoke) a direct Grant. Returns an undo. Grant changes would be Admin-only Audit Events. */
export function setGrant(n: Node, g: Node['grants'][number]): () => void {
  const before = [...n.grants]
  n.grants = g.level ? (n.grants.some((x) => x.kind === g.kind && x.id === g.id) ? n.grants.map((x) => (x.kind === g.kind && x.id === g.id ? { ...g } : x)) : [...n.grants, { ...g }]) : n.grants.filter((x) => !(x.kind === g.kind && x.id === g.id))
  record('grant', n, { detail: `${g.level ? '授予' : '撤销'} ${g.label}` })
  grantLog.unshift({ at: now(), what: `${g.level ? '授予' : '撤销'} ${g.label}${g.level ? ` “${['', '查看', '下载', '编辑', '管理'][g.level]}”` : ''}`, where: pathString(n) })
  changed()
  return () => ((n.grants = before), changed())
}
export const grantLog: { at: string; what: string; where: string }[] = []

/** C2: replace all direct Grants on n at once, optionally stopping inheritance (Confluence-style restriction). */
export function replaceGrants(n: Node, grants: Node['grants'], isolated: boolean): () => void {
  const before = { grants: n.grants, isolated: n.isolated }
  n.grants = grants.map((g) => ({ ...g }))
  n.isolated = isolated || undefined
  record('grant', n, { detail: `保存授权：${grants.length} 条直接授权（${grants.map((g) => g.label).slice(0, 4).join('、')}${grants.length > 4 ? ' 等' : ''}）` })
  grantLog.unshift({ at: now(), what: `${isolated ? '限制为仅指定的人' : '更新授权'}（${grants.length} 条）`, where: pathString(n) })
  changed()
  return () => ((n.grants = before.grants), (n.isolated = before.isolated), changed())
}

/** C4: create a User Group from a set of people. */
export function makeGroup(name: string, people: import('./data').User[]) {
  const id = `g${seq++}`
  GROUPS.push({ id, name })
  people.forEach((u) => u.groups.push(id))
  changed()
  return id
}

/** Round 7: find or create a directory by name (folder uploads keep their structure; an existing folder is merged into). */
export function ensureDir(dir: Node, name: string, by: string): Node {
  const found = dir.children!.find((c) => c.type === 'dir' && c.name === name)
  if (found) return found
  const node: Node = { id: `u${seq++}`, name, type: 'dir', size: 0, modified: now(), modifiedBy: by, grants: [], children: [], parent: dir }
  dir.children!.push(node)
  changed()
  return node
}

/** Round 7: "keep both" picks 名称 (1).ext, 名称 (2).ext, … */
export function uniqueName(dir: Node, name: string): string {
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  let out = name
  for (let i = 1; dir.children!.some((c) => c.name === out); i++) out = `${base} (${i})${ext}`
  return out
}
