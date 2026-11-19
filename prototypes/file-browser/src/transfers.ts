// PROTOTYPE round 7: a fake transfer engine shared by every transfer panel variant (T1–T4).
// Nothing touches a network. It only models what the real thing will expose to the UI:
//   - uploads go browser → object storage in 64 MiB parts, 3 files at a time, sharing a gigabit link;
//   - a network drop loses only the part in flight; on reconnect the parts already stored are listed and the rest continue;
//   - a page reload keeps the server-side multipart session but the browser loses the File, so the User must pick it again;
//   - downloads are presigned redirects handled by the browser's own download manager, so the app sees no progress;
//   - zips stream through the app and are refused above 10 GB before they start.
// State is in memory; reload the page to reset.
import { useEffect, useState } from 'react'
import type { Node, User } from './data'
import { ROOT } from './data'
import { ensureDir, pathString, uniqueName, upload } from './store'
import { userRights } from './rights'
import { record, zipEvent } from './audit'

const MB = 1024 ** 2
const GB = 1024 ** 3
export const PART = 64 * MB
export const MAX_FILE = 20 * GB
export const ZIP_MAX = 10 * GB
export const BLOCKED = ['exe', 'bat', 'cmd', 'vbs', 'ps1', 'msi', 'scr']
export const LINK = 112 * MB // gigabit LAN
export const PARALLEL = 3

export type Status =
  | 'conflict' // same name exists, waiting for 新版本 / 保留两者
  | 'queued'
  | 'running'
  | 'paused'
  | 'offline' // network dropped; resumes by itself
  | 'needsFile' // page reloaded; parts are on the server, the File is gone from the browser
  | 'blocked' // refused before starting (extension, 20 GB, zip 10 GB)
  | 'done'
  | 'canceled'
  | 'preparing' // zip: counting files and checking Download on each
  | 'browser' // handed to the browser's download manager
export type Kind = 'upload' | 'download' | 'zip'
export type Choice = 'version' | 'keepBoth'

export type Job = {
  id: string
  batch: string
  kind: Kind
  name: string
  /** folder path inside the dropped folder, '' for loose files */
  rel: string
  size: number
  sent: number
  speed: number
  status: Status
  reason?: string
  existing?: Node
  choice?: Choice
  /** drop box: a same-named file the User cannot see exists; renamed silently so nothing leaks */
  silentRename?: boolean
  final?: string
  result?: Node
  version?: number
  /** byte offset a resume restarted from (whole parts already on the server) */
  resumedAt?: number
  skipped?: number
  count?: number
  at: number
}
export type Batch = { id: string; kind: Kind; label: string; dir: Node; folder?: string; staged: boolean; dropBox: boolean; at: number }

export const T = {
  jobs: [] as Job[],
  batches: [] as Batch[],
  online: true,
  speedup: 1,
  actor: null as User | null,
  reloads: 0,
  /** bumped when something new should pull the panel into view */
  revealAt: 0,
}

// ---------- subscription ----------
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
export function useTransfers() {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick((x) => x + 1)
    subs.add(f)
    return () => void subs.delete(f)
  }, [])
  return T
}

let seq = 1
const id = () => `t${seq++}`
const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '')
const floorPart = (b: number) => Math.floor(b / PART) * PART

export const batchOf = (j: Job) => T.batches.find((b) => b.id === j.batch)!
export const jobsOf = (b: Batch) => T.jobs.filter((j) => j.batch === b.id)
export const parts = (j: Job) => ({ done: Math.floor(j.sent / PART), total: Math.max(1, Math.ceil(j.size / PART)) })
export const isLive = (j: Job) => ['queued', 'running', 'paused', 'offline', 'needsFile', 'conflict', 'preparing'].includes(j.status)
export const needsHand = (j: Job) => ['conflict', 'needsFile'].includes(j.status)

/** Where a job's file will land. Undefined while its folders do not exist yet. */
function targetDir(b: Batch, rel: string, create = false): Node | undefined {
  let d: Node | undefined = b.dir
  for (const part of [b.folder, ...rel.split('/')].filter(Boolean) as string[]) {
    if (!d) return undefined
    d = create ? ensureDir(d, part, T.actor!.name) : d.children!.find((c) => c.type === 'dir' && c.name === part)
  }
  return d
}

export type Incoming = { name: string; size: number; rel?: string }

/** Add an upload batch. A folder drop passes `folder` and files with `rel`. `stage` holds it for a preflight review. */
export function enqueue(dir: Node, files: Incoming[], opts: { folder?: string; stage?: boolean } = {}): Batch {
  const u = T.actor!
  const r = userRights(u, dir)
  const dropBox = r.has('write') && !r.has('list')
  const b: Batch = {
    id: id(), kind: 'upload', dir, folder: opts.folder, staged: !!opts.stage, dropBox, at: Date.now(),
    label: opts.folder ?? (files.length === 1 ? files[0].name : `${files.length} 个文件`),
  }
  T.batches.push(b)
  for (const f of files) {
    const j: Job = { id: id(), batch: b.id, kind: 'upload', name: f.name, rel: f.rel ?? '', size: f.size, sent: 0, speed: 0, status: 'queued', at: Date.now() }
    const e = extOf(f.name)
    const parent = targetDir(b, j.rel)
    const same = parent?.children!.find((c) => c.type === 'file' && c.name === f.name)
    if (BLOCKED.includes(e)) Object.assign(j, { status: 'blocked', reason: `不允许上传 .${e} 文件` })
    else if (f.size > MAX_FILE) Object.assign(j, { status: 'blocked', reason: `超过单文件 20 GB 上限` })
    else if (same && dropBox && !userRights(u, same).has('list')) Object.assign(j, { choice: 'keepBoth', silentRename: true })
    else if (same) Object.assign(j, { status: 'conflict', existing: same })
    T.jobs.push(j)
  }
  emit()
  return b
}

export function download(n: Node) {
  const b: Batch = { id: id(), kind: 'download', label: n.name, dir: n.parent ?? ROOT, staged: false, dropBox: false, at: Date.now() }
  T.batches.push(b)
  record('download', n)
  T.jobs.push({ id: id(), batch: b.id, kind: 'download', name: n.name, rel: '', size: n.size, sent: n.size, speed: 0, status: 'browser', at: Date.now() })
  emit()
  return b
}

/** Zip the readable files under the selection; files visible but without Download are left out and counted. */
export function zip(nodes: Node[], fake?: { label: string; size: number; count: number }) {
  const u = T.actor!
  let size = 0, count = 0, skipped = 0
  const walk = (n: Node) => {
    if (n.type === 'dir') return n.children!.forEach(walk)
    if (!userRights(u, n).has('list')) return
    if (userRights(u, n).has('read')) (size += n.size), count++
    else skipped++
  }
  if (fake) (size = fake.size), (count = fake.count)
  else nodes.forEach(walk)
  const label = fake?.label ?? (nodes.length === 1 ? `${nodes[0].name}.zip` : `打包下载（${nodes.length} 项）.zip`)
  const b: Batch = { id: id(), kind: 'zip', label, dir: nodes[0]?.parent ?? ROOT, staged: false, dropBox: false, at: Date.now() }
  T.batches.push(b)
  const j: Job = { id: id(), batch: b.id, kind: 'zip', name: label, rel: '', size, sent: 0, speed: 0, status: 'preparing', count, skipped, at: Date.now() }
  if (size > ZIP_MAX) Object.assign(j, { status: 'blocked', reason: `打包内容共 ${(size / GB).toFixed(1)} GB，超过 10 GB 上限。请分批选择，或单独下载大文件` })
  T.jobs.push(j)
  // round 10: ONE Audit Event per zip, listing the files packed and the ones left out
  if (!fake && j.status !== 'blocked') {
    const ev = zipEvent(u, nodes, label)
    record('download', ev.node, ev)
  }
  emit()
  return j
}

// ---------- actions ----------
const find = (jid: string) => T.jobs.find((j) => j.id === jid)!
export function resolve(jid: string, choice: Choice) {
  const j = find(jid)
  Object.assign(j, { choice, status: 'queued' })
  emit()
}
export function resolveAll(bid: string, choice: Choice) {
  T.jobs.filter((j) => j.batch === bid && j.status === 'conflict').forEach((j) => Object.assign(j, { choice, status: 'queued' }))
  emit()
}
export function pause(jid: string) {
  const j = find(jid)
  if (['running', 'queued', 'offline'].includes(j.status)) Object.assign(j, { status: 'paused', speed: 0, sent: floorPart(j.sent) })
  emit()
}
export function resume(jid: string) {
  const j = find(jid)
  if (j.status === 'paused') Object.assign(j, { status: 'queued', resumedAt: j.sent || undefined })
  emit()
}
export function cancel(jid: string) {
  const j = find(jid)
  // aborting a multipart upload also tells storage to drop its stored parts
  if (j.status === 'blocked') T.jobs = T.jobs.filter((x) => x !== j)
  else if (isLive(j)) Object.assign(j, { status: 'canceled', speed: 0 })
  emit()
}
/** Simulated: the User picks the same file again after a reload; matched by name + size, then resumes from the stored parts. */
export function repick(jid: string) {
  const j = find(jid)
  Object.assign(j, { status: 'queued', resumedAt: j.sent || undefined })
  emit()
}
export const repickAll = () => T.jobs.filter((j) => j.status === 'needsFile').forEach((j) => repick(j.id))
export function pauseBatch(bid: string) {
  T.jobs.filter((j) => j.batch === bid).forEach((j) => pause(j.id))
}
export function resumeBatch(bid: string) {
  T.jobs.filter((j) => j.batch === bid).forEach((j) => resume(j.id))
}
export function cancelBatch(bid: string) {
  T.jobs.filter((j) => j.batch === bid && isLive(j)).forEach((j) => Object.assign(j, { status: 'canceled', speed: 0 }))
  emit()
}
export function pauseAll() {
  T.jobs.filter((j) => j.kind === 'upload').forEach((j) => pause(j.id))
}
export function resumeAll() {
  T.jobs.filter((j) => j.kind === 'upload').forEach((j) => resume(j.id))
}
export function startBatch(bid: string) {
  const b = T.batches.find((x) => x.id === bid)!
  b.staged = false
  emit()
}
export function discardBatch(bid: string) {
  T.jobs = T.jobs.filter((j) => j.batch !== bid)
  T.batches = T.batches.filter((b) => b.id !== bid)
  emit()
}
export function clearFinished() {
  T.jobs = T.jobs.filter((j) => isLive(j))
  T.batches = T.batches.filter((b) => T.jobs.some((j) => j.batch === b.id))
  emit()
}
export function dropJob(jid: string) {
  T.jobs = T.jobs.filter((j) => j.id !== jid)
  emit()
}

export function reveal() {
  T.revealAt = Date.now()
  emit()
}

// ---------- simulation controls (prototype bar only) ----------
export function goOffline(ms: number) {
  T.online = false
  emit()
  setTimeout(() => {
    T.online = true
    // reconnect: list stored parts, continue from the last whole part
    T.jobs.filter((j) => j.status === 'offline').forEach((j) => Object.assign(j, { status: 'queued', sent: floorPart(j.sent), resumedAt: floorPart(j.sent) || undefined }))
    emit()
  }, ms)
}
export function simulateReload() {
  T.reloads++
  T.jobs = T.jobs.filter((j) => !(j.kind === 'upload' && (batchOf(j).staged || j.status === 'conflict')))
  T.batches = T.batches.filter((b) => T.jobs.some((j) => j.batch === b.id))
  T.jobs
    .filter((j) => j.kind === 'upload' && ['queued', 'running', 'paused', 'offline'].includes(j.status))
    .forEach((j) => Object.assign(j, { status: 'needsFile', speed: 0, sent: floorPart(j.sent) }))
  emit()
}
export function setSpeedup(x: number) {
  T.speedup = x
  emit()
}

// ---------- ticking ----------
function complete(j: Job) {
  const b = batchOf(j)
  const dir = targetDir(b, j.rel, true)!
  const name = j.choice === 'keepBoth' ? uniqueName(dir, j.name) : j.name
  const r = upload(dir, name, j.size, T.actor!.name)
  Object.assign(j, { status: 'done', sent: j.size, speed: 0, final: name, result: r.node, version: r.newVersion ? r.node.versions![0].v : undefined })
}

let last = performance.now()
setInterval(() => {
  const now = performance.now()
  const dt = ((now - last) / 1000) * T.speedup
  last = now
  if (!T.jobs.some((j) => ['running', 'queued', 'preparing', 'offline'].includes(j.status))) return
  for (const j of T.jobs.filter((j) => j.status === 'preparing')) {
    j.sent += dt * 3 * GB
    if (j.sent >= Math.max(j.size, 1.5 * GB)) Object.assign(j, { status: 'browser', sent: j.size })
  }
  if (!T.online) {
    T.jobs.filter((j) => j.status === 'running').forEach((j) => Object.assign(j, { status: 'offline', speed: 0 }))
    return emit()
  }
  const running = T.jobs.filter((j) => j.status === 'running')
  for (const j of T.jobs) {
    if (running.length >= PARALLEL) break
    if (j.kind === 'upload' && j.status === 'queued' && !batchOf(j).staged) (j.status = 'running'), running.push(j)
  }
  const share = running.length ? LINK / running.length : 0
  for (const j of running) {
    const v = share * (0.78 + Math.random() * 0.3)
    j.speed = j.speed ? j.speed * 0.75 + v * 0.25 : v
    j.sent = Math.min(j.size, j.sent + v * dt)
    if (j.sent >= j.size) complete(j)
  }
  emit()
}, 250)

// ---------- derived ----------
export type Sum = { size: number; sent: number; speed: number; count: number; done: number; live: number; eta: number; states: Partial<Record<Status, number>> }
export function sum(jobs: Job[]): Sum {
  const s: Sum = { size: 0, sent: 0, speed: 0, count: jobs.length, done: 0, live: 0, eta: 0, states: {} }
  for (const j of jobs) {
    s.states[j.status] = (s.states[j.status] ?? 0) + 1
    if (j.status === 'canceled' || j.status === 'blocked') continue
    s.size += j.size
    s.sent += j.sent
    s.speed += j.speed
    if (j.status === 'done') s.done++
    if (isLive(j)) s.live++
  }
  s.eta = s.speed ? (s.size - s.sent) / s.speed : 0
  return s
}
export const uploads = () => T.jobs.filter((j) => j.kind === 'upload')
export const pct = (sent: number, size: number) => (size ? Math.min(100, (sent / size) * 100) : 100)
export const where = (b: Batch) => (b.dir === ROOT ? '/' : pathString(b.dir)) + (b.folder ? `/${b.folder}` : '')

export function fmtBytes(b: number) {
  if (b <= 0) return '0'
  if (b >= GB) return `${(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB`
  if (b >= MB) return `${(b / MB).toFixed(b >= 100 * MB ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(b / 1024))} KB`
}
export const fmtSpeed = (b: number) => `${fmtBytes(b)}/s`
export function fmtEta(s: number) {
  s /= T.speedup
  if (!isFinite(s) || s <= 0) return ''
  if (s < 60) return `约 ${Math.max(1, Math.round(s))} 秒`
  if (s < 3600) return `约 ${Math.round(s / 60)} 分钟`
  return `约 ${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`
}

/** One-line human status, the same words in every variant. */
export function statusText(j: Job): string {
  const p = parts(j)
  switch (j.status) {
    case 'conflict': return '已有同名文件，等你选择'
    case 'queued': return j.resumedAt ? `排队中 · 将从第 ${Math.floor(j.resumedAt / PART) + 1}/${p.total} 片继续` : '排队中'
    case 'running': return `${fmtBytes(j.sent)} / ${fmtBytes(j.size)} · ${fmtSpeed(j.speed)}${j.resumedAt ? ` · 已从第 ${Math.floor(j.resumedAt / PART) + 1} 片续传` : ''}`
    case 'paused': return `已暂停 · ${fmtBytes(j.sent)} / ${fmtBytes(j.size)}`
    case 'offline': return `网络中断 · 已保存 ${p.done}/${p.total} 片，恢复后自动继续`
    case 'needsFile': return p.total > 1 ? `页面刷新后中断 · 服务器已有 ${p.done}/${p.total} 片，重新选择该文件即可继续` : '页面刷新后中断 · 小文件，重新选择后重传'
    case 'blocked': return j.reason!
    case 'done':
      if (j.kind !== 'upload') return '已完成'
      if (j.version) return `已存为新版本 v${j.version}`
      if (j.final !== j.name && !j.silentRename) return `已保存为“${j.final}”`
      return '已上传'
    case 'canceled': return '已取消'
    case 'preparing': return `正在准备 · ${j.count} 个文件${j.skipped ? `，${j.skipped} 个无下载权限将跳过` : ''}`
    case 'browser': return j.kind === 'zip' ? `已交给浏览器下载 · ${j.count} 个文件${j.skipped ? `（跳过 ${j.skipped} 个无下载权限）` : ''}` : '已交给浏览器下载，进度见浏览器下载栏'
  }
}

// ---------- scenarios for the 🧪 panel ----------
export const SCENARIOS: { key: string; label: string; run: (dir: Node) => Incoming[] | { folder: string; files: Incoming[] } | 'zip' }[] = [
  { key: 'few', label: '上传 3 个文件', run: () => [{ name: '设计说明 v2.docx', size: 2.3 * MB }, { name: '现场照片-0412.png', size: 4.1 * MB }, { name: '测试录屏.mp4', size: 860 * MB }] },
  {
    key: 'same', label: '上传含同名文件',
    run: (dir) => {
      const names = (dir.children ?? []).filter((c) => c.type === 'file').slice(0, 2).map((c) => c.name)
      return [...names.map((name) => ({ name, size: 3.4 * MB })), { name: '补充材料.pdf', size: 12 * MB }]
    },
  },
  {
    key: 'folder', label: '拖入文件夹（41 个文件）',
    run: () => ({
      folder: '园区三期-施工图',
      files: ['建筑', '结构', '给排水', '电气', '电气/弱电'].flatMap((sub, i) =>
        Array.from({ length: [12, 10, 7, 8, 4][i] }, (_, k) => ({ name: `${sub.split('/').pop()}-${String(k + 1).padStart(2, '0')}.${k % 3 ? 'dwg' : 'pdf'}`, size: (4 + ((k * 37 + i * 11) % 60)) * MB, rel: sub })),
      ),
    }),
  },
  { key: 'big', label: '上传 18 GB 大文件', run: () => [{ name: '园区全景航拍-原始素材.mov', size: 18.4 * GB }] },
  { key: 'bad', label: '上传 .exe 和 25 GB 文件', run: () => [{ name: '安装包-setup.exe', size: 46 * MB }, { name: '整机备份.img', size: 25 * GB }, { name: '安装说明.pdf', size: 1.2 * MB }] },
  { key: 'zip', label: '打包下载 12 GB', run: () => 'zip' },
]

// Round 7 verdict: closing or reloading the page while uploads are still running asks first.
// Browsers show their own generic wording; the page cannot customise it.
window.addEventListener('beforeunload', (e) => {
  if (!T.jobs.some((j) => j.kind === 'upload' && ['queued', 'running', 'paused', 'offline'].includes(j.status))) return
  e.preventDefault()
  e.returnValue = ''
})
