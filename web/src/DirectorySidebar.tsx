import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Home, Trash2, X } from 'lucide-react'
import { api } from './api/client'
import type { components } from './api/schema.gen'
import { FileIcon } from './FileIcon'

type Node = components['schemas']['TreeNode']
type Branches = Record<number, Node[]>
const narrowViewport = '(max-width: 880px)'
export const minSidebarWidth = 232
export const defaultSidebarWidth = 280
export const maxSidebarWidth = 400

type Props = {
  visible: boolean
  browsing: boolean
  rootSelected: boolean
  recycle: boolean
  recycleHref: string
  openRecycle: () => void
  openFolder: (id?: number) => void
  path: Node[]
  branches: Branches
  revision: number
  width: number
  resize: (width: number) => void
  drawerOpen: boolean
  closeDrawer: () => void
}

export function DirectorySidebar({
  visible, browsing, rootSelected, recycle, recycleHref, openRecycle, openFolder, path, branches,
  revision, width, resize, drawerOpen, closeDrawer,
}: Props) {
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowViewport).matches)
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [extraBranches, setExtraBranches] = useState<Branches>({})
  const [failed, setFailed] = useState<Set<number>>(() => new Set())
  const dialog = useRef<HTMLDialogElement>(null)
  const tree = useRef<HTMLElement>(null)
  const scrollTop = useRef(0)
  const scrolledTo = useRef<number>(undefined)
  const currentId = path.at(-1)?.id ?? 0
  const showTree = visible && (!narrow || drawerOpen)

  useEffect(() => {
    const media = window.matchMedia(narrowViewport)
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    const target = dialog.current
    if (!target) return
    if (showTree && !target.open) target.showModal()
    if (!showTree && target.open) target.close()
  }, [narrow, showTree])

  useEffect(() => {
    if (!visible && drawerOpen) closeDrawer()
  }, [visible, drawerOpen, closeDrawer])

  useEffect(() => {
    setExpanded(previous => new Set([...previous, ...path.map(node => node.id)]))
  }, [path])

  useEffect(() => {
    const extraIds = [...expanded].filter(id => branches[id] === undefined && !path.some(node => node.id === id))
    if (!extraIds.length) return
    const controller = new AbortController()
    void Promise.all(extraIds.map(async id => {
      try {
        const { data } = await api.GET('/tree', { params: { query: { parentId: id } }, signal: controller.signal })
        return [id, data] as const
      } catch {
        return [id, undefined] as const
      }
    })).then(entries => {
      if (controller.signal.aborted) return
      setExtraBranches(previous => ({ ...previous, ...Object.fromEntries(entries.map(([id, nodes]) => [id, nodes ?? []])) }))
      setFailed(new Set(entries.filter(([, nodes]) => !nodes).map(([id]) => id)))
    })
    return () => controller.abort()
  }, [expanded, branches, path, revision])

  useLayoutEffect(() => {
    if (showTree && tree.current) tree.current.scrollTop = scrollTop.current
  }, [showTree, narrow])

  useLayoutEffect(() => {
    if (!showTree || !browsing || currentId === scrolledTo.current) return
    const container = tree.current
    const row = container?.querySelector<HTMLElement>(`[data-directory-id="${currentId}"]`)
    if (!container || !row) return
    scrolledTo.current = currentId
    const frame = container.getBoundingClientRect()
    const target = row.getBoundingClientRect()
    if (target.top < frame.top) container.scrollTop += target.top - frame.top
    if (target.bottom > frame.bottom) container.scrollTop += target.bottom - frame.bottom
    scrollTop.current = container.scrollTop
  }, [showTree, browsing, currentId, branches, expanded, extraBranches])

  function toggle(id: number) {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function renderBranch(parentId: number, depth: number): ReactNode {
    const directories = (branches[parentId] ?? extraBranches[parentId])?.filter(node => !node.isFile)
    return directories?.map(node => {
      const open = expanded.has(node.id)
      const children = branches[node.id] ?? extraBranches[node.id]
      return <div key={node.id}>
        <div className="directory-row" data-directory-id={node.id} style={{ paddingInlineStart: Math.min(depth, 7) * 12 }}>
          <button type="button" className="ghost directory-toggle" aria-label={`${open ? '折叠' : '展开'} ${node.name}`}
            aria-expanded={open} onClick={() => toggle(node.id)}>
            <ChevronRight className={open ? 'expanded' : ''} size={13} />
          </button>
          <a className="sidebar-link tree-node" href={`/#item=${node.id}`} title={node.name}
            aria-current={browsing && currentId === node.id ? 'page' : undefined}
            onClick={event => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              event.preventDefault()
              closeDrawer()
              openFolder(node.id)
            }}>
            <FileIcon node={node} size={16} /><span className="ellipsis">{node.name}</span>
          </a>
        </div>
        {open && <>
          {!children && <p className="branch-feedback" role="status">正在加载目录…</p>}
          {branches[node.id] === undefined && failed.has(node.id) && <p className="branch-feedback" role="status">无法加载目录</p>}
          {renderBranch(node.id, depth + 1)}
        </>}
      </div>
    })
  }

  const contents = <>
    <nav aria-label="目录树" className="sidebar-tree" ref={tree} onScroll={event => {
      if (showTree) scrollTop.current = event.currentTarget.scrollTop
    }}>
      <a className="sidebar-link tree-root" href="/" data-directory-id="0" aria-current={rootSelected ? 'page' : undefined}
        onClick={event => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          event.preventDefault()
          closeDrawer()
          openFolder()
        }}><Home size={16} />全部文件</a>
      {renderBranch(0, 0)}
    </nav>
    <div className="sidebar-footer"><a className="sidebar-link" href={recycleHref} aria-current={recycle ? 'page' : undefined}
      onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        closeDrawer()
        openRecycle()
      }}><Trash2 size={16} />回收站</a></div>
  </>

  if (narrow) return <dialog id="file-directories" ref={dialog} className="directory-drawer" aria-labelledby="directory-title"
    onClose={closeDrawer} onClick={event => { if (event.target === event.currentTarget) closeDrawer() }}>
    <div className="directory-drawer-body">
      <div className="drawer-heading"><h2 id="directory-title">目录</h2>
        <button className="icon ghost" aria-label="关闭目录" onClick={closeDrawer}><X size={17} /></button>
      </div>
      {contents}
    </div>
  </dialog>

  return <aside className="sidebar file-sidebar" hidden={!visible}>
    <span className="sidebar-heading">目录</span>
    {contents}
    <SidebarResize width={width} resize={resize} />
  </aside>
}

function SidebarResize({ width, resize }: { width: number; resize: (width: number) => void }) {
  const drag = useRef<{ startX: number; width: number }>(undefined)
  const change = (value: number) => resize(Math.max(minSidebarWidth, Math.min(value, maxSidebarWidth)))
  return <div className="sidebar-resize" role="separator" aria-label="调整目录栏宽度" aria-orientation="vertical"
    aria-valuemin={minSidebarWidth} aria-valuemax={maxSidebarWidth} aria-valuenow={width} tabIndex={0}
    onKeyDown={event => {
      const next = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: minSidebarWidth, End: maxSidebarWidth }[event.key]
      if (next === undefined) return
      event.preventDefault()
      change(next)
    }}
    onPointerDown={event => {
      if (event.button !== 0) return
      drag.current = { startX: event.clientX, width }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={event => {
      if (drag.current) change(drag.current.width + event.clientX - drag.current.startX)
    }}
    onLostPointerCapture={() => { drag.current = undefined }} />
}
