// PROTOTYPE round 7: where should transfers live? Four panels on D1, all driven by the same fake engine (src/transfers.ts).
//   T1 角落托盘   a collapsible card in the corner, grouped by folder; conflicts and "re-pick after reload" asked inside it
//   T2 传输页     a sidebar destination like a desktop sync client: tabs, a full table, a conflict dialog up front
//   T3 就地进度   no panel: uploads are rows in the destination folder, a header pill for elsewhere, downloads are the browser's
//   T4 先确认后传 a preflight sheet before anything starts, then a header activity bubble for both directions
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Ban, Check, ChevronDown, ChevronRight, Copy, FileUp, Folder, FolderOpen,
  FolderUp, Layers, Pause, Play, RefreshCw, Trash2, WifiOff, X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Node, User } from './data'
import { FileIcon, toast } from './ui'
import {
  type Batch, type Choice, type Incoming, type Job, LINK, PARALLEL, PART, SCENARIOS, T, batchOf, cancel, cancelBatch, clearFinished, discardBatch,
  dropJob, fmtBytes, fmtEta, fmtSpeed, goOffline, isLive, jobsOf, needsHand, parts, pause, pauseAll, pauseBatch, pct, repick, repickAll, resolve,
  resolveAll, resume, resumeAll, reveal, resumeBatch, setSpeedup, simulateReload, startBatch, statusText, sum, useTransfers, where,
} from './transfers'

export type TransferCtx = {
  user: User
  cwd: Node
  go: (n: Node) => void
  openPage: () => void
  /** enqueue through the explorer, so each variant's own entry behaviour applies */
  upload: (files: Incoming[], folder?: string) => void
  zip: (fake: { label: string; size: number; count: number }) => void
  canUpload: boolean
}
export type TransferUI = {
  key: 'dock' | 'page' | 'inline' | 'preflight'
  /** T4: hold new batches for review */
  stage?: boolean
  page?: { label: string; C: React.FC<TransferCtx>; Badge: React.FC }
  Header?: React.FC<TransferCtx>
  Floating?: React.FC<TransferCtx>
  Rows?: React.FC<TransferCtx>
  Banner?: React.FC<TransferCtx>
  /** T3: real folders in cwd that are still arriving; the progress row stands in for them */
  hide?: (cwd: Node) => Set<string>
  /** what the variant does right after something is enqueued (b is the new batch, or the zip job's batch) */
  after: (b: Batch, ctx: TransferCtx) => void
}

// ---------- tiny shared atoms (layouts are NOT shared) ----------
const fakeNode = (name: string, dir = false) => ({ name, type: dir ? 'dir' : 'file' }) as Node
const tone = (j: Job) =>
  j.status === 'blocked' || j.status === 'canceled' ? 'bad' : j.status === 'done' || j.status === 'browser' ? 'ok' : needsHand(j) || j.status === 'offline' ? 'warn' : j.status === 'paused' ? 'idle' : ''

function Bar({ value, t = '' }: { value: number; t?: string }) {
  return (
    <div className={`t-bar ${t}`}>
      <i style={{ width: `${value}%` }} />
    </div>
  )
}
function Ring({ value, size = 18, stroke = 2.5 }: { value: number; size?: number; stroke?: number }) {
  const r = size / 2 - stroke
  const C = 2 * Math.PI * r
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flex: 'none' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line2)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--accent)" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - value / 100)} style={{ transition: 'stroke-dashoffset .25s' }} />
    </svg>
  )
}
function Acts({ j }: { j: Job }) {
  const b = (title: string, icon: React.ReactNode, run: () => void) => (
    <button className="t-ico" title={title} onClick={(e) => (e.stopPropagation(), run())}>
      {icon}
    </button>
  )
  if (j.kind !== 'upload') return j.status === 'blocked' ? b('移除', <X size={14} />, () => dropJob(j.id)) : null
  return (
    <span className="t-acts">
      {['running', 'queued', 'offline'].includes(j.status) && b('暂停', <Pause size={14} />, () => pause(j.id))}
      {j.status === 'paused' && b('继续', <Play size={14} />, () => resume(j.id))}
      {j.status === 'needsFile' && (
        <button className="t-link" onClick={() => (repick(j.id), toast(`（模拟）已重新选择“${j.name}”，大小一致，从第 ${parts(j).done + 1} 片继续`))}>重新选择文件</button>
      )}
      {isLive(j) && b('取消', <X size={14} />, () => cancel(j.id))}
      {j.status === 'blocked' && b('移除', <X size={14} />, () => dropJob(j.id))}
    </span>
  )
}
function ConflictChoice({ j, compact }: { j: Job; compact?: boolean }) {
  return (
    <span className="t-choice">
      <button onClick={() => resolve(j.id, 'version')} title="旧内容保留在版本历史里，可随时恢复">存为新版本</button>
      <button onClick={() => resolve(j.id, 'keepBoth')}>{compact ? '保留两者' : '保留两者（自动改名）'}</button>
    </span>
  )
}
function Offline() {
  const t = useTransfers()
  if (t.online) return null
  return (
    <div className="t-banner warn">
      <WifiOff size={15} /> 网络已断开。已传完的分片都保存在服务器上，恢复后自动从断点继续，不用重新开始。
    </div>
  )
}
function NeedsFile({ compact }: { compact?: boolean }) {
  const t = useTransfers()
  const list = t.jobs.filter((j) => j.status === 'needsFile')
  if (!list.length) return null
  return (
    <div className="t-banner warn col">
      <div>
        <RefreshCw size={15} /> 页面刷新中断了 {list.length} 个上传。{list.some((j) => j.sent) ? `已传完的 ${fmtBytes(list.reduce((a, j) => a + j.sent, 0))} 保留在服务器上 3 天` : '还没传完整片的需要从头传'}
        {compact ? '。' : '；浏览器出于安全原因不能自动重新读取本地文件，请重新选择同一个文件，核对大小一致后从断点继续。'}
      </div>
      <button className="t-link" onClick={() => (repickAll(), toast('（模拟）已重新选择全部文件并核对，继续上传'))}>
        重新选择 {list.length} 个文件
      </button>
    </div>
  )
}
const iconFor = (j: Job) =>
  j.kind === 'upload' ? <FileIcon n={fakeNode(j.name)} size={18} /> : j.kind === 'zip' ? <Layers size={18} className="t-dl" /> : <ArrowDownToLine size={18} className="t-dl" />

// =====================================================================================
// T1 角落托盘
// =====================================================================================
export function Dock({ go }: TransferCtx) {
  const t = useTransfers()
  const [min, setMin] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [oneByOne, setOneByOne] = useState<Set<string>>(new Set())
  useEffect(() => setMin(false), [t.revealAt])
  const bs = [...t.batches].reverse()
  if (!bs.length) return null
  const ups = sum(t.jobs.filter((j) => j.kind === 'upload'))
  const conflictBatches = bs.filter((b) => jobsOf(b).some((j) => j.status === 'conflict'))
  const title = !t.online ? '网络已断开 · 恢复后自动续传' : ups.live ? `正在上传 ${ups.live} 项${ups.eta ? ` · 剩余${fmtEta(ups.eta)}` : ''}` : '传输完成'
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))

  const row = (j: Job, inner = false) => (
    <div key={j.id} className={`t1-row ${tone(j)} ${inner ? 'inner' : ''}`}>
      {iconFor(j)}
      <div className="t1-main">
        <div className="t-ellipsis">{j.name}</div>
        <div className="t-sub">{statusText(j)}</div>
        {j.kind === 'upload' && ['running', 'paused', 'offline', 'queued', 'needsFile'].includes(j.status) && <Bar value={pct(j.sent, j.size)} t={tone(j)} />}
        {j.status === 'conflict' && oneByOne.has(j.batch) && <ConflictChoice j={j} compact />}
      </div>
      {j.status === 'done' && j.kind === 'upload' ? (
        <button className="t-link" onClick={() => j.result?.parent && go(j.result.parent)}>定位</button>
      ) : (
        <Acts j={j} />
      )}
    </div>
  )

  return (
    <motion.div className="t1" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
      <div className="t1-head" onClick={() => setMin((m) => !m)}>
        {ups.live ? <Ring value={pct(ups.sent, ups.size)} /> : !t.online ? <WifiOff size={16} /> : <Check size={16} className="t-ok" />}
        <b>{title}</b>
        <span className="grow" />
        {ups.speed > 0 && t.online && <span className="t-sub">{fmtSpeed(ups.speed)}</span>}
        <ChevronDown size={16} style={{ transform: min ? 'rotate(180deg)' : undefined }} />
        <button className="t-ico" title={ups.live ? '还有上传在进行' : '清除列表'} disabled={ups.live > 0} onClick={(e) => (e.stopPropagation(), clearFinished())}>
          <X size={15} />
        </button>
      </div>
      {!min && (
        <div className="t1-body">
          <Offline />
          <NeedsFile compact />
          {conflictBatches.map((b) => {
            const cs = jobsOf(b).filter((j) => j.status === 'conflict')
            return (
              <div key={b.id} className="t1-conflict">
                <div>
                  <AlertTriangle size={15} /> “{b.folder ?? b.dir.name}”里已有 <b>{cs.length}</b> 个同名文件：{cs.slice(0, 2).map((j) => j.name).join('、')}
                  {cs.length > 2 ? ' 等' : ''}
                </div>
                {!oneByOne.has(b.id) && (
                  <div className="t-choice">
                    <button className="primary" onClick={() => resolveAll(b.id, 'version')}>全部存为新版本</button>
                    <button onClick={() => resolveAll(b.id, 'keepBoth')}>全部保留两者</button>
                    <button onClick={() => setOneByOne((s) => new Set([...s, b.id]))}>逐个选择</button>
                  </div>
                )}
                <div className="t-sub">新版本不会丢失旧内容，可在“详情与版本”里恢复。其余文件不受影响，已在上传。</div>
              </div>
            )
          })}
          {bs.map((b) => {
            const js = jobsOf(b)
            if (!b.folder) return js.map((j) => row(j))
            const s = sum(js)
            const bad = js.filter((j) => j.status === 'blocked').length
            const isOpen = open.has(b.id)
            return (
              <div key={b.id}>
                <div className={`t1-row ${s.live ? '' : 'ok'}`} onClick={() => toggle(b.id)}>
                  {isOpen ? <FolderOpen size={18} className="t-folder" /> : <Folder size={18} className="t-folder" />}
                  <div className="t1-main">
                    <div className="t-ellipsis">{b.folder}</div>
                    <div className="t-sub">
                      {s.done}/{s.count - bad} 个文件 · {fmtBytes(s.sent)} / {fmtBytes(s.size)}
                      {s.live && s.speed ? ` · ${fmtSpeed(s.speed)} · 剩余${fmtEta(s.eta)}` : ''}
                      {bad ? ` · ${bad} 个不能上传` : ''}
                    </div>
                    {s.live > 0 && <Bar value={pct(s.sent, s.size)} />}
                  </div>
                  <span className="t-acts">
                    {s.live > 0 && <button className="t-ico" title="全部暂停" onClick={(e) => (e.stopPropagation(), pauseBatch(b.id))}><Pause size={14} /></button>}
                    {js.some((j) => j.status === 'paused') && <button className="t-ico" title="全部继续" onClick={(e) => (e.stopPropagation(), resumeBatch(b.id))}><Play size={14} /></button>}
                    {s.live > 0 && <button className="t-ico" title="取消整个文件夹" onClick={(e) => (e.stopPropagation(), cancelBatch(b.id))}><X size={14} /></button>}
                    <ChevronRight size={15} style={{ transform: isOpen ? 'rotate(90deg)' : undefined }} />
                  </span>
                </div>
                {isOpen && js.map((j) => row({ ...j, name: `${j.rel}/${j.name}` }, true))}
              </div>
            )
          })}
        </div>
      )}
    </motion.div>
  )
}

// =====================================================================================
// T2 传输页 + 冲突弹窗
// =====================================================================================
export function PageBadge() {
  const t = useTransfers()
  const s = sum(t.jobs.filter((j) => j.kind === 'upload'))
  const hand = t.jobs.filter(needsHand).length
  if (!t.online) return <span className="t-badge warn"><WifiOff size={11} /></span>
  if (hand) return <span className="t-badge warn">{hand}</span>
  if (s.live) return <span className="t-badge"><Ring value={pct(s.sent, s.size)} size={14} stroke={2} /> {s.live}</span>
  return null
}

type Tab = 'up' | 'down' | 'done' | 'bad'
export function TransferPage({ go }: TransferCtx) {
  const t = useTransfers()
  const [tab, setTab] = useState<Tab>('up')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const tabOf = (j: Job): Tab =>
    j.status === 'blocked' || j.status === 'canceled' ? 'bad' : j.kind !== 'upload' ? 'down' : j.status === 'done' ? 'done' : 'up'
  const inTab = (j: Job) => tabOf(j) === tab
  const count = (x: Tab) => t.jobs.filter((j) => tabOf(j) === x).length
  const ups = sum(t.jobs.filter((j) => j.kind === 'upload' && isLive(j)))
  const bs = [...t.batches].reverse().filter((b) => jobsOf(b).some(inTab))
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))

  const line = (j: Job, b: Batch, inner = false) => (
    <div key={j.id} className={`t2-tr ${tone(j)} ${inner ? 'inner' : ''}`}>
      <span className="t2-name">
        {iconFor(j)}
        <span className="t-ellipsis">{inner ? `${j.rel}/${j.name}` : j.name}</span>
      </span>
      <span className="t-sub t-ellipsis">{j.kind === 'upload' ? where(b) : j.kind === 'zip' ? '打包下载' : '下载'}</span>
      <span className="t-sub">{j.size ? fmtBytes(j.size) : '—'}</span>
      <span className="t2-prog">
        {j.kind === 'upload' && j.status !== 'blocked' ? (
          <>
            <Bar value={pct(j.sent, j.size)} t={tone(j)} />
            <span className="t-sub">{j.size > PART ? `分片 ${parts(j).done}/${parts(j).total}` : `${Math.round(pct(j.sent, j.size))}%`}</span>
          </>
        ) : null}
        <span className={`t-sub t2-state ${tone(j)}`}>{j.status === 'running' ? '' : statusText(j)}</span>
      </span>
      <span className="t-sub">{j.status === 'running' ? fmtSpeed(j.speed) : ''}</span>
      <span className="t-sub">{j.status === 'running' && j.speed ? fmtEta((j.size - j.sent) / j.speed) : ''}</span>
      <span>{j.status === 'done' && j.kind === 'upload' ? <button className="t-link" onClick={() => j.result?.parent && go(j.result.parent)}>打开位置</button> : <Acts j={j} />}</span>
    </div>
  )

  return (
    <div className="t2">
      <div className="t2-top">
        <h2>传输</h2>
        <span className="t-sub">
          {ups.live ? `${ups.live} 个上传 · ${fmtSpeed(ups.speed)} · 剩余${fmtEta(ups.eta) || '计算中'}` : '没有进行中的上传'} · 同时上传 {PARALLEL} 个 · 分片 {PART / 1024 / 1024} MB
        </span>
        <span className="grow" />
        <button className="m-btn sm" onClick={pauseAll}><Pause size={14} /> 全部暂停</button>
        <button className="m-btn sm" onClick={resumeAll}><Play size={14} /> 全部继续</button>
        <button className="m-btn sm ghost" onClick={clearFinished}><Trash2 size={14} /> 清除已结束</button>
      </div>
      <Offline />
      <NeedsFile />
      <div className="t2-tabs">
        {([['up', '上传中'], ['down', '下载'], ['done', '已完成'], ['bad', '未上传 / 已取消']] as const).map(([k, l]) => (
          <a key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l} <span className="m-count">{count(k)}</span>
          </a>
        ))}
      </div>
      {tab === 'down' && (
        <div className="t-banner">单个文件直接从存储下载，进度和暂停都在浏览器自己的下载栏里，这里只记录“已开始”。打包下载由服务器边打包边传。</div>
      )}
      <div className="t2-table">
        <div className="t2-tr th">
          <span>名称</span><span>位置</span><span>大小</span><span>进度</span><span>速度</span><span>剩余</span><span />
        </div>
        {bs.length === 0 && <div className="t-empty">这里没有内容</div>}
        {bs.map((b) => {
          const js = jobsOf(b).filter(inTab)
          if (!b.folder) return js.map((j) => line(j, b))
          const s = sum(js)
          return (
            <div key={b.id}>
              <div className="t2-tr group" onClick={() => toggle(b.id)}>
                <span className="t2-name">
                  <ChevronRight size={14} style={{ transform: open.has(b.id) ? 'rotate(90deg)' : undefined }} />
                  <Folder size={18} className="t-folder" />
                  <span className="t-ellipsis">{b.folder}</span>
                  <span className="t-sub">{js.length} 个文件</span>
                </span>
                <span className="t-sub t-ellipsis">{where(b)}</span>
                <span className="t-sub">{fmtBytes(s.size)}</span>
                <span className="t2-prog">{tab === 'up' && <><Bar value={pct(s.sent, s.size)} /><span className="t-sub">{s.done}/{s.count}</span></>}</span>
                <span className="t-sub">{s.speed ? fmtSpeed(s.speed) : ''}</span>
                <span className="t-sub">{s.speed ? fmtEta(s.eta) : ''}</span>
                <span className="t-acts">
                  {tab === 'up' && <button className="t-ico" title="暂停" onClick={(e) => (e.stopPropagation(), pauseBatch(b.id))}><Pause size={14} /></button>}
                  {tab === 'up' && <button className="t-ico" title="继续" onClick={(e) => (e.stopPropagation(), resumeBatch(b.id))}><Play size={14} /></button>}
                  {tab === 'up' && <button className="t-ico" title="取消" onClick={(e) => (e.stopPropagation(), cancelBatch(b.id))}><X size={14} /></button>}
                </span>
              </div>
              {open.has(b.id) && js.map((j) => line(j, b, true))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** T2: conflicts are decided up front in a dialog, like a desktop file copy. */
export function ConflictDialog() {
  const t = useTransfers()
  const [each, setEach] = useState(false)
  const [picks, setPicks] = useState<Record<string, Choice>>({})
  const b = t.batches.find((b) => !b.staged && jobsOf(b).some((j) => j.status === 'conflict'))
  if (!b) return null
  const cs = jobsOf(b).filter((j) => j.status === 'conflict')
  return (
    <div className="t-modal-bg">
      <motion.div className="t-modal" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}>
        <h3><Copy size={18} /> “{b.folder ?? b.dir.name}”中已有 {cs.length} 个同名文件</h3>
        <p className="t-sub">其余 {jobsOf(b).length - cs.length} 个文件已经开始上传。</p>
        {!each ? (
          <div className="t2-opts">
            <button onClick={() => resolveAll(b.id, 'version')}>
              <b>全部存为新版本</b>
              <span>文件名不变，旧内容进入版本历史，可随时恢复</span>
            </button>
            <button onClick={() => resolveAll(b.id, 'keepBoth')}>
              <b>全部保留两者</b>
              <span>新文件自动改名，例如“{cs[0].name.replace(/(\.[^.]+)$/, ' (1)$1')}”</span>
            </button>
            <button onClick={() => setEach(true)}>
              <b>逐个决定…</b>
              <span>查看每个同名文件的大小和修改人</span>
            </button>
            <button className="ghost" onClick={() => cs.forEach((j) => cancel(j.id))}>
              <b>跳过这些文件</b>
            </button>
          </div>
        ) : (
          <>
            <div className="t2-each">
              <div className="t2-each-row th"><span>文件</span><span>已有的</span><span>要上传的</span><span>处理</span></div>
              {cs.map((j) => (
                <div key={j.id} className="t2-each-row">
                  <span className="t-ellipsis">{j.rel ? `${j.rel}/` : ''}{j.name}</span>
                  <span className="t-sub">{fmtBytes(j.existing!.size)} · {j.existing!.modifiedBy} · {j.existing!.modified.slice(5)}</span>
                  <span className="t-sub">{fmtBytes(j.size)} · 你 · 刚刚</span>
                  <span className="t-seg">
                    {(['version', 'keepBoth'] as const).map((c) => (
                      <a key={c} className={(picks[j.id] ?? 'version') === c ? 'on' : ''} onClick={() => setPicks((p) => ({ ...p, [j.id]: c }))}>
                        {c === 'version' ? '新版本' : '保留两者'}
                      </a>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            <div className="t-modal-foot">
              <button className="m-btn" onClick={() => setEach(false)}>返回</button>
              <button className="m-btn primary" onClick={() => (cs.forEach((j) => resolve(j.id, picks[j.id] ?? 'version')), setEach(false), setPicks({}))}>继续上传</button>
            </div>
          </>
        )}
      </motion.div>
    </div>
  )
}

// =====================================================================================
// T3 就地进度
// =====================================================================================
/** Rows for uploads landing in the folder being looked at, rendered inside the file table. */
export function InlineRows({ cwd }: TransferCtx) {
  const t = useTransfers()
  const here = t.batches.filter((b) => b.kind === 'upload' && b.dir === cwd)
  const rows: React.ReactNode[] = []
  for (const b of here) {
    const js = jobsOf(b).filter((j) => j.status !== 'done' && j.status !== 'canceled')
    if (b.folder) {
      const all = jobsOf(b)
      const s = sum(all)
      if (!s.live && !js.some((j) => j.status === 'blocked')) continue
      const bad = all.filter((j) => j.status === 'blocked')
      const cs = all.filter((j) => j.status === 'conflict')
      rows.push(
        <div key={b.id} className="m-tr t3-row" style={{ ['--p' as string]: `${pct(s.sent, s.size)}%` }}>
          <span className="t3-fill" />
          <span />
          <span className="m-name">
            <FolderUp size={20} className="t-folder" />
            <span className="t-ellipsis">{b.folder}</span>
            <span className="t-sub">{s.done}/{s.count - bad.length} 个文件{s.speed ? ` · 剩余${fmtEta(s.eta)}` : ''}</span>
            {cs.length > 0 && (
              <span className="t3-ask">
                {cs.length} 个同名：
                <button onClick={() => resolveAll(b.id, 'version')}>存为新版本</button>
                <button onClick={() => resolveAll(b.id, 'keepBoth')}>保留两者</button>
              </span>
            )}
            {bad.length > 0 && <span className="m-tag warn" title={bad.map((j) => `${j.name}：${j.reason}`).join('\n')}>{bad.length} 个不能上传</span>}
          </span>
          <span className="t-sub">{s.live ? '上传中' : ''}</span>
          <span className="t-sub">{s.speed ? fmtSpeed(s.speed) : !t.online ? '等待网络' : ''}</span>
          <span className="t-sub">{fmtBytes(s.sent)} / {fmtBytes(s.size)}</span>
          <span className="m-row-actions t3-acts">
            {s.live > 0 && <button className="t-ico" title="暂停" onClick={() => pauseBatch(b.id)}><Pause size={14} /></button>}
            {all.some((j) => j.status === 'paused') && <button className="t-ico" title="继续" onClick={() => resumeBatch(b.id)}><Play size={14} /></button>}
            {s.live > 0 && <button className="t-ico" title="取消" onClick={() => cancelBatch(b.id)}><X size={14} /></button>}
          </span>
        </div>,
      )
      continue
    }
    for (const j of js) {
      rows.push(
        <div key={j.id} className={`m-tr t3-row ${tone(j)}`} style={{ ['--p' as string]: `${pct(j.sent, j.size)}%` }}>
          <span className="t3-fill" />
          <span />
          <span className="m-name">
            <FileIcon n={fakeNode(j.name)} />
            <span className="t-ellipsis">{j.name}</span>
            {j.status === 'conflict' ? (
              <span className="t3-ask">
                已有同名文件（{j.existing!.modifiedBy} · {fmtBytes(j.existing!.size)}）：
                <button onClick={() => resolve(j.id, 'version')}>存为新版本</button>
                <button onClick={() => resolve(j.id, 'keepBoth')}>保留两者</button>
              </span>
            ) : j.status === 'blocked' ? (
              <span className="m-tag warn">{j.reason}</span>
            ) : j.status === 'needsFile' ? (
              <span className="t3-ask">刷新后中断 · 服务器已有 {parts(j).done}/{parts(j).total} 片 <button onClick={() => repick(j.id)}>重新选择文件</button></span>
            ) : (
              <span className="t-sub">{j.status === 'running' ? (j.resumedAt ? `已从第 ${Math.floor(j.resumedAt / PART) + 1} 片续传` : '') : statusText(j)}</span>
            )}
          </span>
          <span className="t-sub">{j.status === 'running' ? '上传中' : ''}</span>
          <span className="t-sub">{j.status === 'running' ? `${fmtSpeed(j.speed)} · ${fmtEta((j.size - j.sent) / (j.speed || 1))}` : ''}</span>
          <span className="t-sub">{j.size > 50 * 1024 * 1024 && j.status !== 'blocked' ? `${fmtBytes(j.sent)} / ` : ''}{fmtBytes(j.size)}</span>
          <span className="m-row-actions t3-acts"><Acts j={j} /></span>
        </div>,
      )
    }
  }
  return <>{rows}</>
}
export function InlineBanner() {
  return (
    <>
      <Offline />
      <NeedsFile />
    </>
  )
}
/** Header pill: only about uploads landing somewhere other than here. */
export function InlinePill({ cwd, go }: TransferCtx) {
  const t = useTransfers()
  const [open, setOpen] = useState(false)
  const live = t.jobs.filter((j) => j.kind === 'upload' && isLive(j))
  if (!live.length) return null
  const s = sum(live)
  const dirs = [...new Set(live.map((j) => batchOf(j).dir))]
  return (
    <div className="t-pill-wrap">
      <button className={`t-pill ${!t.online || live.some(needsHand) ? 'warn' : ''}`} onClick={() => setOpen((o) => !o)}>
        {!t.online ? <WifiOff size={14} /> : <Ring value={pct(s.sent, s.size)} size={16} stroke={2} />}
        <ArrowUpFromLine size={13} /> {live.length} · {t.online ? fmtEta(s.eta) || '…' : '等待网络'}
      </button>
      {open && (
        <div className="t-pop" onMouseLeave={() => setOpen(false)}>
          <div className="t-sub">上传会显示在目标文件夹里，像正在出现的文件一样</div>
          {dirs.map((d) => {
            const ss = sum(live.filter((j) => batchOf(j).dir === d))
            return (
              <a key={d.id} className={`t-pop-row ${d === cwd ? 'here' : ''}`} onClick={() => (go(d), setOpen(false))}>
                <Folder size={16} className="t-folder" />
                <span className="t-ellipsis grow">{d.name}</span>
                <span className="t-sub">{ss.live} 个 · {Math.round(pct(ss.sent, ss.size))}%</span>
                {d === cwd ? <span className="m-tag">当前</span> : <ChevronRight size={14} />}
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}

// =====================================================================================
// T4 先确认后传 + 活动气泡
// =====================================================================================
export function Preflight() {
  const t = useTransfers()
  const b = t.batches.find((b) => b.staged)
  const [picks, setPicks] = useState<Record<string, Choice>>({})
  const [expand, setExpand] = useState(false)
  if (!b) return null
  const js = jobsOf(b)
  const bad = js.filter((j) => j.status === 'blocked')
  const cs = js.filter((j) => j.status === 'conflict')
  const ok = js.filter((j) => j.status !== 'blocked')
  const size = ok.reduce((a, j) => a + j.size, 0)
  const silent = js.filter((j) => j.silentRename).length
  const tree = new Map<string, Job[]>()
  ok.forEach((j) => tree.set(j.rel, [...(tree.get(j.rel) ?? []), j]))
  const start = () => {
    cs.forEach((j) => resolve(j.id, picks[j.id] ?? 'version'))
    bad.forEach((j) => dropJob(j.id))
    startBatch(b.id)
    setPicks({})
    reveal()
  }
  const allTo = (c: Choice) => setPicks(Object.fromEntries(cs.map((j) => [j.id, c])))
  return (
    <div className="t-modal-bg">
      <motion.div className="t-modal t4-sheet" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }}>
        <h3><FileUp size={18} /> 上传到 {where({ ...b, folder: undefined })}</h3>
        <div className="t4-chips">
          <span>{ok.length} 个文件</span>
          <span>{fmtBytes(size)}</span>
          <span>预计{fmtEta(size / LINK) || ' 1 秒'}（局域网）</span>
          {b.folder && <span>保留文件夹结构</span>}
          {b.dropBox && <span className="warn">投递箱：传完后你只能看到自己传的文件</span>}
        </div>

        {bad.length > 0 && (
          <section className="t4-sec bad">
            <h4><Ban size={15} /> 不能上传 {bad.length} 个</h4>
            {bad.map((j) => (
              <div key={j.id} className="t4-line"><s>{j.name}</s><span className="t-sub">{fmtBytes(j.size)} · {j.reason}</span></div>
            ))}
          </section>
        )}

        {cs.length > 0 && (
          <section className="t4-sec warn">
            <h4>
              <AlertTriangle size={15} /> 同名 {cs.length} 个
              <span className="grow" />
              <a onClick={() => allTo('version')}>全部新版本</a> · <a onClick={() => allTo('keepBoth')}>全部保留两者</a>
            </h4>
            {cs.map((j) => (
              <div key={j.id} className="t4-line">
                <span className="t-ellipsis">{j.rel ? `${j.rel}/` : ''}{j.name}</span>
                <span className="t-sub">已有：{j.existing!.modifiedBy} · {j.existing!.modified.slice(5)} · {fmtBytes(j.existing!.size)}</span>
                <span className="t-seg">
                  {(['version', 'keepBoth'] as const).map((c) => (
                    <a key={c} className={(picks[j.id] ?? 'version') === c ? 'on' : ''} onClick={() => setPicks((p) => ({ ...p, [j.id]: c }))}>
                      {c === 'version' ? '存为新版本' : '保留两者'}
                    </a>
                  ))}
                </span>
              </div>
            ))}
          </section>
        )}

        <section className="t4-sec">
          <h4><Check size={15} /> 将上传{b.folder ? `“${b.folder}”` : ''}</h4>
          {b.folder ? (
            <div className="t4-tree">
              {[...tree.entries()].slice(0, expand ? undefined : 3).map(([rel, list]) => (
                <div key={rel}>
                  <div className="t4-line"><Folder size={14} className="t-folder" /> {b.folder}/{rel}<span className="t-sub">{list.length} 个 · {fmtBytes(list.reduce((a, j) => a + j.size, 0))}</span></div>
                </div>
              ))}
              {tree.size > 3 && <a className="t-link" onClick={() => setExpand((e) => !e)}>{expand ? '收起' : `还有 ${tree.size - 3} 个文件夹`}</a>}
            </div>
          ) : (
            ok.filter((j) => j.status !== 'conflict').map((j) => (
              <div key={j.id} className="t4-line"><FileIcon n={fakeNode(j.name)} size={16} /> <span className="t-ellipsis">{j.name}</span><span className="t-sub">{fmtBytes(j.size)}</span></div>
            ))
          )}
          {silent > 0 && <div className="t-sub">（原型可见）{silent} 个与他人投递的文件同名，将静默改名，不告诉你对方的文件名。</div>}
        </section>

        <div className="t-modal-foot">
          <span className="t-sub grow">关闭页面会暂停上传；重新打开后选择同一文件即可续传</span>
          <button className="m-btn" onClick={() => discardBatch(b.id)}>取消</button>
          <button className="m-btn primary" disabled={!ok.length} onClick={start}>开始上传 {ok.length} 个</button>
        </div>
      </motion.div>
    </div>
  )
}

export function Activity({ go }: TransferCtx) {
  const t = useTransfers()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => void (t.revealAt && setOpen(true)), [t.revealAt])
  useEffect(() => {
    const off = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as globalThis.Node) && setOpen(false)
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [])
  const list = [...t.jobs].filter((j) => !batchOf(j).staged).reverse()
  const ups = sum(list.filter((j) => j.kind === 'upload' && isLive(j)))
  const warn = !t.online || list.some(needsHand)
  // fold folder batches into one line
  const lines: (Job | Batch)[] = []
  for (const j of list) {
    const b = batchOf(j)
    if (b.folder) lines.includes(b) || lines.push(b)
    else lines.push(j)
  }
  return (
    <div className="t-pill-wrap" ref={ref}>
      <button className={`t4-btn ${warn ? 'warn' : ''}`} title="传输" onClick={() => setOpen((o) => !o)}>
        {ups.live ? <Ring value={pct(ups.sent, ups.size)} size={26} stroke={2.5} /> : null}
        <span className="t4-btn-ico">{warn ? <AlertTriangle size={15} /> : <ArrowDownToLine size={16} style={{ transform: ups.live ? 'rotate(180deg)' : undefined }} />}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="t-pop t4-pop" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <div className="t4-pop-head">
              <b>最近的传输</b>
              <span className="t-sub">{ups.live ? `${ups.live} 个上传 · ${fmtSpeed(ups.speed)} · 剩余${fmtEta(ups.eta)}` : ''}</span>
              <span className="grow" />
              <a className="t-link" onClick={clearFinished}>清除</a>
            </div>
            <Offline />
            <NeedsFile compact />
            {lines.length === 0 && <div className="t-empty">还没有传输</div>}
            {lines.slice(0, 12).map((x) => {
              if ('kind' in x && 'staged' in x) {
                const js = jobsOf(x)
                const s = sum(js)
                return (
                  <div key={x.id} className="t4-item">
                    <Folder size={18} className="t-folder" />
                    <div className="grow">
                      <div className="t-ellipsis">{x.folder}</div>
                      <div className="t-sub">{s.done}/{s.count} 个文件 · {fmtBytes(s.sent)} / {fmtBytes(s.size)}{s.speed ? ` · ${fmtEta(s.eta)}` : ''}</div>
                      {s.live > 0 && <Bar value={pct(s.sent, s.size)} />}
                    </div>
                    {s.live > 0 ? <button className="t-ico" onClick={() => cancelBatch(x.id)}><X size={14} /></button> : <button className="t-link" onClick={() => go(x.dir)}>打开</button>}
                  </div>
                )
              }
              const j = x as Job
              return (
                <div key={j.id} className={`t4-item ${tone(j)}`}>
                  {iconFor(j)}
                  <div className="grow">
                    <div className="t-ellipsis">{j.name}</div>
                    <div className="t-sub">{statusText(j)}</div>
                    {j.kind === 'upload' && ['running', 'paused', 'offline', 'queued', 'needsFile'].includes(j.status) && <Bar value={pct(j.sent, j.size)} t={tone(j)} />}
                  </div>
                  {j.status === 'done' && j.result?.parent ? <button className="t-link" onClick={() => go(j.result!.parent!)}>打开</button> : <Acts j={j} />}
                </div>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// =====================================================================================
// 🧪 simulator (prototype only, not part of any design)
// =====================================================================================
export function Simulator(ctx: TransferCtx) {
  const t = useTransfers()
  const [min, setMin] = useState(false)
  const states = sum(t.jobs).states
  return (
    <div className={`t-sim ${min ? 'min' : ''}`}>
      <div className="t-sim-head" onClick={() => setMin((m) => !m)}>🧪 模拟（原型，不属于设计）{min ? ' ▸' : ' ▾'}</div>
      {!min && (
        <>
          <div className="t-sim-sub">
            目标：{ctx.cwd.name}
            {!ctx.canUpload && <b>（你在这里没有“上传”权限，先进一个能上传的文件夹）</b>}
          </div>
          <div className="t-sim-grid">
            {SCENARIOS.map((s) => (
              <button
                key={s.key}
                disabled={s.key !== 'zip' && !ctx.canUpload}
                onClick={() => {
                  const r = s.run(ctx.cwd)
                  if (r === 'zip') return ctx.zip({ label: '项目全部资料.zip', size: 12.6 * 1024 ** 3, count: 3412 })
                  if (Array.isArray(r)) {
                    if (s.key === 'same' && r.length < 2) return toast('当前文件夹里没有文件，换一个有文件的文件夹再试')
                    return ctx.upload(r)
                  }
                  ctx.upload(r.files, r.folder)
                }}
              >
                {s.label}
              </button>
            ))}
            <button onClick={() => goOffline(8000)} disabled={!t.online}><WifiOff size={13} /> 断网 8 秒</button>
            <button onClick={() => (simulateReload(), toast('（模拟）页面已刷新：上传会话还在服务器上，但浏览器丢了本地文件'))}><RefreshCw size={13} /> 刷新页面</button>
            <button className={t.speedup > 1 ? 'on' : ''} onClick={() => setSpeedup(t.speedup > 1 ? 1 : 10)}>⏩ 快进 ×10</button>
          </div>
          <div className="t-sim-state">
            网络 {t.online ? '在线' : <b>断开</b>} · 链路 {fmtSpeed(LINK)} · 并发 {PARALLEL} · 分片 64 MB{t.reloads ? ` · 已刷新 ${t.reloads} 次` : ''}
            <br />
            {Object.entries(states).map(([k, v]) => `${k} ${v}`).join(' · ') || '无任务'}
            {t.jobs.some((j) => j.silentRename && j.status !== 'done') && <><br />投递箱同名（静默改名）：{t.jobs.filter((j) => j.silentRename).map((j) => j.name).join('、')}</>}
          </div>
        </>
      )}
    </div>
  )
}

// =====================================================================================
// variant configs (mounted by MotionExplorer)
// =====================================================================================
const showToast = (b: Batch, ctx: TransferCtx, label: string, run: () => void) => {
  const j = jobsOf(b)[0]
  if (b.kind === 'zip' && j.status === 'blocked') return toast(j.reason!)
  if (b.kind === 'download') return toast(`已开始下载“${j.name}”，进度见浏览器下载栏`)
  if (b.kind === 'zip') return toast(`正在打包 ${j.count} 个文件，完成后由浏览器下载${j.skipped ? `；${j.skipped} 个无下载权限的文件已跳过` : ''}`)
  if (b.dir !== ctx.cwd) toast(`正在上传到“${b.dir.name}”`, { label, run })
}

export const T1: TransferUI = { key: 'dock', Floating: Dock, after: () => reveal() }
export const T2: TransferUI = {
  key: 'page',
  page: { label: '传输', C: TransferPage, Badge: PageBadge },
  Floating: ConflictDialog,
  after: (b, ctx) => {
    const j = jobsOf(b)[0]
    if (b.kind === 'zip' && j.status === 'blocked') return toast(j.reason!)
    toast(b.kind === 'upload' ? `已加入传输列表：${b.label}` : b.kind === 'zip' ? '已加入传输列表：打包下载' : `已开始下载“${j.name}”`, { label: '查看', run: ctx.openPage })
  },
}
/** Round 7 verdict: downloads are the browser's own business. No in-app UI, except a refused zip must say why. */
export const T3: TransferUI = {
  key: 'inline', Rows: InlineRows, Banner: InlineBanner, Header: InlinePill,
  hide: (cwd) =>
    new Set(
      T.batches
        .filter((b) => b.kind === 'upload' && b.dir === cwd && b.folder && jobsOf(b).some((j) => isLive(j) || j.status === 'blocked'))
        .map((b) => b.folder!),
    ),
  after: (b, ctx) => {
    const j = jobsOf(b)[0]
    if (b.kind === 'zip') return j.status === 'blocked' ? toast(j.reason!) : undefined
    if (b.kind === 'download') return
    if (b.dir !== ctx.cwd) toast(`正在上传到“${b.dir.name}”`, { label: '前往', run: () => ctx.go(b.dir) })
  },
}
export const T4: TransferUI = {
  key: 'preflight', stage: true, Header: Activity, Floating: Preflight,
  after: (b) => {
    const j = jobsOf(b)[0]
    if (b.kind === 'zip' && j.status === 'blocked') return toast(j.reason!)
    if (b.kind !== 'upload') reveal()
  },
}
