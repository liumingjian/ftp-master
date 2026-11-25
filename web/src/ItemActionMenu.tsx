import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FolderInput, History, Info, KeyRound, Link2, Pencil, PencilLine, ShieldCheck, Trash2 } from 'lucide-react'
import { editableOfficeVersion, officeMissingPluginMessage } from './FileViewer'
import { canEditText } from './TextEditor'
import { editQuotaWarning } from './quota'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']
export type InspectorTab = 'overview' | 'versions' | 'permission'
export type MenuAnchor =
  | { kind: 'button'; rect: DOMRect }
  | { kind: 'point'; x: number; y: number }

const BROWSE = 1
const MODIFY = 8
const DELETE = 16
const GRANT = 32

export function ItemActionMenu({
  node,
  anchor,
  officeEditing,
  canMove,
  availableQuotaBytes,
  onClose,
  onEditText,
  onOfficeEditOpen,
  onCopyLink,
  onRename,
  onMove,
  onManageGrants,
  onInspect,
  onRecycle,
}: {
  node: Node
  anchor: MenuAnchor
  officeEditing: boolean
  canMove: boolean
  availableQuotaBytes?: number | null
  onClose: (restoreFocus?: boolean) => void
  onEditText: (node: Node) => void
  onOfficeEditOpen: () => void
  onCopyLink: (node: Node) => void
  onRename: (node: Node) => void
  onMove: (node: Node) => void
  onManageGrants: (node: Node) => void
  onInspect: (node: Node, tab: InspectorTab) => void
  onRecycle: (node: Node) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number; origin: string }>(() =>
    anchor.kind === 'point'
      ? { left: anchor.x, top: anchor.y, origin: 'top left' }
      : { left: anchor.rect.right, top: anchor.rect.bottom + 4, origin: 'top right' },
  )

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const margin = 12
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    let left = anchor.kind === 'point' ? anchor.x : anchor.rect.right - width
    let top = anchor.kind === 'point' ? anchor.y : anchor.rect.bottom + 4
    let horizontalOrigin: 'left' | 'right' = anchor.kind === 'point' ? 'left' : 'right'
    let verticalOrigin: 'top' | 'bottom' = 'top'

    if (left + width > viewportWidth - margin) {
      left = Math.max(margin, viewportWidth - width - margin)
      if (anchor.kind === 'point') horizontalOrigin = 'right'
    }
    if (left < margin) {
      left = margin
      horizontalOrigin = 'left'
    }
    if (top + height > viewportHeight - margin) {
      top = anchor.kind === 'point'
        ? Math.max(margin, anchor.y - height)
        : Math.max(margin, anchor.rect.top - height - 4)
      verticalOrigin = 'bottom'
    }
    setPosition({ left, top, origin: `${verticalOrigin} ${horizontalOrigin}` })
    const first = menu.querySelector<HTMLElement>('[role="menuitem"]')
    first?.focus({ preventScroll: true })
  }, [anchor, node.id])

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current && event.target instanceof Element && menuRef.current.contains(event.target)) return
      onClose(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose(true)
        return
      }
      const menu = menuRef.current
      if (!menu) return
      const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      if (!items.length) return
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        items[(index + 1 + items.length) % items.length]?.focus()
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        items[(index - 1 + items.length) % items.length]?.focus()
      } else if (event.key === 'Home') {
        event.preventDefault()
        items[0]?.focus()
      } else if (event.key === 'End') {
        event.preventDefault()
        items[items.length - 1]?.focus()
      }
    }
    function onViewportChange() {
      onClose(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [onClose])

  const officeVersion = officeEditing ? editableOfficeVersion(node) : undefined
  const editWarning = node.latestVersion ? editQuotaWarning(availableQuotaBytes, node.latestVersion.size) : undefined

  const group1: ReactNode[] = []
  if (canEditText(node)) {
    group1.push(
      <button key="edit-text" type="button" role="menuitem" className={editWarning ? 'quota-tight' : undefined}
        title={editWarning} onClick={() => { onClose(false); onEditText(node) }}>
        <Pencil size={16} aria-hidden="true" />编辑文本
      </button>,
    )
  }
  if (officeVersion) {
    group1.push(
      <a key="edit-office" role="menuitem" className={editWarning ? 'item-menu-link quota-tight' : 'item-menu-link'}
        href={`/api/files/${node.id}/office-edits`} title={editWarning}
        data-ftp-office-edit="1" data-ftp-office-version={officeVersion.id} target="_blank" rel="noopener"
        onAuxClick={event => event.preventDefault()}
        onClick={event => {
          const editorHandledClick = event.defaultPrevented
          event.preventDefault()
          onClose(false)
          if (editorHandledClick) onOfficeEditOpen()
          else if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            window.alert(officeMissingPluginMessage())
          }
        }}>
        <Pencil size={16} aria-hidden="true" />在线编辑
      </a>,
    )
  }
  group1.push(
    <button key="copy-link" type="button" role="menuitem" onClick={() => { onClose(false); onCopyLink(node) }}>
      <Link2 size={16} aria-hidden="true" />复制链接
    </button>,
  )

  const group2: ReactNode[] = []
  if (node.rights & MODIFY) {
    group2.push(
      <button key="rename" type="button" role="menuitem" onClick={() => { onClose(false); onRename(node) }}>
        <PencilLine size={16} aria-hidden="true" />重命名
      </button>,
    )
  }
  if (canMove) {
    group2.push(
      <button key="move" type="button" role="menuitem" onClick={() => { onClose(false); onMove(node) }}>
        <FolderInput size={16} aria-hidden="true" />移动
      </button>,
    )
  }
  if (node.rights & GRANT) {
    group2.push(
      <button key="grants" type="button" role="menuitem" onClick={() => { onClose(false); onManageGrants(node) }}>
        <ShieldCheck size={16} aria-hidden="true" />管理权限
      </button>,
    )
  }
  group2.push(
    <button key="overview" type="button" role="menuitem" onClick={() => { onClose(false); onInspect(node, 'overview') }}>
      <Info size={16} aria-hidden="true" />详细信息
    </button>,
  )
  if (node.isFile && (node.rights & BROWSE)) {
    group2.push(
      <button key="versions" type="button" role="menuitem" onClick={() => { onClose(false); onInspect(node, 'versions') }}>
        <History size={16} aria-hidden="true" />版本历史
      </button>,
    )
  }
  group2.push(
    <button key="permission" type="button" role="menuitem" onClick={() => { onClose(false); onInspect(node, 'permission') }}>
      <KeyRound size={16} aria-hidden="true" />我的权限
    </button>,
  )

  const group3: ReactNode[] = []
  if (node.rights & DELETE) {
    group3.push(
      <button key="recycle" type="button" role="menuitem" className="item-menu-danger"
        onClick={() => { onClose(false); onRecycle(node) }}>
        <Trash2 size={16} aria-hidden="true" />移入回收站
      </button>,
    )
  }

  const groups = [group1, group2, group3].filter(items => items.length > 0)

  const portalHost = document.querySelector('.shell') ?? document.body

  return createPortal(
    <div ref={menuRef} role="menu" aria-label={`操作 ${node.name}`} className="item-menu"
      style={{ left: `${position.left}px`, top: `${position.top}px`, transformOrigin: position.origin }}
      onContextMenu={event => event.preventDefault()}>
      {groups.map((items, index) => <Fragment key={index}>
        {index > 0 && <div role="separator" className="item-menu-separator" />}
        {items}
      </Fragment>)}
    </div>,
    portalHost,
  )
}
