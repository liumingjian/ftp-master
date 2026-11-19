// PROTOTYPE round 10: the simple audit log. Three layouts of the SAME decided feature, on T3, Administrator-only.
//
//   S1 顶部筛选栏      filters in a bar above a dense table; details in a right-hand drawer
//   S2 左侧筛选面板    faceted panel on the left (counts per person / action), table on the right, rows expand in place
//   S3 一句话条件      one editable sentence ("近 7 天 所有人 在 /研发部 的 所有操作"), results grouped by day, detail in a modal
//
// Decided before this round (all three obey them, logic in audit.ts `querySimple`):
//   - one flat append-only log, Administrator-only; no histogram, lanes, trace chains, query language or sessions;
//   - previews are not recorded; a zip download is ONE event listing its files; exporting is not recorded;
//   - time range: 今天 / 近 7 天 / 近 30 天 / 自定义 (to the minute), default 近 7 天, at most 180 days;
//   - people: multi-select, or an Organization and everyone beneath it;
//   - directory: matched by PATH AT THE TIME, prefix, "包含子目录" on by default; old paths can be typed;
//     a zip matches if any file it packed was under the directory;
//   - the detail offers 只看此人 / 只看此目录 / 此文件全部历史 (by stable item id, across renames and moves).
import { CalendarClock, ChevronDown, ChevronRight, Download, FolderSearch, History, Lock, RotateCcw, UserSearch, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ORGS, PEOPLE } from './data'
import { ACTION, BASE, CATS, Category, DAY, Ev, Simple, dirMatch, exportCsv, fmtFull, knownDirs, nowAt, querySimple } from './audit'
import { fmtSize } from './perm'
import { ActionTag, useAudit, type AuditPageProps } from './VariantAudit'
import { Avatar } from './ui'

// ================================================================ shared state and helpers (not layout)
const MIN = 60_000
const nowT = () => Math.max(Date.now(), BASE) + MIN
const sod = (t: number) => new Date(t).setHours(0, 0, 0, 0)
const MAX_DAYS = 180
type PresetKey = 'today' | '7' | '30' | 'custom'
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: '7', label: '近 7 天' },
  { key: '30', label: '近 30 天' },
  { key: 'custom', label: '自定义' },
]
const rangeOf = (k: PresetKey) => {
  const n = nowT()
  if (k === 'today') return { from: sod(n), to: n }
  if (k === '30') return { from: sod(n) - 29 * DAY, to: n }
  return { from: sod(n) - 6 * DAY, to: n }
}
const pad = (x: number) => String(x).padStart(2, '0')
const toInput = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const dayLabel = (t: number) => {
  const d = new Date(t)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 周${WEEK[d.getDay()]}`
}
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
const fileName = (name: string) => name.replace(/\/|:/g, '')

type State = Simple & { preset: PresetKey }
const initial = (): State => ({ preset: '7', ...rangeOf('7'), who: [], sub: true, cats: [], failedOnly: false })

function useSimple() {
  useAudit()
  const [s, setS] = useState<State>(initial)
  const set = (p: Partial<State>) => setS((x) => ({ ...x, ...p }))
  const setPreset = (k: PresetKey) => set(k === 'custom' ? { preset: k } : { preset: k, ...rangeOf(k) })
  /** custom from/to, clamped to 180 days */
  const setCustom = (from: number, to: number) => {
    if (to - from > MAX_DAYS * DAY) from = to - MAX_DAYS * DAY
    set({ preset: 'custom', from, to })
  }
  const rows = querySimple(s)
  const reset = () => setS(initial())
  /** pivots offered by every detail view */
  const pivots = {
    who: (e: Ev) => set({ who: [e.whoId], org: undefined, item: undefined }),
    dir: (e: Ev) => set({ dir: e.node?.type === 'dir' ? e.path : parentOf(e.path), sub: true, item: undefined }),
    item: (e: Ev) => e.node && set({ item: e.node, dir: undefined, preset: 'custom', from: sod(nowT()) - (MAX_DAYS - 1) * DAY, to: nowT() }),
  }
  const csv = () => exportCsv(rows, `审计-${fileName(fmtFull(s.from).slice(0, 16))}-${fileName(fmtFull(s.to).slice(0, 16))}.csv`)
  return { s, set, setPreset, setCustom, rows, reset, pivots, csv }
}
type Ctl = ReturnType<typeof useSimple>

const whoLabel = (s: State) =>
  s.org ? `${ORGS.find((o) => o.id === s.org)!.name}（含下级）` : s.who.length ? s.who.map((id) => PEOPLE.find((u) => u.id === id)?.name).join('、') : '所有人'
const catLabel = (s: State) => (s.cats.length ? s.cats.map((c) => CATS.find((x) => x.key === c)!.label).join('、') : '所有操作')
const rangeText = (s: State) => `${fmtFull(s.from).slice(0, 16)} 至 ${fmtFull(s.to).slice(0, 16)}`

function Header({ c, children }: { c: Ctl; children?: React.ReactNode }) {
  return (
    <div className="au-head">
      <h2>审计日志</h2>
      <span className="au-faint"><Lock size={11} /> 仅管理员可见 · 记录只追加，不能修改或删除 · 至少保留 {MAX_DAYS} 天 · 浏览目录、预览、导出不记录</span>
      <span className="grow" />
      {children}
      <button className="m-btn sm" disabled={!c.rows.length} onClick={c.csv}><Download size={14} /> 导出 CSV（{c.rows.length.toLocaleString()} 条）</button>
    </div>
  )
}

/** Banner while looking at one item's whole history (by stable id), shared because it is a mode, not a layout. */
function ItemBanner({ c }: { c: Ctl }) {
  if (!c.s.item) return null
  const n = c.s.item
  return (
    <div className="s10-item">
      <History size={14} /> 正在看 <b className="au-mono">{n.name}</b> 的全部历史：按文件本身追踪，改名、移动、删除前后的记录都在，与当时路径无关。
      <span className="grow" />
      <button className="m-btn sm" onClick={() => c.set({ item: undefined })}><X size={13} /> 退出</button>
    </div>
  )
}

/** The text that says what an event touched, including zip contents and "matched through the zip". */
function What({ e, s }: { e: Ev; s: State }) {
  const where = nowAt(e)
  const viaZip = s.dir && dirMatch(e, s.dir.replace(/\/+$/, ''), s.sub) === 'zip'
  return (
    <span className="au-path">
      {e.via ? <b>{e.via}</b> : null}
      {e.path ? <span className="au-mono">{e.path}</span> : <span>{e.detail ?? e.reason ?? '—'}</span>}
      {e.files && <span className="m-tag">{e.files.length} 个文件</span>}
      {viaZip && <span className="m-tag warn" title="压缩包本身不在这个目录，但包里有文件当时在这里">包内文件在此目录</span>}
      {e.stale && <span className="m-tag warn">过期保存</span>}
      {where && <span className={`au-now ${where.gone ? 'gone' : ''}`}>{where.label}</span>}
      {e.path && e.detail && !e.files && <span className="au-faint small">{e.detail}</span>}
    </span>
  )
}

/** Every field of one event plus the three pivots. Each variant frames it differently (drawer, inline, modal). */
function DetailBody({ e, c, done }: { e: Ev; c: Ctl; done?: () => void }) {
  const where = nowAt(e)
  const [all, setAll] = useState(false)
  const go = (f: () => void) => () => (f(), done?.())
  return (
    <div className="s10-detail">
      <dl>
        <dt>时间</dt><dd>{fmtFull(e.t)}</dd>
        <dt>用户</dt><dd>{e.who} <span className="au-faint">{PEOPLE.find((u) => u.id === e.whoId)?.orgLabel ?? ''}</span></dd>
        <dt>来源 IP</dt><dd className="au-mono">{e.ip}</dd>
        <dt>操作</dt><dd><ActionTag e={e} />{e.via && ' 打包下载'}</dd>
        <dt>结果</dt><dd>{e.ok ? '成功' : <span className="au-red">失败：{e.reason}</span>}</dd>
        {e.path && (<><dt>对象（当时）</dt><dd className="au-mono">{e.path}</dd></>)}
        {where && (<><dt>现在</dt><dd className={where.gone ? 'au-red' : ''}>{where.label}</dd></>)}
        {e.detail && (<><dt>说明</dt><dd>{e.detail}</dd></>)}
        {e.size ? (<><dt>大小</dt><dd>{fmtSize(e.size)}</dd></>) : null}
        <dt>记录编号</dt><dd className="au-mono">#{e.id}</dd>
      </dl>
      {e.files && (
        <div className="s10-files">
          <div className="au-faint small">压缩包内文件（当时路径）</div>
          {(all ? e.files : e.files.slice(0, 8)).map((f) => (
            <div key={f.path} className={`au-mono ${f.ok ? '' : 'au-red'}`}>{f.path}{!f.ok && ' · 无下载权限，已略去'}</div>
          ))}
          {e.files.length > 8 && !all && <button className="m-btn sm ghost" onClick={() => setAll(true)}>展开其余 {e.files.length - 8} 个</button>}
        </div>
      )}
      <div className="au-pivots">
        {e.whoId !== 'system' && <button className="m-btn sm" onClick={go(() => c.pivots.who(e))}><UserSearch size={13} /> 只看 {e.who}</button>}
        {e.path && <button className="m-btn sm" onClick={go(() => c.pivots.dir(e))}><FolderSearch size={13} /> 只看 {e.node?.type === 'dir' ? e.path : parentOf(e.path)}</button>}
        {e.node && <button className="m-btn sm" onClick={go(() => c.pivots.item(e))}><History size={13} /> 此{e.node.type === 'dir' ? '目录' : '文件'}全部历史</button>}
      </div>
    </div>
  )
}

/** Directory input: type any path (old names included), suggestions from every path ever recorded. */
function DirInput({ c, wide = false }: { c: Ctl; wide?: boolean }) {
  const [q, setQ] = useState(c.s.dir ?? '')
  const [open, setOpen] = useState(false)
  useEffect(() => setQ(c.s.dir ?? ''), [c.s.dir])
  const dirs = knownDirs().filter((d) => !q || d.path.includes(q)).slice(0, 12)
  const commit = (v?: string) => c.set({ dir: v || undefined, item: undefined })
  return (
    <div className={`au-pick s10-dir ${wide ? 'wide' : ''}`}>
      <FolderSearch size={14} className="au-faint" />
      <input
        value={q}
        placeholder="目录路径，如 /研发部/后端组"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (commit(q.trim()), (e.target as HTMLInputElement).blur())}
      />
      {c.s.dir && <X size={13} className="au-faint" style={{ cursor: 'pointer' }} onClick={() => (setQ(''), commit())} />}
      {open && (
        <div className="au-pick-list s10-dirlist">
          {dirs.map((d) => (
            <button key={d.path} onMouseDown={() => (setQ(d.path), commit(d.path))}>
              <span className="au-mono">{d.path}</span>
              {!d.now && <span className="au-now gone">现已不在此路径</span>}
            </button>
          ))}
          <div className="au-faint small" style={{ padding: '4px 8px' }}>按事件发生时的路径匹配。目录改名或移动后，旧记录要用旧路径查。</div>
        </div>
      )}
    </div>
  )
}

function SubToggle({ c }: { c: Ctl }) {
  return (
    <label className={`s10-check ${c.s.dir ? '' : 'off'}`}>
      <input type="checkbox" checked={c.s.sub} disabled={!c.s.dir} onChange={(e) => c.set({ sub: e.target.checked })} /> 包含子目录
    </label>
  )
}

function CustomRange({ c }: { c: Ctl }) {
  return (
    <span className="tr-exact">
      <input type="datetime-local" value={toInput(c.s.from)} max={toInput(c.s.to)} onChange={(e) => e.target.value && c.setCustom(new Date(e.target.value).getTime(), c.s.to)} />
      <span className="au-faint">至</span>
      <input type="datetime-local" value={toInput(c.s.to)} min={toInput(c.s.from)} onChange={(e) => e.target.value && c.setCustom(c.s.from, new Date(e.target.value).getTime())} />
    </span>
  )
}

function usePaged<T>(rows: T[], per: number, reset: unknown) {
  const [n, setN] = useState(per)
  useEffect(() => setN(per), [reset])
  return { shown: rows.slice(0, n), more: rows.length > n ? () => setN(n + per) : null, left: rows.length - n }
}

// ================================================================ S1 顶部筛选栏 + 表格 + 右侧抽屉
export function SimpleBar({}: AuditPageProps) {
  const c = useSimple()
  const { s, set } = c
  const [open, setOpen] = useState<Ev | null>(null)
  const [page, setPage] = useState(0)
  const per = 50
  useEffect(() => setPage(0), [c.rows.length, s.from, s.to])
  const pages = Math.max(1, Math.ceil(c.rows.length / per))
  return (
    <div className="au-page">
      <Header c={c} />
      <div className="s10-bar">
        <div className="au-seg">
          {PRESETS.map((p) => <button key={p.key} className={s.preset === p.key ? 'on' : ''} onClick={() => c.setPreset(p.key)}>{p.label}</button>)}
        </div>
        {s.preset === 'custom' ? <CustomRange c={c} /> : <span className="au-faint small au-mono">{rangeText(s)}</span>}
        <span className="s10-sep" />
        <PeoplePick c={c} />
        <select className="au-select" value={s.org ?? ''} onChange={(e) => set({ org: e.target.value || undefined, who: [] })}>
          <option value="">或按组织…</option>
          {ORGS.map((o) => <option key={o.id} value={o.id}>{o.parent && o.parent !== 'company' ? '　' : ''}{o.name}</option>)}
        </select>
        <span className="s10-sep" />
        <DirInput c={c} />
        <SubToggle c={c} />
      </div>
      <div className="au-filters">
        {CATS.map((k) => {
          const on = s.cats.includes(k.key)
          return <span key={k.key} className={`au-chip ${on ? 'on' : ''}`} onClick={() => set({ cats: on ? s.cats.filter((x) => x !== k.key) : [...s.cats, k.key] })}>{k.label}</span>
        })}
        <span className={`au-chip ${s.failedOnly ? 'on danger' : ''}`} onClick={() => set({ failedOnly: !s.failedOnly })}>只看失败</span>
        <span className="grow" />
        <button className="m-btn sm ghost" onClick={c.reset}><RotateCcw size={13} /> 重置</button>
      </div>
      <ItemBanner c={c} />
      <div className="au-body">
        <div className="au-table">
          <div className="au-tr au-th s10-tr"><span>时间</span><span>用户</span><span>来源 IP</span><span>操作</span><span>对象（当时路径）</span></div>
          {c.rows.slice(page * per, page * per + per).map((e) => (
            <div key={e.id} className={`au-tr s10-tr ${open === e ? 'on' : ''} ${e.ok ? '' : 'fail'} ${e.live ? 'live' : ''}`} onClick={() => setOpen(e)}>
              <span className="au-mono">{fmtFull(e.t).slice(5)}</span>
              <span>{e.who}</span>
              <span className="au-mono au-faint">{e.ip}</span>
              <span><ActionTag e={e} /></span>
              <What e={e} s={s} />
            </div>
          ))}
          {!c.rows.length && <div className="m-empty">这段时间里没有符合条件的记录</div>}
          {pages > 1 && (
            <div className="au-pager">
              <button className="m-btn sm" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button>
              <span className="au-faint small">{page + 1} / {pages} 页 · 共 {c.rows.length.toLocaleString()} 条</span>
              <button className="m-btn sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>下一页</button>
            </div>
          )}
        </div>
        {open && (
          <aside className="au-detail">
            <div className="au-detail-head"><b className="grow">记录详情</b><X size={16} onClick={() => setOpen(null)} style={{ cursor: 'pointer' }} /></div>
            <DetailBody e={open} c={c} done={() => setOpen(null)} />
          </aside>
        )}
      </div>
    </div>
  )
}

function PeoplePick({ c }: { c: Ctl }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const hits = PEOPLE.filter((u) => !c.s.who.includes(u.id) && (!q || u.name.includes(q) || u.orgLabel.includes(q))).slice(0, 8)
  return (
    <div className="au-pick s10-people">
      <UserSearch size={14} className="au-faint" />
      {c.s.who.map((id) => (
        <span key={id} className="au-chip on" onClick={() => c.set({ who: c.s.who.filter((x) => x !== id) })}>{PEOPLE.find((u) => u.id === id)?.name} <X size={11} /></span>
      ))}
      <input value={q} placeholder={c.s.who.length ? '再加一人' : c.s.org ? whoLabel(c.s) : '所有人'} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => setQ(e.target.value)} />
      {open && (
        <div className="au-pick-list">
          {hits.map((u) => (
            <button key={u.id} onMouseDown={() => (c.set({ who: [...c.s.who, u.id], org: undefined }), setQ(''))}>
              <Avatar name={u.name} size={20} /> {u.name} <span className="au-faint">{u.orgLabel}{u.inactive ? '（已停用）' : ''}</span>
            </button>
          ))}
          {!hits.length && <div className="au-faint small" style={{ padding: '4px 8px' }}>没有匹配的人</div>}
        </div>
      )}
    </div>
  )
}

// ================================================================ S2 左侧筛选面板（分面计数）+ 行内展开
export function SimpleFacets({}: AuditPageProps) {
  const c = useSimple()
  const { s, set } = c
  const [open, setOpen] = useState<number | null>(null)
  const [pq, setPq] = useState('')
  // facet counts: each facet counts over the results of all OTHER filters, so you see what picking it would give
  const byWho = new Map<string, number>()
  for (const e of querySimple({ ...s, who: [], org: undefined })) byWho.set(e.whoId, (byWho.get(e.whoId) ?? 0) + 1)
  const byCat = new Map<Category, number>()
  for (const e of querySimple({ ...s, cats: [] })) byCat.set(ACTION[e.action].cat, (byCat.get(ACTION[e.action].cat) ?? 0) + 1)
  const people = [...byWho.entries()].map(([id, n]) => ({ id, n, name: PEOPLE.find((u) => u.id === id)?.name ?? (id === 'system' ? '系统' : id) }))
    .filter((p) => !pq || p.name.includes(pq)).sort((a, b) => b.n - a.n)
  const failed = querySimple({ ...s, failedOnly: true }).length
  const page = usePaged(c.rows, 60, c.rows.length + s.from)
  const active: { label: string; clear: () => void }[] = []
  if (s.who.length || s.org) active.push({ label: whoLabel(s), clear: () => set({ who: [], org: undefined }) })
  if (s.dir) active.push({ label: `${s.dir}${s.sub ? ' 及子目录' : ' 仅本层'}`, clear: () => set({ dir: undefined }) })
  if (s.cats.length) active.push({ label: catLabel(s), clear: () => set({ cats: [] }) })
  if (s.failedOnly) active.push({ label: '只看失败', clear: () => set({ failedOnly: false }) })
  return (
    <div className="au-page">
      <Header c={c} />
      <div className="s10-split">
        <aside className="s10-side">
          <section>
            <h4><CalendarClock size={13} /> 时间</h4>
            {PRESETS.map((p) => (
              <label key={p.key} className="s10-radio"><input type="radio" checked={s.preset === p.key} onChange={() => c.setPreset(p.key)} /> {p.label}</label>
            ))}
            {s.preset === 'custom' && <div className="s10-stack"><CustomRange c={c} /></div>}
            <div className="au-faint small">最长 {MAX_DAYS} 天</div>
          </section>
          <section>
            <h4><UserSearch size={13} /> 人</h4>
            <select className="au-select" style={{ width: '100%' }} value={s.org ?? ''} onChange={(e) => set({ org: e.target.value || undefined, who: [] })}>
              <option value="">全部组织</option>
              {ORGS.map((o) => <option key={o.id} value={o.id}>{o.parent && o.parent !== 'company' ? '　' : ''}{o.name}（含下级）</option>)}
            </select>
            <input className="s10-mini" placeholder="筛选名字" value={pq} onChange={(e) => setPq(e.target.value)} />
            <div className="s10-facet-list">
              {people.map((p) => (
                <label key={p.id} className="s10-facet">
                  <input type="checkbox" checked={s.who.includes(p.id)} onChange={(e) => set({ who: e.target.checked ? [...s.who, p.id] : s.who.filter((x) => x !== p.id), org: undefined })} />
                  <span className="grow">{p.name}</span><span className="au-faint">{p.n.toLocaleString()}</span>
                </label>
              ))}
              {!people.length && <div className="au-faint small">这段时间没有人有记录</div>}
            </div>
          </section>
          <section>
            <h4><FolderSearch size={13} /> 目录</h4>
            <DirTree c={c} />
            <DirInput c={c} wide />
            <SubToggle c={c} />
          </section>
          <section>
            <h4>操作</h4>
            {CATS.map((k) => (
              <label key={k.key} className="s10-facet">
                <input type="checkbox" checked={s.cats.includes(k.key)} onChange={(e) => set({ cats: e.target.checked ? [...s.cats, k.key] : s.cats.filter((x) => x !== k.key) })} />
                <span className="grow">{k.label}</span><span className="au-faint">{(byCat.get(k.key) ?? 0).toLocaleString()}</span>
              </label>
            ))}
          </section>
          <section>
            <h4>结果</h4>
            <label className="s10-facet"><input type="checkbox" checked={s.failedOnly} onChange={(e) => set({ failedOnly: e.target.checked })} /><span className="grow au-red">只看失败</span><span className="au-faint">{failed}</span></label>
          </section>
          <button className="m-btn sm" onClick={c.reset}><RotateCcw size={13} /> 清空条件</button>
        </aside>
        <div className="s10-main">
          <div className="au-filters">
            <span className="au-faint small au-mono">{rangeText(s)}</span>
            {active.map((a) => <span key={a.label} className="au-chip on" onClick={a.clear}>{a.label} <X size={11} /></span>)}
            <span className="grow" />
            <span className="au-faint small">{c.rows.length.toLocaleString()} 条</span>
          </div>
          <ItemBanner c={c} />
          <div className="au-table">
            <div className="au-tr au-th s10-tr2"><span /><span>时间</span><span>用户</span><span>操作</span><span>对象（当时路径）</span></div>
            {page.shown.map((e) => (
              <div key={e.id}>
                <div className={`au-tr s10-tr2 ${open === e.id ? 'on' : ''} ${e.ok ? '' : 'fail'} ${e.live ? 'live' : ''}`} onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <span className="au-faint">{open === e.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                  <span className="au-mono">{fmtFull(e.t).slice(5)}</span>
                  <span>{e.who}</span>
                  <span><ActionTag e={e} /></span>
                  <What e={e} s={s} />
                </div>
                {open === e.id && <div className="s10-inline"><DetailBody e={e} c={c} done={() => setOpen(null)} /></div>}
              </div>
            ))}
            {!c.rows.length && <div className="m-empty">没有符合条件的记录</div>}
            {page.more && <div className="au-pager"><button className="m-btn sm" onClick={page.more}>再加载 60 条（还有 {page.left.toLocaleString()} 条）</button></div>}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Current directory tree for clicking; old paths go through DirInput. */
function DirTree({ c }: { c: Ctl }) {
  const dirs = knownDirs().filter((d) => d.now)
  return (
    <div className="s10-tree">
      {dirs.map((d) => {
        const depth = d.path.split('/').length - 2
        const on = c.s.dir === d.path
        return (
          <div key={d.path} className={`s10-node ${on ? 'on' : ''}`} style={{ paddingLeft: 6 + depth * 14 }} onClick={() => c.set({ dir: on ? undefined : d.path, item: undefined })}>
            {d.path.split('/').pop()}
          </div>
        )
      })}
    </div>
  )
}

// ================================================================ S3 一句话条件 + 按天分组 + 弹窗详情
type Tok = 'time' | 'who' | 'dir' | 'cat'
export function SimpleSentence({}: AuditPageProps) {
  const c = useSimple()
  const { s, set } = c
  const [tok, setTok] = useState<Tok | null>(null)
  const [open, setOpen] = useState<Ev | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!tok) return
    const off = (e: MouseEvent) => box.current && !box.current.contains(e.target as globalThis.Node) && setTok(null)
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [tok])
  const page = usePaged(c.rows, 120, c.rows.length + s.from)
  const days: { day: number; evs: Ev[] }[] = []
  for (const e of page.shown) {
    const d = sod(e.t)
    if (days[days.length - 1]?.day !== d) days.push({ day: d, evs: [] })
    days[days.length - 1].evs.push(e)
  }
  const dayCount = new Map<number, { n: number; fail: number }>()
  for (const e of c.rows) {
    const d = sod(e.t)
    const x = dayCount.get(d) ?? { n: 0, fail: 0 }
    x.n++
    if (!e.ok) x.fail++
    dayCount.set(d, x)
  }
  const T = ({ k, children }: { k: Tok; children: React.ReactNode }) => (
    <button className={`s10-tok ${tok === k ? 'on' : ''}`} onClick={() => setTok(tok === k ? null : k)}>{children}<ChevronDown size={12} /></button>
  )
  const timeText = s.preset === 'custom' ? rangeText(s) : PRESETS.find((p) => p.key === s.preset)!.label
  return (
    <div className="au-page">
      <Header c={c} />
      <div className="s10-sentence" ref={box}>
        <span>查看</span>
        <T k="time">{timeText}</T>
        <span>内</span>
        <T k="who">{whoLabel(s)}</T>
        <span>在</span>
        <T k="dir">{s.dir ? `${s.dir}${s.sub ? ' 及子目录' : '（仅本层）'}` : '所有目录'}</T>
        <span>的</span>
        <T k="cat">{catLabel(s)}</T>
        <label className={`s10-tok plain ${s.failedOnly ? 'danger' : ''}`}><input type="checkbox" checked={s.failedOnly} onChange={(e) => set({ failedOnly: e.target.checked })} /> 只看失败</label>
        <span className="grow" />
        <span className="au-faint">{c.rows.length.toLocaleString()} 条</span>
        {(s.who.length || s.org || s.dir || s.cats.length || s.failedOnly || s.preset !== '7') ? <button className="m-btn sm ghost" onClick={c.reset}><RotateCcw size={13} /> 重置</button> : null}
        {tok && (
          <div className={`s10-pop at-${tok}`}>
            {tok === 'time' && (
              <>
                <div className="s10-pop-row">{PRESETS.map((p) => <span key={p.key} className={`au-chip ${s.preset === p.key ? 'on' : ''}`} onClick={() => (c.setPreset(p.key), p.key !== 'custom' && setTok(null))}>{p.label}</span>)}</div>
                {s.preset === 'custom' && <div className="s10-pop-row"><CustomRange c={c} /></div>}
                <div className="au-faint small">精确到分钟，最长 {MAX_DAYS} 天</div>
              </>
            )}
            {tok === 'who' && (
              <>
                <div className="s10-pop-row"><PeoplePick c={c} /></div>
                <div className="au-faint small" style={{ margin: '6px 0 4px' }}>或者一个组织（含下级所有人）</div>
                <div className="s10-pop-row">
                  {ORGS.map((o) => <span key={o.id} className={`au-chip ${s.org === o.id ? 'on' : ''}`} onClick={() => set({ org: s.org === o.id ? undefined : o.id, who: [] })}>{o.name}</span>)}
                </div>
                <div className="s10-pop-row"><span className="au-chip" onClick={() => (set({ who: [], org: undefined }), setTok(null))}>所有人</span></div>
              </>
            )}
            {tok === 'dir' && (
              <>
                <div className="s10-pop-row"><DirInput c={c} wide /></div>
                <div className="s10-pop-row"><SubToggle c={c} /><span className="grow" /><span className="au-chip" onClick={() => (set({ dir: undefined }), setTok(null))}>所有目录</span></div>
              </>
            )}
            {tok === 'cat' && (
              <div className="s10-pop-row">
                {CATS.map((k) => {
                  const on = s.cats.includes(k.key)
                  return <span key={k.key} className={`au-chip ${on ? 'on' : ''}`} onClick={() => set({ cats: on ? s.cats.filter((x) => x !== k.key) : [...s.cats, k.key] })}>{k.label}</span>
                })}
                <span className="au-chip" onClick={() => (set({ cats: [] }), setTok(null))}>所有操作</span>
              </div>
            )}
          </div>
        )}
      </div>
      <ItemBanner c={c} />
      <div className="s10-days">
        {days.map(({ day, evs }) => {
          const k = dayCount.get(day)!
          return (
            <section key={day}>
              <h3>{dayLabel(day)} <span className="au-faint">· {k.n.toLocaleString()} 条{k.fail ? <span className="au-red"> · {k.fail} 条失败</span> : null}</span></h3>
              {evs.map((e) => (
                <div key={e.id} className={`s10-line ${e.ok ? '' : 'fail'} ${e.live ? 'live' : ''}`} onClick={() => setOpen(e)}>
                  <span className="au-mono au-faint">{fmtFull(e.t).slice(11, 19)}</span>
                  <b>{e.who}</b>
                  <ActionTag e={e} />
                  <What e={e} s={s} />
                  <span className="au-mono au-faint s10-ip">{e.ip}</span>
                </div>
              ))}
            </section>
          )
        })}
        {!c.rows.length && <div className="m-empty">没有符合这句话的记录</div>}
        {page.more && <div className="au-pager"><button className="m-btn sm" onClick={page.more}>继续往前看（还有 {page.left.toLocaleString()} 条）</button></div>}
      </div>
      {open && (
        <div className="s10-modal" onMouseDown={() => setOpen(null)}>
          <div className="s10-modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="au-detail-head"><ActionTag e={open} /><b className="grow">{open.who} · {fmtFull(open.t)}</b><X size={16} onClick={() => setOpen(null)} style={{ cursor: 'pointer' }} /></div>
            <DetailBody e={open} c={c} done={() => setOpen(null)} />
          </div>
        </div>
      )}
    </div>
  )
}

