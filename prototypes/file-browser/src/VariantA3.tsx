// PROTOTYPE Variant A3 "proactive" (after Feishu Drive / Notion / Box).
// Same skeleton as A, but the system does the thinking so the User clicks less:
// - the sidebar leads with the User's own entry points; chains of Traversable Ancestors are
//   collapsed into one row ("项目 › 2026-智慧园区 › 合同"), and the page opens there by default
// - "needs your attention" cards turn problems into one-click fixes: a Stale Save → restore,
//   a denied download on something you manage → grant it, items about to be purged → restore
// - every row has one visible smart button (Edit for Office files, otherwise Preview)
// - filter chips instead of advanced search; granting is inline in the inspector, no dialog
import { AlertTriangle, Check, ChevronRight, Filter, Pin, Plus, ShieldAlert, Sparkles, Trash2, Upload, X, Clock, Layers } from 'lucide-react'
import { useState } from 'react'
import { Grant, Node, ROOT, USERS } from './data'
import type { VariantProps } from './main'
import { LEVELS, allVisible, entryPoints, ext, fmtSize, grantSources, kids, level, pathOf, stub, traversable } from './perm'
import { addGrant, bin, nextSample, restore, restoreVersion, upload, useStore } from './store'
import { Avatar, FileIcon, Toaster, primaryAction, toast } from './ui'

const PRINCIPALS: Omit<Grant, 'level'>[] = [
  ...USERS.map((u) => ({ kind: 'user' as const, id: u.id, label: u.name })),
  { kind: 'org', id: 'company', label: '全公司' }, { kind: 'org', id: 'rd', label: '研发部' }, { kind: 'org', id: 'fin', label: '财务部' },
  { kind: 'org', id: 'mkt', label: '市场部' }, { kind: 'group', id: 'park', label: '智慧园区项目组' }, { kind: 'group', id: 'dmp', label: '数据中台项目组' },
]

const FILTERS: { key: string; label: string; test: (n: Node, l: number) => boolean }[] = [
  { key: 'all', label: '全部', test: () => true },
  { key: 'doc', label: '文档', test: (n) => ['doc', 'docx', 'wps', 'pdf', 'md'].includes(ext(n)) },
  { key: 'sheet', label: '表格', test: (n) => ['xls', 'xlsx'].includes(ext(n)) },
  { key: 'edit', label: '我可编辑', test: (_, l) => l >= 3 },
  { key: 'recent', label: '近 7 天', test: (n) => n.modified >= '2026-11-09' },
]

export function VariantA3({ user, plugin }: VariantProps) {
  useStore()
  const entries = entryPoints(user)
  const [cwd, setCwd] = useState<Node>(user.admin ? ROOT : entries[0] ?? ROOT)
  const [pins, setPins] = useState<Node[]>([])
  const [filter, setFilter] = useState('all')
  const [info, setInfo] = useState<Node | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [treeOpen, setTreeOpen] = useState(false)

  const go = (n: Node) => (setCwd(n), setFilter('all'))
  const open = (n: Node) => (n.type === 'dir' ? go(n) : stub(primaryAction(user, n, plugin).label, n))
  const f = FILTERS.find((x) => x.key === filter)!
  // filters other than "all" search the whole subtree, so one chip replaces drilling down
  const rows =
    filter === 'all'
      ? kids(user, cwd)
      : allVisible(user).filter((n) => n.type === 'file' && pathOf(n).includes(cwd) && f.test(n, level(user, n)))
  const canWrite = cwd !== ROOT && level(user, cwd) >= 3

  // ---- attention cards, computed from data the User is allowed to act on ----
  type Card = { id: string; tone: 'warn' | 'info' | 'danger'; icon: React.ReactNode; text: React.ReactNode; actions: { label: string; run: () => void; primary?: boolean }[] }
  const cards: Card[] = []
  for (const n of allVisible(user)) {
    const v = n.versions?.[0]
    if (v?.stale && level(user, n) >= 3 && n.versions!.length > 1) {
      const prev = n.versions![1]
      cards.push({
        id: `stale-${n.id}-${v.v}`, tone: 'warn', icon: <AlertTriangle size={18} />,
        text: <><b>{n.name}</b> 的 v{v.v} 由 {v.by} 基于旧版本保存，可能覆盖了 {prev.by} 在 {prev.at.slice(11)} 的修改</>,
        actions: [
          { label: `恢复 ${prev.by} 的 v${prev.v}`, primary: true, run: () => (toast(`已恢复为 v${restoreVersion(n, prev.v, user.name)}（内容同 v${prev.v}）`), dismiss(`stale-${n.id}-${v.v}`)) },
          { label: '对比两个版本', run: () => stub(`对比 v${prev.v} 与 v${v.v}`, n) },
        ],
      })
    }
    for (const e of n.audit ?? [])
      if (!e.ok && level(user, n) >= 4) {
        const who = USERS.find((u) => u.name === e.who)
        const id = `deny-${n.id}-${e.at}`
        cards.push({
          id, tone: 'danger', icon: <ShieldAlert size={18} />,
          text: <><b>{e.who}</b> 尝试{e.what} <b>{n.name}</b> 被拒绝（{e.at.slice(5)}）</>,
          actions: who
            ? [{ label: `允许 ${e.who} ${e.what}`, primary: true, run: () => (addGrant(n, { kind: 'user', id: who.id, label: who.name, level: 2 }), toast(`已授予 ${who.name}“下载”权限`), dismiss(id)) }]
            : [],
        })
      }
  }
  const expiring = bin.filter((b) => b.by === user.name && parseInt(b.purgeIn) <= 14)
  if (expiring.length)
    cards.push({
      id: 'bin', tone: 'info', icon: <Trash2 size={18} />,
      text: <>你删除的 <b>{expiring.map((b) => b.name).join('、')}</b> 将在 {expiring[0].purgeIn}后被永久清除</>,
      actions: [{ label: '全部还原', primary: true, run: () => (restore(expiring), toast(`已还原 ${expiring.length} 项`)) }],
    })
  const visibleCards = cards.filter((c) => !dismissed.has(c.id))
  function dismiss(id: string) {
    setDismissed((d) => new Set([...d, id]))
  }

  const crumbLabel = (n: Node) => {
    // collapse leading Traversable Ancestors into the entry point's own label
    const parts = pathOf(n).slice(1)
    return parts.map((p) => p.name).join(' › ')
  }

  const Tree = ({ n, depth }: { n: Node; depth: number }) => (
    <>
      {n !== ROOT && (
        <div className={`s-row ${cwd === n ? 'active' : ''}`} style={{ paddingLeft: 12 + depth * 12 }} onClick={() => go(n)}>
          <FileIcon n={n} size={15} traverse={traversable(user, n)} /> <span className={traversable(user, n) ? 's-faint' : ''}>{n.name}</span>
        </div>
      )}
      {(n === ROOT || pathOf(cwd).includes(n)) && kids(user, n).filter((c) => c.type === 'dir').map((c) => <Tree key={c.id} n={c} depth={n === ROOT ? 0 : depth + 1} />)}
    </>
  )

  return (
    <div className="s-shell">
      <aside className="s-side">
        <div className="s-brand"><span className="m-logo">F</span> ftp-master</div>
        <button className="s-upload" disabled={!canWrite} onClick={() => {
          const [name, size] = nextSample()
          const r = upload(cwd, name, size, user.name)
          toast(r.newVersion ? `同名文件已存在，已保存为新版本 v${r.node.versions![0].v}` : `已上传到“${cwd.name}”`, r.newVersion ? { label: '改为保留副本', run: () => stub('另存为副本') } : undefined)
        }}>
          <Upload size={16} /> 上传到“{cwd === ROOT ? '…' : cwd.name}”
        </button>
        {!canWrite && <div className="s-faint small" style={{ padding: '0 16px' }}>当前目录不可上传</div>}

        {pins.length > 0 && <div className="s-label"><Pin size={12} /> 固定</div>}
        {pins.map((n) => (
          <div key={n.id} className={`s-row ${cwd === n ? 'active' : ''}`} onClick={() => go(n)}>
            <FileIcon n={n} size={15} /> {n.name}
          </div>
        ))}

        <div className="s-label"><Sparkles size={12} /> 我的入口</div>
        {entries.map((n) => (
          <div key={n.id} className={`s-row s-entry ${cwd === n ? 'active' : ''}`} onClick={() => go(n)}>
            <FileIcon n={n} size={15} />
            <div className="s-entry-text">
              <span>{n.name}</span>
              {pathOf(n).length > 2 && <span className="s-faint small">{pathOf(n).slice(1, -1).map((p) => p.name).join(' › ')}</span>}
            </div>
            <span className="s-lvl">{LEVELS[level(user, n)]}</span>
          </div>
        ))}

        <div className="s-label s-toggle" onClick={() => setTreeOpen((o) => !o)}>
          <ChevronRight size={12} className={treeOpen ? 'rot' : ''} /> 全部文件
        </div>
        {treeOpen && <Tree n={ROOT} depth={0} />}
      </aside>

      <main className="s-main">
        <div className="s-head">
          <div>
            <div className="s-faint small">{crumbLabel(cwd.parent ?? ROOT) || '全部文件'}</div>
            <h1>
              {cwd === ROOT ? '全部文件' : cwd.name}
              {cwd !== ROOT && (
                <button className={`s-pin ${pins.includes(cwd) ? 'on' : ''}`} title="固定到侧栏" onClick={() => setPins((p) => (p.includes(cwd) ? p.filter((x) => x !== cwd) : [...p, cwd]))}>
                  <Pin size={15} />
                </button>
              )}
            </h1>
          </div>
          <span className="grow" />
          {cwd !== ROOT && (
            <div className="s-access" onClick={() => setInfo(cwd)} title="查看谁能访问">
              {grantSources(cwd).slice(0, 4).map(({ grant }, i) => <Avatar key={i} name={grant.label} size={26} />)}
              <span className="s-faint small">{traversable(user, cwd) ? '仅可经过' : `你可${LEVELS[level(user, cwd)]}`}</span>
            </div>
          )}
        </div>

        {visibleCards.length > 0 && (
          <section className="s-cards">
            {visibleCards.map((c) => (
              <div key={c.id} className={`s-card ${c.tone}`}>
                <span className="s-card-icon">{c.icon}</span>
                <div className="grow">{c.text}</div>
                {c.actions.map((a) => (
                  <button key={a.label} className={`m-btn sm ${a.primary ? 'primary' : ''}`} onClick={a.run}>{a.label}</button>
                ))}
                <X size={15} className="s-faint" style={{ cursor: 'pointer' }} onClick={() => dismiss(c.id)} />
              </div>
            ))}
          </section>
        )}

        <div className="s-chips">
          <Filter size={14} className="s-faint" />
          {FILTERS.map((x) => (
            <button key={x.key} className={`s-chip ${filter === x.key ? 'on' : ''}`} onClick={() => setFilter(x.key)}>
              {filter === x.key && x.key !== 'all' && <Check size={13} />} {x.label}
            </button>
          ))}
          {filter !== 'all' && <span className="s-faint small">· 已包含所有子文件夹，共 {rows.length} 项</span>}
        </div>

        <div className="s-table">
          {rows.map((n) => {
            const trav = traversable(user, n)
            const pa = primaryAction(user, n, plugin)
            return (
              <div key={n.id} className={`s-tr ${info === n ? 'sel' : ''}`} onClick={() => setInfo(n)} onDoubleClick={() => open(n)}>
                <FileIcon n={n} size={22} traverse={trav} />
                <div className="s-name">
                  <a onClick={(e) => (e.stopPropagation(), open(n))} className={trav ? 's-faint' : ''}>{n.name}</a>
                  <span className="s-faint small">
                    {trav ? '你只能经过此文件夹' : filter !== 'all' ? pathOf(n).slice(1, -1).map((p) => p.name).join(' › ') : `${n.modifiedBy} · ${n.modified.slice(5)}${n.type === 'file' ? ` · ${fmtSize(n.size)}` : ` · ${kids(user, n).length} 项`}`}
                  </span>
                </div>
                {n.versions?.[0]?.stale && <span className="m-tag warn">过期保存</span>}
                {n.versions && n.versions.length > 1 && <span className="s-faint small"><Layers size={12} /> {n.versions.length}</span>}
                {!trav && (
                  <button className={`m-btn sm ${pa.key === 'office' ? 'primary' : ''}`} onClick={(e) => (e.stopPropagation(), open(n))}>
                    {pa.label}
                  </button>
                )}
              </div>
            )
          })}
          {rows.length === 0 && <div className="m-empty">没有符合条件的文件</div>}
        </div>
      </main>

      {info && <SmartInspector key={info.id} n={info} user={user} close={() => setInfo(null)} />}
      <Toaster />
    </div>
  )
}

function SmartInspector({ n, user, close }: { n: Node; user: VariantProps['user']; close: () => void }) {
  const [q, setQ] = useState('')
  const [lvl, setLvl] = useState(1)
  const manage = level(user, n) >= 4
  const trav = traversable(user, n)
  const suggestions = q ? PRINCIPALS.filter((p) => p.label.includes(q)).slice(0, 5) : []
  const activity = [
    ...(n.versions ?? []).map((v) => ({ at: v.at, who: v.by, text: `保存了 v${v.v}`, warn: v.stale })),
    ...(n.audit ?? []).filter((a) => !a.what.startsWith('保存')).map((a) => ({ at: a.at, who: a.who, text: a.ok ? a.what : `${a.what}（被拒绝）`, warn: !a.ok })),
  ].sort((a, b) => b.at.localeCompare(a.at))

  return (
    <aside className="s-insp">
      <div className="s-insp-head">
        <FileIcon n={n} size={32} traverse={trav} />
        <b className="grow">{n.name}</b>
        <X size={16} style={{ cursor: 'pointer' }} onClick={close} />
      </div>
      {trav ? (
        <div className="s-faint" style={{ padding: 16 }}>你在此没有权限，只能经过。</div>
      ) : (
        <>
          <div className="s-label">谁能访问</div>
          {manage && (
            <div className="s-grant-add">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入人员、部门或用户组" />
              <div className="s-seg">
                {[1, 2, 3, 4].map((l) => (
                  <button key={l} className={lvl === l ? 'on' : ''} onClick={() => setLvl(l)}>{LEVELS[l]}</button>
                ))}
              </div>
              {suggestions.map((p) => (
                <div key={p.kind + p.id} className="s-sugg" onClick={() => (addGrant(n, { ...p, level: lvl }), setQ(''), toast(`已授予 ${p.label}“${LEVELS[lvl]}”权限`))}>
                  <Avatar name={p.label} size={22} /> {p.label}
                  <span className="s-faint small">{{ user: '人员', org: '部门', group: '用户组' }[p.kind]}</span>
                  <span className="grow" /> <Plus size={14} /> {LEVELS[lvl]}
                </div>
              ))}
            </div>
          )}
          {grantSources(n).map(({ grant, from }, i) => (
            <div key={i} className="m-grant">
              <Avatar name={grant.label} size={24} />
              <div className="grow">
                {grant.label}
                <div className="s-faint small">{from === n ? '直接授权' : `继承自 ${from.name}`}</div>
              </div>
              <span className="m-tag">{LEVELS[grant.level]}</span>
            </div>
          ))}
          {activity.length > 0 && (
            <>
              <div className="s-label"><Clock size={12} /> 动态</div>
              {activity.map((a, i) => (
                <div key={i} className={`s-act ${a.warn ? 'warn' : ''}`}>
                  <Avatar name={a.who} size={20} />
                  <div className="grow">
                    <b>{a.who}</b> {a.text}
                    <div className="s-faint small">{a.at.slice(5)}</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </aside>
  )
}
