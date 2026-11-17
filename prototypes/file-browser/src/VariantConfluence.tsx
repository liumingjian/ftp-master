// PROTOTYPE round 5: Grant UIs borrowed from Confluence, tested at ~200 people. All sit on F (M2 calm).
//
//   C1 space     空间权限   Confluence "Space permissions": each top-level folder is a space; a principals × levels
//                          checkbox table with tabs (组织与用户组 / 个人 / 子文件夹例外), search, paging, bulk edit,
//                          and edit-then-"保存全部" instead of instant changes.
//   C2 restrict  页面限制   Confluence "Restrictions" dialog: three modes (沿用上级 / 追加 / 仅限指定的人) with an
//                          impact preview ("保存后 N 人失去访问"). Mode 3 stops inheritance, which the current
//                          model forbids (Grants only allow); it is here to see whether that is worth changing.
//   C3 inspect   权限检查   Confluence "Inspect permissions": pick a person + a location, see a capability checklist and
//                          the identity chain × folder chain that produced it; reverse tab "谁能访问这里" grouped by source.
//   C4 groups    用户组优先 Confluence's advice "grant to groups, not people": inspector shows group cards with reach,
//                          folds individual Grants away, nudges toward groups, merges stray individuals into a group.
import { ArrowLeft, Building2, Check, ChevronRight, Download, Lock, LockOpen, Plus, Search, ShieldCheck, TriangleAlert, UserRoundPlus, Users, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Grant, Node, PEOPLE, ROOT, User } from './data'
import { LEVEL_HINT, LV, Principal, allPrincipals, canManage, direct, explain, grantsBelow, keyOf, levelOf, members, orgChain, orgName, personOf, principalOfGrant, same, sources, where } from './grants'
import { allVisible, entryPoints, kids, level, pathOf, scopePath } from './perm'
import { makeGroup, replaceGrants, setGrant, useStore } from './store'
import { Avatar, FileIcon, toast } from './ui'
import { GrantProps, LevelSelect, PIcon, PrincipalPicker, isUnder, reachNote, useApply } from './VariantGrant'

const active = () => PEOPLE.filter((u) => !u.inactive)

function Stack({ people, max = 5 }: { people: User[]; max?: number }) {
  return (
    <span className="c-stack">
      {people.slice(0, max).map((u) => <Avatar key={u.id} name={u.name} size={20} />)}
      {people.length > max && <span className="c-stack-more">+{people.length - max}</span>}
    </span>
  )
}

// =================================================================== C1: space permissions

type Row = { p: Principal; level: number; orig: number }

export function SpacePermissions({ n, user, close, go }: GrantProps) {
  useStore()
  const spaces = user.admin ? kids(user, ROOT).filter((x) => x.type === 'dir') : entryPoints(user).filter((e) => level(user, e) >= 4)
  const [space, setSpace] = useState<Node | undefined>(() => spaces.find((s) => s === n || isUnder(n, s)) ?? spaces[0])
  const [tab, setTab] = useState<'shared' | 'people' | 'below'>('shared')
  const [draft, setDraft] = useState<Map<string, Row>>(new Map())
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState<{ p: Principal; level: number } | null>(null)
  const [lockWarn, setLockWarn] = useState(false)
  if (!space) return <div className="m-empty">你没有可以管理的空间。</div>

  const base: Row[] = space.grants.map((g) => ({ p: principalOfGrant(g), level: g.level, orig: g.level }))
  const rows = [...base.map((r) => draft.get(keyOf(r.p)) ?? r), ...[...draft.values()].filter((d) => !base.some((b) => same(b.p, d.p)))]
  const isShared = (r: Row) => r.p.kind !== 'user'
  const inTab = rows.filter((r) => (tab === 'shared' ? isShared(r) : !isShared(r)))
  const shown = inTab.filter((r) => !q || r.p.label.includes(q) || reachNote(r.p).includes(q))
  const PER = 10
  const pageRows = shown.slice(page * PER, page * PER + PER)
  const below = grantsBelow(space)
  const belowBy = [...new Set(below.map((b) => b.node))].map((node) => ({ node, list: below.filter((b) => b.node === node).map((b) => b.grant) }))
  const dirty = [...draft.values()].filter((d) => d.level !== d.orig)

  const set = (r: Row, l: number) => setDraft((m) => new Map(m).set(keyOf(r.p), { ...r, level: l }))
  const bulk = (l: number) => (rows.filter((r) => picked.has(keyOf(r.p))).forEach((r) => set(r, l)), setPicked(new Set()))
  const switchSpace = (s: Node) => (setSpace(s), setDraft(new Map()), setPage(0), setPicked(new Set()))

  const save = (force = false) => {
    const undos = dirty.map((d) => setGrant(space, { kind: d.p.kind, id: d.p.id, label: d.p.label, level: d.level }))
    if (!force && !user.admin && level(user, space) < 4) {
      undos.reverse().forEach((u) => u())
      return setLockWarn(true)
    }
    setLockWarn(false)
    setDraft(new Map())
    toast(`已保存“${space.name}”的 ${dirty.length} 项权限变更`, { label: '撤销', run: () => undos.reverse().forEach((u) => u()) })
  }

  return (
    <div className="g-page c-space">
      <div className="g-page-head">
        <button className="m-btn ghost" onClick={close}><ArrowLeft size={15} /> 返回文件</button>
        <b>空间权限</b>
        <div className="c-pills">
          {spaces.map((s) => (
            <button key={s.id} className={`c-pill ${s === space ? 'on' : ''}`} onClick={() => (dirty.length && !confirm('有未保存的更改，确定切换？') ? null : switchSpace(s))}>
              <FileIcon n={s} size={14} /> {s.name}
            </button>
          ))}
        </div>
      </div>
      <div className="m-faint small c-sub">顶层文件夹就是“空间”。这里设置的权限覆盖整个空间；空间内个别文件夹的额外授权见“子文件夹例外”。</div>

      <div className="c-tabs">
        {([['shared', '组织与用户组', rows.filter(isShared).length], ['people', '个人', rows.filter((r) => !isShared(r)).length], ['below', '子文件夹例外', below.length]] as const).map(([k, label, c]) => (
          <a key={k} className={tab === k ? 'on' : ''} onClick={() => (setTab(k), setPage(0), setPicked(new Set()))}>{label} <span className="m-count">{c}</span></a>
        ))}
      </div>

      {tab !== 'below' ? (
        <div className="c-card">
          <div className="c-toolbar">
            <label className="g-picker-input c-filter"><Search size={14} /><input value={q} placeholder={`在 ${inTab.length} 条中筛选`} onChange={(e) => (setQ(e.target.value), setPage(0))} /></label>
            <div className="grow" />
            {adding ? (
              <div className="c-addrow">
                <PIcon p={adding.p} size={24} /> <b>{adding.p.label}</b> <span className="m-faint small">{reachNote(adding.p)}</span>
                <LevelSelect value={adding.level} none="取消" onChange={(l) => (l ? setAdding({ ...adding, level: l }) : setAdding(null))} />
                <button className="m-btn sm primary" onClick={() => (setDraft((m) => new Map(m).set(keyOf(adding.p), { p: adding.p, level: adding.level, orig: direct(space, adding.p)?.level ?? 0 })), setTab(adding.p.kind === 'user' ? 'people' : 'shared'), setAdding(null))}>加入列表</button>
              </div>
            ) : (
              <div style={{ width: 300 }}><PrincipalPicker placeholder={tab === 'shared' ? '添加组织或用户组' : '添加个人'} onPick={(p) => setAdding({ p, level: 1 })} /></div>
            )}
          </div>
          {picked.size > 0 && (
            <div className="c-bulk">
              已选 {picked.size} 条：设为
              {[1, 2, 3, 4].map((l) => <button key={l} className="m-btn sm" onClick={() => bulk(l)}>{LV[l]}</button>)}
              <button className="m-btn sm danger" onClick={() => bulk(0)}>移除</button>
              <a className="small" onClick={() => setPicked(new Set())}>取消选择</a>
            </div>
          )}
          <table className="c-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}><input type="checkbox" checked={pageRows.length > 0 && pageRows.every((r) => picked.has(keyOf(r.p)))} onChange={(e) => setPicked(e.target.checked ? new Set(pageRows.map((r) => keyOf(r.p))) : new Set())} /></th>
                <th className="c-left">{tab === 'shared' ? '组织 / 用户组' : '人员'}</th>
                <th className="c-left">{tab === 'shared' ? '覆盖' : '所在组织'}</th>
                {[1, 2, 3, 4].map((l) => <th key={l} title={LEVEL_HINT[l]}>{LV[l]}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => {
                const k = keyOf(r.p)
                const changed = r.level !== r.orig
                const off = personOf(r.p)?.inactive
                return (
                  <tr key={k} className={`${changed ? 'changed' : ''} ${r.level === 0 ? 'removed' : ''} ${off ? 'off' : ''}`}>
                    <td><input type="checkbox" checked={picked.has(k)} onChange={(e) => setPicked((s) => { const t = new Set(s); e.target.checked ? t.add(k) : t.delete(k); return t })} /></td>
                    <td className="c-left"><span className="c-who"><PIcon p={r.p} size={24} /> {r.p.label} {off && <span className="m-tag warn">已停用</span>} {changed && <span className="m-tag">{r.orig ? (r.level ? `${LV[r.orig]} → ${LV[r.level]}` : '将移除') : '新增'}</span>}</span></td>
                    <td className="c-left">{r.p.kind === 'user' ? <span className="m-faint small">{reachNote(r.p)}</span> : <span className="c-who"><Stack people={members(r.p)} /> <span className="m-faint small">{members(r.p).length} 人</span></span>}</td>
                    {[1, 2, 3, 4].map((l) => (
                      <td key={l}>
                        <span className={`c-box ${r.level >= l ? 'on' : ''} ${r.level === l ? 'top' : ''}`} onClick={() => set(r, r.level >= l && r.level === l ? l - 1 : l)}>
                          {r.level >= l && <Check size={12} strokeWidth={3} />}
                        </span>
                      </td>
                    ))}
                    <td><button className="m-btn icon sm ghost" title="移除" onClick={() => set(r, 0)}><X size={14} /></button></td>
                  </tr>
                )
              })}
              {!pageRows.length && <tr><td colSpan={8} className="m-faint" style={{ padding: 24 }}>{q ? '没有匹配的条目' : tab === 'shared' ? '还没有授予任何组织或用户组' : '还没有个人授权。Confluence 的建议是尽量授予组，而不是个人。'}</td></tr>}
            </tbody>
          </table>
          {shown.length > PER && (
            <div className="c-pager">
              <span className="m-faint small">第 {page * PER + 1}–{Math.min(shown.length, page * PER + PER)} 条，共 {shown.length} 条</span>
              <button className="m-btn sm" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button>
              <button className="m-btn sm" disabled={(page + 1) * PER >= shown.length} onClick={() => setPage(page + 1)}>下一页</button>
            </div>
          )}
        </div>
      ) : (
        <div className="c-card">
          {belowBy.map(({ node, list }) => {
            const users = list.filter((g) => g.kind === 'user')
            return (
              <div key={node.id} className="c-below">
                <FileIcon n={node} size={18} />
                <div className="grow">
                  <a onClick={() => (close(), go(node.type === 'dir' ? node : node.parent!))}>{where(node).slice(where(space).length + 1)}</a>
                  {node.isolated && <span className="m-tag warn"><Lock size={10} /> 仅限指定的人</span>}
                  <div className="m-faint small">
                    {list.filter((g) => g.kind !== 'user').map((g) => `${g.label}·${LV[g.level]}`).join('，') || '无组授权'}
                    {users.length > 0 && `；个人 ${users.length} 条`}
                  </div>
                </div>
                {users.length >= 10 && <span className="g-warn" style={{ margin: 0 }}><TriangleAlert size={13} /> 个人授权过多，建议改为用户组</span>}
              </div>
            )
          })}
          {!belowBy.length && <div className="m-faint" style={{ padding: 24 }}>空间内没有额外授权，权限完全由上面的设置决定。</div>}
        </div>
      )}

      {lockWarn && (
        <div className="g-warn danger">
          <TriangleAlert size={15} /> <span className="grow">保存后你将失去“{space.name}”的管理权限。</span>
          <button className="m-btn sm" onClick={() => setLockWarn(false)}>返回修改</button>
          <button className="m-btn sm danger" onClick={() => save(true)}>仍然保存</button>
        </div>
      )}
      {dirty.length > 0 && (
        <div className="c-savebar">
          <span>有 <b>{dirty.length}</b> 项未保存的更改</span>
          <span className="m-faint small">{dirty.slice(0, 3).map((d) => `${d.p.label} ${d.orig ? LV[d.orig] : '无'}→${d.level ? LV[d.level] : '移除'}`).join('；')}{dirty.length > 3 ? '…' : ''}</span>
          <div className="grow" />
          <button className="m-btn sm ghost" onClick={() => (setDraft(new Map()), setLockWarn(false))}>放弃</button>
          <button className="m-btn sm primary" onClick={() => save()}>保存全部</button>
        </div>
      )}
    </div>
  )
}

// =================================================================== C2: restrictions dialog

type Mode = 0 | 1 | 2
const MODES: { icon: React.ReactNode; title: string; desc: string }[] = [
  { icon: <LockOpen size={18} />, title: '沿用上级权限', desc: '能访问上级文件夹的人都能访问这里，这里不单独授权' },
  { icon: <UserRoundPlus size={18} />, title: '在上级基础上追加', desc: '上级的人照常访问，再额外给某些人或组更高权限' },
  { icon: <Lock size={18} />, title: '仅限指定的人', desc: '断开继承：只有下面列出的人能访问，上级的授权在这里不生效' },
]

/** Who can access n under hypothetical direct Grants / isolation. Temporarily mutates n, then restores it. */
function simulate(n: Node, grants: Grant[], isolated: boolean) {
  const keep = { g: n.grants, i: n.isolated }
  n.grants = grants
  n.isolated = isolated || undefined
  const out = new Map(active().map((u) => [u.id, level(u, n)]))
  n.grants = keep.g
  n.isolated = keep.i
  return out
}

export function RestrictDialog({ n, user, close, go }: GrantProps) {
  useStore()
  const can = canManage(user, n)
  const [mode, setMode] = useState<Mode>(n.isolated ? 2 : n.grants.length ? 1 : 0)
  const [list, setList] = useState<Grant[]>(() => n.grants.map((g) => ({ ...g })))
  const [adding, setAdding] = useState<{ p: Principal; level: number } | null>(null)
  const [showWho, setShowWho] = useState(false)
  const draft = mode === 0 ? [] : list
  const before = useMemo(() => new Map(active().map((u) => [u.id, level(u, n)])), [n, n.grants, n.isolated])
  const after = simulate(n, draft, mode === 2)
  const lose = active().filter((u) => before.get(u.id)! > 0 && !after.get(u.id))
  const gain = active().filter((u) => !before.get(u.id) && after.get(u.id)! > 0)
  const reach = active().filter((u) => after.get(u.id)! > 0)
  const iLose = !user.admin && after.get(user.id)! < 4
  const cut = pathOf(n).slice(0, -1).reverse().find((a) => a.isolated)
  const floor = (p: Principal) => (mode === 1 && n.parent ? levelOf(p, n.parent) : 0)
  const changed = mode !== (n.isolated ? 2 : n.grants.length ? 1 : 0) || JSON.stringify(draft) !== JSON.stringify(n.grants)

  const apply = () => {
    const undo = replaceGrants(n, draft, mode === 2)
    toast(`已更新“${n.name}”的权限${lose.length ? `，${lose.length} 人失去访问` : ''}`, { label: '撤销', run: undo })
    close()
  }

  return (
    <div className="g-overlay" onMouseDown={close}>
      <div className="g-dialog c-restrict" onMouseDown={(e) => e.stopPropagation()}>
        <div className="g-dialog-head">
          <FileIcon n={n} size={28} />
          <div className="grow"><b>“{n.name}”的访问限制</b><div className="m-faint small">{where(n)}</div></div>
          <button className="m-btn icon ghost" onClick={close}><X size={16} /></button>
        </div>

        {cut && (
          <div className="g-warn"><Lock size={14} /> <span>上级“<a onClick={() => (close(), go(cut))}>{cut.name}</a>”已限制为仅指定的人，这里的访问不会超出那个范围。</span></div>
        )}

        <div className="c-modes">
          {MODES.map((m, i) => (
            <button key={i} disabled={!can} className={`c-mode ${mode === i ? 'on' : ''}`} onClick={() => setMode(i as Mode)}>
              <span className="c-mode-ico">{m.icon}</span>
              <span className="grow">
                <b>{m.title}</b> {i === 2 && <span className="m-tag warn">需改模型</span>}
                <div className="m-faint small">{m.desc}</div>
              </span>
              <span className={`c-radio ${mode === i ? 'on' : ''}`} />
            </button>
          ))}
        </div>

        {mode === 2 && (
          <div className="g-warn">
            <TriangleAlert size={15} />
            <span>这是 Confluence 的“限制”，等于对上级授权说“不”。现有约定是授权只增不减、没有拒绝（术语表 Grant；spec 不包含“拒绝授权”）。选这个方向需要先改模型和 ADR。</span>
          </div>
        )}

        {mode !== 0 && (
          <>
            <div className="m-section-title">{mode === 2 ? '只有这些人可以访问' : '额外授权'} · {list.length}</div>
            {can && (adding ? (
              <div className="g-adding">
                <PIcon p={adding.p} size={28} />
                <div className="grow"><b>{adding.p.label}</b><div className="m-faint small">{reachNote(adding.p)}</div></div>
                <LevelSelect value={adding.level} floor={floor(adding.p)} none="取消" onChange={(l) => (l ? setAdding({ ...adding, level: l }) : setAdding(null))} />
                <button className="m-btn sm primary" onClick={() => (setList((xs) => [...xs.filter((g) => !same(principalOfGrant(g), adding.p)), { ...adding.p, level: adding.level }]), setAdding(null))}>添加</button>
              </div>
            ) : (
              <PrincipalPicker placeholder="添加人员、组织或用户组" onPick={(p) => setAdding({ p, level: mode === 2 ? 2 : Math.min(4, floor(p) + 1) })} />
            ))}
            <div className="c-list">
              {list.map((g) => {
                const p = principalOfGrant(g)
                const fl = floor(p)
                return (
                  <div key={keyOf(p)} className="g-row">
                    <PIcon p={p} size={24} />
                    <div className="grow">{g.label} {g.level <= fl && <span className="m-tag warn">无效果</span>}<div className="m-faint small">{g.level <= fl ? `上级已给“${LV[fl]}”` : reachNote(p)}</div></div>
                    <LevelSelect value={g.level} floor={fl} disabled={!can} onChange={(l) => setList((xs) => (l ? xs.map((x) => (x === g ? { ...x, level: l } : x)) : xs.filter((x) => x !== g)))} />
                  </div>
                )
              })}
              {!list.length && <div className="m-faint small g-empty">{mode === 2 ? '列表为空：除管理员外没人能访问。' : '还没有额外授权。'}</div>}
            </div>
          </>
        )}

        <div className="c-impact">
          <div>
            保存后 <b>{reach.length}</b> 人可以访问
            {lose.length > 0 && <span className="c-lose">，{lose.length} 人失去访问</span>}
            {gain.length > 0 && <span className="c-gain">，新增 {gain.length} 人</span>}
            <a className="small" style={{ marginLeft: 8 }} onClick={() => setShowWho(!showWho)}>{showWho ? '收起' : '查看名单'}</a>
          </div>
          {lose.length > 0 && <div className="c-names"><span className="m-faint small">失去：</span>{lose.slice(0, 14).map((u) => <span key={u.id} className="c-chip lose">{u.name}</span>)}{lose.length > 14 && <span className="m-faint small">等 {lose.length} 人</span>}</div>}
          {showWho && [4, 3, 2, 1].map((l) => {
            const who = reach.filter((u) => after.get(u.id) === l)
            return who.length ? (
              <div key={l} className="c-names"><span className="g-lv">{LV[l]} {who.length}</span>{who.slice(0, 40).map((u) => <span key={u.id} className="c-chip">{u.name}</span>)}{who.length > 40 && <span className="m-faint small">…</span>}</div>
            ) : null
          })}
          {iLose && changed && <div className="g-warn danger"><TriangleAlert size={14} /> 你自己也将失去对这里的管理权限。</div>}
        </div>

        <div className="c-foot">
          {!can && <span className="m-faint small"><Lock size={12} /> 你在这里只有“{LV[level(user, n)]}”，只能查看</span>}
          <div className="grow" />
          <button className="m-btn" onClick={close}>取消</button>
          <button className="m-btn primary" disabled={!can || !changed} onClick={apply}>应用</button>
        </div>
      </div>
    </div>
  )
}

// =================================================================== C3: inspect permissions

const CAPS: [string, number][] = [['查看、预览', 1], ['下载', 2], ['上传、新建文件夹', 3], ['重命名、编辑、恢复版本', 3], ['删除', 4], ['授权给他人', 4]]

export function InspectPermissions({ n, user, close, go }: GrantProps) {
  useStore()
  const scope = allVisible(user).filter((x) => canManage(user, x))
  const [at, setAt] = useState<Node | undefined>(() => (canManage(user, n) ? n : scope.find((x) => x.type === 'dir')))
  const [who, setWho] = useState<Principal>(() => {
    const u = PEOPLE.find((x) => x.id === 'sunqi')!
    return { kind: 'user', id: u.id, label: u.name }
  })
  const [tab, setTab] = useState<'one' | 'all'>('one')
  const [locQ, setLocQ] = useState('')
  const [nameQ, setNameQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  if (!at) return <div className="m-empty">你没有可以检查的位置（需要“管理”权限）。</div>

  const e = explain(who, at)
  const u = personOf(who)
  const chainNodes = scopePath(at)
  const cutAt = chainNodes[0] !== ROOT ? chainNodes[0] : null
  const locHits = locQ ? scope.filter((x) => x.name.includes(locQ)).slice(0, 8) : []

  // reverse view: every active person, grouped by the Grant that gives them their level
  const people = active().map((p) => {
    const s = p.admin ? undefined : sources({ kind: 'user', id: p.id, label: p.name }, at)[0]
    return { u: p, l: level(p, at), s }
  }).filter((x) => x.l > 0)
  const bySource = new Map<string, { label: string; l: number; list: User[] }>()
  for (const x of people) {
    const key = x.s ? `${keyOf(x.s.grant)}@${x.s.from.id}` : 'admin'
    const label = x.s ? `${x.s.grant.label}（${{ user: '个人', org: '组织', group: '用户组' }[x.s.grant.kind]}，在“${x.s.from === ROOT ? '/' : x.s.from.name}”授予）` : '管理员身份'
    const b = bySource.get(key) ?? { label, l: x.l, list: [] }
    b.list.push(x.u)
    bySource.set(key, b)
  }
  const groups = [...bySource.entries()].sort((a, b) => b[1].l - a[1].l || b[1].list.length - a[1].list.length)

  return (
    <div className="g-page c-inspect">
      <div className="g-page-head">
        <button className="m-btn ghost" onClick={close}><ArrowLeft size={15} /> 返回文件</button>
        <b>权限检查</b>
        <span className="m-faint small">只能检查你有“管理”权限的位置 · 全公司 {active().length} 名在职人员</span>
      </div>

      <div className="c-inspect-q">
        <div className="c-q">
          <div className="m-faint small">位置</div>
          <div className="g-picker">
            <label className="g-picker-input"><FileIcon n={at} size={16} /><input value={locQ} placeholder={where(at)} onChange={(ev) => setLocQ(ev.target.value)} /></label>
            {locHits.length > 0 && (
              <div className="g-picker-list">
                {locHits.map((x) => <button key={x.id} className="g-picker-item" onClick={() => (setAt(x), setLocQ(''))}><FileIcon n={x} size={18} /><span className="grow">{x.name}<div className="m-faint small">{where(x)}</div></span></button>)}
              </div>
            )}
          </div>
        </div>
        <div className="c-tabs inline">
          <a className={tab === 'one' ? 'on' : ''} onClick={() => setTab('one')}>检查某个人</a>
          <a className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>谁能访问这里 <span className="m-count">{people.length}</span></a>
        </div>
      </div>

      {tab === 'one' ? (
        <div className="c-inspect-grid">
          <div className="c-card pad">
            <div className="m-faint small">人员 / 组织 / 用户组</div>
            <div className="c-who-pick">
              <PIcon p={who} size={34} />
              <div className="grow"><b>{who.label}</b><div className="m-faint small">{allPrincipals().find((p) => same(p, who))?.sub}</div></div>
            </div>
            <PrincipalPicker placeholder="换一个：输入姓名或部门" onPick={setWho} />
            <div className={`c-verdict l${e.level}`}>
              {e.level ? <>可以<b>{LV[e.level]}</b></> : <>不能访问</>}
            </div>
            <div className="c-caps">
              {CAPS.map(([label, need]) => (
                <div key={label} className={e.level >= need ? 'ok' : 'no'}>
                  {e.level >= need ? <Check size={14} /> : <X size={14} />} {label}
                  {e.level < need && <span className="m-faint small">需要“{LV[need]}”</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="c-card pad">
            <div className="m-section-title" style={{ marginTop: 0 }}>为什么</div>
            {e.lines.map((l, i) => <div key={i} className={`g-explain-line ${i === 0 && e.best ? 'best' : ''}`}><ChevronRight size={13} /> {l}</div>)}

            {u && !u.admin && !u.inactive && (
              <>
                <div className="m-section-title">TA 的身份</div>
                <div className="c-chain">
                  <span className="c-node"><Avatar name={u.name} size={18} /> {u.name}</span>
                  {orgChain(u.orgs.at(-1)!).reverse().map((o) => <span key={o} className="c-node org"><Building2 size={13} /> {orgName(o)}</span>)}
                  {u.groups.map((g) => <span key={g} className="c-node group"><Users size={13} /> {allPrincipals().find((p) => p.kind === 'group' && p.id === g)?.label}</span>)}
                </div>
              </>
            )}

            <div className="m-section-title">目录链上的授权</div>
            {cutAt && <div className="g-warn"><Lock size={13} /> 在“{cutAt.name}”处断开了继承，更上层的授权不生效</div>}
            <div className="c-path">
              {chainNodes.map((x) => {
                const hit = x.grants.filter((g) => sources(who, at).some((s) => s.grant === g))
                const other = x.grants.length - hit.length
                return (
                  <div key={x.id} className="c-path-node">
                    <span className="c-path-name">{x === ROOT ? '全部文件' : <><FileIcon n={x} size={14} /> {x.name}</>}</span>
                    <span className="grow">
                      {hit.map((g) => <span key={keyOf(g)} className={`c-hit ${e.best?.grant === g ? 'best' : ''}`}><PIcon p={principalOfGrant(g)} size={16} /> {g.label} · {LV[g.level]}{e.best?.grant === g && ' ← 生效'}</span>)}
                      {other > 0 && <span className="m-faint small">另有 {other} 条授权与 TA 无关</span>}
                      {!x.grants.length && <span className="m-faint small">—</span>}
                    </span>
                    {canManage(user, x) && x !== ROOT && <a className="small" onClick={() => (close(), go(x.type === 'dir' ? x : x.parent!))}>去修改</a>}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="c-card pad">
          <div className="c-levels">
            {[4, 3, 2, 1].map((l) => {
              const c = people.filter((x) => x.l === l).length
              return <div key={l} className="c-level"><span className={`g-lv l${l}`}>{LV[l]}</span><b>{c}</b><i style={{ width: `${(c / active().length) * 100}%` }} /></div>
            })}
          </div>
          <div className="c-toolbar">
            <label className="g-picker-input c-filter"><Search size={14} /><input value={nameQ} placeholder="在名单里找人" onChange={(ev) => setNameQ(ev.target.value)} /></label>
            <div className="grow" />
            <button className="m-btn sm" onClick={() => toast('PROTOTYPE：导出 CSV（未实现）')}><Download size={14} /> 导出名单</button>
          </div>
          {groups.map(([k, g]) => {
            const list = g.list.filter((x) => !nameQ || x.name.includes(nameQ) || x.orgLabel.includes(nameQ))
            if (!list.length) return null
            const isOpen = open === k || !!nameQ
            return (
              <div key={k} className="c-src">
                <a className="c-src-head" onClick={() => setOpen(isOpen && !nameQ ? null : k)}>
                  <ChevronRight size={14} style={{ transform: isOpen ? 'rotate(90deg)' : '' }} />
                  <span className={`g-lv l${g.l}`}>{LV[g.l]}</span>
                  <span className="grow">通过 {g.label}</span>
                  <b>{list.length} 人</b>
                </a>
                {isOpen && <div className="c-names">{list.slice(0, 80).map((x) => <span key={x.id} className="c-chip" title={x.orgLabel} onClick={() => (setWho({ kind: 'user', id: x.id, label: x.name }), setTab('one'))}>{x.name}</span>)}{list.length > 80 && <span className="m-faint small">还有 {list.length - 80} 人，请筛选</span>}</div>}
              </div>
            )
          })}
          <div className="m-faint small g-scope"><ShieldCheck size={13} /> 每人只按“生效的那条授权”归类；已停用账号不计入。点名字可查看 TA 的完整原因。</div>
        </div>
      )}
    </div>
  )
}

// =================================================================== C4: groups first (inspector)

export function GroupFirstPanel({ n, user, go }: GrantProps) {
  useStore()
  const can = canManage(user, n)
  const { apply, Confirm } = useApply(n, user)
  const [showPeople, setShowPeople] = useState(false)
  const [nudge, setNudge] = useState<{ p: Principal; level: number } | null>(null)
  const [merge, setMerge] = useState<string | null>(null)
  const all = scopePath(n).flatMap((from) => from.grants.map((grant) => ({ grant, from })))
  const shared = all.filter((x) => x.grant.kind !== 'user').sort((a, b) => b.grant.level - a.grant.level)
  const indiv = all.filter((x) => x.grant.kind === 'user')
  const directIndiv = n.grants.filter((g) => g.kind === 'user')
  const reach = active().filter((u) => level(u, n) > 0).length

  const doMerge = (name: string) => {
    const lv = Math.max(...directIndiv.map((g) => g.level))
    const ppl = directIndiv.map((g) => PEOPLE.find((u) => u.id === g.id)!).filter(Boolean)
    const before = n.grants
    const id = makeGroup(name, ppl)
    const undo = replaceGrants(n, [...n.grants.filter((g) => g.kind !== 'user'), { kind: 'group', id, label: name, level: lv }], !!n.isolated)
    setMerge(null)
    toast(`已创建用户组“${name}”（${ppl.length} 人）并替换 ${directIndiv.length} 条个人授权`, { label: '撤销', run: () => (undo(), void before) })
  }

  const suggestions = (p: Principal): Principal[] => {
    const u = personOf(p)
    if (!u) return []
    return [
      { kind: 'org' as const, id: u.orgs.at(-1)!, label: orgName(u.orgs.at(-1)!) },
      ...u.groups.map((g) => allPrincipals().find((x) => x.kind === 'group' && x.id === g)!).filter(Boolean),
    ]
  }

  return (
    <div className="g-insp c-groups">
      <div className="c-reach"><b>{reach}</b> 人可以访问 <span className="m-faint small">· 来自 {shared.length} 个组织/用户组{indiv.length ? ` 和 ${indiv.length} 条个人授权` : ''}</span></div>
      {Confirm}
      {shared.map(({ grant, from }) => {
        const p = principalOfGrant(grant)
        const ms = members(p)
        return (
          <div key={keyOf(grant) + from.id} className="c-gcard">
            <div className="c-gcard-top">
              <PIcon p={p} size={28} />
              <div className="grow"><b>{grant.label}</b><div className="m-faint small">{from === n ? '在此授予' : `继承自“${from === ROOT ? '/' : from.name}”`}</div></div>
              {from === n && can ? <LevelSelect value={grant.level} onChange={(l) => apply(p, l)} /> : <span className="g-lv">{LV[grant.level]}</span>}
            </div>
            <div className="c-gcard-foot"><Stack people={ms} max={8} /><span className="m-faint small">{ms.length} 人</span></div>
          </div>
        )
      })}

      {indiv.length > 0 && (
        <div className="c-indiv">
          <a className="c-src-head" onClick={() => setShowPeople(!showPeople)}>
            <ChevronRight size={14} style={{ transform: showPeople ? 'rotate(90deg)' : '' }} /> <span className="grow">个人授权 · {indiv.length} 条</span>
            <Stack people={indiv.map((x) => PEOPLE.find((u) => u.id === x.grant.id)!).filter(Boolean)} max={4} />
          </a>
          {indiv.length >= 5 && (
            <div className="g-warn"><TriangleAlert size={14} /> <span className="grow">个人授权一多，人员调岗、离职时就容易漏改。Confluence 建议改用用户组。</span></div>
          )}
          {can && directIndiv.length >= 2 && (merge === null ? (
            <button className="m-btn sm" onClick={() => setMerge(`${n.name}-访问者`)}><Users size={14} /> 把这里的 {directIndiv.length} 人合并为一个用户组…</button>
          ) : (
            <div className="c-merge">
              <input className="g-select" value={merge} onChange={(e) => setMerge(e.target.value)} />
              <button className="m-btn sm primary" onClick={() => doMerge(merge)}>创建并替换</button>
              <button className="m-btn sm ghost" onClick={() => setMerge(null)}>取消</button>
            </div>
          ))}
          {showPeople && indiv.map(({ grant, from }) => (
            <div key={grant.id + from.id} className="g-row inh">
              <Avatar name={grant.label} size={20} />
              <span className="grow">{grant.label} <span className="m-faint small">{from === n ? '' : `继承自“${from.name}”`}</span></span>
              {from === n && can ? <LevelSelect value={grant.level} onChange={(l) => apply(principalOfGrant(grant), l)} /> : <span className="g-lv">{LV[grant.level]}</span>}
            </div>
          ))}
        </div>
      )}

      {can && (nudge ? (
        <div className="c-nudge">
          <div><b>只给 {nudge.p.label} 一个人吗？</b></div>
          <div className="m-faint small">以后 TA 调岗或离职，这条授权需要有人记得去改。也可以授予 TA 所在的组：</div>
          {suggestions(nudge.p).map((s) => (
            <button key={keyOf(s)} className="g-picker-item" onClick={() => (apply(s, nudge.level), setNudge(null))}>
              <PIcon p={s} size={22} /> <span className="grow">{s.label} <span className="m-faint small">{members(s).length} 人</span></span> <Plus size={14} />
            </button>
          ))}
          <div className="c-merge">
            <LevelSelect value={nudge.level} none="取消" onChange={(l) => (l ? setNudge({ ...nudge, level: l }) : setNudge(null))} />
            <button className="m-btn sm" onClick={() => (apply(nudge.p, nudge.level), setNudge(null))}>仍然只给 TA</button>
          </div>
        </div>
      ) : (
        <PrincipalPicker placeholder="授予组织或用户组（也可以选个人）" onPick={(p) => (p.kind === 'user' ? setNudge({ p, level: 1 }) : apply(p, 1))} />
      ))}
      <div className="m-faint small g-scope"><ShieldCheck size={13} /> 先选组，再选人。合并后的用户组可以在“用户组”管理里继续维护成员。</div>
    </div>
  )
}
