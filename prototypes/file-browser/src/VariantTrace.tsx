// PROTOTYPE round 9: L1 won. Audit is Administrator-only; the job is "something went wrong — who did what, when?".
// Four directions, all on L1's table, all with the same precise time range control (RangeBar):
//
//   K1 精确检索     L1 + a real time range: presets, minute-precision from/to, drag on the histogram to zoom, zoom history
//   K2 时间泳道     one lane per person across the range: see who was active around the moment, drag to zoom, ±15 min
//   K3 追溯链       start from a symptom (an item, person, IP or moment) and follow pivots; pin evidence; export the trail
//   K4 查询语句     one query line (人:孙七 操作:下载 路径:/研发部 结果:失败), results grouped by sign-in session
import { ArrowLeft, ChevronDown, ChevronRight, Clock, Crosshair, Download, FileWarning, Globe, Pin, PinOff, Search, Undo2, UserSearch, X, ZoomOut } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Node, PEOPLE, User } from './data'
import {
  ACTION, Action, BASE, CATS, Category, DAY, Ev, Filter as Q, adminOnly, dayKey, exportCsv, fmt, fmtFull, nowAt, offHours, pathOfNode, query, sessionOf,
} from './audit'
import { ActionTag, Detail, WherePicker, WhoPicker, useAudit, type AuditPageProps } from './VariantAudit'
import { Avatar } from './ui'

// ================================================================ time range
export type Range = { from: number; to: number }
const MIN = 60_000
const HOUR = 3600_000
const nowT = () => Math.max(Date.now(), BASE)
const sod = (t: number) => new Date(t).setHours(0, 0, 0, 0)
const PRESETS: { label: string; get: () => Range }[] = [
  { label: '最近 1 小时', get: () => ({ from: nowT() - HOUR, to: nowT() + MIN }) },
  { label: '最近 24 小时', get: () => ({ from: nowT() - DAY, to: nowT() + MIN }) },
  { label: '今天', get: () => ({ from: sod(nowT()), to: nowT() + MIN }) },
  { label: '昨天', get: () => ({ from: sod(nowT()) - DAY, to: sod(nowT()) }) },
  { label: '近 7 天', get: () => ({ from: sod(nowT()) - 6 * DAY, to: nowT() + MIN }) },
  { label: '近 30 天', get: () => ({ from: sod(nowT()) - 29 * DAY, to: nowT() + MIN }) },
  { label: '近 180 天', get: () => ({ from: sod(nowT()) - 179 * DAY, to: nowT() + MIN }) },
]
const pad = (x: number) => String(x).padStart(2, '0')
const toInput = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromInput = (s: string) => new Date(s).getTime()
export const fmtSpan = (ms: number) => (ms < HOUR ? `${Math.round(ms / MIN)} 分钟` : ms < 2 * DAY ? `${+(ms / HOUR).toFixed(1)} 小时` : `${Math.round(ms / DAY)} 天`)
export const around = (t: number, min = 15): Range => ({ from: t - min * MIN, to: t + min * MIN })
const label = (r: Range) => `${fmtFull(r.from).slice(0, 16)} → ${fmtFull(r.to).slice(0, 16)}`

function bucketOf(span: number) {
  if (span <= 2 * HOUR) return 5 * MIN
  if (span <= DAY + HOUR) return 30 * MIN
  if (span <= 4 * DAY) return HOUR
  if (span <= 200 * DAY) return DAY
  return 7 * DAY
}

/** The shared control: presets, exact from/to (minute precision), histogram with drag-to-zoom, zoom history. */
export function RangeBar({ value, onChange, evs }: { value: Range; onChange: (r: Range) => void; evs: Ev[] }) {
  const [stack, setStack] = useState<Range[]>([])
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null)
  const set = (r: Range) => (setStack([...stack, value].slice(-20)), onChange(r))
  const step = bucketOf(value.to - value.from)
  const start = step >= DAY ? sod(value.from) : value.from - ((value.from - sod(value.from)) % step)
  const buckets: { t: number; n: number; fail: number }[] = []
  for (let t = start; t < value.to && buckets.length < 400; t += step) buckets.push({ t, n: 0, fail: 0 })
  for (const e of evs) {
    const i = Math.floor((e.t - start) / step)
    if (buckets[i]) (buckets[i].n++, e.ok || buckets[i].fail++)
  }
  const max = Math.max(1, ...buckets.map((b) => b.n))
  const lo = drag ? Math.min(drag.a, drag.b) : -1
  const hi = drag ? Math.max(drag.a, drag.b) : -1
  useEffect(() => {
    if (!drag) return
    const up = () => {
      const a = buckets[lo], b = buckets[hi]
      if (a && b) set({ from: Math.max(a.t, value.from), to: Math.min(b.t + step, value.to) })
      setDrag(null)
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  })
  const active = PRESETS.find((p) => {
    const r = p.get()
    return Math.abs(r.from - value.from) < MIN * 2 && Math.abs(r.to - value.to) < MIN * 2
  })
  return (
    <div className="tr-range">
      <div className="au-filters" style={{ marginBottom: 6 }}>
        <Clock size={14} className="au-faint" />
        {PRESETS.map((p) => <span key={p.label} className={`au-chip ${active === p ? 'on' : ''}`} onClick={() => set(p.get())}>{p.label}</span>)}
        <span className="tr-exact">
          <input type="datetime-local" value={toInput(value.from)} max={toInput(value.to)} onChange={(e) => e.target.value && set({ ...value, from: fromInput(e.target.value) })} />
          <span className="au-faint">至</span>
          <input type="datetime-local" value={toInput(value.to)} min={toInput(value.from)} onChange={(e) => e.target.value && set({ ...value, to: fromInput(e.target.value) })} />
        </span>
        <span className="au-faint small">共 {fmtSpan(value.to - value.from)}</span>
        <span className="grow" />
        <button className="m-btn sm ghost" title="范围扩大一倍" onClick={() => set({ from: value.from - (value.to - value.from) / 2, to: Math.min(nowT() + MIN, value.to + (value.to - value.from) / 2) })}><ZoomOut size={14} /></button>
        <button className="m-btn sm ghost" disabled={!stack.length} title="回到上一个范围" onClick={() => (onChange(stack[stack.length - 1]), setStack(stack.slice(0, -1)))}><Undo2 size={14} /></button>
      </div>
      <div className="tr-hist">
        {buckets.map((b, i) => (
          <div
            key={b.t}
            className={`au-bar ${i >= lo && i <= hi ? 'on' : ''}`}
            title={`${fmt(b.t)}–${fmt(b.t + step).slice(6)}：${b.n} 条${b.fail ? `，${b.fail} 条失败` : ''}`}
            onMouseDown={(e) => (e.preventDefault(), setDrag({ a: i, b: i }))}
            onMouseEnter={() => drag && setDrag({ ...drag, b: i })}
          >
            <i style={{ height: `${(b.n / max) * 100}%` }}>{b.fail > 0 && <s style={{ height: `${Math.max(10, (b.fail / b.n) * 100)}%` }} />}</i>
          </div>
        ))}
      </div>
      <div className="tr-axis">
        <span>{fmt(value.from)}</span>
        <span className="au-faint">每格 {fmtSpan(step)} · 在柱状图上拖动可放大到那一段 · 红色为失败</span>
        <span>{fmt(value.to)}</span>
      </div>
    </div>
  )
}

// ================================================================ shared table
function EvTable({ rows, open, setOpen, per = 40, session = false }: { rows: Ev[]; open: Ev | null; setOpen: (e: Ev) => void; per?: number; session?: boolean }) {
  const [page, setPage] = useState(0)
  useEffect(() => setPage(0), [rows.length])
  const pages = Math.max(1, Math.ceil(rows.length / per))
  return (
    <div className="au-table">
      <div className="au-tr au-th tr-tr"><span>时间</span><span>用户</span><span>操作</span><span>对象（当时路径）</span><span>来源 IP</span></div>
      {rows.slice(page * per, page * per + per).map((e) => {
        const where = nowAt(e)
        const s = session ? sessionOf(e) : undefined
        return (
          <div key={e.id} className={`au-tr tr-tr ${open === e ? 'on' : ''} ${e.ok ? '' : 'fail'} ${e.live ? 'live' : ''}`} onClick={() => setOpen(e)}>
            <span className="au-mono">{fmtFull(e.t).slice(5)}{offHours(e.t) && <i className="au-dot warn" title="非工作时间" />}</span>
            <span>{e.who}</span>
            <span><ActionTag e={e} /></span>
            <span className="au-path">
              {e.path ? <span className="au-mono">{e.path}</span> : <span>{e.detail ?? (e.reason ? e.reason : '—')}</span>}
              {e.via && <span className="m-tag">随 {e.via}</span>}
              {e.stale && <span className="m-tag warn">过期保存</span>}
              {where && <span className={`au-now ${where.gone ? 'gone' : ''}`}>{where.label}</span>}
              {e.path && e.detail && e.action !== 'download' && <span className="au-faint small">{e.detail}</span>}
              {s && <span className="au-faint small">会话 {fmt(s.start).slice(6)} 起</span>}
            </span>
            <span className={`au-mono ${e.ip.startsWith('10.') || e.ip === '—' ? 'au-faint' : 'au-red'}`}>{e.ip}</span>
          </div>
        )
      })}
      {!rows.length && <div className="m-empty">这段时间里没有符合条件的记录</div>}
      {pages > 1 && (
        <div className="au-pager">
          <button className="m-btn sm" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="au-faint small">{page + 1} / {pages}</span>
          <button className="m-btn sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
    </div>
  )
}

function Head({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="au-head">
      <h2>{title}</h2>
      <span className="au-faint">仅管理员可见 · 记录只追加，不可修改或删除 · 至少保留 180 天 · 浏览目录不记录</span>
      <span className="grow" />
      {children}
    </div>
  )
}

const dlName = (r: Range, what = '审计') => `${what}-${fmtFull(r.from).slice(0, 16).replace(/[: ]/g, '')}-${fmtFull(r.to).slice(0, 16).replace(/[: ]/g, '')}.csv`
const RangeLine = ({ r, n }: { r: Range; n: number }) => (
  <span className="au-faint small"><b className="au-mono" style={{ color: 'var(--text)' }}>{label(r)}</b> · {n.toLocaleString()} 条</span>
)

// ================================================================ K1 精确检索
export function TraceSearch({ user }: AuditPageProps) {
  useAudit()
  const [r, setR] = useState<Range>(PRESETS[4].get())
  const [f, setF] = useState<Q>({})
  const [open, setOpen] = useState<Ev | null>(null)
  const rows = query(user, { ...f, from: r.from, to: r.to })
  const set = (p: Partial<Q>) => setF({ ...f, ...p })
  return (
    <div className="au-page">
      <Head title="审计日志" />
      <RangeBar value={r} onChange={setR} evs={rows} />
      <div className="au-filters">
        <WhoPicker value={f.who} onChange={(who) => set({ who })} />
        <WherePicker user={user} value={f.where} onChange={(where) => set({ where })} files />
        <div className="au-search"><Search size={14} /><input placeholder="路径、IP、说明（含已删除的文件）" value={f.text ?? ''} onChange={(e) => set({ text: e.target.value || undefined })} /></div>
        {f.ip && <span className="au-chip on" onClick={() => set({ ip: undefined })}>IP {f.ip} <X size={11} /></span>}
      </div>
      <div className="au-filters">
        {CATS.map((c) => {
          const on = f.cats?.includes(c.key)
          return <span key={c.key} className={`au-chip ${on ? 'on' : ''}`} onClick={() => set({ cats: on ? f.cats!.filter((x) => x !== c.key) : [...(f.cats ?? []), c.key] })}>{c.label}</span>
        })}
        <span className={`au-chip ${f.failedOnly ? 'on danger' : ''}`} onClick={() => set({ failedOnly: !f.failedOnly || undefined })}>仅失败</span>
        <span className="grow" />
        <RangeLine r={r} n={rows.length} />
        <button className="m-btn sm" disabled={!rows.length} onClick={() => exportCsv(rows, dlName(r))}><Download size={14} /> 导出 CSV</button>
      </div>
      <div className="au-body">
        <EvTable rows={rows} open={open} setOpen={setOpen} />
        {open && (
          <Detail e={open} close={() => setOpen(null)} pivot={(p) => (set(p), setOpen(null))}
            actions={<button className="m-btn sm" onClick={() => (setR(around(open.t)), setF({}))}><Crosshair size={13} /> 前后 15 分钟所有人在做什么</button>} />
        )}
      </div>
    </div>
  )
}

// ================================================================ K2 时间泳道
const CAT_COLOR: Record<Category, string> = { read: '#3370ff', write: '#13854e', delete: '#e67700', grant: '#7c3aed', session: '#86909c', account: '#7c3aed' }
export function TraceLanes({ user }: AuditPageProps) {
  useAudit()
  const [r, setR] = useState<Range>(PRESETS[1].get())
  const [cats, setCats] = useState<Category[]>([])
  const [only, setOnly] = useState<string | null>(null)
  const [open, setOpen] = useState<Ev | null>(null)
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null)
  const track = useRef<HTMLDivElement>(null)
  const evs = query(user, { from: r.from, to: r.to, cats: cats.length ? cats : undefined })
  const people = new Map<string, Ev[]>()
  for (const e of evs) people.set(e.whoId, [...(people.get(e.whoId) ?? []), e])
  // busiest first, but anyone with a failure, a delete or off-hours activity floats up: that is what an investigator looks for
  const score = (es: Ev[]) => es.length + es.filter((e) => !e.ok || ACTION[e.action].cat === 'delete' || offHours(e.t)).length * 20
  const lanes = [...people.entries()].sort((a, b) => score(b[1]) - score(a[1]))
  const shown = lanes.slice(0, 24)
  const x = (t: number) => `${((t - r.from) / (r.to - r.from)) * 100}%`
  const frac = (clientX: number) => {
    const b = track.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - b.left) / b.width))
  }
  useEffect(() => {
    if (!brush) return
    const move = (e: MouseEvent) => setBrush((b) => b && { ...b, b: frac(e.clientX) })
    const up = () => {
      setBrush((b) => {
        if (b && Math.abs(b.b - b.a) > 0.01) {
          const span = r.to - r.from
          setR({ from: r.from + Math.min(b.a, b.b) * span, to: r.from + Math.max(b.a, b.b) * span })
        }
        return null
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => (window.removeEventListener('mousemove', move), window.removeEventListener('mouseup', up))
  }, [!!brush])
  const ticks = Array.from({ length: 7 }, (_, i) => r.from + ((r.to - r.from) * i) / 6)
  const rows = only ? evs.filter((e) => e.whoId === only) : evs
  return (
    <div className="au-page">
      <Head title="审计 · 时间泳道" />
      <RangeBar value={r} onChange={setR} evs={evs} />
      <div className="au-filters">
        {CATS.map((c) => {
          const on = cats.includes(c.key)
          return <span key={c.key} className={`au-chip ${on ? 'on' : ''}`} onClick={() => setCats(on ? cats.filter((x) => x !== c.key) : [...cats, c.key])}><i className="tr-sw" style={{ background: CAT_COLOR[c.key] }} />{c.label}</span>
        })}
        <span className="grow" />
        <span className="au-faint small">{people.size} 人活动{lanes.length > shown.length ? `，显示最值得看的 ${shown.length} 人` : ''}</span>
      </div>
      <div className="tr-lanes">
        <div className="tr-lane tr-lane-axis">
          <span />
          <div className="tr-track">{ticks.map((t, i) => <span key={i} style={{ left: x(t) }}>{(r.to - r.from) > 2 * DAY ? fmt(t).slice(0, 5) : fmt(t).slice(6)}</span>)}</div>
        </div>
        <div className="tr-lane-body" onMouseDown={(e) => track.current && (e.target as HTMLElement).closest('.tr-track') && !(e.target as HTMLElement).closest('.tr-ev') && setBrush({ a: frac(e.clientX), b: frac(e.clientX) })}>
          {shown.map(([id, es]) => (
            <div key={id} className={`tr-lane ${only === id ? 'on' : ''} ${only && only !== id ? 'dim' : ''}`}>
              <span className="tr-who" onClick={() => setOnly(only === id ? null : id)} title="只看这个人的明细">
                <Avatar name={es[0].who} size={20} /> {es[0].who}
                <span className="au-faint small">{es.length}</span>
              </span>
              <div className="tr-track" ref={track}>
                {offHoursBands(r).map((b, i) => <i key={i} className="tr-night" style={{ left: x(b.from), width: `calc(${x(b.to)} - ${x(b.from)})` }} />)}
                {es.map((e) => (
                  <span key={e.id} className={`tr-ev ${e.ok ? '' : 'fail'} ${open === e ? 'on' : ''}`} style={{ left: x(e.t), background: e.ok ? CAT_COLOR[ACTION[e.action].cat] : undefined }}
                    title={`${fmtFull(e.t)} ${e.who} ${ACTION[e.action].label} ${e.path || e.detail || ''}`} onClick={() => setOpen(e)} />
                ))}
              </div>
            </div>
          ))}
          {brush && <div className="tr-brush" style={{ left: `calc(130px + (100% - 130px) * ${Math.min(brush.a, brush.b)})`, width: `calc((100% - 130px) * ${Math.abs(brush.b - brush.a)})` }} />}
          {!shown.length && <div className="m-empty">这段时间里没有人活动</div>}
        </div>
        <div className="au-faint small" style={{ padding: '6px 0 0 130px' }}>灰色底 = 非工作时间 · 在泳道上横向拖动可放大 · 点名字只看这个人 · 点一个点看详情</div>
      </div>
      <div className="au-filters" style={{ marginTop: 14 }}>
        <b>{only ? `${PEOPLE.find((u) => u.id === only)?.name ?? only} 的明细` : '明细'}</b>
        {only && <span className="au-chip on" onClick={() => setOnly(null)}>回到所有人 <X size={11} /></span>}
        <span className="grow" />
        <RangeLine r={r} n={rows.length} />
        <button className="m-btn sm" disabled={!rows.length} onClick={() => exportCsv(rows, dlName(r))}><Download size={14} /> 导出 CSV</button>
      </div>
      <div className="au-body">
        <EvTable rows={rows} open={open} setOpen={setOpen} per={25} />
        {open && (
          <Detail e={open} close={() => setOpen(null)}
            actions={<>
              <button className="m-btn sm" onClick={() => (setR(around(open.t)), setOnly(null))}><Crosshair size={13} /> 以此为中心 ±15 分钟</button>
              <button className="m-btn sm" onClick={() => setOnly(open.whoId)}>只看 {open.who}</button>
            </>} />
        )}
      </div>
    </div>
  )
}
function offHoursBands(r: Range): Range[] {
  const out: Range[] = []
  for (let d = sod(r.from) - DAY; d < r.to; d += DAY) {
    const wd = new Date(d).getDay()
    if (wd === 0 || wd === 6) out.push({ from: d, to: d + DAY })
    else out.push({ from: d, to: d + 7 * HOUR }, { from: d + 21 * HOUR, to: d + DAY })
  }
  return out.map((b) => ({ from: Math.max(b.from, r.from), to: Math.min(b.to, r.to) })).filter((b) => b.to > b.from)
}

// ================================================================ K3 追溯链
type Step = { title: string; f: Q; r: Range; icon: React.ReactNode }
export function TraceChain({ user }: AuditPageProps) {
  useAudit()
  const [r, setR] = useState<Range>(PRESETS[5].get())
  const [steps, setSteps] = useState<Step[]>([])
  const [cur, setCur] = useState(0)
  const [pins, setPins] = useState<Ev[]>([])
  const [open, setOpen] = useState<Ev | null>(null)
  const [q, setQ] = useState('')
  const [ip, setIp] = useState('')
  const [moment, setMoment] = useState(toInput(nowT() - 16 * HOUR))
  const start = (s: Step) => (setSteps([s]), setCur(0), setOpen(null))
  const follow = (s: Step) => (setSteps([...steps.slice(0, cur + 1), s]), setCur(cur + 1), setOpen(null))
  const step = steps[cur]
  const rows = step ? query(user, { ...step.f, from: step.r.from, to: step.r.to }) : []
  const pinned = (e: Ev) => pins.includes(e)
  const pin = (e: Ev) => setPins(pinned(e) ? pins.filter((x) => x !== e) : [...pins, e].sort((a, b) => a.t - b.t))

  // "a file went missing / changed": search every path ever recorded, including deleted and purged items
  const items = new Map<Node, Ev>()
  if (q.trim()) for (const e of query(user, { text: q.trim(), from: r.from, to: r.to })) {
    if (e.node && !items.has(e.node) && e.path.includes(q.trim())) items.set(e.node, e)
    if (items.size >= 12) break
  }

  return (
    <div className="au-page">
      <Head title="审计 · 追溯">
        {steps.length > 0 && <button className="m-btn sm ghost" onClick={() => (setSteps([]), setPins([]))}><ArrowLeft size={14} /> 重新开始</button>}
      </Head>
      {!steps.length ? (
        <>
          <RangeBar value={r} onChange={setR} evs={query(user, { from: r.from, to: r.to })} />
          <div className="tr-starts">
            <div className="tr-start">
              <b><FileWarning size={16} /> 从一个文件或文件夹查起</b>
              <span className="au-faint small">文件不见了、被改了、被拿走了。已删除、已清除的也能搜到。</span>
              <div className="au-search"><Search size={14} /><input autoFocus placeholder="文件名或路径片段，如 旧稿、预算" value={q} onChange={(e) => setQ(e.target.value)} /></div>
              {[...items.entries()].map(([n, e]) => {
                const w = nowAt(e)
                return (
                  <a key={n.id} className="tr-item" onClick={() => start({ title: `${n.name} 的全部记录`, f: { where: n }, r, icon: <FileWarning size={13} /> })}>
                    <span className="au-mono">{e.path}</span> {w && <span className={`au-now ${w.gone ? 'gone' : ''}`}>{w.label}</span>}
                  </a>
                )
              })}
            </div>
            <div className="tr-start">
              <b><UserSearch size={16} /> 从一个人查起</b>
              <span className="au-faint small">他在这段时间做了什么，从哪里登录。</span>
              <WhoPicker onChange={(id) => id && start({ title: `${PEOPLE.find((u) => u.id === id)!.name} 的全部操作`, f: { who: id }, r, icon: <UserSearch size={13} /> })} placeholder="输入姓名" />
            </div>
            <div className="tr-start">
              <b><Globe size={16} /> 从一个 IP 查起</b>
              <span className="au-faint small">一个陌生地址都用哪些账号干了什么。</span>
              <div className="au-search"><input placeholder="如 172.16.9.23" value={ip} onChange={(e) => setIp(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ip && start({ title: `来自 ${ip}`, f: { ip }, r, icon: <Globe size={13} /> })} /></div>
            </div>
            <div className="tr-start">
              <b><Crosshair size={16} /> 从一个时间点查起</b>
              <span className="au-faint small">知道大概什么时候出的事：那前后 30 分钟所有人的操作。</span>
              <div className="tr-exact"><input type="datetime-local" value={moment} onChange={(e) => setMoment(e.target.value)} />
                <button className="m-btn sm" onClick={() => start({ title: `${fmt(fromInput(moment))} 前后 30 分钟`, f: {}, r: around(fromInput(moment), 30), icon: <Crosshair size={13} /> })}>查</button></div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="tr-trail">
            {steps.map((s, i) => (
              <span key={i} className={`tr-crumb ${i === cur ? 'on' : ''}`} onClick={() => (setCur(i), setOpen(null))}>
                {i > 0 && <ChevronRight size={13} className="au-faint" />} {s.icon} {s.title}
              </span>
            ))}
          </div>
          <div className="au-filters">
            <RangeLine r={step.r} n={rows.length} />
            <span className="grow" />
            <span className="au-faint small">点一条记录，顺着人、会话、文件或 IP 继续追；觉得重要就钉住</span>
          </div>
          <div className="au-body">
            <div className="grow" style={{ minWidth: 0 }}>
              <EvTable rows={rows} open={open} setOpen={setOpen} per={30} session />
            </div>
            {open ? (
              <Detail e={open} close={() => setOpen(null)}
                actions={<>
                  <button className={`m-btn sm ${pinned(open) ? 'primary' : ''}`} onClick={() => pin(open)}>{pinned(open) ? <PinOff size={13} /> : <Pin size={13} />} {pinned(open) ? '取消钉住' : '钉为证据'}</button>
                  {(() => {
                    const s = sessionOf(open)
                    return s && <button className="m-btn sm" onClick={() => follow({ title: `${open.who} 这次登录（${fmt(s.start).slice(6)}，${s.ip}）`, f: { who: open.whoId, ip: s.ip }, r: { from: s.start, to: s.end + 1000 }, icon: <Clock size={13} /> })}>这次登录做的所有事（{s.events.length}）</button>
                  })()}
                  <button className="m-btn sm" onClick={() => follow({ title: `${open.who} 前后 2 小时`, f: { who: open.whoId }, r: around(open.t, 120), icon: <UserSearch size={13} /> })}>{open.who} 前后 2 小时</button>
                  {open.node && <button className="m-btn sm" onClick={() => follow({ title: `${open.node!.name} 的全部记录`, f: { where: open.node }, r: PRESETS[6].get(), icon: <FileWarning size={13} /> })}>这个{open.node.type === 'dir' ? '文件夹' : '文件'}的全部历史</button>}
                  {open.ip !== '—' && <button className="m-btn sm" onClick={() => follow({ title: `来自 ${open.ip}`, f: { ip: open.ip }, r: PRESETS[6].get(), icon: <Globe size={13} /> })}>这个 IP 的全部记录</button>}
                  <button className="m-btn sm" onClick={() => follow({ title: `${fmt(open.t)} 前后 15 分钟所有人`, f: {}, r: around(open.t), icon: <Crosshair size={13} /> })}>同一时间所有人</button>
                </>} />
            ) : (
              <aside className="au-detail tr-pins">
                <b><Pin size={14} /> 证据（{pins.length}）</b>
                <div className="au-faint small" style={{ margin: '4px 0 8px' }}>按时间排好，就是事情的经过</div>
                {pins.map((e) => (
                  <div key={e.id} className="tr-pin" onClick={() => setOpen(e)}>
                    <span className="au-mono au-faint">{fmt(e.t)}</span> <b>{e.who}</b> <ActionTag e={e} />
                    <div className="au-mono small">{e.path || e.detail} {e.ip !== '—' && <span className="au-faint">· {e.ip}</span>}</div>
                  </div>
                ))}
                {!pins.length && <div className="au-faint small">还没有钉住任何记录</div>}
                {pins.length > 0 && <button className="m-btn sm" style={{ marginTop: 10 }} onClick={() => exportCsv(pins, `追溯证据-${dayKey(Date.now())}.csv`)}><Download size={13} /> 导出证据</button>}
              </aside>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ================================================================ K4 查询语句
const KEYS: { k: string; hint: string; examples: string[] }[] = [
  { k: '人', hint: '姓名', examples: ['孙七', '李四', '周八'] },
  { k: '操作', hint: ACTION_LABELS(), examples: ['下载', '删除', '登录失败', '授权变更'] },
  { k: '路径', hint: '路径片段', examples: ['/研发部', '/财务部', '合同'] },
  { k: 'IP', hint: '完整地址', examples: ['172.16.9.23', '10.2.3.200'] },
  { k: '结果', hint: '成功 / 失败', examples: ['失败'] },
]
function ACTION_LABELS() {
  return Object.values(ACTION).map((a) => a.label).join(' / ')
}
const EXAMPLES: { q: string; r: () => Range; say: string }[] = [
  { say: '昨晚谁在下载研发部的东西？', q: '操作:下载 路径:/研发部', r: () => ({ from: sod(nowT()) - DAY + 18 * HOUR, to: sod(nowT()) + 6 * HOUR }) },
  { say: '李四的账号最近从哪登录过？', q: '人:李四 操作:登录,登录失败', r: () => PRESETS[5].get() },
  { say: '前端组谁删过东西？', q: '操作:删除,彻底清除 路径:/研发部/前端组', r: () => PRESETS[5].get() },
  { say: '这个月所有失败的操作', q: '结果:失败', r: () => PRESETS[5].get() },
  { say: '谁动过权限？', q: '操作:授权变更', r: () => PRESETS[6].get() },
]
function parse(src: string): { f: Q; tokens: { k: string; v: string; ok: boolean }[] } {
  const f: Q = {}
  const tokens: { k: string; v: string; ok: boolean }[] = []
  const free: string[] = []
  for (const part of src.trim().split(/\s+/).filter(Boolean)) {
    const m = part.match(/^([^:：]+)[:：](.+)$/)
    if (!m) { free.push(part); continue }
    const [, k, v] = m
    let ok = true
    if (k === '人' || k === '用户') {
      const u = PEOPLE.find((x) => x.name === v)
      if (u) f.who = u.id
      else ok = false
    } else if (k === '操作') {
      const acts = v.split(/[,，]/).flatMap((x) => (Object.keys(ACTION) as Action[]).filter((a) => ACTION[a].label === x || (ACTION[a].label.includes(x) && x.length > 1 && !(x === '登录' && a !== 'signin'))))
      if (acts.length) f.actions = acts
      else ok = false
    } else if (k === '路径' || k === '位置') f.pathLike = v
    else if (k.toUpperCase() === 'IP') f.ip = v
    else if (k === '结果') v.includes('失败') ? (f.failedOnly = true) : (ok = false)
    else ok = false
    tokens.push({ k, v, ok })
  }
  if (free.length) f.text = free.join(' ')
  return { f, tokens }
}

export function TraceQuery({ user }: AuditPageProps) {
  useAudit()
  const [src, setSrc] = useState('')
  const [r, setR] = useState<Range>(PRESETS[4].get())
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Ev | null>(null)
  const [focus, setFocus] = useState(false)
  const { f, tokens } = parse(src)
  const rows = query(user, { ...f, from: r.from, to: r.to })
  const last = src.split(/\s+/).pop() ?? ''
  const key = KEYS.find((k) => last.startsWith(k.k + ':') || last.startsWith(k.k + '：'))
  // group by sign-in session so "who, from where, in which sitting" is the first thing you read
  const groups: { key: string; head: string; sub: string; evs: Ev[]; warn: boolean }[] = []
  const idx = new Map<string, number>()
  for (const e of rows) {
    const s = sessionOf(e)
    const k = s ? s.key : `x${e.whoId}-${e.ip}-${dayKey(e.t)}`
    if (!idx.has(k)) {
      idx.set(k, groups.length)
      groups.push({
        key: k, evs: [],
        head: `${e.who} · ${e.ip}`,
        sub: s ? `${s.signin ? `${fmt(s.start)} 登录` : `${fmt(s.start)} 起`} → ${s.signout ? `${fmt(s.end).slice(6)} 退出` : s.expired ? `${fmt(s.end).slice(6)} 后无操作，会话过期` : '仍在线'} · 本次共 ${s.events.length} 条` : `${dayKey(e.t)} · 未登录（登录失败）`,
        warn: false,
      })
    }
    const g = groups[idx.get(k)!]
    g.evs.push(e)
    if (!e.ok || !e.ip.startsWith('10.') || offHours(e.t)) g.warn = true
  }
  return (
    <div className="au-page">
      <Head title="审计 · 查询" />
      <div className="tr-q">
        <Search size={16} className="au-faint" />
        <input value={src} placeholder="人:孙七 操作:下载 路径:/研发部 IP:… 结果:失败  （也可直接输入关键字）" onChange={(e) => setSrc(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)} />
        {src && <X size={14} style={{ cursor: 'pointer' }} onClick={() => setSrc('')} />}
        {focus && (
          <div className="tr-suggest">
            {key ? (
              <>
                <div className="au-faint small">{key.k}：{key.hint}</div>
                {key.examples.map((x) => <button key={x} onMouseDown={() => setSrc(src.replace(/\S*$/, `${key.k}:${x} `))}>{key.k}:{x}</button>)}
              </>
            ) : (
              <>
                <div className="au-faint small">可用条件</div>
                {KEYS.map((k) => <button key={k.k} onMouseDown={() => setSrc((src && !src.endsWith(' ') ? src + ' ' : src) + k.k + ':')}><b>{k.k}:</b> <span className="au-faint">{k.hint.length > 30 ? '登录 / 下载 / 删除 / …' : k.hint}</span></button>)}
              </>
            )}
          </div>
        )}
      </div>
      <div className="au-filters" style={{ minHeight: 26 }}>
        {tokens.map((t, i) => <span key={i} className={`au-chip ${t.ok ? 'on' : 'on danger'}`} title={t.ok ? '' : '没认出来'}>{t.k}：{t.v}</span>)}
        {f.text && <span className="au-chip">关键字：{f.text}</span>}
        {!src && EXAMPLES.map((x) => <span key={x.q} className="au-chip" onClick={() => (setSrc(x.q + ' '), setR(x.r()))}>{x.say}</span>)}
      </div>
      <RangeBar value={r} onChange={setR} evs={rows} />
      <div className="au-filters">
        <RangeLine r={r} n={rows.length} />
        <span className="au-faint small">· 分在 {groups.length} 次登录里</span>
        <span className="grow" />
        <button className="m-btn sm ghost" onClick={() => setFolded(folded.size ? new Set() : new Set(groups.map((g) => g.key)))}>{folded.size ? '全部展开' : '全部折叠'}</button>
        <button className="m-btn sm" disabled={!rows.length} onClick={() => exportCsv(rows, dlName(r, '审计查询'))}><Download size={14} /> 导出 CSV</button>
      </div>
      <div className="au-body">
        <div className="grow" style={{ minWidth: 0 }}>
          {groups.slice(0, 60).map((g) => {
            const shut = folded.has(g.key)
            return (
              <div key={g.key} className={`tr-sess ${g.warn ? 'warn' : ''}`}>
                <div className="tr-sess-head" onClick={() => setFolded(new Set(shut ? [...folded].filter((x) => x !== g.key) : [...folded, g.key]))}>
                  {shut ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <Avatar name={g.head} size={22} />
                  <b>{g.head}</b>
                  <span className="au-faint small">{g.sub}</span>
                  <span className="grow" />
                  <span className="au-faint small">命中 {g.evs.length} 条</span>
                </div>
                {!shut && g.evs.slice(0, 40).map((e) => (
                  <div key={e.id} className={`au-tl-row ${e.ok ? '' : 'fail'} ${open === e ? 'on' : ''}`} onClick={() => setOpen(e)}>
                    <span className="au-mono au-faint">{fmtFull(e.t).slice(5)}</span>
                    <ActionTag e={e} />
                    <span className="grow au-mono">{e.path || e.detail || e.reason}{e.via && <span className="m-tag" style={{ marginLeft: 4 }}>随 {e.via}</span>}{(() => { const w = nowAt(e); return w && <span className={`au-now ${w.gone ? 'gone' : ''}`}>{w.label}</span> })()}</span>
                  </div>
                ))}
                {!shut && g.evs.length > 40 && <div className="au-faint small" style={{ padding: '2px 10px' }}>还有 {g.evs.length - 40} 条，导出可看全部</div>}
              </div>
            )
          })}
          {groups.length > 60 && <div className="au-faint small">只显示前 60 次登录，缩小时间范围或加条件</div>}
          {!rows.length && <div className="m-empty">没有符合条件的记录</div>}
        </div>
        {open && <Detail e={open} close={() => setOpen(null)}
          actions={<>
            <button className="m-btn sm" onClick={() => setSrc(`人:${open.who} `)}>人:{open.who}</button>
            {open.ip !== '—' && <button className="m-btn sm" onClick={() => setSrc(`IP:${open.ip} `)}>IP:{open.ip}</button>}
            <button className="m-btn sm" onClick={() => setR(around(open.t))}><Crosshair size={13} /> 前后 15 分钟</button>
          </>} />}
      </div>
    </div>
  )
}

export { adminOnly }
