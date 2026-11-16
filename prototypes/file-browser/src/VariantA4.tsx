// PROTOTYPE Variant A4 "see before you open" (after macOS Finder / Apple Files / Eagle).
// Same skeleton as A, but the right pane is a large live preview instead of a tabbed inspector:
// - one click on any row previews it; no "open", no download just to look
// - the preview has a version slider: drag through File Versions and restore the one you see
// - a folder shows a summary instead (types, contributors, latest changes)
// - list / thumbnail grid toggle; every breadcrumb segment drops down its siblings,
//   so jumping sideways (合同 → 方案) is one click instead of up-then-down
import { ChevronDown, ChevronRight, Download, LayoutGrid, List, Pencil, History, Users } from 'lucide-react'
import { useState } from 'react'
import { Node, ROOT } from './data'
import type { VariantProps } from './main'
import { LEVELS, allVisible, ext, fmtSize, kids, level, officeEditable, pathOf, stub, traversable } from './perm'
import { restoreVersion, useStore } from './store'
import { Avatar, FakeDoc, FileIcon, Toaster, toast } from './ui'

export function VariantA4({ user, plugin }: VariantProps) {
  useStore()
  const [cwd, setCwd] = useState<Node>(ROOT)
  const [sel, setSel] = useState<Node | null>(null)
  const [grid, setGrid] = useState(false)
  const [drop, setDrop] = useState<Node | null>(null)

  const go = (n: Node) => (setCwd(n), setSel(null), setDrop(null))
  const rows = kids(user, cwd)
  const focus = sel ?? cwd

  const Tree = ({ n, depth }: { n: Node; depth: number }) => {
    const ch = kids(user, n).filter((c) => c.type === 'dir')
    return (
      <>
        <div className={`p-tree-row ${cwd === n ? 'active' : ''}`} style={{ paddingLeft: 12 + depth * 14 }} onClick={() => go(n)}>
          {n === ROOT ? '🏠' : <FileIcon n={n} size={15} traverse={traversable(user, n)} />}
          <span className="grow">{n === ROOT ? '全部文件' : n.name}</span>
        </div>
        {(n === ROOT || pathOf(cwd).includes(n)) && ch.map((c) => <Tree key={c.id} n={c} depth={depth + 1} />)}
      </>
    )
  }

  return (
    <div className="p-shell" onClick={() => setDrop(null)}>
      <header className="p-top">
        <div className="p-brand"><span className="m-logo">F</span> ftp-master</div>
        <div className="p-path">
          {pathOf(cwd).map((n, i) => {
            const siblings = n.parent ? kids(user, n.parent).filter((c) => c.type === 'dir') : []
            return (
              <span key={n.id} className="p-seg">
                {i > 0 && <ChevronRight size={14} className="p-faint" />}
                <a onClick={() => go(n)}>{n === ROOT ? '全部文件' : n.name}</a>
                {siblings.length > 1 && (
                  <button className="p-seg-dd" onClick={(e) => (e.stopPropagation(), setDrop(drop === n ? null : n))}>
                    <ChevronDown size={12} />
                  </button>
                )}
                {drop === n && (
                  <div className="p-dd" onClick={(e) => e.stopPropagation()}>
                    {siblings.map((s) => (
                      <a key={s.id} className={s === n ? 'on' : ''} onClick={() => go(s)}>
                        <FileIcon n={s} size={14} traverse={traversable(user, s)} /> {s.name}
                      </a>
                    ))}
                  </div>
                )}
              </span>
            )
          })}
        </div>
        <div className="p-seg-ctl">
          <button className={!grid ? 'on' : ''} onClick={() => setGrid(false)}><List size={15} /></button>
          <button className={grid ? 'on' : ''} onClick={() => setGrid(true)}><LayoutGrid size={15} /></button>
        </div>
        <Avatar name={user.name} size={26} />
      </header>

      <aside className="p-side">
        <Tree n={ROOT} depth={0} />
      </aside>

      <main className="p-main" onClick={() => setSel(null)}>
        {grid ? (
          <div className="p-grid">
            {rows.map((n) => (
              <div
                key={n.id}
                className={`p-tile ${sel === n ? 'sel' : ''}`}
                onClick={(e) => (e.stopPropagation(), setSel(n))}
                onDoubleClick={() => n.type === 'dir' && go(n)}
              >
                <div className="p-tile-thumb">
                  {n.type === 'file' ? <div className="p-mini"><FakeDoc n={n} /></div> : <FileIcon n={n} size={56} traverse={traversable(user, n)} />}
                </div>
                <div className="p-tile-name">{n.name}</div>
                <div className="p-faint small">{n.type === 'dir' ? `${kids(user, n).length} 项` : fmtSize(n.size)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-list">
            {rows.map((n) => {
              const trav = traversable(user, n)
              return (
                <div
                  key={n.id}
                  className={`p-tr ${sel === n ? 'sel' : ''}`}
                  onClick={(e) => (e.stopPropagation(), setSel(n))}
                  onDoubleClick={() => n.type === 'dir' && go(n)}
                >
                  <FileIcon n={n} size={18} traverse={trav} />
                  <span className={`grow ${trav ? 'p-faint' : ''}`}>{n.name}</span>
                  {n.versions?.[0]?.stale && <span className="m-tag warn">过期保存</span>}
                  <span className="p-faint p-col">{trav ? '' : n.modified.slice(5)}</span>
                  <span className="p-faint p-col">{n.type === 'file' ? fmtSize(n.size) : trav ? '仅可经过' : `${kids(user, n).length} 项`}</span>
                  {n.type === 'dir' && <ChevronRight size={14} className="p-faint" onClick={() => go(n)} />}
                </div>
              )
            })}
          </div>
        )}
        {rows.length === 0 && <div className="m-empty">空文件夹</div>}
        <div className="p-hint">单击预览 · 双击进入文件夹</div>
      </main>

      <aside className="p-preview">
        {focus === ROOT ? (
          <FolderSummary n={ROOT} user={user} />
        ) : traversable(user, focus) ? (
          <div className="p-empty-prev">
            <FileIcon n={focus} size={64} traverse />
            <p>你在“{focus.name}”没有权限</p>
            <p className="p-faint small">只显示通往你被授权内容的路径</p>
          </div>
        ) : focus.type === 'dir' ? (
          <FolderSummary n={focus} user={user} />
        ) : (
          <FilePreview key={focus.id} n={focus} user={user} plugin={plugin} />
        )}
      </aside>
      <Toaster />
    </div>
  )
}

function FilePreview({ n, user, plugin }: { n: Node } & VariantProps) {
  const versions = n.versions ?? []
  const [vi, setVi] = useState(0) // 0 = latest
  const v = versions[vi]
  const canEdit = officeEditable(user, n, plugin)
  return (
    <div className="p-file">
      <div className="p-stage">
        <div className={`p-doc ${vi > 0 ? 'old' : ''}`}>
          <FakeDoc n={n} />
          {vi > 0 && <div className="p-old-badge">v{v.v} · {v.by} · {v.at.slice(5)}</div>}
        </div>
        <div className="p-float-actions">
          {vi === 0 ? (
            <>
              {canEdit && <button className="m-btn primary sm" onClick={() => stub('在 WPS 中编辑', n)}><Pencil size={14} /> 编辑</button>}
              {level(user, n) >= 2 && <button className="m-btn sm" onClick={() => stub('下载', n)}><Download size={14} /> 下载</button>}
            </>
          ) : (
            level(user, n) >= 3 && (
              <button className="m-btn primary sm" onClick={() => (toast(`已恢复为 v${restoreVersion(n, v.v, user.name)}（内容同 v${v.v}）`), setVi(0))}>
                <History size={14} /> 恢复此版本
              </button>
            )
          )}
        </div>
      </div>

      {versions.length > 1 && (
        <div className="p-scrub">
          <div className="p-scrub-head"><History size={13} /> 版本 <span className="p-faint small">拖动查看历史</span></div>
          <input type="range" min={0} max={versions.length - 1} value={versions.length - 1 - vi} onChange={(e) => setVi(versions.length - 1 - +e.target.value)} />
          <div className="p-scrub-ticks">
            {[...versions].reverse().map((x) => (
              <span key={x.v} className={`${x === v ? 'on' : ''} ${x.stale ? 'warn' : ''}`} onClick={() => setVi(versions.indexOf(x))}>
                v{x.v}
              </span>
            ))}
          </div>
          {v.stale && <div className="p-warn small">⚠ v{v.v} 基于旧版本保存，可能覆盖了他人修改</div>}
        </div>
      )}

      <dl className="p-meta">
        <dt>名称</dt><dd>{n.name}</dd>
        <dt>类型</dt><dd>{ext(n).toUpperCase()} · {fmtSize(n.size)}</dd>
        <dt>修改</dt><dd>{n.modifiedBy} · {n.modified}</dd>
        <dt>我的权限</dt><dd>{LEVELS[level(user, n)]}</dd>
      </dl>
    </div>
  )
}

function FolderSummary({ n, user }: { n: Node; user: VariantProps['user'] }) {
  const files = allVisible(user).filter((x) => x.type === 'file' && pathOf(x).includes(n))
  const byType: Record<string, number> = {}
  for (const f of files) byType[ext(f)] = (byType[ext(f)] ?? 0) + 1
  const people = [...new Set(files.map((f) => f.modifiedBy))]
  const total = files.reduce((a, f) => a + f.size, 0)
  const latest = [...files].sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 4)
  const COLORS: Record<string, string> = { docx: '#2b6af3', doc: '#2b6af3', xlsx: '#1f9d55', pdf: '#e03131', png: '#7048e8', pptx: '#e8590c' }
  return (
    <div className="p-folder">
      <FileIcon n={n} size={64} />
      <h2>{n === ROOT ? '全部文件' : n.name}</h2>
      <div className="p-faint">{files.length} 个文件 · {fmtSize(total)}{n !== ROOT && ` · 你可${LEVELS[level(user, n)]}`}</div>
      <div className="p-typebar">
        {Object.entries(byType).map(([t, c]) => (
          <i key={t} style={{ flex: c, background: COLORS[t] ?? '#adb5bd' }} title={`${t} ${c}`} />
        ))}
      </div>
      <div className="p-typelegend">
        {Object.entries(byType).map(([t, c]) => (
          <span key={t}><i style={{ background: COLORS[t] ?? '#adb5bd' }} /> {t} {c}</span>
        ))}
      </div>
      <div className="p-sub"><Users size={13} /> 参与者</div>
      <div className="p-people">{people.map((p) => <Avatar key={p} name={p} size={28} />)}</div>
      <div className="p-sub"><History size={13} /> 最近变更</div>
      {latest.map((f) => (
        <div key={f.id} className="p-latest">
          <FileIcon n={f} size={16} /> <span className="grow">{f.name}</span> <span className="p-faint small">{f.modified.slice(5, 10)}</span>
        </div>
      ))}
    </div>
  )
}
