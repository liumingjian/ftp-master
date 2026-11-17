// PROTOTYPE round 8: an in-memory Audit Event log shared by every audit UI variant (L1–L4). Wipe freely.
//
// What it models (spec stories 68–75):
//   - one immutable event per significant action: sign-in / failed sign-in / sign-out, upload, download (one per file,
//     also inside zips), preview, open-for-edit, edit save, rename, move, delete, restore, purge, version restore,
//     Grant changes and account changes;
//   - each event stands alone: User, time, source IP, the item and its path *at that time*, action, success/failure;
//   - directory browsing is never recorded (story 75), so there is no "list" event at all;
//   - scope: Administrators see everything; a User with the Grant Right on a directory sees item events within it,
//     but never sign-in, account or Grant-change events (story 73);
//   - ~190 days of seeded history (retention is at least 180 days, story 74), plus scripted incidents to investigate.
// Live actions in the prototype (upload, delete, rename, download, zip, Grants, switching identity) are appended too.
import { Node, PEOPLE, ROOT, User } from './data'
import { ext } from './perm'
import { userRights } from './rights'

export type Action =
  | 'signin' | 'signin_fail' | 'signout'
  | 'upload' | 'download' | 'preview' | 'edit_open' | 'edit_save'
  | 'rename' | 'move' | 'delete' | 'restore' | 'purge' | 'version_restore'
  | 'grant' | 'account' | 'export'

export type Category = 'session' | 'read' | 'write' | 'delete' | 'grant' | 'account'

export const ACTION: Record<Action, { label: string; cat: Category }> = {
  signin: { label: '登录', cat: 'session' },
  signin_fail: { label: '登录失败', cat: 'session' },
  signout: { label: '退出', cat: 'session' },
  upload: { label: '上传', cat: 'write' },
  download: { label: '下载', cat: 'read' },
  preview: { label: '预览', cat: 'read' },
  edit_open: { label: '打开编辑', cat: 'write' },
  edit_save: { label: '编辑保存', cat: 'write' },
  rename: { label: '重命名', cat: 'write' },
  move: { label: '移动', cat: 'write' },
  delete: { label: '删除', cat: 'delete' },
  restore: { label: '从回收站恢复', cat: 'delete' },
  purge: { label: '彻底清除', cat: 'delete' },
  version_restore: { label: '恢复历史版本', cat: 'write' },
  grant: { label: '授权变更', cat: 'grant' },
  account: { label: '账户变更', cat: 'account' },
  export: { label: '导出审计', cat: 'account' },
}
export const CATS: { key: Category; label: string; adminOnly?: boolean }[] = [
  { key: 'read', label: '查看与下载' },
  { key: 'write', label: '上传与修改' },
  { key: 'delete', label: '删除与恢复' },
  { key: 'grant', label: '授权变更', adminOnly: true },
  { key: 'session', label: '登录', adminOnly: true },
  { key: 'account', label: '账户', adminOnly: true },
]
export const adminOnly = (a: Action) => ['session', 'grant', 'account'].includes(ACTION[a].cat)

export type Ev = {
  id: number
  t: number
  who: string
  whoId: string
  ip: string
  action: Action
  ok: boolean
  /** why it failed */
  reason?: string
  /** the item, if any; kept even after it is renamed, moved, deleted or purged */
  node?: Node
  /** path of the item at the time of the event (story 69) */
  path: string
  /** free text: rename/move target, Grant diff, account change, version */
  detail?: string
  /** downloads inside a zip carry the zip's name */
  via?: string
  stale?: boolean
  size?: number
  live?: boolean
}

// ---------------------------------------------------------------- helpers
export const pathOfNode = (n: Node) => {
  const parts: string[] = []
  for (let p: Node | undefined = n; p && p !== ROOT; p = p.parent) parts.unshift(p.name)
  return '/' + parts.join('/')
}
const pad = (x: number) => String(x).padStart(2, '0')
export const fmt = (t: number) => {
  const d = new Date(t)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const fmtFull = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
export const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export const DAY = 86400_000
/** Prototype "now": the seeded history ends here; live events use the real clock. */
export const BASE = new Date(2026, 10, 17, 14, 0).getTime()
export const now = () => Math.max(Date.now(), BASE)
export const offHours = (t: number) => {
  const d = new Date(t)
  return d.getHours() >= 21 || d.getHours() < 7 || d.getDay() === 0 || d.getDay() === 6
}

let seed = 20261117
const rnd = () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]

function walk(n: Node, out: Node[] = []): Node[] {
  for (const c of n.children ?? []) {
    out.push(c)
    walk(c, out)
  }
  return out
}
const byPath = (p: string) => walk(ROOT).find((n) => pathOfNode(n) === p)!
const person = (name: string) => PEOPLE.find((u) => u.name === name)!
const ipOf = (u: { id: string }) => {
  if (u.id === 'admin') return '10.2.1.8'
  let h = 0
  for (const c of u.id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `10.2.${(h % 6) + 1}.${(h % 200) + 20}`
}

// ---------------------------------------------------------------- the log
export const LOG: Ev[] = []
let seq = 1
const listeners = new Set<() => void>()
export const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f))

function push(e: Omit<Ev, 'id'>) {
  LOG.push({ id: seq++, ...e })
}

/** A ghost item that existed once (deleted and purged, or never in the mock tree). */
function ghost(name: string, parentPath: string, size = 300_000): Node {
  const parent = byPath(parentPath)
  return { id: `ghost-${seq}`, name, type: name.includes('.') ? 'file' : 'dir', size, modified: '', modifiedBy: '', grants: [], parent, children: name.includes('.') ? undefined : [] }
}

function seedHistory() {
  const files = walk(ROOT).filter((n) => n.type === 'file')
  const active = PEOPLE.filter((u) => !u.inactive)
  // who works on what: everyone gets the files they can Browse; people with nothing but 公共资料 are less active
  const reach = new Map<User, Node[]>()
  for (const u of active) {
    if (u.admin) continue
    const fs = files.filter((f) => userRights(u, f).has('list'))
    if (fs.length) reach.set(u, fs)
  }
  const keen = [...reach.keys()].filter((u) => reach.get(u)!.length > 3)
  const casual = [...reach.keys()].filter((u) => reach.get(u)!.length <= 3)
  const start = BASE - 190 * DAY
  for (let day = start; day < BASE - DAY / 2; day += DAY) {
    const d = new Date(day)
    const weekend = d.getDay() === 0 || d.getDay() === 6
    const n = weekend ? 2 : 14 + Math.floor(rnd() * 8)
    const today = new Set<User>()
    for (let i = 0; i < n; i++) today.add(rnd() < 0.7 ? pick(keen) : pick(casual))
    for (const u of today) {
      const ip = ipOf(u)
      const d0 = new Date(day)
      d0.setHours(8 + Math.floor(rnd() * 2), Math.floor(rnd() * 60), Math.floor(rnd() * 60))
      let t = d0.getTime()
      push({ t, who: u.name, whoId: u.id, ip, action: 'signin', ok: true, path: '' })
      const k = 2 + Math.floor(rnd() * 7)
      for (let j = 0; j < k; j++) {
        t += (10 + rnd() * 70) * 60_000
        const f = pick(reach.get(u)!)
        const r = userRights(u, f)
        const roll = rnd()
        const base = { t, who: u.name, whoId: u.id, ip, ok: true, node: f, path: pathOfNode(f), size: f.size }
        if (roll < 0.42 || !r.has('read')) push({ ...base, action: 'preview' })
        else if (roll < 0.75) push({ ...base, action: 'download' })
        else if (roll < 0.9 && r.has('modify') && ['docx', 'xlsx', 'doc', 'xls'].includes(ext(f))) {
          push({ ...base, action: 'edit_open' })
          push({ ...base, t: t + (5 + rnd() * 40) * 60_000, action: 'edit_save', detail: '新版本' })
          t += 45 * 60_000
        } else if (r.has('write')) push({ ...base, action: 'upload', detail: '同名上传 → 新版本' })
        else push({ ...base, action: 'preview' })
      }
      if (rnd() < 0.55) push({ t: t + (20 + rnd() * 90) * 60_000, who: u.name, whoId: u.id, ip, action: 'signout', ok: true, path: '' })
    }
    // a few people mistype their password every week
    if (rnd() < 0.25) {
      const u = pick(active)
      const d1 = new Date(day)
      d1.setHours(9, Math.floor(rnd() * 50))
      push({ t: d1.getTime(), who: u.name, whoId: u.id, ip: ipOf(u), action: 'signin_fail', ok: false, path: '', reason: '密码错误' })
    }
  }
}

function seedIncidents() {
  const at = (m: number, d: number, h: number, mi: number, s = 0) => new Date(2026, m - 1, d, h, mi, s).getTime()
  const sys = { who: '系统', whoId: 'system', ip: '—' }
  const admin = { who: '王管理', whoId: 'admin', ip: '10.2.1.8' }
  const by = (name: string, ip?: string) => ({ who: name, whoId: person(name).id, ip: ip ?? ipOf(person(name)) })

  // 1. late-night bulk zip by 孙七 (one event per file, story 68)
  const rd = byPath('/研发部')
  push({ t: at(11, 16, 22, 31), ...by('孙七'), action: 'signin', ok: true, path: '' })
  let t = at(11, 16, 22, 38)
  for (const [label, dir] of [['研发部.zip', rd], ['研发部.zip', rd], ['项目.zip', byPath('/项目/2026-智慧园区')]] as const) {
    for (const f of walk(dir).filter((x) => x.type === 'file')) {
      const okRead = userRights(person('孙七'), f).has('read')
      if (!userRights(person('孙七'), f).has('list')) continue
      push({ t: (t += 900), ...by('孙七'), action: 'download', ok: okRead, reason: okRead ? undefined : '无下载权限，已从压缩包中略去', node: f, path: pathOfNode(f), via: label, size: f.size })
    }
    t += 4 * 60_000
  }

  // 2. a password-guessing burst against 李四 from an unknown address, then a success and a budget download
  for (let i = 0; i < 7; i++) push({ t: at(11, 15, 2, 10, i * 9), ...by('李四', '172.16.9.23'), action: 'signin_fail', ok: false, path: '', reason: i === 6 ? '密码错误，账户锁定 15 分钟' : '密码错误' })
  push({ t: at(11, 15, 2, 31), ...by('李四', '172.16.9.23'), action: 'signin', ok: true, path: '' })
  const budget = byPath('/财务部/2026 年度预算.xlsx')
  push({ t: at(11, 15, 2, 33), ...by('李四', '172.16.9.23'), action: 'download', ok: true, node: budget, path: pathOfNode(budget), size: budget.size })
  const voucher = byPath('/财务部/凭证/2026-10 凭证汇总.xlsx')
  push({ t: at(11, 15, 2, 34), ...by('李四', '172.16.9.23'), action: 'download', ok: true, node: voucher, path: pathOfNode(voucher), size: voucher.size })

  // 3. a rename: earlier events keep the old name in their path (story 69)
  const spec = byPath('/研发部/后端组/设计文档/接口规范 v3.docx')
  const renameAt = at(11, 12, 10, 28)
  for (const e of LOG) if (e.node === spec && e.t < renameAt) e.path = e.path.replace('接口规范 v3.docx', '接口规范 v2.docx')
  push({ t: renameAt, ...by('孙七'), action: 'rename', ok: true, node: spec, path: '/研发部/后端组/设计文档/接口规范 v2.docx', detail: '→ 接口规范 v3.docx' })

  // 4. a move: 设计稿.zip used to live in 公共资料
  const art = byPath('/研发部/前端组/设计稿.zip')
  const moveAt = at(11, 3, 10, 5)
  for (const e of LOG) if (e.node === art && e.t < moveAt) e.path = '/公共资料/设计稿.zip'
  push({ t: moveAt, ...by('周八'), action: 'move', ok: true, node: art, path: '/公共资料/设计稿.zip', detail: '→ /研发部/前端组' })

  // 5. a delete spree in 前端组 (later purged), and the two items now in the Recycle Bin
  push({ t: at(11, 13, 17, 41), ...by('周八'), action: 'signin', ok: true, path: '' })
  push({ t: at(11, 16, 8, 48), ...admin, action: 'signin', ok: true, path: '' })
  for (let i = 1; i <= 12; i++) {
    const g = ghost(`旧稿-${pad(i)}.psd`, '/研发部/前端组', 40_000_000)
    push({ t: at(11, 13, 17, 55, i * 3), ...by('周八'), action: 'delete', ok: true, node: g, path: `/研发部/前端组/${g.name}`, size: g.size })
    push({ t: at(11, 16, 8, 50, i), ...admin, action: 'purge', ok: true, node: g, path: `/研发部/前端组/${g.name}`, detail: '清空回收站' })
  }
  push({ t: at(11, 12, 10, 0), ...by('张三'), action: 'delete', ok: true, node: ghost('旧版接口规范.docx', '/研发部/后端组/设计文档'), path: '/研发部/后端组/设计文档/旧版接口规范.docx' })
  push({ t: at(11, 1, 18, 0), ...by('张三'), action: 'delete', ok: true, node: ghost('临时', '/项目/2026-智慧园区'), path: '/项目/2026-智慧园区/临时', detail: '文件夹，含 6 个文件' })
  const g2 = ghost('报价单-作废.xlsx', '/项目/2026-智慧园区/合同')
  push({ t: at(10, 20, 15, 2), ...by('张三'), action: 'delete', ok: true, node: g2, path: '/项目/2026-智慧园区/合同/报价单-作废.xlsx' })
  push({ t: at(10, 21, 9, 12), ...by('张三'), action: 'restore', ok: true, node: g2, path: '/项目/2026-智慧园区/合同/报价单-作废.xlsx' })
  push({ t: at(10, 28, 11, 0), ...by('张三'), action: 'delete', ok: true, node: g2, path: '/项目/2026-智慧园区/合同/报价单-作废.xlsx' })

  // 6. overlapping edits on 补充协议一 and a refused download (story 58)
  const sup = byPath('/项目/2026-智慧园区/合同/补充协议一.docx')
  const supP = pathOfNode(sup)
  push({ t: at(11, 16, 8, 55), ...by('孙七'), action: 'edit_open', ok: true, node: sup, path: supP, detail: '基于 v2' })
  push({ t: at(11, 16, 9, 2), ...by('张三'), action: 'edit_open', ok: true, node: sup, path: supP, detail: '基于 v2' })
  push({ t: at(11, 16, 9, 31), ...by('张三'), action: 'edit_save', ok: true, node: sup, path: supP, detail: 'v3' })
  push({ t: at(11, 16, 9, 40), ...by('孙七'), action: 'edit_save', ok: true, node: sup, path: supP, detail: 'v4（基于 v2，过期保存）', stale: true })
  push({ t: at(11, 15, 19, 2), ...by('李四'), action: 'download', ok: false, node: sup, path: supP, reason: '无下载权限（仅浏览）' })
  const db = byPath('/研发部/后端组/设计文档/数据库设计.xlsx')
  push({ t: at(11, 9, 14, 20), ...by('孙七'), action: 'version_restore', ok: true, node: db, path: pathOfNode(db), detail: '恢复 v1 → 生成 v3' })

  // 7. Grant and account changes (Administrator-only events, story 73)
  const rel = byPath('/研发部/后端组/发布包')
  push({ t: at(11, 10, 11, 2), ...admin, action: 'grant', ok: true, node: rel, path: pathOfNode(rel), detail: '授予 发布评审组：只读（本层及以下）' })
  push({ t: at(11, 14, 16, 30), ...admin, action: 'grant', ok: true, node: rel, path: pathOfNode(rel), detail: '授予 23 位个人：仅浏览（本层及以下）' })
  const drop = byPath('/公共资料/资料投递')
  push({ t: at(11, 1, 9, 0), ...admin, action: 'grant', ok: true, node: drop, path: pathOfNode(drop), detail: '授予 全公司：投递箱（仅本层）' })
  const ct = byPath('/项目/2026-智慧园区/合同')
  push({ t: at(11, 6, 10, 15), ...by('张三'), action: 'grant', ok: true, node: ct, path: pathOfNode(ct), detail: '授予 李四：仅浏览（本层及以下）' })
  push({ t: at(11, 5, 17, 40), ...admin, action: 'account', ok: true, path: '', detail: '停用 钱十（市场部）' })
  for (const u of PEOPLE.filter((x) => x.groups.includes('newbie')).slice(0, 5)) push({ t: at(11, 3, 9, 30), ...admin, action: 'account', ok: true, path: '', detail: `激活 ${u.name}，归属 ${u.orgLabel}` })
  push({ t: at(11, 11, 14, 0), ...admin, action: 'account', ok: true, path: '', detail: '将 吴九 加入 智慧园区项目组' })
  push({ t: at(11, 17, 9, 5), ...admin, action: 'signin', ok: true, path: '' })
}

seedHistory()
seedIncidents()
LOG.sort((a, b) => a.t - b.t)

// ---------------------------------------------------------------- live recording
export const ctx: { actor: User | null } = { actor: null }

/** Called by the prototype's store and transfer engine. */
export function record(action: Action, node?: Node, extra: Partial<Ev> = {}) {
  const u = ctx.actor
  if (!u) return
  LOG.push({ id: seq++, t: Date.now() < BASE ? BASE + (seq % 1000) * 1000 : Date.now(), who: u.name, whoId: u.id, ip: ipOf(u), action, ok: true, node, path: node ? pathOfNode(node) : '', size: node?.size, live: true, ...extra })
  listeners.forEach((f) => f())
}
export function signIn(u: User) {
  if (ctx.actor?.id === u.id) return
  if (ctx.actor) record('signout')
  ctx.actor = u
  record('signin')
}

// ---------------------------------------------------------------- scope and query
/** Directories whose item events this User may query: the topmost ones where they hold the Grant Right. */
export function auditRoots(u: User): Node[] {
  if (u.admin) return [ROOT]
  const out: Node[] = []
  const go = (n: Node) => {
    if (n !== ROOT && n.type === 'dir' && userRights(u, n).has('grant')) return void out.push(n)
    for (const c of n.children ?? []) if (c.type === 'dir') go(c)
  }
  go(ROOT)
  return out
}
const under = (n: Node | undefined, root: Node) => {
  for (let p = n; p; p = p.parent) if (p === root) return true
  return false
}
/**
 * Story 72/73. PROTOTYPE choice: an item is "within" a directory if it is there now OR its path at the time was
 * (so a file moved out of your area still shows its history with you, and a file moved in brings its history along).
 */
export function canSee(u: User, e: Ev, roots = auditRoots(u)): boolean {
  if (u.admin) return true
  if (adminOnly(e.action)) return false
  return roots.some((r) => under(e.node, r) || e.path.startsWith(pathOfNode(r) + '/'))
}

export type Filter = {
  who?: string
  /** path prefix (directory) or exact item */
  where?: Node
  cats?: Category[]
  from?: number
  to?: number
  failedOnly?: boolean
  ip?: string
  text?: string
  /** round 9 */
  actions?: Action[]
  pathLike?: string
}
export function query(u: User, f: Filter = {}): Ev[] {
  const roots = auditRoots(u)
  const wp = f.where && f.where !== ROOT ? pathOfNode(f.where) : null
  const out: Ev[] = []
  for (let i = LOG.length - 1; i >= 0; i--) {
    const e = LOG[i]
    if (f.from && e.t < f.from) continue
    if (f.to && e.t >= f.to) continue
    if (f.who && e.whoId !== f.who) continue
    if (f.cats?.length && !f.cats.includes(ACTION[e.action].cat)) continue
    if (f.failedOnly && e.ok) continue
    if (f.ip && e.ip !== f.ip) continue
    if (f.actions?.length && !f.actions.includes(e.action)) continue
    if (f.pathLike && !e.path.includes(f.pathLike)) continue
    if (f.where && f.where !== ROOT) {
      const hit = f.where.type === 'file' ? e.node === f.where : under(e.node, f.where) || e.path === wp || e.path.startsWith(wp + '/')
      if (!hit) continue
    }
    if (f.text && !`${e.who} ${e.path} ${e.detail ?? ''} ${e.ip} ${e.via ?? ''}`.includes(f.text)) continue
    if (!canSee(u, e, roots)) continue
    out.push(e)
  }
  return out
}

/** Where the item is now, or why it is not anywhere. */
export function nowAt(e: Ev): { label: string; gone?: boolean } | null {
  if (!e.node) return null
  if (e.node.id.startsWith('ghost')) {
    const purged = LOG.some((x) => x.node === e.node && x.action === 'purge')
    return { label: purged ? '已彻底清除' : '在回收站', gone: true }
  }
  let attached = true
  for (let p: Node | undefined = e.node; p && p !== ROOT; p = p.parent) if (!p.parent?.children?.includes(p)) attached = false
  if (!attached) return { label: '在回收站', gone: true }
  const cur = pathOfNode(e.node)
  return cur === e.path ? null : { label: `现在：${cur}` }
}

export function describe(e: Ev): string {
  const a = ACTION[e.action].label
  if (e.action === 'account') return e.detail ?? a
  if (!e.path) return a
  return `${a} ${e.path.split('/').pop()}${e.detail ? ` ${e.detail}` : ''}`
}

/** CSV with a BOM so Excel opens Chinese correctly. The export itself is recorded (auditing the auditors). */
export function exportCsv(rows: Ev[], name: string) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
  const head = ['时间', '用户', '来源 IP', '操作', '对象（当时路径）', '结果', '说明', '所属压缩包']
  const lines = rows.map((e) => [fmtFull(e.t), e.who, e.ip, ACTION[e.action].label, e.path, e.ok ? '成功' : '失败', [e.detail, e.reason].filter(Boolean).join('；'), e.via ?? ''].map(esc).join(','))
  const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  record('export', undefined, { detail: `导出 ${rows.length} 条` })
}

// ---------------------------------------------------------------- aggregation for the feed (L4)
export type Burst = { key: string; who: string; whoId: string; action: Action; first: number; last: number; events: Ev[]; via?: string }
/** Collapse runs of the same person doing the same thing within 30 minutes (or the same zip) into one card. */
export function bursts(evs: Ev[]): Burst[] {
  const out: Burst[] = []
  for (const e of [...evs].sort((a, b) => b.t - a.t)) {
    const b = out[out.length - 1]
    if (b && b.whoId === e.whoId && b.action === e.action && (e.via ? b.via === e.via : !b.via) && b.first - e.t < 30 * 60_000 && e.action !== 'grant' && e.action !== 'account') {
      b.events.push(e)
      b.first = e.t
    } else out.push({ key: `b${e.id}`, who: e.who, whoId: e.whoId, action: e.action, first: e.t, last: e.t, events: [e], via: e.via })
  }
  return out
}

export type Signal = { key: string; title: string; detail: string; tone: 'danger' | 'warn' | 'info'; events: Ev[]; adminOnly?: boolean }
/** Heuristics a reviewer would otherwise scan for by eye. PROTOTYPE thresholds. */
export function signals(u: User, from: number): Signal[] {
  const evs = query(u, { from })
  const out: Signal[] = []
  const groups = new Map<string, Ev[]>()
  for (const e of evs) {
    const k = `${e.action}|${e.whoId}|${e.ip}|${dayKey(e.t)}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  for (const [k, es] of groups) {
    const [a] = k.split('|')
    if (a === 'signin_fail' && es.length >= 3) out.push({ key: k, tone: 'danger', adminOnly: true, title: `${es[0].who} 连续登录失败 ${es.length} 次`, detail: `${fmt(es[es.length - 1].t)} 起，来自 ${es[0].ip}${es[0].ip.startsWith('10.') ? '' : '（非办公网段）'}`, events: es })
    if (a === 'download' && es.length >= 8 && es.some((e) => offHours(e.t))) out.push({ key: k, tone: 'warn', title: `${es[0].who} 非工作时间下载 ${es.length} 个文件`, detail: `${fmt(es[es.length - 1].t)}–${fmt(es[0].t).slice(6)}${es[0].via ? `，打包 ${new Set(es.map((e) => e.via)).size} 次` : ''}`, events: es })
    if (a === 'delete' && es.length >= 5) out.push({ key: k, tone: 'warn', title: `${es[0].who} 一次删除 ${es.length} 项`, detail: fmt(es[es.length - 1].t), events: es })
  }
  const offSignin = evs.filter((e) => e.action === 'signin' && !e.ip.startsWith('10.'))
  for (const e of offSignin) out.push({ key: `ip${e.id}`, tone: 'danger', adminOnly: true, title: `${e.who} 从陌生地址登录成功`, detail: `${fmt(e.t)} · ${e.ip}`, events: evs.filter((x) => x.whoId === e.whoId && x.ip === e.ip) })
  const stale = evs.filter((e) => e.stale)
  if (stale.length) out.push({ key: 'stale', tone: 'info', title: `${stale.length} 次过期保存`, detail: stale.map((e) => e.path.split('/').pop()).join('、'), events: stale })
  const failed = evs.filter((e) => !e.ok && e.action !== 'signin_fail')
  if (failed.length) out.push({ key: 'denied', tone: 'info', title: `${failed.length} 次越权尝试被拒`, detail: [...new Set(failed.map((e) => e.who))].join('、'), events: failed })
  return out.sort((a, b) => ['danger', 'warn', 'info'].indexOf(a.tone) - ['danger', 'warn', 'info'].indexOf(b.tone))
}

export const oldest = () => LOG[0]?.t ?? BASE
export const RETENTION_DAYS = 180

// ---------------------------------------------------------------- sessions (round 9)
/** A sign-in session: same person and IP, from a sign-in until sign-out, a new sign-in, or 2 hours idle (spec: sliding 2-hour expiry). */
export type Session = { key: string; who: string; whoId: string; ip: string; start: number; end: number; signin?: Ev; signout?: Ev; expired: boolean; events: Ev[] }
let sessCache: { n: number; byEv: Map<number, Session>; all: Session[] } = { n: -1, byEv: new Map(), all: [] }
function buildSessions() {
  if (sessCache.n === LOG.length) return sessCache
  const byEv = new Map<number, Session>()
  const all: Session[] = []
  const open = new Map<string, Session>()
  for (const e of [...LOG].sort((a, b) => a.t - b.t)) {
    if (e.whoId === 'system' || e.action === 'signin_fail') continue
    let s = open.get(e.whoId)
    if (s && (e.action === 'signin' || e.ip !== s.ip || e.t - s.end > 2 * 3600_000)) {
      s.expired = !s.signout
      open.delete(e.whoId)
      s = undefined
    }
    if (!s) {
      s = { key: `s${e.id}`, who: e.who, whoId: e.whoId, ip: e.ip, start: e.t, end: e.t, expired: false, events: [] }
      if (e.action === 'signin') s.signin = e
      all.push(s)
      open.set(e.whoId, s)
    }
    s.events.push(e)
    s.end = e.t
    byEv.set(e.id, s)
    if (e.action === 'signout') (s.signout = e), open.delete(e.whoId)
  }
  for (const s of open.values()) s.expired = now() - s.end > 2 * 3600_000
  sessCache = { n: LOG.length, byEv, all }
  return sessCache
}
export const sessionOf = (e: Ev) => buildSessions().byEv.get(e.id)
export const allSessions = () => buildSessions().all
