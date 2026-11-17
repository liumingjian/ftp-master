// PROTOTYPE round 8: four ways to look at Audit Events, all on T3 (the chosen file browser + D1 Grants + in-place uploads).
//
//   L1 检索表      an admin console: filter bar, per-day histogram, dense table, detail drawer, CSV export
//   L2 调查问题    question first: "who touched this file", "what did this person do", "what changed here", …
//   L3 就地动态    no console for department heads: activity lives next to the item (inspector + folder button)
//   L4 动态流      a feed: runs of the same action collapse into one card, heuristics surface what looks wrong
//
// Rules shared by all four (see audit.ts): events are read-only (no edit/delete anywhere); directory browsing is not
// recorded; Grant-Right holders see only item events within their directories and never sign-in, account or Grant events;
// paths are shown as they were at the time, with where the item is now.
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, Download, FileSearch, Filter, Fingerprint, FolderClock, History, KeyRound, Lock, Search, ShieldAlert, UserSearch, Users, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Node, PEOPLE, ROOT, User } from './data'
import { fmtSize } from './perm'
import { Avatar, FileIcon } from './ui'
import {
  ACTION, BASE, CATS, Category, DAY, Ev, Filter as Q, RETENTION_DAYS, auditRoots, bursts, canSee, dayKey, describe, exportCsv, fmt, fmtFull,
  nowAt, offHours, oldest, pathOfNode, query, signals, subscribe,
} from './audit'

export type AuditPageProps = { user: User; go: (n: Node) => void; at: Node }
export type AuditInspProps = { user: User; n: Node; go: (n: Node) => void }

export function useAudit() {
  const [, tick] = useState(0)
  useEffect(() => subscribe(() => tick((x) => x + 1)), [])
}

// ---------------------------------------------------------------- shared bits
const RANGES = [
  { key: '1', label: '今天', days: 1 },
  { key: '7', label: '近 7 天', days: 7 },
  { key: '30', label: '近 30 天', days: 30 },
  { key: '180', label: '近 180 天', days: 180 },
  { key: 'all', label: '全部', days: 0 },
]
const startOfToday = () => new Date(new Date(Math.max(Date.now(), BASE)).setHours(0, 0, 0, 0)).getTime()
const rangeFrom = (k: string) => {
  const r = RANGES.find((x) => x.key === k)!
  return r.days ? startOfToday() - (r.days - 1) * DAY : undefined
}
const CAT_TONE: Record<Category, string> = { read: 'read', write: 'write', delete: 'del', grant: 'grant', session: 'sess', account: 'grant' }

function ActionTag({ e }: { e: Ev }) {
  return <span className={`au-act ${CAT_TONE[ACTION[e.action].cat]} ${e.ok ? '' : 'fail'}`}>{ACTION[e.action].label}{e.ok ? '' : ' · 失败'}</span>
}

function ScopeNote({ user }: { user: User }) {
  if (user.admin) return null
  const roots = auditRoots(user)
  return (
    <div className="au-scope">
      <Lock size={13} /> 你在 {roots.map((r) => <b key={r.id}>{pathOfNode(r)}</b>)} 有授权权，只能看到这些位置里文件和文件夹的记录；登录、账户和授权变更仅管理员可见。
    </div>
  )
}

function Retention() {
  const days = Math.round((BASE - oldest()) / DAY)
  return (
    <span className="au-faint">
      <History size={12} /> 最早记录 {dayKey(oldest())}（{days} 天前）· 至少保留 {RETENTION_DAYS} 天 · 记录只追加，任何人都不能修改或删除 · 浏览目录不记录
    </span>
  )
}

function WhoPicker({ value, onChange, placeholder = '任何人' }: { value?: string; onChange: (id?: string) => void; placeholder?: string }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const cur = PEOPLE.find((u) => u.id === value)
  const hits = PEOPLE.filter((u) => !q || u.name.includes(q) || u.orgLabel.includes(q)).slice(0, 8)
  return (
    <div className="au-pick">
      <UserSearch size={14} className="au-faint" />
      {cur ? (
        <span className="au-chip on" onClick={() => onChange(undefined)}>{cur.name} <X size={11} /></span>
      ) : (
        <input value={q} placeholder={placeholder} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => setQ(e.target.value)} />
      )}
      {open && !cur && (
        <div className="au-pick-list">
          {hits.map((u) => (
            <button key={u.id} onMouseDown={() => (onChange(u.id), setQ(''))}>
              <Avatar name={u.name} size={20} /> {u.name} <span className="au-faint">{u.orgLabel}{u.inactive ? '（已停用）' : ''}</span>
            </button>
          ))}
          {PEOPLE.length > 8 && <div className="au-faint small" style={{ padding: '4px 8px' }}>共 {PEOPLE.length} 人，继续输入缩小范围</div>}
        </div>
      )}
    </div>
  )
}

/** Directories (and optionally files) inside the caller's audit roots, as an indented select. */
function scopeNodes(user: User, files = false): { n: Node; depth: number }[] {
  const out: { n: Node; depth: number }[] = []
  const walk = (n: Node, depth: number) => {
    out.push({ n, depth })
    for (const c of n.children ?? []) if (c.type === 'dir' || files) walk(c, depth + 1)
  }
  for (const r of auditRoots(user)) walk(r, 0)
  return out
}
function WherePicker({ user, value, onChange, files = false }: { user: User; value?: Node; onChange: (n?: Node) => void; files?: boolean }) {
  const opts = scopeNodes(user, files)
  return (
    <select className="au-select" value={value?.id ?? ''} onChange={(e) => onChange(opts.find((o) => o.n.id === e.target.value)?.n)}>
      <option value="">{user.admin ? '所有位置' : '我能审计的所有位置'}</option>
      {opts.filter((o) => o.n !== ROOT).map(({ n, depth }) => (
        <option key={n.id} value={n.id}>{'　'.repeat(depth)}{n.type === 'dir' ? '📁 ' : ''}{n.name}</option>
      ))}
    </select>
  )
}

function Detail({ e, close, pivot }: { e: Ev; close: () => void; pivot?: (f: Q) => void }) {
  const where = nowAt(e)
  return (
    <aside className="au-detail">
      <div className="au-detail-head">
        <ActionTag e={e} />
        <b className="grow">#{e.id}</b>
        <X size={16} onClick={close} style={{ cursor: 'pointer' }} />
      </div>
      <dl>
        <dt>时间</dt><dd>{fmtFull(e.t)}{offHours(e.t) && <span className="m-tag warn" style={{ marginLeft: 6 }}>非工作时间</span>}</dd>
        <dt>用户</dt><dd>{e.who} <span className="au-faint">{PEOPLE.find((u) => u.id === e.whoId)?.orgLabel ?? ''}</span></dd>
        <dt>来源 IP</dt><dd>{e.ip}{e.ip !== '—' && !e.ip.startsWith('10.') && <span className="m-tag warn" style={{ marginLeft: 6 }}>非办公网段</span>}</dd>
        <dt>结果</dt><dd>{e.ok ? '成功' : <span className="au-red">失败：{e.reason}</span>}</dd>
        {e.path && (<><dt>对象（当时）</dt><dd className="au-mono">{e.path}</dd></>)}
        {where && (<><dt>现在</dt><dd className={where.gone ? 'au-red' : ''}>{where.label}</dd></>)}
        {e.detail && (<><dt>说明</dt><dd>{e.detail}</dd></>)}
        {e.via && (<><dt>所属压缩包</dt><dd>{e.via}</dd></>)}
        {e.size ? (<><dt>大小</dt><dd>{fmtSize(e.size)}</dd></>) : null}
      </dl>
      {pivot && (
        <div className="au-pivots">
          <span className="au-faint small">以此为线索：</span>
          <button className="m-btn sm" onClick={() => pivot({ who: e.whoId })}>只看 {e.who}</button>
          {e.node && <button className="m-btn sm" onClick={() => pivot({ where: e.node })}>只看这个{e.node.type === 'dir' ? '文件夹' : '文件'}</button>}
          {e.ip !== '—' && <button className="m-btn sm" onClick={() => pivot({ ip: e.ip })}>只看 IP {e.ip}</button>}
        </div>
      )}
      <div className="au-faint small" style={{ marginTop: 16 }}><Lock size={11} /> 审计记录不可修改、不可删除</div>
    </aside>
  )
}

// ================================================================ L1 检索表
export function AuditTable({ user }: AuditPageProps) {
  useAudit()
  const [f, setF] = useState<Q>({})
  const [range, setRange] = useState('30')
  const [day, setDay] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<Ev | null>(null)
  const cats = CATS.filter((c) => user.admin || !c.adminOnly)
  const from = rangeFrom(range)
  const base = query(user, { ...f, from })
  const rows = day ? base.filter((e) => dayKey(e.t) === day) : base
  const PER = 40
  const pages = Math.max(1, Math.ceil(rows.length / PER))
  const set = (p: Partial<Q>) => (setF({ ...f, ...p }), setPage(0), setDay(null))

  // histogram of the range (per day)
  const hist = useMemo(() => {
    const m = new Map<string, { n: number; fail: number }>()
    for (const e of base) {
      const k = dayKey(e.t)
      const x = m.get(k) ?? { n: 0, fail: 0 }
      x.n++
      if (!e.ok) x.fail++
      m.set(k, x)
    }
    const start = from ?? Math.min(...base.map((e) => e.t), startOfToday())
    const out: { k: string; n: number; fail: number }[] = []
    for (let t = new Date(start).setHours(12); t <= startOfToday() + DAY; t += DAY) out.push({ k: dayKey(t), ...(m.get(dayKey(t)) ?? { n: 0, fail: 0 }) })
    return out
  }, [base.length, range])
  const max = Math.max(1, ...hist.map((h) => h.n))

  return (
    <div className="au-page">
      <div className="au-head">
        <h2>审计日志</h2>
        <Retention />
      </div>
      <ScopeNote user={user} />
      <div className="au-filters">
        <WhoPicker value={f.who} onChange={(who) => set({ who })} />
        <WherePicker user={user} value={f.where} onChange={(where) => set({ where })} files />
        <div className="au-seg">
          {RANGES.map((r) => <button key={r.key} className={range === r.key ? 'on' : ''} onClick={() => (setRange(r.key), setPage(0), setDay(null))}>{r.label}</button>)}
        </div>
        <div className="au-search"><Search size={14} /><input placeholder="路径、IP、说明…" value={f.text ?? ''} onChange={(e) => set({ text: e.target.value || undefined })} /></div>
      </div>
      <div className="au-filters">
        <Filter size={14} className="au-faint" />
        {cats.map((c) => {
          const on = f.cats?.includes(c.key)
          return <span key={c.key} className={`au-chip ${on ? 'on' : ''}`} onClick={() => set({ cats: on ? f.cats!.filter((x) => x !== c.key) : [...(f.cats ?? []), c.key] })}>{c.label}</span>
        })}
        <span className={`au-chip ${f.failedOnly ? 'on danger' : ''}`} onClick={() => set({ failedOnly: !f.failedOnly || undefined })}>仅失败</span>
        {f.ip && <span className="au-chip on" onClick={() => set({ ip: undefined })}>IP {f.ip} <X size={11} /></span>}
        <span className="grow" />
        <span className="au-faint small">{rows.length.toLocaleString()} 条</span>
        <button className="m-btn sm" disabled={!rows.length} onClick={() => exportCsv(rows, `审计-${dayKey(Date.now())}.csv`)}><Download size={14} /> 导出 CSV</button>
      </div>

      <div className="au-hist" title="点一天只看那天">
        {hist.map((h) => (
          <div key={h.k} className={`au-bar ${day === h.k ? 'on' : ''}`} onClick={() => (setDay(day === h.k ? null : h.k), setPage(0))} title={`${h.k}：${h.n} 条${h.fail ? `，${h.fail} 条失败` : ''}`}>
            <i style={{ height: `${(h.n / max) * 100}%` }}>{h.fail > 0 && <s style={{ height: `${Math.max(8, (h.fail / h.n) * 100)}%` }} />}</i>
          </div>
        ))}
      </div>
      {day && <div className="au-faint small" style={{ margin: '-4px 0 8px' }}>只看 {day} · <a onClick={() => setDay(null)}>取消</a></div>}

      <div className="au-body">
        <div className="au-table">
          <div className="au-tr au-th"><span>时间</span><span>用户</span><span>操作</span><span>对象（当时路径）</span><span>来源 IP</span></div>
          {rows.slice(page * PER, page * PER + PER).map((e) => {
            const where = nowAt(e)
            return (
              <div key={e.id} className={`au-tr ${open === e ? 'on' : ''} ${e.ok ? '' : 'fail'} ${e.live ? 'live' : ''}`} onClick={() => setOpen(e)}>
                <span className="au-mono">{fmt(e.t)}{offHours(e.t) && <i className="au-dot warn" title="非工作时间" />}</span>
                <span>{e.who}</span>
                <span><ActionTag e={e} /></span>
                <span className="au-path">
                  {e.path ? <span className="au-mono">{e.path}</span> : <span>{e.detail ?? '—'}</span>}
                  {e.via && <span className="m-tag">随 {e.via}</span>}
                  {e.stale && <span className="m-tag warn">过期保存</span>}
                  {where && <span className={`au-now ${where.gone ? 'gone' : ''}`}>{where.label}</span>}
                  {e.path && e.detail && e.action !== 'download' && <span className="au-faint small">{e.detail}</span>}
                </span>
                <span className="au-mono au-faint">{e.ip}</span>
              </div>
            )
          })}
          {!rows.length && <div className="m-empty">没有符合条件的记录</div>}
          {pages > 1 && (
            <div className="au-pager">
              <button className="m-btn sm" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button>
              <span className="au-faint small">{page + 1} / {pages}</span>
              <button className="m-btn sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>下一页</button>
            </div>
          )}
        </div>
        {open && <Detail e={open} close={() => setOpen(null)} pivot={(p) => (set(p), setOpen(null))} />}
      </div>
    </div>
  )
}

// ================================================================ L2 调查问题
type QKey = 'file' | 'person' | 'folder' | 'top' | 'signin' | 'grants'
const QUESTIONS: { key: QKey; icon: React.ReactNode; q: string; hint: string; admin?: boolean }[] = [
  { key: 'file', icon: <FileSearch size={16} />, q: '这个文件谁动过？', hint: '谁看过、谁下载过、谁改过，以及它改过名、搬过家吗' },
  { key: 'person', icon: <UserSearch size={16} />, q: '这个人做了什么？', hint: '按天列出某人的操作' },
  { key: 'folder', icon: <FolderClock size={16} />, q: '这里最近少了什么、变了什么？', hint: '删除、清除、恢复、改名、移动、新上传' },
  { key: 'top', icon: <Download size={16} />, q: '谁下载得最多？', hint: '按人排行，标出非工作时间' },
  { key: 'signin', icon: <KeyRound size={16} />, q: '有没有异常登录？', hint: '连续失败、陌生地址', admin: true },
  { key: 'grants', icon: <Fingerprint size={16} />, q: '谁改过权限和账户？', hint: '授权变更、激活与停用', admin: true },
]

export function AuditInvestigate({ user }: AuditPageProps) {
  useAudit()
  const qs = QUESTIONS.filter((q) => user.admin || !q.admin)
  const [k, setK] = useState<QKey>('file')
  const [item, setItem] = useState<Node | undefined>()
  const [who, setWho] = useState<string | undefined>()
  const [range, setRange] = useState('30')
  const [open, setOpen] = useState<Ev | null>(null)
  const from = rangeFrom(range)
  const ask = (key: QKey, p: { item?: Node; who?: string } = {}) => (setK(key), p.item && setItem(p.item), p.who && setWho(p.who), setOpen(null))

  let body: React.ReactNode = null
  let evidence: Ev[] = []
  if (k === 'file') {
    if (!item) body = <div className="m-empty">先选一个文件（或文件夹）</div>
    else {
      evidence = query(user, { where: item, from })
      const per = new Map<string, { who: string; id: string; read: number; dl: number; write: number; last: number }>()
      for (const e of evidence) {
        const r = per.get(e.whoId) ?? { who: e.who, id: e.whoId, read: 0, dl: 0, write: 0, last: 0 }
        if (e.action === 'preview') r.read++
        else if (e.action === 'download') r.dl++
        else r.write++
        r.last = Math.max(r.last, e.t)
        per.set(e.whoId, r)
      }
      const life = evidence.filter((e) => ['rename', 'move', 'delete', 'restore', 'purge', 'version_restore', 'grant'].includes(e.action) || e.stale)
      const names = [...new Set(evidence.map((e) => e.path))]
      body = (
        <>
          <p className="au-answer">
            {RANGES.find((r) => r.key === range)!.label}，<b>{per.size}</b> 人接触过 <b>{item.name}</b>：
            {[...per.values()].filter((r) => r.read).length} 人预览，{[...per.values()].filter((r) => r.dl).length} 人下载，{[...per.values()].filter((r) => r.write).length} 人修改或管理。
            {names.length > 1 && <> 期间它用过 {names.length} 个路径。</>}
          </p>
          <table className="au-mini">
            <thead><tr><th>人</th><th>预览</th><th>下载</th><th>修改/管理</th><th>最后一次</th><th /></tr></thead>
            <tbody>
              {[...per.values()].sort((a, b) => b.last - a.last).map((r) => (
                <tr key={r.id}>
                  <td><Avatar name={r.who} size={20} /> {r.who}</td><td>{r.read || ''}</td><td>{r.dl || ''}</td><td>{r.write || ''}</td><td className="au-mono">{fmt(r.last)}</td>
                  <td><a onClick={() => ask('person', { who: r.id })}>这个人还做了什么 →</a></td>
                </tr>
              ))}
            </tbody>
          </table>
          {life.length > 0 && (
            <>
              <div className="m-section-title">生命周期</div>
              <Timeline evs={life} onOpen={setOpen} />
            </>
          )}
        </>
      )
    }
  } else if (k === 'person') {
    if (!who) body = <div className="m-empty">先选一个人</div>
    else {
      evidence = query(user, { who, from })
      const p = PEOPLE.find((u) => u.id === who)!
      const by = (c: Category) => evidence.filter((e) => ACTION[e.action].cat === c).length
      const ips = [...new Set(evidence.map((e) => e.ip))]
      body = (
        <>
          <p className="au-answer">
            <b>{p.name}</b>（{p.orgLabel}）{RANGES.find((r) => r.key === range)!.label}共 <b>{evidence.length}</b> 条记录：查看下载 {by('read')}，上传修改 {by('write')}，删除恢复 {by('delete')}
            {user.admin && <>，登录 {by('session')}</>}。来自 {ips.length} 个地址{ips.some((ip) => !ip.startsWith('10.') && ip !== '—') && <span className="au-red">（含非办公网段 {ips.filter((ip) => !ip.startsWith('10.')).join('、')}）</span>}。
            {evidence.some((e) => offHours(e.t)) && <> 其中 <b>{evidence.filter((e) => offHours(e.t)).length}</b> 条在非工作时间。</>}
          </p>
          {!user.admin && <p className="au-faint small">你只能看到他在你管辖位置里的操作。</p>}
          <Timeline evs={evidence} onOpen={setOpen} byDay />
        </>
      )
    }
  } else if (k === 'folder') {
    const where = item?.type === 'dir' ? item : undefined
    evidence = query(user, { where, from, cats: ['delete', 'write'] }).filter((e) => !['edit_open', 'edit_save'].includes(e.action) && !(e.action === 'upload' && e.detail))
    const dels = evidence.filter((e) => e.action === 'delete')
    body = (
      <>
        <p className="au-answer">
          {where ? <b>{where.name}</b> : user.admin ? '全站' : '你管辖的位置'}{RANGES.find((r) => r.key === range)!.label}：删除 <b>{dels.length}</b> 项（{dels.filter((e) => nowAt(e)?.label === '已彻底清除').length} 项已彻底清除，其余还在回收站可恢复），
          改名或移动 {evidence.filter((e) => e.action === 'rename' || e.action === 'move').length} 次，新上传 {evidence.filter((e) => e.action === 'upload').length} 个文件。
        </p>
        <Timeline evs={evidence} onOpen={setOpen} byDay />
      </>
    )
  } else if (k === 'top') {
    evidence = query(user, { from, cats: ['read'] }).filter((e) => e.action === 'download')
    const per = new Map<string, { who: string; id: string; n: number; bytes: number; off: number; zips: Set<string> }>()
    for (const e of evidence) {
      const r = per.get(e.whoId) ?? { who: e.who, id: e.whoId, n: 0, bytes: 0, off: 0, zips: new Set() }
      r.n++
      r.bytes += e.size ?? 0
      if (offHours(e.t)) r.off++
      if (e.via) r.zips.add(e.via)
      per.set(e.whoId, r)
    }
    const top = [...per.values()].sort((a, b) => b.n - a.n).slice(0, 15)
    body = (
      <>
        <p className="au-answer">{RANGES.find((r) => r.key === range)!.label}共 {evidence.length} 次下载（打包下载按文件计），{per.size} 人。</p>
        <table className="au-mini">
          <thead><tr><th>人</th><th>文件数</th><th>总量</th><th>非工作时间</th><th>打包</th><th /></tr></thead>
          <tbody>
            {top.map((r) => (
              <tr key={r.id} className={r.off >= 5 ? 'warn' : ''}>
                <td><Avatar name={r.who} size={20} /> {r.who}</td><td>{r.n}</td><td>{fmtSize(r.bytes)}</td><td>{r.off || ''}</td><td>{[...r.zips].join('、')}</td>
                <td><a onClick={() => ask('person', { who: r.id })}>看明细 →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    )
  } else if (k === 'signin') {
    evidence = query(user, { from, cats: ['session'] }).filter((e) => e.action === 'signin_fail' || !e.ip.startsWith('10.'))
    body = (
      <>
        <p className="au-answer">{RANGES.find((r) => r.key === range)!.label}：{evidence.filter((e) => e.action === 'signin_fail').length} 次登录失败，{evidence.filter((e) => e.action === 'signin').length} 次从非办公网段登录成功。</p>
        <Timeline evs={evidence} onOpen={setOpen} byDay />
      </>
    )
  } else {
    evidence = query(user, { from, cats: ['grant', 'account'] })
    body = <Timeline evs={evidence} onOpen={setOpen} byDay />
  }

  const needs = k === 'file' ? 'item' : k === 'person' ? 'who' : k === 'folder' ? 'dir' : null
  return (
    <div className="au-page au-inv">
      <div className="au-head">
        <h2>审计调查</h2>
        <Retention />
      </div>
      <ScopeNote user={user} />
      <div className="au-inv-body">
        <nav className="au-qs">
          {qs.map((q) => (
            <div key={q.key} className={`au-q ${k === q.key ? 'on' : ''}`} onClick={() => ask(q.key)}>
              {q.icon}
              <div>
                <div>{q.q}</div>
                <div className="au-faint small">{q.hint}</div>
              </div>
            </div>
          ))}
        </nav>
        <section className="au-ans">
          <div className="au-filters">
            {needs === 'item' && <WherePicker user={user} value={item} onChange={setItem} files />}
            {needs === 'dir' && <WherePicker user={user} value={item?.type === 'dir' ? item : undefined} onChange={setItem} />}
            {needs === 'who' && <WhoPicker value={who} onChange={setWho} placeholder="输入姓名或部门" />}
            <div className="au-seg">
              {RANGES.map((r) => <button key={r.key} className={range === r.key ? 'on' : ''} onClick={() => setRange(r.key)}>{r.label}</button>)}
            </div>
            <span className="grow" />
            <button className="m-btn sm" disabled={!evidence.length} onClick={() => exportCsv(evidence, `审计调查-${dayKey(Date.now())}.csv`)}><Download size={14} /> 导出依据（{evidence.length} 条）</button>
          </div>
          {body}
        </section>
        {open && <Detail e={open} close={() => setOpen(null)} />}
      </div>
    </div>
  )
}

function Timeline({ evs, onOpen, byDay = false, limit = 200 }: { evs: Ev[]; onOpen: (e: Ev) => void; byDay?: boolean; limit?: number }) {
  const [more, setMore] = useState(false)
  const shown = more ? evs : evs.slice(0, limit)
  let lastDay = ''
  return (
    <div className="au-tl">
      {shown.map((e) => {
        const d = dayKey(e.t)
        const head = byDay && d !== lastDay ? ((lastDay = d), <div key={`d${d}`} className="au-tl-day">{d}</div>) : null
        const where = nowAt(e)
        return [
          head,
          <div key={e.id} className={`au-tl-row ${e.ok ? '' : 'fail'}`} onClick={() => onOpen(e)}>
            <span className="au-mono au-faint">{byDay ? fmt(e.t).slice(6) : fmt(e.t)}</span>
            <ActionTag e={e} />
            <span className="grow">
              {e.who} · {e.path ? <span className="au-mono">{e.path}</span> : e.detail}
              {e.path && e.detail && <span className="au-faint"> {e.detail}</span>}
              {e.via && <span className="m-tag" style={{ marginLeft: 4 }}>随 {e.via}</span>}
              {e.stale && <span className="m-tag warn" style={{ marginLeft: 4 }}>过期保存</span>}
              {where && <span className={`au-now ${where.gone ? 'gone' : ''}`}>{where.label}</span>}
            </span>
            <span className="au-mono au-faint small">{e.ip}</span>
          </div>,
        ]
      })}
      {evs.length > limit && !more && <a className="small" onClick={() => setMore(true)}>还有 {evs.length - limit} 条，全部展开</a>}
      {!evs.length && <div className="m-empty">没有记录</div>}
    </div>
  )
}

// ================================================================ L3 就地动态
/** Inspector section: the item's own history (a folder includes everything beneath it). */
export function ItemActivity({ user, n }: AuditInspProps) {
  useAudit()
  const [cat, setCat] = useState<Category | 'all'>('all')
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<Ev | null>(null)
  const roots = auditRoots(user)
  const allowed = user.admin || roots.some((r) => { for (let p: Node | undefined = n; p; p = p.parent) if (p === r) return true; return false })
  if (!allowed) return null
  const evs = query(user, { where: n === ROOT ? undefined : n, cats: cat === 'all' ? undefined : [cat] })
  const everyone = new Set(query(user, { where: n, cats: ['read'], from: startOfToday() - 29 * DAY }).map((e) => e.whoId))
  const lastWrite = query(user, { where: n, cats: ['write'] })[0]
  return (
    <div className="au-insp">
      <div className="m-section-title"><History size={14} /> 动态 <span className="au-faint" style={{ textTransform: 'none', fontWeight: 400 }}>· 仅你可见（你有此处的授权权）</span></div>
      <div className="au-insp-sum">
        <span><Users size={13} /> 近 30 天 {everyone.size} 人查看或下载</span>
        {lastWrite && <span>最后修改：{lastWrite.who} · {fmt(lastWrite.t)}</span>}
      </div>
      <div className="au-filters" style={{ gap: 4 }}>
        {(['all', 'read', 'write', 'delete'] as const).map((c) => (
          <span key={c} className={`au-chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c === 'all' ? '全部' : CATS.find((x) => x.key === c)!.label}</span>
        ))}
        {user.admin && <span className={`au-chip ${cat === 'grant' ? 'on' : ''}`} onClick={() => setCat('grant')}>授权</span>}
      </div>
      {(all ? evs : evs.slice(0, 12)).map((e) => (
        <div key={e.id} className={`au-insp-row ${e.ok ? '' : 'fail'}`} onClick={() => setOpen(open === e ? null : e)}>
          <Avatar name={e.who} size={22} />
          <div className="grow">
            <div>{e.who} <ActionTag e={e} /> {n.type === 'dir' && e.node !== n && <span className="au-faint">{e.path.split('/').pop()}</span>}</div>
            <div className="au-faint small">{fmt(e.t)}{e.via ? ` · 随 ${e.via}` : ''}{e.detail && e.action !== 'download' ? ` · ${e.detail}` : ''}{e.stale ? ' · 过期保存' : ''}{nowAt(e) && n.type === 'file' ? ` · 当时路径 ${e.path}` : ''}</div>
            {open === e && <div className="au-insp-more au-mono small">{fmtFull(e.t)} · {e.ip}{e.reason ? ` · ${e.reason}` : ''}<br />{e.path}</div>}
          </div>
        </div>
      ))}
      {evs.length > 12 && !all && <a className="small" onClick={() => setAll(true)}>查看全部 {evs.length} 条</a>}
      {!evs.length && <div className="au-faint small">没有记录</div>}
      {evs.length > 0 && <button className="m-btn sm ghost" onClick={() => exportCsv(evs, `${n.name}-动态.csv`)}><Download size={13} /> 导出</button>}
    </div>
  )
}

/** L3's only page, Administrators only: what an item inspector cannot show (sign-ins, accounts, deleted top-level things). */
export function AdminOnlyAudit({ user }: AuditPageProps) {
  useAudit()
  const [open, setOpen] = useState<Ev | null>(null)
  const [range, setRange] = useState('30')
  const evs = query(user, { from: rangeFrom(range), cats: ['session', 'account', 'grant'] }).filter((e) => e.action !== 'signin' || !e.ip.startsWith('10.') || e.live)
  return (
    <div className="au-page">
      <div className="au-head"><h2>账户与登录审计</h2><Retention /></div>
      <p className="au-faint small">文件和文件夹的动态在各自的详情侧栏里（点 ⓘ 或文件夹标题旁的“动态”）。这里只放不属于任何文件的记录。常规的办公网登录已折叠。</p>
      <div className="au-filters">
        <div className="au-seg">{RANGES.map((r) => <button key={r.key} className={range === r.key ? 'on' : ''} onClick={() => setRange(r.key)}>{r.label}</button>)}</div>
        <span className="grow" />
        <button className="m-btn sm" onClick={() => exportCsv(query(user, { from: rangeFrom(range) }), `审计-全部-${dayKey(Date.now())}.csv`)}><Download size={14} /> 导出全部记录</button>
      </div>
      <div className="au-body">
        <div className="grow"><Timeline evs={evs} onOpen={setOpen} byDay /></div>
        {open && <Detail e={open} close={() => setOpen(null)} />}
      </div>
    </div>
  )
}

// ================================================================ L4 动态流
const VERB: Partial<Record<string, string>> = { preview: '预览了', download: '下载了', upload: '上传了', edit_save: '编辑保存了', edit_open: '打开编辑', delete: '删除了', rename: '重命名了', move: '移动了', restore: '恢复了', purge: '清除了', version_restore: '恢复了历史版本', signin_fail: '登录失败', signin: '登录', signout: '退出' }

export function AuditFeed({ user }: AuditPageProps) {
  useAudit()
  const [range, setRange] = useState('7')
  const [cats, setCats] = useState<Category[]>([])
  const [focus, setFocus] = useState<{ title: string; evs: Ev[] } | null>(null)
  const [quiet, setQuiet] = useState(true)
  const [openB, setOpenB] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Ev | null>(null)
  const from = rangeFrom(range)
  const sig = signals(user, rangeFrom('30')!)
  let raw = focus ? focus.evs : query(user, { from, cats: cats.length ? cats : undefined })
  // "quiet" hides routine noise: office-network sign-in/out and previews (still searchable, still recorded)
  if (quiet && !focus) raw = raw.filter((e) => !(e.ok && (e.action === 'signin' || e.action === 'signout') && e.ip.startsWith('10.')) && e.action !== 'preview')
  const cards = bursts(raw)
  let lastDay = ''
  const allCats = CATS.filter((c) => user.admin || !c.adminOnly)
  return (
    <div className="au-page au-feed">
      <div className="au-head"><h2>动态</h2><Retention /></div>
      <ScopeNote user={user} />
      {sig.length > 0 && (
        <div className="au-signals">
          <div className="au-faint small" style={{ marginBottom: 6 }}><ShieldAlert size={13} /> 近 30 天值得看一眼的</div>
          <div className="au-signal-row">
            {sig.map((s) => (
              <div key={s.key} className={`au-signal ${s.tone} ${focus?.title === s.title ? 'on' : ''}`} onClick={() => setFocus(focus?.title === s.title ? null : { title: s.title, evs: s.events })}>
                <AlertTriangle size={14} />
                <div><b>{s.title}</b><div className="small">{s.detail}</div></div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="au-filters">
        {focus ? (
          <span className="au-chip on" onClick={() => setFocus(null)}><ArrowLeft size={12} /> {focus.title} · 回到全部</span>
        ) : (
          <>
            <div className="au-seg">{RANGES.map((r) => <button key={r.key} className={range === r.key ? 'on' : ''} onClick={() => setRange(r.key)}>{r.label}</button>)}</div>
            {allCats.map((c) => {
              const on = cats.includes(c.key)
              return <span key={c.key} className={`au-chip ${on ? 'on' : ''}`} onClick={() => setCats(on ? cats.filter((x) => x !== c.key) : [...cats, c.key])}>{c.label}</span>
            })}
            <label className="au-faint small" title="办公网段的正常登录/退出和预览不进动态流，但仍被记录，可在导出里看到">
              <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} /> 隐藏日常噪音
            </label>
          </>
        )}
        <span className="grow" />
        <span className="au-faint small">{raw.length.toLocaleString()} 条记录 → {cards.length.toLocaleString()} 条动态</span>
        <button className="m-btn sm" onClick={() => exportCsv(raw, `动态-${dayKey(Date.now())}.csv`)}><Download size={14} /> 导出</button>
      </div>
      <div className="au-body">
        <div className="au-cards">
          {cards.slice(0, 150).map((b) => {
            const d = dayKey(b.last)
            const head = d !== lastDay ? ((lastDay = d), <div key={`d${d}`} className="au-tl-day">{d === dayKey(Date.now()) || d === dayKey(BASE) ? '今天' : d}</div>) : null
            const e0 = b.events[0]
            const many = b.events.length > 1
            const fail = b.events.filter((e) => !e.ok).length
            const isOpen = openB.has(b.key)
            const names = [...new Set(b.events.map((e) => e.path.split('/').pop()))]
            return [
              head,
              <div key={b.key} className={`au-card ${fail ? 'fail' : ''} ${b.events.some((e) => offHours(e.t)) && many ? 'night' : ''}`}>
                <Avatar name={b.who} size={30} />
                <div className="grow">
                  <div>
                    <b>{b.who}</b>{' '}
                    {e0.action === 'grant' || e0.action === 'account' || e0.action === 'export' ? (
                      <>{e0.detail}{e0.path && <> · <span className="au-mono">{e0.path}</span></>}</>
                    ) : (
                      <>
                        {VERB[b.action] ?? ACTION[b.action].label}{' '}
                        {many ? (b.action.startsWith('signin') || b.action === 'signout' ? `${b.events.length} 次` : <b>{names.length > 1 ? `${b.events.length} 个文件` : `${names[0]} ${b.events.length} 次`}</b>) : <b>{names[0]}</b>}
                        {b.via && <span className="m-tag" style={{ marginLeft: 6 }}>打包 {b.via}</span>}
                        {!many && e0.detail && <span className="au-faint"> {e0.detail}</span>}
                      </>
                    )}
                    {fail > 0 && <span className="au-red"> · {fail} 次失败</span>}
                    {b.events.some((e) => e.stale) && <span className="m-tag warn" style={{ marginLeft: 6 }}>过期保存</span>}
                  </div>
                  <div className="au-faint small">
                    {fmt(b.first).slice(6)}{many && b.last !== b.first ? `–${fmt(b.last).slice(6)}` : ''} · {e0.ip}
                    {!many && e0.path && <> · <span className="au-mono">{e0.path.split('/').slice(0, -1).join('/') || '/'}</span></>}
                    {many && names.length > 1 && <> · <a onClick={() => setOpenB(new Set(isOpen ? [...openB].filter((x) => x !== b.key) : [...openB, b.key]))}>{isOpen ? '收起' : '逐条展开'} {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</a></>}
                    {!many && <> · <a onClick={() => setOpen(e0)}>详情</a></>}
                  </div>
                  {isOpen && (
                    <div className="au-card-list">
                      {b.events.map((e) => (
                        <div key={e.id} className={e.ok ? '' : 'au-red'} onClick={() => setOpen(e)}>
                          <span className="au-mono au-faint">{fmt(e.t).slice(6)}</span> <span className="au-mono">{e.path}</span> {!e.ok && `· ${e.reason}`}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>,
            ]
          })}
          {cards.length > 150 && <div className="au-faint small">只显示最近 150 条动态，缩小时间或类别以查看更多</div>}
          {!cards.length && <div className="m-empty">这段时间很安静</div>}
        </div>
        {open && <Detail e={open} close={() => setOpen(null)} />}
      </div>
    </div>
  )
}

export { canSee }
