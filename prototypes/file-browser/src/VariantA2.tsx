// PROTOTYPE Variant A2 "keyboard and command palette" (after Linear / Raycast / VS Code).
// Same skeleton as A in a dark theme, built for people who live in it all day:
// - ⌘K (or /) palette: type a few letters, Enter runs it. Jump to any folder, open/edit any file,
//   or run a context action ("upload here", "new folder") without touching the mouse
// - the table has a keyboard cursor: ↑↓ move, Enter open, ⌫ up a level, Space quick look,
//   E edit in WPS, D download, R rename, S star, X select, ⌘⌫ delete (with undo)
// - the inspector follows the cursor, so details never need a click
// - status bar always shows where you are and what you can do here
import { Command, CornerDownLeft, Download, Pencil, Star, Trash2, Upload, FolderPlus, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Node, ROOT } from './data'
import type { VariantProps } from './main'
import { LEVELS, allVisible, fmtSize, kids, level, officeEditable, pathOf, stub, traversable } from './perm'
import { mkdir, nextSample, remove, restore, upload, useStore } from './store'
import { Avatar, FakeDoc, FileIcon, Kbd, Toaster, primaryAction, toast } from './ui'
import { InlineRename } from './VariantA1'

type Cmd = { id: string; label: string; hint?: string; icon: React.ReactNode; run: () => void; group: string }

export function VariantA2({ user, plugin }: VariantProps) {
  useStore()
  const [cwd, setCwd] = useState<Node>(ROOT)
  const [cursor, setCursor] = useState(0)
  const [sel, setSel] = useState<Set<Node>>(new Set())
  const [stars, setStars] = useState<Node[]>([])
  const [palette, setPalette] = useState(false)
  const [look, setLook] = useState<Node | null>(null)
  const [editing, setEditing] = useState<Node | null>(null)
  const [help, setHelp] = useState(false)

  const rows = kids(user, cwd)
  const cur: Node | undefined = rows[Math.min(cursor, rows.length - 1)]
  const canWrite = cwd !== ROOT && level(user, cwd) >= 3

  const go = (n: Node, focus?: Node) => {
    setCwd(n)
    setSel(new Set())
    setCursor(focus ? Math.max(0, kids(user, n).indexOf(focus)) : 0)
  }
  const open = (n: Node) => {
    if (n.type === 'dir') return go(n)
    const a = primaryAction(user, n, plugin)
    stub(a.label, n)
  }
  const del = (nodes: Node[]) => {
    const deletable = nodes.filter((n) => level(user, n) >= 4)
    if (!deletable.length) return toast('你没有删除权限（需要“管理”）')
    const items = remove(deletable, user.name)
    setSel(new Set())
    toast(`已删除 ${deletable.length} 项`, { label: '撤销  ⌘Z', run: () => restore(items) })
  }
  const up = () => cwd.parent && go(cwd.parent, cwd)
  const doUpload = () => {
    if (!canWrite) return toast('当前目录需要“编辑”权限才能上传')
    const [name, size] = nextSample()
    const r = upload(cwd, name, size, user.name)
    toast(r.newVersion ? `已作为新版本 v${r.node.versions![0].v} 上传：${name}` : `已上传 ${name}`)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') return e.preventDefault(), setPalette((p) => !p)
      if (t.closest('input, textarea, select') || palette) return
      if (look) {
        if (e.key === ' ' || e.key === 'Escape') e.preventDefault(), setLook(null)
        return
      }
      const k = e.key.toLowerCase()
      if (e.key === '/') return e.preventDefault(), setPalette(true)
      if (e.key === '?') return setHelp((h) => !h)
      if (e.key === 'ArrowDown' || k === 'j') return e.preventDefault(), setCursor((c) => Math.min(rows.length - 1, c + 1))
      if (e.key === 'ArrowUp' || k === 'k') return e.preventDefault(), setCursor((c) => Math.max(0, c - 1))
      if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) return del(sel.size ? [...sel] : cur ? [cur] : [])
      if (e.key === 'Backspace') return e.preventDefault(), up()
      if (!cur || traversable(user, cur)) {
        if (e.key === 'Enter' && cur) open(cur)
        return
      }
      if (e.key === 'Enter') return open(cur)
      if (e.key === ' ') return e.preventDefault(), cur.type === 'file' && setLook(cur)
      if (k === 'e') return officeEditable(user, cur, plugin) ? stub('在 WPS 中编辑', cur) : toast('此文件不能在线编辑')
      if (k === 'd') return level(user, cur) >= 2 ? stub('下载', cur) : toast('需要“下载”权限')
      if (k === 'r') return level(user, cur) >= 3 ? setEditing(cur) : toast('需要“编辑”权限')
      if (k === 's') return setStars((s) => (s.includes(cur) ? s.filter((x) => x !== cur) : [...s, cur]))
      if (k === 'x') return setSel((s) => (s.has(cur) ? new Set([...s].filter((x) => x !== cur)) : new Set([...s, cur])))
      if (k === 'u') return doUpload()
      if (k === 'n') return canWrite && setEditing(mkdir(cwd, user.name))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const commands: Cmd[] = useMemo(() => {
    const here: Cmd[] = []
    if (canWrite) {
      here.push({ id: 'up', group: '当前目录', label: `上传到“${cwd.name}”`, hint: 'U', icon: <Upload size={15} />, run: doUpload })
      here.push({ id: 'mk', group: '当前目录', label: '新建文件夹', hint: 'N', icon: <FolderPlus size={15} />, run: () => setEditing(mkdir(cwd, user.name)) })
    }
    if (cur && officeEditable(user, cur, plugin))
      here.push({ id: 'ed', group: '当前目录', label: `在 WPS 中编辑“${cur.name}”`, hint: 'E', icon: <Pencil size={15} />, run: () => stub('在 WPS 中编辑', cur) })
    const items = allVisible(user)
      .filter((n) => !traversable(user, n))
      .map<Cmd>((n) => ({
        id: n.id,
        group: n.type === 'dir' ? '跳转到文件夹' : '打开文件',
        label: n.name,
        hint: pathOf(n).slice(1, -1).map((p) => p.name).join(' / '),
        icon: <FileIcon n={n} size={16} />,
        run: () => (n.type === 'dir' ? go(n) : (go(n.parent!, n), open(n))),
      }))
    return [...here, ...items]
  }, [cwd, cur, user, plugin, canWrite])

  const Tree = ({ n, depth }: { n: Node; depth: number }) => {
    const ch = kids(user, n).filter((c) => c.type === 'dir')
    const show = pathOf(cwd).includes(n)
    return (
      <>
        <div className={`k-tree-row ${cwd === n ? 'active' : ''}`} style={{ paddingLeft: 10 + depth * 12 }} onClick={() => go(n)}>
          {n === ROOT ? <Command size={14} /> : <FileIcon n={n} size={14} traverse={traversable(user, n)} />}
          {n === ROOT ? '全部文件' : n.name}
        </div>
        {(show || n === ROOT) && ch.map((c) => <Tree key={c.id} n={c} depth={depth + 1} />)}
      </>
    )
  }

  return (
    <div className="k-shell">
      <header className="k-top">
        <b>ftp-master</b>
        <button className="k-cmdk" onClick={() => setPalette(true)}>
          <Search size={14} /> 搜索或执行命令… <span className="grow" /> <Kbd>⌘K</Kbd>
        </button>
        <Avatar name={user.name} size={24} />
      </header>

      <aside className="k-side">
        {stars.length > 0 && (
          <>
            <div className="k-label">收藏</div>
            {stars.map((n) => (
              <div key={n.id} className="k-tree-row" onClick={() => (n.type === 'dir' ? go(n) : go(n.parent!, n))}>
                <Star size={13} fill="#f5c542" color="#f5c542" /> {n.name}
              </div>
            ))}
          </>
        )}
        <div className="k-label">目录</div>
        <Tree n={ROOT} depth={0} />
      </aside>

      <main className="k-main">
        <div className="k-crumbs">
          {pathOf(cwd).map((n, i) => (
            <span key={n.id}>
              {i > 0 && <span className="k-dim"> / </span>}
              <a onClick={() => go(n)}>{n === ROOT ? '全部文件' : n.name}</a>
            </span>
          ))}
        </div>
        <div className="k-table">
          {rows.map((n, i) => {
            const trav = traversable(user, n)
            return (
              <div
                key={n.id}
                className={`k-tr ${i === cursor ? 'cursor' : ''} ${sel.has(n) ? 'sel' : ''}`}
                onMouseMove={() => i !== cursor && setCursor(i)}
                onClick={() => open(n)}
              >
                <span className="k-sel-dot">{sel.has(n) ? '●' : ''}</span>
                <FileIcon n={n} size={16} traverse={trav} />
                <span className={`k-name ${trav ? 'k-dim' : ''}`}>
                  {editing === n ? <InlineRename n={n} done={() => setEditing(null)} /> : n.name}
                  {stars.includes(n) && <Star size={11} fill="#f5c542" color="#f5c542" />}
                  {n.versions?.[0]?.stale && <span className="k-tag warn">过期保存</span>}
                </span>
                <span className="k-dim">{trav ? '仅可经过' : n.modifiedBy}</span>
                <span className="k-dim">{trav ? '' : n.modified.slice(5)}</span>
                <span className="k-dim k-right">{n.type === 'file' ? fmtSize(n.size) : ''}</span>
                <span className="k-hints">
                  {i === cursor && !trav && (
                    <>
                      <Kbd>↵</Kbd> {primaryAction(user, n, plugin).label}
                      {n.type === 'file' && <><Kbd>␣</Kbd> 预览</>}
                    </>
                  )}
                </span>
              </div>
            )
          })}
          {rows.length === 0 && <div className="k-empty">空目录 · 按 <Kbd>U</Kbd> 上传 · <Kbd>⌫</Kbd> 返回上级</div>}
        </div>
      </main>

      <aside className="k-insp">
        {cur && !traversable(user, cur) ? (
          <>
            <div className="k-thumb">{cur.type === 'file' ? <FakeDoc n={cur} /> : <FileIcon n={cur} size={56} />}</div>
            <h3>{cur.name}</h3>
            <dl className="k-dl">
              <dt>位置</dt><dd>{pathOf(cur).slice(1, -1).map((p) => p.name).join(' / ') || '/'}</dd>
              <dt>修改</dt><dd>{cur.modifiedBy} · {cur.modified}</dd>
              {cur.type === 'file' && <><dt>大小</dt><dd>{fmtSize(cur.size)}</dd></>}
              <dt>我的权限</dt><dd>{LEVELS[level(user, cur)]}</dd>
            </dl>
            <div className="k-actions">
              {officeEditable(user, cur, plugin) && <span><Kbd>E</Kbd> 在 WPS 编辑</span>}
              {level(user, cur) >= 2 && <span><Download size={12} /> <Kbd>D</Kbd> 下载</span>}
              {level(user, cur) >= 3 && <span><Kbd>R</Kbd> 重命名</span>}
              <span><Kbd>S</Kbd> 收藏</span>
              {level(user, cur) >= 4 && <span><Trash2 size={12} /> <Kbd>⌘⌫</Kbd> 删除</span>}
            </div>
            {cur.versions && cur.versions.length > 1 && (
              <>
                <div className="k-label">版本</div>
                {cur.versions.map((v) => (
                  <div key={v.v} className="k-ver">
                    v{v.v} · {v.by} · <span className="k-dim">{v.at.slice(5)}</span> {v.stale && <span className="k-tag warn">过期保存</span>}
                  </div>
                ))}
              </>
            )}
          </>
        ) : (
          <div className="k-dim" style={{ padding: 20 }}>移动光标查看详情</div>
        )}
      </aside>

      <footer className="k-status">
        <span>{cwd === ROOT ? '全部文件' : `${cwd.name} · ${traversable(user, cwd) ? '仅可经过' : `你可${LEVELS[level(user, cwd)]}`}`}</span>
        <span>{rows.length} 项{sel.size ? ` · 已选 ${sel.size}` : ''}</span>
        <span className="grow" />
        <span><Kbd>?</Kbd> 快捷键</span>
      </footer>

      {palette && <Palette commands={commands} close={() => setPalette(false)} />}
      {look && (
        <div className="k-look" onClick={() => setLook(null)}>
          <div className="k-look-card" onClick={(e) => e.stopPropagation()}>
            <div className="k-look-head">
              <FileIcon n={look} size={18} /> {look.name}
              <span className="grow" />
              <span className="k-dim small">空格或 Esc 关闭</span>
            </div>
            <FakeDoc n={look} />
          </div>
        </div>
      )}
      {help && (
        <div className="k-look" onClick={() => setHelp(false)}>
          <div className="k-help">
            {[
              ['⌘K  /', '命令面板：搜索、跳转、执行'], ['↑ ↓  j k', '移动光标'], ['↵', '打开 / 进入'], ['⌫', '返回上级'],
              ['␣', '快速预览'], ['E', '在 WPS 中编辑'], ['D', '下载'], ['R', '重命名'], ['U', '上传'], ['N', '新建文件夹'],
              ['S', '收藏'], ['X', '多选'], ['⌘⌫', '删除（可撤销）'],
            ].map(([k, d]) => (
              <div key={k}><Kbd>{k}</Kbd> <span>{d}</span></div>
            ))}
          </div>
        </div>
      )}
      <Toaster />
    </div>
  )
}

function Palette({ commands, close }: { commands: Cmd[]; close: () => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const list = commands.filter((c) => !q || (c.label + (c.hint ?? '')).toLowerCase().includes(q.toLowerCase())).slice(0, 12)
  const run = (c?: Cmd) => c && (close(), c.run())
  let lastGroup = ''
  return (
    <div className="k-look" onClick={close}>
      <div className="k-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={ref}
          value={q}
          placeholder="输入文件名、文件夹或命令…"
          onChange={(e) => (setQ(e.target.value), setI(0))}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            if (e.key === 'ArrowDown') e.preventDefault(), setI((x) => Math.min(list.length - 1, x + 1))
            if (e.key === 'ArrowUp') e.preventDefault(), setI((x) => Math.max(0, x - 1))
            if (e.key === 'Enter') run(list[i])
          }}
        />
        <div className="k-pal-list">
          {list.map((c, j) => {
            const header = c.group !== lastGroup ? (lastGroup = c.group) : null
            return (
              <div key={c.id}>
                {header && <div className="k-label">{header}</div>}
                <div className={`k-pal-item ${j === i ? 'on' : ''}`} onMouseMove={() => setI(j)} onClick={() => run(c)}>
                  {c.icon}
                  <span>{c.label}</span>
                  <span className="k-dim small grow k-ellipsis">{c.hint && c.hint.length > 1 ? c.hint : ''}</span>
                  {c.hint?.length === 1 && <Kbd>{c.hint}</Kbd>}
                  {j === i && <CornerDownLeft size={14} />}
                </div>
              </div>
            )
          })}
          {list.length === 0 && <div className="k-empty">没有匹配项</div>}
        </div>
      </div>
    </div>
  )
}
