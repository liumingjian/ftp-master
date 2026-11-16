// PROTOTYPE Variant A1 "hover to act" (after Dropbox / Google Drive).
// Same skeleton as A, but nothing needs select-then-toolbar:
// - every row shows its own actions on hover; clicking a name opens it immediately
// - drop files anywhere in the window to upload into the current folder (real file names are used)
// - drag rows onto a folder in the tree, table or breadcrumb to move them
// - no confirmation dialogs: delete goes to the Recycle Bin with an Undo toast
// - same-name upload silently becomes a new File Version
import { ChevronRight, Download, FolderPlus, Info, MoreHorizontal, Pencil, Search, Trash2, Upload, UserPlus, X, Clock, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Node, ROOT } from './data'
import type { VariantProps } from './main'
import { LEVELS, allVisible, fmtSize, grantSources, kids, level, pathOf, stub, traversable } from './perm'
import { bin, mkdir, move, nextSample, remove, rename, restore, upload, useStore } from './store'
import { Avatar, FileIcon, Toaster, primaryAction, toast } from './ui'

type Uploading = { id: number; name: string; size: number; pct: number; dir: Node }

export function VariantA1({ user, plugin }: VariantProps) {
  useStore()
  const [cwd, setCwd] = useState<Node>(ROOT)
  const [inBin, setInBin] = useState(false)
  const [sel, setSel] = useState<Set<Node>>(new Set())
  const [info, setInfo] = useState<Node | null>(null)
  const [editing, setEditing] = useState<Node | null>(null)
  const [menu, setMenu] = useState<Node | null>(null)
  const [q, setQ] = useState('')
  const [dragOver, setDragOver] = useState<Node | 'window' | null>(null)
  const [ups, setUps] = useState<Uploading[]>([])
  const dragging = useRef<Node[]>([])
  const canWrite = cwd !== ROOT && level(user, cwd) >= 3

  // simulated upload progress
  useEffect(() => {
    if (!ups.some((u) => u.pct < 100)) return
    const t = setInterval(() => {
      setUps((list) =>
        list.map((u) => {
          if (u.pct >= 100) return u
          const pct = Math.min(100, u.pct + 8 + Math.random() * 20)
          if (pct === 100) {
            const r = upload(u.dir, u.name, u.size, user.name)
            if (r.newVersion) toast(`“${u.name}”已存在，已保存为新版本 v${r.node.versions![0].v}`, { label: '查看版本', run: () => setInfo(r.node) })
          }
          return { ...u, pct }
        }),
      )
    }, 250)
    return () => clearInterval(t)
  }, [ups, user.name])

  const startUpload = (files: [string, number][], dir = cwd) =>
    setUps((l) => [...l.filter((u) => u.pct < 100 || l.length < 6), ...files.map(([name, size], i) => ({ id: Date.now() + i, name, size, pct: 0, dir }))])

  const go = (n: Node) => (setCwd(n), setInBin(false), setSel(new Set()), setQ(''), setMenu(null))
  const open = (n: Node) => {
    if (n.type === 'dir') return go(n)
    const a = primaryAction(user, n, plugin)
    stub(a.label, n)
  }
  const del = (nodes: Node[]) => {
    const items = remove(nodes, user.name)
    setSel(new Set())
    setInfo(null)
    toast(`已将 ${nodes.length === 1 ? `“${nodes[0].name}”` : `${nodes.length} 项`}移到回收站`, { label: '撤销', run: () => restore(items) })
  }
  const dropMove = (target: Node) => {
    const moved = dragging.current.map((n) => [n, n.parent!] as const).filter(([n]) => move(n, target))
    if (moved.length) {
      setSel(new Set())
      toast(`已移动 ${moved.length} 项到“${target.name}”`, { label: '撤销', run: () => moved.forEach(([n, from]) => move(n, from)) })
    }
    dragging.current = []
    setDragOver(null)
  }
  const dropProps = (target: Node) =>
    target === ROOT || level(user, target) < 3
      ? {}
      : {
          onDragOver: (e: React.DragEvent) => (e.preventDefault(), e.stopPropagation(), setDragOver(target)),
          onDragLeave: () => setDragOver(null),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault()
            e.stopPropagation()
            if (e.dataTransfer.files.length) {
              startUpload([...e.dataTransfer.files].map((f) => [f.name, f.size]), target)
              setDragOver(null)
            } else dropMove(target)
          },
        }

  const rows = q
    ? allVisible(user).filter((n) => !traversable(user, n) && n.name.toLowerCase().includes(q.toLowerCase()))
    : kids(user, cwd)
  const recent = allVisible(user)
    .filter((n) => n.type === 'file')
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, 4)

  const Tree = ({ n, depth }: { n: Node; depth: number }) => {
    const ch = kids(user, n).filter((c) => c.type === 'dir')
    const onPath = pathOf(cwd).includes(n)
    const trav = n !== ROOT && traversable(user, n)
    return (
      <>
        <div
          className={`m-tree-row ${cwd === n && !inBin ? 'active' : ''} ${dragOver === n ? 'drop' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => go(n)}
          {...dropProps(n)}
        >
          <ChevronRight size={14} className={`m-chev ${onPath ? 'open' : ''}`} style={{ visibility: ch.length ? 'visible' : 'hidden' }} />
          {n === ROOT ? <span className="m-tree-home">🏠</span> : <FileIcon n={n} size={16} traverse={trav} />}
          <span className={trav ? 'm-faint' : ''}>{n === ROOT ? '全部文件' : n.name}</span>
        </div>
        {(onPath || n === ROOT) && ch.map((c) => <Tree key={c.id} n={c} depth={depth + 1} />)}
      </>
    )
  }

  return (
    <div
      className="m-shell"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') && canWrite) (e.preventDefault(), setDragOver('window'))
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (e.dataTransfer.files.length && canWrite) startUpload([...e.dataTransfer.files].map((f) => [f.name, f.size]))
        setDragOver(null)
      }}
      onClick={() => setMenu(null)}
    >
      <header className="m-top">
        <div className="m-brand">
          <span className="m-logo">F</span> ftp-master
        </div>
        <label className="m-search">
          <Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索全部可访问的文件" />
          {q && <X size={14} onClick={() => setQ('')} style={{ cursor: 'pointer' }} />}
        </label>
        <div className="m-user">
          <Avatar name={user.name} size={28} />
          <div>
            <div>{user.name}</div>
            <div className="m-faint small">{user.orgLabel}</div>
          </div>
        </div>
      </header>

      <aside className="m-side">
        <div className="m-side-actions">
          <button className="m-btn primary grow" disabled={!canWrite} title={canWrite ? '也可以直接把文件拖进窗口' : '当前目录需要“编辑”权限'} onClick={() => startUpload([nextSample()])}>
            <Upload size={16} /> 上传
          </button>
          <button className="m-btn icon" disabled={!canWrite} title="新建文件夹" onClick={() => setEditing(mkdir(cwd, user.name))}>
            <FolderPlus size={16} />
          </button>
        </div>
        <div className="m-tree">
          <Tree n={ROOT} depth={0} />
        </div>
        <div className={`m-tree-row m-bin ${inBin ? 'active' : ''}`} onClick={() => (setInBin(true), setInfo(null))}>
          <Trash2 size={16} /> 回收站 <span className="m-count">{bin.length}</span>
        </div>
      </aside>

      <main className="m-main">
        {inBin ? (
          <BinView />
        ) : (
          <>
            <div className="m-crumbs">
              {q ? (
                <span>“{q}”的搜索结果 · {rows.length} 项</span>
              ) : (
                pathOf(cwd).map((n, i) => (
                  <span key={n.id} className="m-crumb-wrap">
                    {i > 0 && <ChevronRight size={14} className="m-faint" />}
                    <a className={`m-crumb ${dragOver === n ? 'drop' : ''}`} onClick={() => go(n)} {...dropProps(n)}>
                      {n === ROOT ? '全部文件' : n.name}
                    </a>
                  </span>
                ))
              )}
              {!q && cwd !== ROOT && (
                <span className="m-perm-pill">{traversable(user, cwd) ? '仅可经过' : `你可${LEVELS[level(user, cwd)]}`}</span>
              )}
            </div>

            {cwd === ROOT && !q && (
              <section className="m-quick">
                <div className="m-section-title"><Clock size={14} /> 最近编辑</div>
                <div className="m-quick-row">
                  {recent.map((n) => (
                    <div key={n.id} className="m-quick-card" onClick={() => open(n)}>
                      <FileIcon n={n} size={28} />
                      <div className="m-ellipsis">{n.name}</div>
                      <div className="m-faint small">{n.modifiedBy} · {n.modified.slice(5)}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {traversable(user, cwd) && cwd !== ROOT && !q && (
              <div className="m-note">你在“{cwd.name}”没有权限，这里只显示通往你被授权内容的路径。</div>
            )}

            <div className="m-table">
              <div className="m-tr m-th">
                <span /><span>名称</span><span>修改人</span><span>修改时间</span><span>大小</span><span />
              </div>
              {rows.map((n) => {
                const trav = traversable(user, n)
                const l = level(user, n)
                const pa = primaryAction(user, n, plugin)
                const checked = sel.has(n)
                return (
                  <div
                    key={n.id}
                    className={`m-tr ${checked ? 'sel' : ''} ${dragOver === n ? 'drop' : ''} ${sel.size ? 'selecting' : ''}`}
                    draggable={!trav && l >= 3}
                    onDragStart={() => (dragging.current = checked ? [...sel] : [n])}
                    {...(n.type === 'dir' ? dropProps(n) : {})}
                    onClick={() => (sel.size ? toggleSel(n) : setInfo(n))}
                  >
                    <span className="m-check" onClick={(e) => (e.stopPropagation(), toggleSel(n))}>
                      {!trav && <input type="checkbox" checked={checked} readOnly />}
                    </span>
                    <span className="m-name">
                      <FileIcon n={n} traverse={trav} />
                      {editing === n ? (
                        <InlineRename n={n} done={() => setEditing(null)} />
                      ) : (
                        <a className={trav ? 'm-faint' : ''} onClick={(e) => (e.stopPropagation(), open(n))}>
                          {n.name}
                        </a>
                      )}
                      {q && <span className="m-faint small m-ellipsis">{pathOf(n).slice(1, -1).map((p) => p.name).join(' / ')}</span>}
                      {n.versions?.[0]?.stale && <span className="m-tag warn">过期保存</span>}
                    </span>
                    <span className="m-who">{!trav && <><Avatar name={n.modifiedBy} size={20} /> {n.modifiedBy}</>}</span>
                    <span className="m-faint">{trav ? '' : n.modified.slice(5)}</span>
                    <span className="m-faint">{n.type === 'dir' ? '' : fmtSize(n.size)}</span>
                    <span className="m-row-actions" onClick={(e) => e.stopPropagation()}>
                      {!trav && (
                        <>
                          {n.type === 'file' && pa.key !== 'download' && (
                            <button className="m-btn sm" onClick={() => open(n)}>{pa.label}</button>
                          )}
                          {l >= 2 && (
                            <button className="m-btn icon sm" title="下载" onClick={() => stub('下载', n)}>
                              <Download size={15} />
                            </button>
                          )}
                          <button className="m-btn icon sm" title="更多" onClick={(e) => (e.stopPropagation(), setMenu(menu === n ? null : n))}>
                            <MoreHorizontal size={15} />
                          </button>
                          {menu === n && (
                            <div className="m-menu">
                              <a onClick={() => (setInfo(n), setMenu(null))}><Info size={14} /> 详情与版本</a>
                              {l >= 3 && <a onClick={() => (setEditing(n), setMenu(null))}><Pencil size={14} /> 重命名</a>}
                              {l >= 4 && <a onClick={() => (setInfo(n), setMenu(null))}><UserPlus size={14} /> 授权</a>}
                              {l >= 4 && <a className="danger" onClick={() => (del([n]), setMenu(null))}><Trash2 size={14} /> 删除</a>}
                              {l >= 3 && <div className="m-menu-hint">提示：直接把它拖到左侧文件夹即可移动</div>}
                            </div>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                )
              })}
              {rows.length === 0 && (
                <div className="m-empty">
                  {canWrite ? '把文件拖到这里上传' : '这里还没有内容'}
                </div>
              )}
            </div>
          </>
        )}
      </main>

      {info && !inBin && <Inspector n={info} user={user} close={() => setInfo(null)} />}

      {sel.size > 0 && (
        <div className="m-selbar">
          <b>已选 {sel.size} 项</b>
          <button className="m-btn ghost" onClick={() => stub(`打包下载 ${sel.size} 项`)}><Download size={15} /> 下载</button>
          {[...sel].every((n) => level(user, n) >= 4) && (
            <button className="m-btn ghost danger" onClick={() => del([...sel])}><Trash2 size={15} /> 删除</button>
          )}
          <span className="m-faint small">拖动可移动</span>
          <button className="m-btn icon ghost" onClick={() => setSel(new Set())}><X size={15} /></button>
        </div>
      )}

      {dragOver === 'window' && (
        <div className="m-drop-overlay">
          <Upload size={40} />
          <div>松开即可上传到“{cwd.name}”</div>
        </div>
      )}

      {ups.length > 0 && (
        <div className="m-uptray">
          <div className="m-uptray-head">
            {ups.every((u) => u.pct >= 100) ? `${ups.length} 个文件已上传` : `正在上传 ${ups.filter((u) => u.pct < 100).length} 个文件`}
            <X size={14} onClick={() => setUps([])} style={{ cursor: 'pointer' }} />
          </div>
          {ups.map((u) => (
            <div key={u.id} className="m-up">
              <span className="m-ellipsis">{u.name}</span>
              <span className="m-faint small">{u.pct >= 100 ? '完成' : `${Math.round(u.pct)}%`}</span>
              <div className="m-bar"><i style={{ width: `${u.pct}%` }} /></div>
            </div>
          ))}
        </div>
      )}
      <Toaster />
    </div>
  )

  function toggleSel(n: Node) {
    if (traversable(user, n)) return
    setSel((s) => {
      const t = new Set(s)
      t.has(n) ? t.delete(n) : t.add(n)
      return t
    })
  }
}

export function InlineRename({ n, done }: { n: Node; done: () => void }) {
  const [v, setV] = useState(n.name)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current!
    el.focus()
    el.setSelectionRange(0, n.type === 'file' ? n.name.lastIndexOf('.') : n.name.length)
  }, [n])
  const save = () => (v.trim() && v !== n.name && rename(n, v.trim()), done())
  return (
    <input
      ref={ref}
      className="m-rename"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={save}
      onKeyDown={(e) => (e.key === 'Enter' ? save() : e.key === 'Escape' && done())}
    />
  )
}

function BinView() {
  return (
    <>
      <div className="m-crumbs">回收站 <span className="m-faint small">删除的内容保留 30 天后自动清除</span></div>
      <div className="m-table">
        {bin.map((b, i) => (
          <div key={i} className="m-tr bin">
            <span />
            <span className="m-name">{b.name}<span className="m-faint small">{b.from}</span></span>
            <span className="m-who"><Avatar name={b.by} size={20} /> {b.by}</span>
            <span className="m-faint">{b.at.slice(5)}</span>
            <span className="m-faint">{b.purgeIn}后清除</span>
            <span className="m-row-actions show">
              <button className="m-btn sm" onClick={() => (restore([b]), toast(`已还原“${b.name}”`))}><RotateCcw size={14} /> 还原</button>
            </span>
          </div>
        ))}
        {bin.length === 0 && <div className="m-empty">回收站是空的</div>}
      </div>
    </>
  )
}

function Inspector({ n, user, close }: { n: Node; user: VariantProps['user']; close: () => void }) {
  const trav = traversable(user, n)
  return (
    <aside className="m-insp">
      <div className="m-insp-head">
        <FileIcon n={n} size={36} traverse={trav} />
        <div className="grow">
          <b>{n.name}</b>
          <div className="m-faint small">{trav ? '仅可经过' : `你可${LEVELS[level(user, n)]}`}</div>
        </div>
        <X size={16} onClick={close} style={{ cursor: 'pointer' }} />
      </div>
      {!trav && (
        <>
          <div className="m-section-title">谁能访问</div>
          {grantSources(n).map(({ grant, from }, i) => (
            <div key={i} className="m-grant">
              <Avatar name={grant.label} size={24} />
              <div className="grow">
                {grant.label}
                <div className="m-faint small">{from === n ? '直接授权' : `继承自 ${from.name}`}</div>
              </div>
              <span className="m-tag">{LEVELS[grant.level]}</span>
            </div>
          ))}
          {level(user, n) >= 4 && <button className="m-btn ghost" onClick={() => stub('添加授权', n)}><UserPlus size={15} /> 添加授权</button>}
          {n.versions && (
            <>
              <div className="m-section-title">版本</div>
              {n.versions.map((v, i) => (
                <div key={v.v} className="m-ver">
                  <span className="m-ver-dot" />
                  <div className="grow">
                    v{v.v} · {v.by} {i === 0 && <span className="m-tag">当前</span>}
                    {v.stale && <span className="m-tag warn">过期保存</span>}
                    <div className="m-faint small">{v.at} · {fmtSize(v.size)}</div>
                  </div>
                  {i > 0 && level(user, n) >= 3 && <a className="small" onClick={() => stub(`恢复 v${v.v}`, n)}>恢复</a>}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </aside>
  )
}
