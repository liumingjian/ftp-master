// PROTOTYPE round 4: what should making and explaining Grants look like? All four sit on F (M2 calm).
//
//   P1 dialog     共享弹窗   item-centric modal: add people/orgs/groups, direct vs inherited, check someone
//   P2 inspector  侧栏刻度   in the inspector: one 4-step bar per principal; inherited levels are a locked floor
//   P3 matrix     权限矩阵   a page: folders × principals for a whole subtree, click a cell to change it
//   P4 people     以人为中心 a page: pick a person/org/group, see everywhere they reach and why, grant from there
//
// Grants only ever allow (no deny), so every UI has to show that a direct Grant at or below what is
// inherited does nothing, and that inherited Grants can only be changed where they were made.
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, Building2, ChevronRight, CornerDownRight, Lock, Plus, Search, ShieldCheck, TriangleAlert, User as UserIcon, Users, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Grant, Node, ROOT, User } from './data'
import {
  LEVEL_HINT, LV, Principal, Source, allPrincipals, canManage, direct, explain, floorOf, grantsBelow, keyOf, levelOf, members,
  personOf, principalOfGrant, same, sources, subtree, where, wouldLockOut,
} from './grants'
import { entryPoints, kids, level } from './perm'
import { setGrant, useStore } from './store'
import { Avatar, FileIcon, toast } from './ui'

export type GrantProps = { n: Node; user: User; close: () => void; go: (n: Node) => void }

// ---------------------------------------------------------------- shared bits

export function PIcon({ p, size = 26 }: { p: Principal; size?: number }) {
  if (p.kind === 'user') return <Avatar name={p.label} size={size} />
  const I = p.kind === 'org' ? Building2 : Users
  return (
    <span className={`g-picon ${p.kind}`} style={{ width: size, height: size }}>
      <I size={size * 0.55} />
    </span>
  )
}

const kindLabel = { user: '人员', org: '组织', group: '用户组' }

function PrincipalPicker({ onPick, placeholder = '添加人员、组织或用户组', autoFocus, annotate }: {
  onPick: (p: Principal) => void
  placeholder?: string
  autoFocus?: boolean
  annotate?: (p: Principal) => React.ReactNode
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const all = useMemo(allPrincipals, [])
  const hits = all.filter((p) => !q || p.label.includes(q) || p.sub.includes(q) || p.id.includes(q.toLowerCase()))
  return (
    <div className="g-picker" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <label className="g-picker-input">
        <Search size={15} />
        <input autoFocus={autoFocus} value={q} placeholder={placeholder} onClick={() => setOpen(true)} onChange={(e) => (setQ(e.target.value), setOpen(true))} />
      </label>
      <AnimatePresence>
        {open && (
          <motion.div className="g-picker-list" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
            {(['user', 'org', 'group'] as const).map((k) => {
              const list = hits.filter((p) => p.kind === k)
              if (!list.length) return null
              return (
                <div key={k}>
                  <div className="g-picker-group">{kindLabel[k]}</div>
                  {list.map((p) => (
                    <button key={keyOf(p)} className={`g-picker-item ${p.inactive ? 'off' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => (onPick(p), setQ(''), setOpen(false))}>
                      <PIcon p={p} size={24} />
                      <span className="grow">
                        {p.label} {p.inactive && <span className="m-tag warn">已停用</span>}
                        <div className="m-faint small m-ellipsis">{p.sub}</div>
                      </span>
                      {annotate?.(p)}
                    </button>
                  ))}
                </div>
              )
            })}
            {!hits.length && <div className="g-picker-group">没有匹配的人员、组织或用户组</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function LevelSelect({ value, onChange, floor = 0, none = '移除', disabled }: { value: number; onChange: (l: number) => void; floor?: number; none?: string; disabled?: boolean }) {
  return (
    <select className="g-select" value={value} disabled={disabled} onChange={(e) => onChange(+e.target.value)}>
      {[1, 2, 3, 4].map((l) => (
        <option key={l} value={l}>
          {LV[l]}
          {l <= floor ? '（已继承，无效果）' : ''}
        </option>
      ))}
      <option value={0}>{none}</option>
    </select>
  )
}

function reachNote(p: Principal) {
  const u = personOf(p)
  if (u?.inactive) return '账号已停用，授权保留但不生效'
  if (u) return u.orgLabel
  return `影响 ${members(p).length} 人`
}

/** Apply a direct-Grant change with the two guards every variant needs: self lock-out and the no-deny floor. */
function useApply(n: Node, user: User) {
  const [confirm, setConfirm] = useState<{ p: Principal; next: number } | null>(null)
  const apply = (p: Principal, next: number, force = false) => {
    const g = direct(n, p)
    if (!force && g && wouldLockOut(user, n, g, next)) return setConfirm({ p, next })
    setConfirm(null)
    const fl = floorOf(p, n).level
    const undo = setGrant(n, { kind: p.kind, id: p.id, label: p.label, level: next })
    const msg = !next
      ? `已撤销 ${p.label} 在“${n.name}”上的直接授权${fl ? `，仍从上层继承“${LV[fl]}”` : ''}`
      : next <= fl
        ? `已授予 ${p.label}“${LV[next]}”，但 TA 已从上层继承“${LV[fl]}”，这条授权暂时没有效果`
        : `已授予 ${p.label} 在“${n.name}”上的“${LV[next]}”`
    toast(msg, { label: '撤销', run: undo })
  }
  const Confirm = confirm && (
    <div className="g-warn danger">
      <TriangleAlert size={15} />
      <span className="grow">这样改之后你将失去“{n.name}”的管理权限，也就无法再改回来。</span>
      <button className="m-btn sm" onClick={() => setConfirm(null)}>取消</button>
      <button className="m-btn sm danger" onClick={() => apply(confirm.p, confirm.next, true)}>仍然修改</button>
    </div>
  )
  return { apply, Confirm }
}

function ScopeNote({ n, user }: { n: Node; user: User }) {
  if (user.admin) return <span>你是管理员，可以在任何位置授权。</span>
  const scope = entryPoints(user).find((e) => level(user, e) >= 4 && (e === n || isUnder(n, e)))
  return <span>你在“{scope?.name ?? n.name}”内有管理权限，可在其中授予最高“管理”。</span>
}
const isUnder = (n: Node, a: Node) => {
  for (let p = n.parent; p; p = p.parent) if (p === a) return true
  return false
}

function ExplainCard({ p, n, onGo }: { p: Principal; n: Node; onGo?: (n: Node) => void }) {
  useStore()
  const e = explain(p, n)
  return (
    <div className="g-explain">
      <div className="g-explain-head">
        <PIcon p={p} size={26} />
        <b className="grow">{p.label}</b>
        <span className={`g-lv l${e.level}`}>{e.level ? LV[e.level] : '无权限'}</span>
      </div>
      {e.lines.map((l, i) => (
        <div key={i} className={`g-explain-line ${i === 0 && e.best ? 'best' : ''}`}>
          <CornerDownRight size={13} /> {l}
        </div>
      ))}
      {e.best && e.best.from !== n && onGo && (
        <a className="small" onClick={() => onGo(e.best!.from)}>
          前往“{e.best.from.name}”修改这条授权 →
        </a>
      )}
      {personOf(p) && !personOf(p)!.inactive && !personOf(p)!.admin && e.level > 0 && (
        <div className="m-faint small">即：{LEVEL_HINT.slice(1, e.level + 1).join(' ')}</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- P1: share dialog

export function GrantDialog({ n, user, close, go }: GrantProps) {
  useStore()
  const can = canManage(user, n)
  const [adding, setAdding] = useState<{ p: Principal; level: number } | null>(null)
  const [check, setCheck] = useState<Principal | null>(null)
  const [showBelow, setShowBelow] = useState(false)
  const { apply, Confirm } = useApply(n, user)
  const inherited = pathSources(n)
  const below = grantsBelow(n)
  const addFloor = adding ? floorOf(adding.p, n) : null

  return (
    <motion.div className="g-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} onMouseDown={close}>
      <motion.div className="g-dialog" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.14 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="g-dialog-head">
          <FileIcon n={n} size={28} />
          <div className="grow">
            <b>授权“{n.name}”</b>
            <div className="m-faint small">{where(n)}</div>
          </div>
          <button className="m-btn icon ghost" onClick={close}><X size={16} /></button>
        </div>

        {can ? (
          <>
            {!adding ? (
              <PrincipalPicker onPick={(p) => setAdding({ p, level: Math.min(4, Math.max(1, floorOf(p, n).level + 1)) })} annotate={(p) => {
                const l = levelOf(p, n)
                return l ? <span className="m-faint small">已有{LV[l]}</span> : null
              }} />
            ) : (
              <div className="g-adding">
                <PIcon p={adding.p} size={30} />
                <div className="grow">
                  <b>{adding.p.label}</b>
                  <div className="m-faint small">{reachNote(adding.p)}</div>
                </div>
                <LevelSelect value={adding.level} floor={addFloor!.level} none="取消" onChange={(l) => (l ? setAdding({ ...adding, level: l }) : setAdding(null))} />
                <button className="m-btn primary" onClick={() => (apply(adding.p, adding.level), setAdding(null))}>授权</button>
              </div>
            )}
            {adding && addFloor!.level >= adding.level && (
              <div className="g-warn">
                <TriangleAlert size={15} />
                <span>{adding.p.label} 已从“{addFloor!.src?.from.name ?? '管理员身份'}”继承“{LV[addFloor!.level]}”。授权只增不减，低于或等于它的授权不会生效。</span>
              </div>
            )}
            <div className="m-faint small g-scope"><ShieldCheck size={13} /> <ScopeNote n={n} user={user} /></div>
          </>
        ) : (
          <div className="g-warn"><Lock size={15} /> 你在这里只有“{LV[level(user, n)]}”，只能查看谁有权限。</div>
        )}
        {Confirm}

        <div className="m-section-title">直接授权 · {n.grants.length}</div>
        {!n.grants.length && <div className="m-faint small g-empty">这里没有直接授权，所有权限都继承自上层。</div>}
        {n.grants.map((g) => {
          const p = principalOfGrant(g)
          const fl = floorOf(p, n)
          const inactive = personOf(p)?.inactive
          return (
            <div key={keyOf(p)} className={`g-row ${g.level <= fl.level || inactive ? 'dim' : ''}`}>
              <PIcon p={p} />
              <div className="grow">
                {g.label}
                {g.level <= fl.level && <span className="m-tag warn">无效果</span>}
                {inactive && <span className="m-tag warn">已停用</span>}
                <div className="m-faint small">{g.level <= fl.level ? `已从“${fl.src?.from.name}”继承“${LV[fl.level]}”` : reachNote(p)}</div>
              </div>
              <LevelSelect value={g.level} floor={fl.level} disabled={!can} onChange={(l) => apply(p, l)} />
            </div>
          )
        })}

        {inherited.length > 0 && (
          <>
            <div className="m-section-title">继承的授权 · 只能在来源处修改</div>
            {groupBy(inherited, (s) => s.from).map(([from, list]) => (
              <div key={from.id} className="g-inh">
                <a className="g-inh-from" onClick={() => (close(), go(from))}>
                  <FileIcon n={from} size={14} /> 来自“{from.name}” <ChevronRight size={13} />
                </a>
                {list.map((s) => (
                  <div key={keyOf(s.grant)} className="g-row inh">
                    <PIcon p={principalOfGrant(s.grant)} size={22} />
                    <span className="grow">{s.grant.label}<span className="m-faint small"> · {reachNote(principalOfGrant(s.grant))}</span></span>
                    <span className="g-lv">{LV[s.grant.level]}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {n.type === 'dir' && below.length > 0 && (
          <>
            <a className="m-section-title g-toggle" onClick={() => setShowBelow(!showBelow)}>
              <ChevronRight size={13} style={{ transform: showBelow ? 'rotate(90deg)' : '' }} /> 内部还有 {below.length} 条更具体的授权
            </a>
            {showBelow && below.map(({ node, grant }) => (
              <div key={node.id + keyOf(grant)} className="g-row inh">
                <PIcon p={principalOfGrant(grant)} size={22} />
                <span className="grow">{grant.label} <span className="m-faint small">在 {where(node).slice(where(n).length) || '/'}</span></span>
                <span className="g-lv">{LV[grant.level]}</span>
              </div>
            ))}
          </>
        )}

        <div className="m-section-title">检查某人的权限</div>
        {check ? (
          <>
            <ExplainCard p={check} n={n} onGo={(x) => (close(), go(x))} />
            <a className="small" onClick={() => setCheck(null)}>换一个人</a>
          </>
        ) : (
          <PrincipalPicker placeholder="输入姓名，查看 TA 为什么能/不能访问这里" onPick={setCheck} />
        )}
      </motion.div>
    </motion.div>
  )
}

function pathSources(n: Node): Source[] {
  const out: Source[] = []
  for (let a = n.parent; a; a = a.parent) a.grants.forEach((grant) => out.push({ grant, from: a!, why: '' }))
  return out
}
function groupBy<T, K>(list: T[], f: (t: T) => K): [K, T[]][] {
  const m = new Map<K, T[]>()
  list.forEach((t) => m.set(f(t), [...(m.get(f(t)) ?? []), t]))
  return [...m]
}

// ---------------------------------------------------------------- P2: inspector, one level bar per principal

export function GrantInspector({ n, user, go }: GrantProps) {
  useStore()
  const can = canManage(user, n)
  const [extra, setExtra] = useState<Principal[]>([])
  const [adding, setAdding] = useState(false)
  const { apply, Confirm } = useApply(n, user)
  const me: Principal = { kind: 'user', id: user.id, label: user.name }

  // everyone with a Grant reaching n, plus principals just added in this session
  const ps: Principal[] = []
  for (const x of [...pathSources(n).map((s) => principalOfGrant(s.grant)), ...n.grants.map(principalOfGrant), ...extra])
    if (!ps.some((y) => same(x, y))) ps.push(x)
  ps.sort((a, b) => levelOf(b, n) - levelOf(a, n))

  const click = (p: Principal, l: number) => {
    if (!can) return
    const g = direct(n, p)
    const fl = floorOf(p, n).level
    if (l <= fl) return g ? apply(p, 0) : toast(`${p.label} 已从上层继承“${LV[fl]}”，不能在这里降低（授权只增不减）`)
    apply(p, g?.level === l ? 0 : l)
  }

  return (
    <div className="g-insp">
      <div className="m-section-title">你的权限</div>
      <ExplainCard p={me} n={n} onGo={go} />

      <div className="m-section-title" style={{ justifyContent: 'space-between' }}>
        <span>谁能访问 · {ps.length}</span>
        <span className="g-legend"><i className="inh" />继承 <i className="dir" />直接</span>
      </div>
      {Confirm}
      {ps.map((p) => {
        const fl = floorOf(p, n)
        const g = direct(n, p)
        const eff = Math.max(fl.level, g?.level ?? 0)
        const off = personOf(p)?.inactive
        return (
          <div key={keyOf(p)} className={`g-bar-row ${off ? 'dim' : ''}`}>
            <div className="g-bar-who">
              <PIcon p={p} size={22} />
              <span className="grow m-ellipsis">{p.label}</span>
              {g && g.level <= fl.level && <span className="m-tag warn" title="已继承同等或更高的级别">无效果</span>}
              {off && <span className="m-tag warn">停用</span>}
            </div>
            <div className={`g-bar ${can ? 'can' : ''}`}>
              {[1, 2, 3, 4].map((l) => {
                const state = l <= fl.level ? 'inh' : g && l <= g.level ? 'dir' : 'off'
                return (
                  <button
                    key={l}
                    className={`g-seg ${state} ${l === eff ? 'top' : ''}`}
                    title={l <= fl.level ? `继承自“${fl.src?.from.name ?? '管理员身份'}”（${fl.src?.why ?? ''}）` : can ? (g?.level === l ? '再点一次撤销' : `设为${LV[l]}`) : ''}
                    onClick={() => click(p, l)}
                  >
                    {l <= fl.level && l === fl.level && <Lock size={10} />}
                    {LV[l]}
                  </button>
                )
              })}
            </div>
            <div className="m-faint small g-bar-src">
              {fl.level > 0 && <>继承自“{fl.src?.from.name ?? '管理员'}”{g && g.level > fl.level ? ` · 此处提升到${LV[g.level]}` : ''}</>}
              {!fl.level && g && '仅此处直接授权'}
              {!fl.level && !g && '尚无权限'}
              {p.kind !== 'user' && ` · ${members(p).length} 人`}
            </div>
          </div>
        )
      })}
      {can &&
        (adding ? (
          <PrincipalPicker autoFocus onPick={(p) => (setExtra((x) => [...x, p]), setAdding(false))} />
        ) : (
          <button className="m-btn ghost" onClick={() => setAdding(true)}><Plus size={15} /> 添加人员、组织或用户组</button>
        ))}
      {can && <div className="m-faint small g-scope"><ShieldCheck size={13} /> 点刻度设置级别，再点一次撤销。灰色带锁的部分来自上层，只能去来源处改。</div>}
    </div>
  )
}

// ---------------------------------------------------------------- P3: matrix page

export function GrantMatrix({ n, user, close, go }: GrantProps) {
  useStore()
  const roots = user.admin ? [ROOT, ...kids(user, ROOT)] : entryPoints(user).filter((e) => level(user, e) >= 4)
  const [root, setRoot] = useState<Node>(() => (user.admin ? (n === ROOT ? ROOT : n.type === 'dir' ? n : n.parent!) : roots.find((r) => r === n || isUnder(n, r)) ?? roots[0]))
  const [files, setFiles] = useState(false)
  const [extra, setExtra] = useState<Principal[]>([])
  const [pick, setPick] = useState(false)
  const [cell, setCell] = useState<{ node: Node; p: Principal; x: number; y: number } | null>(null)
  const [hl, setHl] = useState<string | null>(null)
  if (!root) return <div className="m-empty">你没有可以授权的位置。</div>

  const rows = subtree(root).filter((r) => files || r.node.type === 'dir')
  const cols: Principal[] = []
  for (const x of [...pathSources(root).map((s) => principalOfGrant(s.grant)), ...subtree(root).flatMap((r) => r.node.grants.map(principalOfGrant)), ...extra])
    if (!cols.some((y) => same(x, y))) cols.push(x)

  return (
    <div className="g-page" onClick={() => setCell(null)}>
      <div className="g-page-head">
        <button className="m-btn ghost" onClick={close}><ArrowLeft size={15} /> 返回文件</button>
        <b>权限总览</b>
        <select className="g-select" value={root.id} onChange={(e) => setRoot([root, ...roots].find((r) => r.id === e.target.value)!)}>
          {(roots.includes(root) ? roots : [root, ...roots]).map((r) => <option key={r.id} value={r.id}>{r === ROOT ? '全部文件' : r.name}</option>)}
        </select>
        <label className="small"><input type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} /> 显示文件</label>
        <span className="g-legend"><i className="dir" />直接授权 <i className="inh" />继承 <i className="warn" />无效果</span>
      </div>
      <div className="g-matrix-wrap">
        <table className="g-matrix">
          <thead>
            <tr>
              <th className="g-mx-name">位置</th>
              {cols.map((p) => (
                <th key={keyOf(p)} className={hl === keyOf(p) ? 'hl' : ''} onMouseEnter={() => setHl(keyOf(p))} onMouseLeave={() => setHl(null)}>
                  <PIcon p={p} size={24} />
                  <div className="m-ellipsis">{p.label}</div>
                  <div className="m-faint small">{p.kind === 'user' ? (personOf(p)?.inactive ? '已停用' : '人员') : `${members(p).length} 人`}</div>
                </th>
              ))}
              <th className="g-mx-add" onClick={(e) => e.stopPropagation()}>
                {pick ? <PrincipalPicker autoFocus placeholder="添加一列" onPick={(p) => (setExtra((x) => [...x, p]), setPick(false))} /> : <button className="m-btn sm ghost" onClick={() => setPick(true)}><Plus size={14} /> 添加列</button>}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth }) => (
              <tr key={node.id}>
                <td className="g-mx-name" style={{ paddingLeft: 12 + depth * 18 }}>
                  <a onClick={() => (close(), go(node.type === 'dir' ? node : node.parent!))}><FileIcon n={node} size={15} /> {node.name}</a>
                </td>
                {cols.map((p) => {
                  const g = direct(node, p)
                  const fl = floorOf(p, node)
                  const eff = levelOf(p, node)
                  const off = personOf(p)?.inactive
                  const cls = off ? (g ? 'off' : 'none') : g ? (g.level <= fl.level ? 'warn' : 'dir') : eff ? 'inh' : 'none'
                  const e = explain(p, node)
                  return (
                    <td
                      key={keyOf(p)}
                      className={`g-cell ${cls} ${hl === keyOf(p) ? 'hl' : ''} ${canManage(user, node) ? 'can' : ''}`}
                      title={e.lines.join('\n')}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        if (!canManage(user, node)) return
                        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
                        setCell({ node, p, x: r.left, y: r.bottom + 4 })
                      }}
                    >
                      {off ? (g ? LV[g.level] : '·') : eff ? LV[eff] : '·'}
                      {!off && g && g.level <= fl.level && <s className="g-cell-dead">{LV[g.level]}</s>}
                    </td>
                  )
                })}
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="m-faint small g-scope"><ShieldCheck size={13} /> 实心 = 在这一行直接授予；浅色 = 从上面的行继承下来；悬停看原因，点击修改。</div>
      <AnimatePresence>{cell && <CellPopover key={cell.node.id + keyOf(cell.p)} {...cell} user={user} done={() => setCell(null)} />}</AnimatePresence>
    </div>
  )
}

function CellPopover({ node, p, x, y, user, done }: { node: Node; p: Principal; x: number; y: number; user: User; done: () => void }) {
  const { apply, Confirm } = useApply(node, user)
  const g = direct(node, p)
  const fl = floorOf(p, node)
  return (
    <motion.div className="g-pop" style={{ left: Math.min(x, innerWidth - 300), top: y }} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} onClick={(e) => e.stopPropagation()}>
      <div className="small"><b>{p.label}</b> 在“{node.name}”</div>
      {fl.level > 0 && <div className="m-faint small">已从“{fl.src?.from.name ?? '管理员'}”继承“{LV[fl.level]}”</div>}
      <div className="g-pop-levels">
        {[1, 2, 3, 4].map((l) => (
          <button key={l} disabled={l <= fl.level} className={`m-btn sm ${g?.level === l ? 'primary' : ''}`} onClick={() => (apply(p, l), done())}>{LV[l]}</button>
        ))}
      </div>
      {g && <button className="m-btn sm ghost danger" onClick={() => apply(p, 0)}>撤销这里的直接授权</button>}
      {Confirm}
    </motion.div>
  )
}

// ---------------------------------------------------------------- P4: people-centric page

export function GrantPeople({ n, user, close, go }: GrantProps) {
  useStore()
  const all = useMemo(allPrincipals, [])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Principal>(() => {
    const top = all.filter((p) => levelOf(p, n) > 0).sort((a, b) => levelOf(b, n) - levelOf(a, n))
    return top.find((p) => !same(p, { kind: 'user', id: user.id, label: '' })) ?? all[0]
  })
  const [onlyReach, setOnlyReach] = useState(true)
  const focus = n === ROOT ? null : n
  const list = all.filter((p) => !q || p.label.includes(q) || p.sub.includes(q))

  // the Shared Tree as the *acting* User may see it, annotated with sel's level on each folder
  const rows: { node: Node; depth: number }[] = []
  const walk = (x: Node, depth: number) => {
    for (const c of kids(user, x)) {
      if (c.type !== 'dir' && !(focus && c === focus)) continue
      if (!onlyReach || levelOf(sel, c) > 0 || subtree(c).some((r) => levelOf(sel, r.node) > 0)) rows.push({ node: c, depth })
      walk(c, depth + 1)
    }
  }
  walk(ROOT, 0)

  return (
    <div className="g-page g-people">
      <div className="g-page-head">
        <button className="m-btn ghost" onClick={close}><ArrowLeft size={15} /> 返回文件</button>
        <b>按人查看权限</b>
        {focus && <span className="m-faint small">从“{focus.name}”进入：左侧按在这里的权限排序</span>}
      </div>
      <div className="g-people-grid">
        <div className="g-plist">
          <label className="g-picker-input"><Search size={15} /><input value={q} placeholder="搜索人员、组织、用户组" onChange={(e) => setQ(e.target.value)} /></label>
          {(['user', 'org', 'group'] as const).map((k) => (
            <div key={k}>
              <div className="g-picker-group">{kindLabel[k]}</div>
              {list
                .filter((p) => p.kind === k)
                .sort((a, b) => (focus ? levelOf(b, focus) - levelOf(a, focus) : 0))
                .map((p) => (
                  <button key={keyOf(p)} className={`g-picker-item ${same(p, sel) ? 'on' : ''} ${p.inactive ? 'off' : ''}`} onClick={() => setSel(p)}>
                    <PIcon p={p} size={24} />
                    <span className="grow m-ellipsis">{p.label}</span>
                    {focus && levelOf(p, focus) > 0 && <span className="g-lv">{LV[levelOf(p, focus)]}</span>}
                  </button>
                ))}
            </div>
          ))}
        </div>
        <div className="g-pdetail">
          <div className="g-adding">
            <PIcon p={sel} size={40} />
            <div className="grow">
              <b style={{ fontSize: 16 }}>{sel.label}</b>
              <div className="m-faint small">{all.find((p) => same(p, sel))?.sub}</div>
              {personOf(sel)?.inactive && <div className="g-warn"><TriangleAlert size={14} /> 账号已停用：下面的授权都保留，但现在不生效。</div>}
              {sel.kind !== 'user' && <div className="m-faint small">成员：{members(sel).map((u) => u.name).join('、') || '—'}</div>}
            </div>
            <label className="small"><input type="checkbox" checked={onlyReach} onChange={(e) => setOnlyReach(e.target.checked)} /> 只看能访问的</label>
          </div>
          <div className="g-ptree">
            {rows.map(({ node, depth }) => (
              <PeopleRow key={node.id} node={node} depth={depth} p={sel} user={user} focus={node === focus} go={(x) => (close(), go(x))} />
            ))}
            {!rows.length && <div className="m-empty">{sel.label} 在你能看到的范围内没有任何权限。</div>}
          </div>
          <div className="m-faint small g-scope"><ShieldCheck size={13} /> 只显示你自己能看到的位置；你没有管理权限的位置只能查看，不能修改。</div>
        </div>
      </div>
    </div>
  )
}

function PeopleRow({ node, depth, p, user, focus, go }: { node: Node; depth: number; p: Principal; user: User; focus: boolean; go: (n: Node) => void }) {
  useStore()
  const { apply, Confirm } = useApply(node, user)
  const eff = levelOf(p, node)
  const g = direct(node, p)
  const fl = floorOf(p, node)
  const s = sources(p, node)[0]
  const parentEff = node.parent ? levelOf(p, node.parent) : 0
  const can = canManage(user, node)
  const changed = eff !== parentEff || !!g
  return (
    <>
      <div className={`g-prow ${focus ? 'focus' : ''} ${changed ? '' : 'quiet'} ${g ? 'has' : ''}`} style={{ paddingLeft: 10 + depth * 18 }}>
        <a className="grow g-prow-name" onClick={() => go(node)}><FileIcon n={node} size={16} /> {node.name}</a>
        <span className="g-prow-src m-faint small">
          {personOf(p)?.admin ? '管理员' : !s ? '' : s.from === node ? (g && g.level <= fl.level ? `此处授权无效果（已继承${LV[fl.level]}）` : `在此授予 · ${s.why}`) : changed ? `继承自“${s.from.name}” · ${s.why}` : '同上'}
        </span>
        <span className={`g-lv l${eff}`}>{eff ? LV[eff] : '—'}</span>
        {can && !personOf(p)?.admin ? (
          <LevelSelect value={g?.level ?? 0} floor={fl.level} none={g ? '撤销直接授权' : '— 不直接授权'} onChange={(l) => apply(p, l)} />
        ) : (
          <span className="g-select ghost">{can ? '' : <Lock size={12} />}</span>
        )}
      </div>
      {Confirm}
    </>
  )
}
