// PROTOTYPE round 3: A1's layout and interaction model, with three motion personalities.
// The layout is shared on purpose: the question this round is how it should *move and feel*.
//
//   M1 spring  灵动  physical springs, directional navigation, staggered rows, deletes fly into the bin
//   M2 calm    克制  fast fades, cursor spotlight, skeletons and a top progress bar, nothing bounces
//   M3 glass   通透  frosted panels over an ambient gradient, depth transitions, tilting cards, floating inspector
//
// Shared interaction ideas (all three): Traversable Ancestors hidden (permitted items hoisted up),
// hover peek, lasso + shift-click selection, spring-loaded folders while dragging, drag onto the bin
// to delete, custom drag ghost, upload button that becomes a progress ring, sortable columns that
// animate, dark mode with a circular reveal, prefers-reduced-motion respected.
import { AnimatePresence, MotionConfig, motion, useMotionValue, useSpring, type Transition } from 'motion/react'
import { ArrowUp, ChevronRight, Clock, Download, FolderPlus, Info, Moon, MoreHorizontal, Pencil, RotateCcw, Search, Sun, Trash2, Upload, UserPlus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Node, ROOT } from './data'
import type { VariantProps } from './main'
import { Entry, LEVELS, allVisible, fmtSize, grantSources, level, listing, pathOf, stub, traversable } from './perm'
import { bin, mkdir, move, nextSample, remove, restore, upload, useStore, type BinItem } from './store'
import { Avatar, FakeDoc, FileIcon, Toaster, primaryAction, toast } from './ui'
import { InlineRename } from './VariantA1'
import { GrantDialog, GrantInspector, GrantMatrix, GrantPeople, type GrantProps } from './VariantGrant'
import { canManage } from './grants'
import { entryPoints } from './perm'
import { ShieldCheck } from 'lucide-react'

type Flavor = 'spring' | 'calm' | 'glass'
const MOTION: Record<Flavor, Transition> = {
  spring: { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 },
  calm: { duration: 0.14, ease: [0.2, 0, 0, 1] },
  glass: { type: 'spring', stiffness: 240, damping: 28 },
}

export const VariantM1 = (p: VariantProps) => <MotionExplorer {...p} flavor="spring" />
export const VariantM2 = (p: VariantProps) => <MotionExplorer {...p} flavor="calm" />
export const VariantM3 = (p: VariantProps) => <MotionExplorer {...p} flavor="glass" />
/** Round 3 pick: M2's calm motion everywhere, plus M1's delete-flies-into-the-bin. */
export const VariantF = (p: VariantProps) => <MotionExplorer {...p} flavor="calm" flyToBin />

// Round 4: four ways to make and explain Grants, all on F.
type GrantUI = { mount: 'modal' | 'inspector' | 'page'; C: React.ComponentType<GrantProps>; page?: string }
export const VariantP1 = (p: VariantProps) => <MotionExplorer {...p} flavor="calm" flyToBin grantUI={{ mount: 'modal', C: GrantDialog }} />
export const VariantP2 = (p: VariantProps) => <MotionExplorer {...p} flavor="calm" flyToBin grantUI={{ mount: 'inspector', C: GrantInspector }} />
export const VariantP3 = (p: VariantProps) => <MotionExplorer {...p} flavor="calm" flyToBin grantUI={{ mount: 'page', C: GrantMatrix, page: '权限总览' }} />
export const VariantP4 = (p: VariantProps) => <MotionExplorer {...p} flavor="calm" flyToBin grantUI={{ mount: 'page', C: GrantPeople, page: '按人查看权限' }} />

type Uploading = { id: number; name: string; size: number; pct: number; dir: Node }
type Ghost = { id: number; node: Node; from: DOMRect; to: DOMRect }
type SortKey = 'name' | 'modifiedBy' | 'modified' | 'size'

function MotionExplorer({ user, plugin, flavor, flyToBin = flavor === 'spring', grantUI }: VariantProps & { flavor: Flavor; flyToBin?: boolean; grantUI?: GrantUI }) {
  useStore()
  const T = MOTION[flavor]
  const [cwd, setCwd] = useState<Node>(ROOT)
  const [navDir, setNavDir] = useState(1)
  const [loading, setLoading] = useState(false)
  const [inBin, setInBin] = useState(false)
  const [sel, setSel] = useState<Set<Node>>(new Set())
  const [anchor, setAnchor] = useState<Node | null>(null)
  const [info, setInfo] = useState<Node | null>(null)
  const [editing, setEditing] = useState<Node | null>(null)
  const [menu, setMenu] = useState<{ n: Node; x: number; y: number } | null>(null)
  const [peek, setPeek] = useState<{ n: Node; x: number; y: number } | null>(null)
  const [q, setQ] = useState('')
  const [dragOver, setDragOver] = useState<Node | 'window' | 'bin' | null>(null)
  const [draggingIds, setDraggingIds] = useState<Set<string>>(new Set())
  const [ups, setUps] = useState<Uploading[]>([])
  const [glow, setGlow] = useState<Set<string>>(new Set())
  const [ghosts, setGhosts] = useState<Ghost[]>([])
  const [binBump, setBinBump] = useState(0)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [lasso, setLasso] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [grantFor, setGrantFor] = useState<Node | null>(null)
  const openGrant = (n: Node) => (grantUI?.mount === 'inspector' ? setInfo(n) : setGrantFor(n))
  const managesSomething = user.admin || entryPoints(user).some((e) => level(user, e) >= 4)
  const grantPage = grantUI?.mount === 'page' && grantFor

  const dragging = useRef<Node[]>([])
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const binRef = useRef<HTMLDivElement>(null)
  const peekTimer = useRef(0)
  const springTimer = useRef<{ target: Node; t: number } | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)

  const canWrite = cwd !== ROOT && level(user, cwd) >= 3
  const active = ups.filter((u) => u.pct < 100)
  const crumbs = pathOf(cwd).filter((n) => n === ROOT || !traversable(user, n))

  // ---------- navigation ----------
  const go = (n: Node) => {
    setNavDir(pathOf(n).length >= pathOf(cwd).length ? 1 : -1)
    if (flavor === 'calm') {
      setLoading(true)
      setTimeout(() => setLoading(false), 320)
    }
    setCwd(n)
    setGrantFor(null)
    setInBin(false)
    setSel(new Set())
    setQ('')
    setMenu(null)
    setPeek(null)
  }
  const open = (n: Node) => (n.type === 'dir' ? go(n) : stub(primaryAction(user, n, plugin).label, n))

  // ---------- rows ----------
  const entries: Entry[] = q
    ? allVisible(user)
        .filter((n) => !traversable(user, n) && n.name.toLowerCase().includes(q.toLowerCase()))
        .map((node) => ({ node, via: pathOf(node).slice(1, -1) }))
    : listing(user, cwd)
  entries.sort((a, b) => {
    if (a.node.type !== b.node.type) return a.node.type === 'dir' ? -1 : 1
    const k = sort.key
    const av = a.node[k], bv = b.node[k]
    return (typeof av === 'number' ? av - (bv as number) : String(av).localeCompare(String(bv), 'zh')) * sort.dir
  })
  const rows = entries.map((e) => e.node)
  const recent = allVisible(user)
    .filter((n) => n.type === 'file' && !traversable(user, n))
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, 4)

  // ---------- selection ----------
  const clickSelect = (n: Node, e: React.MouseEvent) => {
    if (e.shiftKey && anchor) {
      const [a, b] = [rows.indexOf(anchor), rows.indexOf(n)].sort((x, y) => x - y)
      setSel(new Set(rows.slice(a, b + 1)))
      return
    }
    setAnchor(n)
    setSel((s) => {
      const t = new Set(s)
      t.has(n) ? t.delete(n) : t.add(n)
      return t
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return
      if (e.key === 'Escape') setSel(new Set()), setInfo(null), setMenu(null)
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') e.preventDefault(), setSel(new Set(rows))
      if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && sel.size) del([...sel])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // lasso selection, started from empty space in the main pane
  const startLasso = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    if (e.button !== 0 || t.closest('.m-tr, button, a, input, .m-quick-card, .m-crumbs')) return
    const base = e.shiftKey ? new Set(sel) : new Set<Node>()
    const x0 = e.clientX, y0 = e.clientY
    setLasso({ x0, y0, x1: x0, y1: y0 })
    setInfo(null)
    const onMove = (m: MouseEvent) => {
      const r = { l: Math.min(x0, m.clientX), r: Math.max(x0, m.clientX), t: Math.min(y0, m.clientY), b: Math.max(y0, m.clientY) }
      setLasso({ x0, y0, x1: m.clientX, y1: m.clientY })
      const next = new Set(base)
      for (const n of rows) {
        const el = rowRefs.current.get(n.id)
        if (!el) continue
        const b = el.getBoundingClientRect()
        if (b.right > r.l && b.left < r.r && b.bottom > r.t && b.top < r.b) next.add(n)
      }
      setSel(next)
    }
    const onUp = () => (setLasso(null), window.removeEventListener('mousemove', onMove), window.removeEventListener('mouseup', onUp))
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ---------- mutations ----------
  const del = (nodes: Node[]) => {
    nodes = nodes.filter((n) => level(user, n) >= 4)
    if (!nodes.length) return toast('删除需要“管理”权限')
    if (flyToBin && binRef.current) {
      const to = binRef.current.getBoundingClientRect()
      const fresh = nodes
        .map((n, i) => ({ id: Date.now() + i, node: n, from: rowRefs.current.get(n.id)?.getBoundingClientRect(), to }))
        .filter((g): g is Ghost => !!g.from)
      setGhosts((g) => [...g, ...fresh])
    } else setBinBump((b) => b + 1)
    const items = remove(nodes, user.name)
    setSel(new Set())
    setInfo(null)
    toast(`已将 ${nodes.length === 1 ? `“${nodes[0].name}”` : `${nodes.length} 项`}移到回收站`, { label: '撤销', run: () => restore(items) })
  }

  const startUpload = (files: [string, number][], dir = cwd) =>
    setUps((l) => [...l.filter((u) => u.pct < 100), ...files.map(([name, size], i) => ({ id: Date.now() + i, name, size, pct: 0, dir }))])

  useEffect(() => {
    if (!active.length) return
    const t = setInterval(() => {
      setUps((list) =>
        list.map((u) => {
          if (u.pct >= 100) return u
          const pct = Math.min(100, u.pct + 6 + Math.random() * 18)
          if (pct === 100) {
            const r = upload(u.dir, u.name, u.size, user.name)
            flashGlow(r.node)
            if (r.newVersion) toast(`“${u.name}”已存在，已保存为新版本 v${r.node.versions![0].v}`, { label: '查看版本', run: () => setInfo(r.node) })
          }
          return { ...u, pct }
        }),
      )
    }, 220)
    return () => clearInterval(t)
  }, [active.length, user.name])

  const flashGlow = (n: Node) => {
    setGlow((g) => new Set([...g, n.id]))
    setTimeout(() => setGlow((g) => new Set([...g].filter((x) => x !== n.id))), 2200)
  }

  const newFolder = () => {
    const n = mkdir(cwd, user.name)
    flashGlow(n)
    setEditing(n)
  }

  // ---------- drag and drop ----------
  const clearSpring = () => {
    if (springTimer.current) clearTimeout(springTimer.current.t)
    springTimer.current = null
  }
  const dropProps = (target: Node) =>
    target === ROOT || level(user, target) < 3
      ? {}
      : {
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault()
            e.stopPropagation()
            setDragOver(target)
            // spring-loaded folders: hover while dragging to open
            if (target !== cwd && springTimer.current?.target !== target) {
              clearSpring()
              springTimer.current = { target, t: window.setTimeout(() => go(target), 900) }
            }
          },
          onDragLeave: () => (setDragOver(null), clearSpring()),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault()
            e.stopPropagation()
            clearSpring()
            setDragOver(null)
            if (e.dataTransfer.files.length) return startUpload([...e.dataTransfer.files].map((f) => [f.name, f.size]), target)
            const moved = dragging.current.map((n) => [n, n.parent!] as const).filter(([n]) => move(n, target))
            if (moved.length) {
              setSel(new Set())
              toast(`已移动 ${moved.length} 项到“${target.name}”`, { label: '撤销', run: () => moved.forEach(([n, from]) => move(n, from)) })
            }
          },
        }

  const onRowDragStart = (e: React.DragEvent, n: Node) => {
    const list = sel.has(n) ? [...sel] : [n]
    dragging.current = list
    setDraggingIds(new Set(list.map((x) => x.id)))
    const ghost = document.createElement('div')
    ghost.className = `m-drag-ghost ${list.length > 1 ? 'stack' : ''}`
    ghost.innerHTML = `<span>${list[0].name}</span>${list.length > 1 ? `<b>${list.length}</b>` : ''}`
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 18, 18)
    setTimeout(() => ghost.remove())
  }
  const onRowDragEnd = () => (setDraggingIds(new Set()), setDragOver(null), clearSpring())

  // ---------- peek ----------
  const peekIn = (n: Node, e: React.MouseEvent) => {
    if (n.type !== 'file' || draggingIds.size) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    peekTimer.current = window.setTimeout(() => setPeek({ n, x: r.left, y: r.bottom + 6 }), 500)
  }
  const peekOut = () => (clearTimeout(peekTimer.current), setPeek(null))

  // ---------- theme with circular reveal ----------
  const toggleTheme = (e: React.MouseEvent) => {
    const next = theme === 'light' ? 'dark' : 'light'
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } }
    if (!doc.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return setTheme(next)
    const { clientX: x, clientY: y } = e
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
    doc.startViewTransition(() => flushSync(() => setTheme(next))).ready.then(() =>
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 550, easing: 'cubic-bezier(.2,0,0,1)', pseudoElement: '::view-transition-new(root)' },
      ),
    )
  }

  // ---------- per-flavor animation recipes ----------
  const pageVariants = {
    spring: { enter: (d: number) => ({ x: 28 * d, opacity: 0 }), center: { x: 0, opacity: 1 }, exit: (d: number) => ({ x: -28 * d, opacity: 0 }) },
    calm: { enter: { opacity: 0 }, center: { opacity: 1 }, exit: { opacity: 0 } },
    glass: {
      enter: (d: number) => ({ scale: d > 0 ? 0.97 : 1.03, opacity: 0, filter: 'blur(6px)' }),
      center: { scale: 1, opacity: 1, filter: 'blur(0px)' },
      exit: (d: number) => ({ scale: d > 0 ? 1.02 : 0.98, opacity: 0, filter: 'blur(4px)' }),
    },
  }[flavor]
  const rowAnim = (i: number) =>
    ({
      spring: { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0, transition: { ...T, delay: Math.min(i, 12) * 0.03 } } },
      calm: { initial: { opacity: 0 }, animate: { opacity: 1 } },
      glass: { initial: { opacity: 0, y: 6, filter: 'blur(4px)' }, animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { ...T, delay: Math.min(i, 12) * 0.02 } } },
    })[flavor]
  const rowExit = {
    spring: { opacity: 0, height: 0, x: -12 },
    calm: { opacity: 0, height: 0 },
    glass: { opacity: 0, height: 0, scale: 0.96, filter: 'blur(8px)' },
  }[flavor]

  // ---------- render ----------
  const Tree = ({ n, depth, via = [] }: { n: Node; depth: number; via?: Node[] }) => {
    const ch = listing(user, n).filter((e) => e.node.type === 'dir')
    const onPath = pathOf(cwd).includes(n)
    return (
      <>
        <div
          className={`m-tree-row ${cwd === n && !inBin ? 'active' : ''} ${dragOver === n ? 'drop' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => go(n)}
          {...dropProps(n)}
        >
          {cwd === n && !inBin && <motion.span layoutId="tree-active" className="m-tree-active-bg" transition={T} />}
          <motion.span animate={{ rotate: onPath && ch.length ? 90 : 0 }} transition={T} className="m-chev-w" style={{ visibility: ch.length ? 'visible' : 'hidden' }}>
            <ChevronRight size={14} />
          </motion.span>
          {n === ROOT ? <span className="m-tree-home">🏠</span> : <FileIcon n={n} size={16} />}
          <span className="m-tree-label">
            {n === ROOT ? '全部文件' : n.name}
            {via.length > 0 && <span className="m-via">{via.map((v) => v.name).join(' › ')}</span>}
          </span>
        </div>
        <AnimatePresence initial={false}>
          {(onPath || n === ROOT) && ch.length > 0 && (
            <motion.div key="kids" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={T} style={{ overflow: 'hidden' }}>
              {ch.map((c) => <Tree key={c.node.id} n={c.node} via={c.via} depth={depth + 1} />)}
            </motion.div>
          )}
        </AnimatePresence>
      </>
    )
  }

  const overall = active.length ? active.reduce((a, u) => a + u.pct, 0) / active.length : 0

  return (
    <MotionConfig reducedMotion="user" transition={T}>
      <div
        className={`m-shell mx ${flavor} ${theme}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files') && canWrite) e.preventDefault(), dragOver !== 'window' && !(dragOver instanceof Object) && setDragOver('window')
        }}
        onDrop={(e) => {
          e.preventDefault()
          if (e.dataTransfer.files.length && canWrite) startUpload([...e.dataTransfer.files].map((f) => [f.name, f.size]))
          setDragOver(null)
        }}
        onClick={() => setMenu(null)}
      >
        {flavor === 'glass' && (
          <div className="m-ambient" aria-hidden>
            <i /><i /><i />
          </div>
        )}
        <AnimatePresence>
          {loading && <motion.div className="m-topbar" initial={{ scaleX: 0, opacity: 1 }} animate={{ scaleX: 0.8 }} exit={{ scaleX: 1, opacity: 0 }} transition={{ duration: 0.3 }} />}
        </AnimatePresence>

        <header className="m-top">
          <div className="m-brand">
            <span className="m-logo">F</span> ftp-master
          </div>
          <motion.label className="m-search" layout>
            <Search size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索全部可访问的文件" />
            <AnimatePresence>{q && <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}><X size={14} onClick={() => setQ('')} style={{ cursor: 'pointer' }} /></motion.span>}</AnimatePresence>
          </motion.label>
          <motion.button className="m-btn icon ghost m-theme" whileTap={{ scale: 0.85 }} onClick={toggleTheme} title="切换深色/浅色">
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={theme} initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: 90, opacity: 0 }} style={{ display: 'grid' }}>
                {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
              </motion.span>
            </AnimatePresence>
          </motion.button>
          <div className="m-user">
            <Avatar name={user.name} size={28} />
            <div>
              <div>{user.name}</div>
              <div className="m-faint small">{user.orgLabel}</div>
            </div>
          </div>
        </header>

        <aside className="m-side">
          <AnimatePresence initial={false}>
            {canWrite && !inBin && (
              <motion.div className="m-side-actions" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                <motion.button layout className="m-btn primary grow m-upload" whileTap={{ scale: 0.96 }} title="也可以直接把文件拖进窗口" onClick={() => startUpload([nextSample()])}>
                  {active.length ? (
                    <>
                      <Ring pct={overall} /> 上传中 {ups.length - active.length}/{ups.length}
                    </>
                  ) : (
                    <>
                      <Upload size={16} /> 上传
                    </>
                  )}
                </motion.button>
                <motion.button className="m-btn icon" whileTap={{ scale: 0.9 }} title="新建文件夹" onClick={newFolder}>
                  <FolderPlus size={16} />
                </motion.button>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="m-tree">
            <Tree n={ROOT} depth={0} />
          </div>
          {grantUI?.page && managesSomething && (
            <div className={`m-tree-row m-bin ${grantPage ? 'active' : ''}`} onClick={() => (setInBin(false), setInfo(null), setGrantFor(cwd))}>
              <ShieldCheck size={16} /> {grantUI.page}
            </div>
          )}
          <div
            ref={binRef}
            className={`m-tree-row m-bin ${inBin ? 'active' : ''} ${dragOver === 'bin' ? 'drop danger' : ''}`}
            onClick={() => (setInBin(true), setGrantFor(null), setInfo(null), setSel(new Set()))}
            onDragOver={(e) => {
              if (dragging.current.length && dragging.current.every((n) => level(user, n) >= 4)) e.preventDefault(), setDragOver('bin')
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => (e.preventDefault(), setDragOver(null), del(dragging.current))}
          >
            <motion.span
              key={binBump}
              animate={dragOver === 'bin' ? { rotate: -14, scale: 1.25 } : { rotate: 0, scale: binBump ? [1.4, 1] : 1 }}
              transition={{ type: 'spring', stiffness: 600, damping: 14 }}
              style={{ display: 'grid' }}
            >
              <Trash2 size={16} />
            </motion.span>
            {dragOver === 'bin' ? '松开删除' : '回收站'}
            <span className="m-count">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={bin.length} initial={{ y: -10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 10, opacity: 0 }} style={{ display: 'inline-block' }}>
                  {bin.length}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
        </aside>

        <main className="m-main" onMouseDown={grantPage ? undefined : startLasso}>
          {grantPage && grantUI ? (
            <grantUI.C key={grantFor.id} n={grantFor} user={user} close={() => setGrantFor(null)} go={go} />
          ) : (
          <AnimatePresence mode="wait" custom={navDir} initial={false}>
            <motion.div
              key={inBin ? 'bin' : q ? 'search' : cwd.id}
              custom={navDir}
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={flavor === 'calm' ? { duration: 0.1 } : T}
            >
              {inBin ? (
                <BinView flavor={flavor} />
              ) : (
                <>
                  <div className="m-crumbs">
                    {q ? (
                      <span>“{q}”的搜索结果 · {rows.length} 项</span>
                    ) : (
                      crumbs.map((n, i) => (
                        <span key={n.id} className="m-crumb-wrap">
                          {i > 0 && <ChevronRight size={14} className="m-faint" />}
                          <a className={`m-crumb ${dragOver === n ? 'drop' : ''}`} onClick={() => go(n)} {...dropProps(n)}>
                            {n === ROOT ? '全部文件' : n.name}
                          </a>
                        </span>
                      ))
                    )}
                    {!q && cwd !== ROOT && <span className="m-perm-pill">你可{LEVELS[level(user, cwd)]}</span>}
                    {!q && grantUI && canManage(user, cwd) && (
                      <button className="m-btn sm ghost" onClick={() => openGrant(cwd)}><UserPlus size={14} /> 授权</button>
                    )}
                  </div>

                  {cwd === ROOT && !q && recent.length > 0 && (
                    <section className="m-quick">
                      <div className="m-section-title"><Clock size={14} /> 最近编辑</div>
                      <div className="m-quick-row">
                        {recent.map((n, i) => (
                          <QuickCard key={n.id} n={n} i={i} flavor={flavor} onOpen={() => open(n)} />
                        ))}
                      </div>
                    </section>
                  )}

                  <div
                    ref={tableRef}
                    className="m-table"
                    onMouseMove={(e) => {
                      if (flavor !== 'calm' || !tableRef.current) return
                      const r = tableRef.current.getBoundingClientRect()
                      tableRef.current.style.setProperty('--mx', `${e.clientX - r.left}px`)
                      tableRef.current.style.setProperty('--my', `${e.clientY - r.top}px`)
                    }}
                  >
                    <div className="m-tr m-th">
                      <span />
                      {([['name', '名称'], ['modifiedBy', '修改人'], ['modified', '修改时间'], ['size', '大小']] as const).map(([k, label]) => (
                        <span key={k} className={`m-sort ${sort.key === k ? 'on' : ''}`} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (-s.dir as 1 | -1) : 1 }))}>
                          {label}
                          {sort.key === k && (
                            <motion.span animate={{ rotate: sort.dir === 1 ? 0 : 180 }} style={{ display: 'inline-grid' }}>
                              <ArrowUp size={12} />
                            </motion.span>
                          )}
                        </span>
                      ))}
                      <span />
                    </div>
                    {loading ? (
                      Array.from({ length: 5 }, (_, i) => (
                        <div key={i} className="m-tr m-skel">
                          <span /><span><i style={{ width: `${40 + ((i * 23) % 35)}%` }} /></span><span><i /></span><span><i /></span><span><i /></span><span />
                        </div>
                      ))
                    ) : (
                      <AnimatePresence initial={true}>
                        {entries.map(({ node: n, via }, i) => {
                          const l = level(user, n)
                          const pa = primaryAction(user, n, plugin)
                          const checked = sel.has(n)
                          const springing = dragOver === n && n.type === 'dir'
                          return (
                            <motion.div
                              key={n.id}
                              layout="position"
                              className="m-row-wrap"
                              ref={(el: HTMLDivElement | null) => void (el ? rowRefs.current.set(n.id, el) : rowRefs.current.delete(n.id))}
                              {...rowAnim(i)}
                              exit={rowExit}
                            >
                            <div
                              className={`m-tr ${checked ? 'sel' : ''} ${dragOver === n ? 'drop' : ''} ${sel.size ? 'selecting' : ''} ${glow.has(n.id) ? 'glow' : ''} ${draggingIds.has(n.id) ? 'dragging' : ''}`}
                              draggable={l >= 3}
                              onDragStart={(e) => onRowDragStart(e, n)}
                              onDragEnd={onRowDragEnd}
                              {...(n.type === 'dir' ? dropProps(n) : {})}
                              onClick={(e) => (sel.size || e.shiftKey ? clickSelect(n, e) : setInfo(info === n ? null : n))}
                            >
                              {springing && <span className="m-spring-fill" />}
                              <span className="m-check" onClick={(e) => (e.stopPropagation(), clickSelect(n, e))}>
                                <Check on={checked} />
                              </span>
                              <span className="m-name">
                                <FileIcon n={n} />
                                {editing === n ? (
                                  <InlineRename n={n} done={() => setEditing(null)} />
                                ) : (
                                  <a onClick={(e) => (e.stopPropagation(), peekOut(), open(n))} onMouseEnter={(e) => peekIn(n, e)} onMouseLeave={peekOut}>
                                    <Highlight text={n.name} q={q} />
                                  </a>
                                )}
                                {via.length > 0 && <span className="m-via">{via.map((v) => v.name).join(' › ')}</span>}
                                {n.versions?.[0]?.stale && <span className="m-tag warn">过期保存</span>}
                              </span>
                              <span className="m-who"><Avatar name={n.modifiedBy} size={20} /> {n.modifiedBy}</span>
                              <span className="m-faint">{n.modified.slice(5)}</span>
                              <span className="m-faint">{n.type === 'dir' ? '' : fmtSize(n.size)}</span>
                              <span className="m-row-actions" onClick={(e) => e.stopPropagation()}>
                                {n.type === 'file' && pa.key !== 'download' && (
                                  <motion.button whileTap={{ scale: 0.92 }} className={`m-btn sm ${pa.key === 'office' ? 'primary' : ''}`} onClick={() => open(n)}>
                                    {pa.label}
                                  </motion.button>
                                )}
                                {l >= 2 && (
                                  <motion.button whileTap={{ scale: 0.85 }} className="m-btn icon sm" title="下载" onClick={() => stub('下载', n)}>
                                    <Download size={15} />
                                  </motion.button>
                                )}
                                <motion.button
                                  whileTap={{ scale: 0.85 }}
                                  className="m-btn icon sm"
                                  title="更多"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                                    setMenu(menu?.n === n ? null : { n, x: r.right, y: r.bottom + 6 })
                                  }}
                                >
                                  <MoreHorizontal size={15} />
                                </motion.button>
                              </span>
                            </div>
                            </motion.div>
                          )
                        })}
                      </AnimatePresence>
                    )}
                    {!loading && rows.length === 0 && (
                      <div className="m-empty-anim">
                        <motion.div animate={{ y: [0, -6, 0] }} transition={{ repeat: Infinity, duration: 2.4, ease: 'easeInOut' }}>
                          <Upload size={28} />
                        </motion.div>
                        {canWrite ? '把文件拖到这里上传' : '这里还没有内容'}
                      </div>
                    )}
                  </div>
                  <div className="m-lasso-hint">在空白处拖动可框选 · Shift 点击连选 · ⌘A 全选</div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
          )}
        </main>

        <AnimatePresence>
          {info && !inBin && (
            <motion.div
              key="insp"
              className="m-insp-wrap"
              initial={flavor === 'glass' ? { opacity: 0, x: 30, scale: 0.97 } : { width: 0, opacity: 0 }}
              animate={flavor === 'glass' ? { opacity: 1, x: 0, scale: 1 } : { width: 340, opacity: 1 }}
              exit={flavor === 'glass' ? { opacity: 0, x: 30, scale: 0.97 } : { width: 0, opacity: 0 }}
            >
              <Inspector n={info} user={user} close={() => setInfo(null)} grantUI={grantUI} openGrant={() => setGrantFor(info)} go={go} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* floating layers */}
        <AnimatePresence>
          {sel.size > 0 && (
            <motion.div className="m-selbar" style={{ x: '-50%' }} initial={{ y: 30, opacity: 0, scale: 0.95 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 30, opacity: 0, scale: 0.95 }}>
              <b>
                已选{' '}
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span key={sel.size} initial={{ y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 8, opacity: 0 }} style={{ display: 'inline-block' }}>
                    {sel.size}
                  </motion.span>
                </AnimatePresence>{' '}
                项
              </b>
              <button className="m-btn ghost" onClick={() => stub(`打包下载 ${sel.size} 项`)}><Download size={15} /> 下载</button>
              {[...sel].every((n) => level(user, n) >= 4) && (
                <button className="m-btn ghost danger" onClick={() => del([...sel])}><Trash2 size={15} /> 删除</button>
              )}
              <span className="m-faint small">拖到文件夹移动 · 拖到回收站删除</span>
              <button className="m-btn icon ghost" onClick={() => setSel(new Set())}><X size={15} /></button>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {menu && (
            <motion.div
              className="m-menu fixed"
              style={{ left: menu.x - 210, top: menu.y, transformOrigin: 'top right' }}
              initial={{ opacity: 0, scale: 0.92, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.12 }}
              onClick={(e) => e.stopPropagation()}
            >
              <a onClick={() => (setInfo(menu.n), setMenu(null))}><Info size={14} /> 详情与版本</a>
              {level(user, menu.n) >= 3 && <a onClick={() => (setEditing(menu.n), setMenu(null))}><Pencil size={14} /> 重命名</a>}
              {level(user, menu.n) >= 4 && <a onClick={() => (grantUI ? openGrant(menu.n) : setInfo(menu.n), setMenu(null))}><UserPlus size={14} /> 授权</a>}
              {level(user, menu.n) >= 4 && <a className="danger" onClick={() => (del([menu.n]), setMenu(null))}><Trash2 size={14} /> 删除</a>}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {peek && (
            <motion.div
              className="m-peek"
              style={{ left: peek.x, top: peek.y, transformOrigin: 'top left' }}
              initial={{ opacity: 0, scale: 0.9, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.1 } }}
            >
              <div className="m-peek-doc"><FakeDoc n={peek.n} /></div>
              <div className="m-peek-meta">
                <b>{peek.n.name}</b>
                <span className="m-faint small">{peek.n.modifiedBy} · {peek.n.modified} · {fmtSize(peek.n.size)}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {ghosts.map((g) => (
          <motion.div
            key={g.id}
            className="m-ghost"
            initial={{ left: g.from.left, top: g.from.top, width: g.from.width, height: g.from.height, opacity: 1, borderRadius: 8 }}
            animate={{ left: g.to.left + 8, top: g.to.top + 4, width: 24, height: 24, opacity: 0.2, borderRadius: 12 }}
            transition={{ duration: 0.55, ease: [0.5, 0, 0.2, 1] }}
            onAnimationComplete={() => (setGhosts((gs) => gs.filter((x) => x !== g)), setBinBump((b) => b + 1))}
          >
            <FileIcon n={g.node} size={16} /> <span>{g.node.name}</span>
          </motion.div>
        ))}

        {lasso && (
          <div
            className="m-lasso"
            style={{ left: Math.min(lasso.x0, lasso.x1), top: Math.min(lasso.y0, lasso.y1), width: Math.abs(lasso.x1 - lasso.x0), height: Math.abs(lasso.y1 - lasso.y0) }}
          />
        )}

        <AnimatePresence>
          {dragOver === 'window' && (
            <motion.div className="m-drop-overlay" initial={{ opacity: 0, scale: 1.03 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.02 }}>
              <motion.div animate={{ y: [0, -10, 0] }} transition={{ repeat: Infinity, duration: 1.2, ease: 'easeInOut' }}>
                <Upload size={44} />
              </motion.div>
              <div>松开即可上传到“{cwd.name}”</div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {ups.length > 0 && (
            <motion.div className="m-uptray" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}>
              <div className="m-uptray-head">
                {active.length ? `正在上传 ${active.length} 个文件` : `${ups.length} 个文件已上传`}
                <X size={14} onClick={() => setUps([])} style={{ cursor: 'pointer' }} />
              </div>
              {ups.map((u) => (
                <motion.div key={u.id} className="m-up" layout initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}>
                  <span className="m-ellipsis">{u.name}</span>
                  <span className="m-faint small">{u.pct >= 100 ? '✓ 完成' : `${Math.round(u.pct)}%`}</span>
                  <div className="m-bar">
                    <motion.i animate={{ width: `${u.pct}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} className={u.pct >= 100 ? 'done' : ''} />
                  </div>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {grantUI?.mount === 'modal' && grantFor && <grantUI.C key="grant" n={grantFor} user={user} close={() => setGrantFor(null)} go={go} />}
        </AnimatePresence>
        <Toaster />
      </div>
    </MotionConfig>
  )
}

function Ring({ pct }: { pct: number }) {
  const C = 2 * Math.PI * 7
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" style={{ transform: 'rotate(-90deg)' }}>
      <circle cx="9" cy="9" r="7" fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="2.5" />
      <motion.circle cx="9" cy="9" r="7" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={C} animate={{ strokeDashoffset: C * (1 - pct / 100) }} />
    </svg>
  )
}

function Check({ on }: { on: boolean }) {
  return (
    <motion.span className={`m-cb ${on ? 'on' : ''}`} animate={{ scale: on ? [0.85, 1.1, 1] : 1 }} transition={{ duration: 0.25 }}>
      <svg viewBox="0 0 16 16" width="12" height="12">
        <motion.path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" initial={false} animate={{ pathLength: on ? 1 : 0 }} transition={{ duration: 0.2 }} />
      </svg>
    </motion.span>
  )
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

function QuickCard({ n, i, flavor, onOpen }: { n: Node; i: number; flavor: Flavor; onOpen: () => void }) {
  const rx = useSpring(useMotionValue(0), { stiffness: 300, damping: 20 })
  const ry = useSpring(useMotionValue(0), { stiffness: 300, damping: 20 })
  const tilt = flavor === 'glass'
  return (
    <motion.div
      className="m-quick-card"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0, transition: { delay: i * 0.05 } }}
      whileHover={flavor === 'spring' ? { y: -4, scale: 1.02 } : flavor === 'calm' ? { borderColor: 'var(--accent)' } : undefined}
      whileTap={{ scale: 0.98 }}
      style={tilt ? { rotateX: rx, rotateY: ry, transformPerspective: 600 } : undefined}
      onMouseMove={(e) => {
        if (!tilt) return
        const r = e.currentTarget.getBoundingClientRect()
        ry.set(((e.clientX - r.left) / r.width - 0.5) * 14)
        rx.set(-((e.clientY - r.top) / r.height - 0.5) * 14)
      }}
      onMouseLeave={() => (rx.set(0), ry.set(0))}
      onClick={onOpen}
    >
      <FileIcon n={n} size={28} />
      <div className="m-ellipsis">{n.name}</div>
      <div className="m-faint small">{n.modifiedBy} · {n.modified.slice(5)}</div>
    </motion.div>
  )
}

function BinView({ flavor }: { flavor: Flavor }) {
  const back = (b: BinItem) => (restore([b]), toast(`已还原“${b.name}”`))
  return (
    <>
      <div className="m-crumbs">回收站 <span className="m-faint small" style={{ fontWeight: 400 }}>删除的内容保留 30 天后自动清除</span></div>
      <div className="m-table">
        <AnimatePresence>
          {bin.map((b, i) => (
            <motion.div
              key={b.name + b.at}
              layout
              className="m-tr bin"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: { delay: i * 0.03 } }}
              exit={flavor === 'spring' ? { opacity: 0, x: 60, height: 0 } : { opacity: 0, height: 0 }}
              style={{ overflow: 'clip' }}
            >
              <span />
              <span className="m-name">{b.name}<span className="m-via">{b.from}</span></span>
              <span className="m-who"><Avatar name={b.by} size={20} /> {b.by}</span>
              <span className="m-faint">{b.at.slice(5)}</span>
              <span className="m-faint">{b.purgeIn}后清除</span>
              <span className="m-row-actions show">
                <motion.button whileTap={{ scale: 0.92 }} className="m-btn sm" onClick={() => back(b)}><RotateCcw size={14} /> 还原</motion.button>
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
        {bin.length === 0 && <div className="m-empty-anim">回收站是空的</div>}
      </div>
    </>
  )
}

function Inspector({ n, user, close, grantUI, openGrant, go }: { n: Node; user: VariantProps['user']; close: () => void; grantUI?: GrantUI; openGrant: () => void; go: (n: Node) => void }) {
  return (
    <aside className="m-insp">
      <AnimatePresence mode="wait">
        <motion.div key={n.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }}>
          <div className="m-insp-head">
            <FileIcon n={n} size={36} />
            <div className="grow">
              <b>{n.name}</b>
              <div className="m-faint small">你可{LEVELS[level(user, n)]}</div>
            </div>
            <X size={16} onClick={close} style={{ cursor: 'pointer' }} />
          </div>
          {n.type === 'file' && (
            <div className="m-insp-preview">
              <FakeDoc n={n} />
            </div>
          )}
          {grantUI?.mount === 'inspector' ? (
            <grantUI.C n={n} user={user} close={close} go={go} />
          ) : (
          <>
          <div className="m-section-title">谁能访问</div>
          {grantSources(n).map(({ grant, from }, i) => (
            <motion.div key={i} className="m-grant" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0, transition: { delay: 0.05 + i * 0.04 } }}>
              <Avatar name={grant.label} size={24} />
              <div className="grow">
                {grant.label}
                <div className="m-faint small">{from === n ? '直接授权' : `继承自 ${from.name}`}</div>
              </div>
              <span className="m-tag">{LEVELS[grant.level]}</span>
            </motion.div>
          ))}
          {level(user, n) >= 4 && <button className="m-btn ghost" onClick={() => (grantUI ? openGrant() : stub('添加授权', n))}><UserPlus size={15} /> {grantUI ? '管理授权' : '添加授权'}</button>}
          </>
          )}
          {n.versions && (
            <>
              <div className="m-section-title">版本</div>
              <div className="m-timeline">
                {n.versions.map((v, i) => (
                  <motion.div key={v.v} className="m-ver" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0, transition: { delay: 0.1 + i * 0.05 } }}>
                    <span className={`m-ver-dot ${i === 0 ? 'now' : ''} ${v.stale ? 'warn' : ''}`} />
                    <div className="grow">
                      v{v.v} · {v.by} {i === 0 && <span className="m-tag">当前</span>}
                      {v.stale && <span className="m-tag warn">过期保存</span>}
                      <div className="m-faint small">{v.at} · {fmtSize(v.size)}</div>
                    </div>
                    {i > 0 && level(user, n) >= 3 && <a className="small" onClick={() => stub(`恢复 v${v.v}`, n)}>恢复</a>}
                  </motion.div>
                ))}
              </div>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </aside>
  )
}
