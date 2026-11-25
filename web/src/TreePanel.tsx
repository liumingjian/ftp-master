import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, Download, FolderOpen, FolderPlus, MoreHorizontal, PanelLeft, Pencil, Search, ShieldCheck, Trash2, Upload, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { canEditText, TextEditorDialog } from './TextEditor'
import { copiedItemId } from './BrowseTools'
import { canPreviewOffice, editableOfficeVersion, FileViewer, OfficeEditAction, type ViewerUser } from './FileViewer'
import { ZipDownload } from './ZipDownload'
import { RecycleBin } from './RecycleBin'
import { DirectorySidebar } from './DirectorySidebar'
import { FolderUpload } from './FolderUpload'
import { UploadRow, type FileUploadState } from './UploadRow'
import { GrantsPanel } from './GrantsPanel'
import { FileIcon, formatSize } from './FileIcon'
import { ItemActionMenu, type InspectorTab, type MenuAnchor } from './ItemActionMenu'
import { ItemInspectorDialog } from './ItemInspectorDialog'
import { CreateFolderDialog, DeleteFolderDialog, MoveDialog, RenameDialog } from './ItemActionDialogs'
import { api } from './api/client'
import { loadAncestors, loadBranches, loadDirectory } from './treePath'
import { systemClock } from './clock'
import { editQuotaWarning } from './quota'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']
const ROOT = 0
const BROWSE = 1
const DOWNLOAD = 2
const UPLOAD = 4
const MODIFY = 8
const DELETE = 16
const GRANT = 32

type SortKey = 'name' | 'size' | 'username' | 'createdAt'

type Props = {
  administrator: boolean
  active: boolean
  hash: string
  query: string
  navigate: (hash: string) => void
  transferSlot: HTMLDivElement | null
  sidebarWidth: number
  resizeSidebar: (width: number) => void
  sidebarCollapsed?: boolean
  viewerUser?: ViewerUser
  grantId?: number
  openGrant: (id: number) => void
  recycle: boolean
  openRecycle: () => void
  recycleHref: string
  availableQuotaBytes?: number | null
}

export function TreePanel({ administrator, active, hash, query, navigate, transferSlot, sidebarWidth, resizeSidebar, sidebarCollapsed = false, viewerUser, grantId, openGrant, recycle, openRecycle, recycleHref, availableQuotaBytes }: Props) {
  const [officeEditing, setOfficeEditing] = useState(false)
  useEffect(() => {
    if (!active) return
    let controller: AbortController
    function refreshPolicy() {
      controller?.abort()
      controller = new AbortController()
      const { signal } = controller
      void api.GET('/office-edit-policy', { signal }).then(({ data }) => {
        if (!signal.aborted) setOfficeEditing(data?.enabled === true)
      }).catch(() => { if (!signal.aborted) setOfficeEditing(false) })
    }
    refreshPolicy()
    window.addEventListener('focus', refreshPolicy)
    return () => { controller.abort(); window.removeEventListener('focus', refreshPolicy) }
  }, [active])

  const [officePreview, setOfficePreview] = useState(false)
  const [path, setPath] = useState<Node[]>([])
  const [resolvedHash, setResolvedHash] = useState<string>()
  const [branches, setBranches] = useState<Record<number, Node[]>>({})
  const [results, setResults] = useState<Node[]>([])
  const [message, setMessage] = useState('')
  const [revision, refresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [showDirectoryProgress, setShowDirectoryProgress] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'name', descending: false })
  const [recycling, setRecycling] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [menu, setMenu] = useState<{ node: Node; anchor: MenuAnchor }>()
  const [inspector, setInspector] = useState<{ node: Node; tab: InspectorTab }>()
  const [viewedFile, setViewedFile] = useState<Node>()
  const [textEditNode, setTextEditNode] = useState<Node>()
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [renamingNode, setRenamingNode] = useState<Node>()
  const [movingNode, setMovingNode] = useState<Node>()
  const [deletingFolder, setDeletingFolder] = useState<Node>()
  const [grantNode, setGrantNode] = useState<Node>()
  const [grantDirty, setGrantDirty] = useState(false)
  const [uploadActivity, setUploadActivity] = useState<Record<string, boolean>>({})
  const [fileUploads, setFileUploads] = useState<Record<number, FileUploadState>>({})
  const [uploadStatus, setUploadStatus] = useState<Record<string, boolean>>({})
  const [uploadPaths, setUploadPaths] = useState<Node[][]>([])
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [dropZone, setDropZone] = useState<HTMLDivElement | null>(null)
  const [dragTarget, setDragTarget] = useState(false)
  const [taskLabels, setTaskLabels] = useState<Record<string, string>>({})
  const dragDepth = useRef(0)
  const menuTrigger = useRef<HTMLElement | null>(null)
  const keepMessageOnNextHash = useRef(false)
  const explorerRef = useRef<HTMLElement>(null)
  const scrollPositions = useRef(new Map<string, number>())
  const restoredLocation = useRef<string>(undefined)
  const officeEditStarted = useRef(false)
  const openedLinkedFile = useRef(false)

  const current = path.at(-1)
  const currentId = current?.id ?? ROOT
  const itemId = copiedItemId(hash)
  const locationPending = resolvedHash !== hash
  const browsing = active && !recycle && !grantId
  const canUpload = !!(current && current.rights & UPLOAD)
  const canCreate = current ? canUpload : administrator
  const dirNodes = branches[currentId] ?? []
  const nodes = query ? results : dirNodes
  const rows = [...nodes].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1
    const key = sort.key
    const order = key === 'size'
      ? (a.latestVersion?.size ?? 0) - (b.latestVersion?.size ?? 0)
      : (key === 'name' ? a.name : a.latestVersion?.[key] ?? '').localeCompare(
        key === 'name' ? b.name : b.latestVersion?.[key] ?? '', 'zh-CN', { numeric: true })
    return sort.descending ? -order : order
  })

  const selectedIds = selected.filter(id => nodes.some(node => node.id === id))
  const checkedNode = selectedIds.length === 1 ? nodes.find(node => node.id === selectedIds[0]) : undefined
  const otherUploads = Object.keys(uploadActivity).filter(key =>
    uploadActivity[key] && (!browsing || !!query || Number(key.split(':')[1]) !== currentId))
  const inspectedNode = inspector && (nodes.find(node => node.id === inspector.node.id) ?? inspector.node)
  const menuNode = menu && (nodes.find(node => node.id === menu.node.id) ?? menu.node)
  const viewerNode = viewedFile && (nodes.find(node => node.id === viewedFile.id) ?? viewedFile)
  const fileUpload = fileUploads[currentId] ?? 'idle'
  const pending = locationPending || (query ? searching : loading)
  const retainDirectory = !query && locationPending && resolvedHash !== undefined && !loadFailed
  const failed = query ? searchFailed : loadFailed
  const EmptyIcon = query ? Search : FolderOpen
  const scrollKey = JSON.stringify([hash, query])

  function canMoveNode(node: Node): boolean {
    return query ? Boolean(node.canMoveFromParent) : current ? Boolean(current.rights & DELETE) : administrator
  }

  useLayoutEffect(() => {
    if (pending || !browsing || restoredLocation.current === scrollKey || !explorerRef.current) return
    explorerRef.current.scrollTop = scrollPositions.current.get(scrollKey) ?? 0
    restoredLocation.current = scrollKey
  }, [browsing, pending, scrollKey])

  useEffect(() => {
    const root = document.documentElement
    const updatePreviewFlag = () => {
      setOfficePreview(root.getAttribute('data-ftp-office-preview') === '1')
    }
    const observer = new MutationObserver(updatePreviewFlag)
    observer.observe(root, { attributes: true, attributeFilter: ['data-ftp-office-preview'] })
    updatePreviewFlag()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    function refreshEditedFile() {
      if (!officeEditStarted.current || document.visibilityState !== 'visible') return
      officeEditStarted.current = false
      refresh(value => value + 1)
    }
    window.addEventListener('focus', refreshEditedFile)
    document.addEventListener('visibilitychange', refreshEditedFile)
    return () => {
      window.removeEventListener('focus', refreshEditedFile)
      document.removeEventListener('visibilitychange', refreshEditedFile)
    }
  }, [])

  useEffect(() => {
    openedLinkedFile.current = false
    setSelected([])
    setMenu(undefined)
    setInspector(undefined)
    setViewedFile(undefined)
    setTextEditNode(undefined)
    setCreatingFolder(false)
    setRenamingNode(undefined)
    setMovingNode(undefined)
    setDeletingFolder(undefined)
    if (keepMessageOnNextHash.current) keepMessageOnNextHash.current = false
    else setMessage('')
  }, [hash])

  useEffect(() => {
    setShowDirectoryProgress(false)
    if (retainDirectory) return systemClock.after(180, () => setShowDirectoryProgress(true))
  }, [retainDirectory, hash])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    setLoading(true)
    setLoadFailed(false)

    async function resolve() {
      let nextPath: Node[] = []
      try {
        let node: Node | undefined
        if (itemId !== undefined) {
          const { data, response } = await api.GET('/tree/{id}', { params: { path: { id: itemId } }, signal })
          if (signal.aborted) return
          node = data
          if (!node) setMessage(response.status === 404 ? '项目不存在或无权访问' : '无法加载项目')
        }

        const directoryId = node?.isFile ? node.parentId ?? ROOT : node?.id ?? ROOT
        const listing = loadDirectory(directoryId, signal).catch(() => undefined)
        if (node) {
          const ancestors = await loadAncestors(node, signal)
          nextPath = node.isFile ? ancestors : [...ancestors, node]
        }
        const visibleId = nextPath.at(-1)?.id ?? ROOT
        const loadedNodes = visibleId === directoryId ? await listing : await loadDirectory(visibleId, signal)
        if (signal.aborted) return
        setPath(nextPath)
        if (!loadedNodes) {
          setLoadFailed(true)
          return
        }
        setBranches(previous => {
          const parents = [ROOT, ...nextPath.slice(0, -1).map(parent => parent.id)]
          return {
            ...Object.fromEntries(parents.filter(id => previous[id] !== undefined).map(id => [id, previous[id]])),
            [visibleId]: loadedNodes,
          }
        })
        if (node?.isFile && !openedLinkedFile.current) {
          openedLinkedFile.current = true
          setViewedFile(node)
        }

        if (visibleId !== ROOT) void loadBranches(nextPath.slice(0, -1), signal).then(parents => {
          if (!signal.aborted) setBranches(previous => ({ ...previous, ...parents }))
        }).catch(() => {})
      } catch {
        if (!signal.aborted) {
          setPath(nextPath)
          setLoadFailed(true)
        }
      } finally {
        if (!signal.aborted) {
          setResolvedHash(hash)
          setLoading(false)
        }
      }
    }
    void resolve()
    return () => controller.abort()
  }, [itemId, hash, revision])

  useEffect(() => {
    if (!canUpload) return
    setUploadPaths(previous => previous.some(target => target.at(-1)?.id === currentId)
      ? previous.map(target => target.at(-1)?.id === currentId ? path : target)
      : [...previous, path])
  }, [path, canUpload, currentId])

  useEffect(() => {
    setSelected([])
    setMenu(undefined)
    setInspector(undefined)
  }, [query])

  useEffect(() => {
    setSearchFailed(false)
    if (!query) {
      setResults([])
      setSearching(false)
      return
    }
    const controller = new AbortController()
    setSearching(true)
    void api.GET('/tree/search', { params: { query: { q: query } }, signal: controller.signal })
      .then(({ data, response }) => {
        if (controller.signal.aborted) return
        setResults(data ?? [])
        if (!response.ok) setSearchFailed(true)
      }).catch(() => {
        if (!controller.signal.aborted) setSearchFailed(true)
      }).finally(() => {
        if (!controller.signal.aborted) setSearching(false)
      })
    return () => controller.abort()
  }, [query, revision])

  useEffect(() => {
    if (!grantId || grantId === grantNode?.id) return
    const controller = new AbortController()
    void api.GET('/tree/{id}', { params: { path: { id: grantId } }, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        if (data && data.rights & GRANT) {
          setGrantDirty(false)
          setGrantNode(data)
        } else setMessage('项目不存在或无权管理')
      }).catch(() => {
        if (!controller.signal.aborted) setMessage('无法加载项目')
      })
    return () => controller.abort()
  }, [grantId, grantNode?.id])

  useEffect(() => {
    dragDepth.current = 0
    setDragTarget(false)
  }, [currentId, browsing, query])

  function showGrants(id: number) {
    if (grantDirty && id !== grantNode?.id && !window.confirm('有未保存的更改，确定切换授权项目？')) return
    setMessage('')
    setMenu(undefined)
    setInspector(undefined)
    openGrant(id)
  }

  function trackOfficeEdit() {
    officeEditStarted.current = true
    setViewedFile(undefined)
    setMenu(undefined)
  }

  function openFolder(id = ROOT) {
    setMenu(undefined)
    setInspector(undefined)
    navigate(id === ROOT ? '' : `#item=${id}`)
  }

  function closeMenu(restoreFocus = false) {
    setMenu(undefined)
    if (restoreFocus) menuTrigger.current?.focus()
  }

  function update(nextMessage: string) {
    setMessage(nextMessage)
    refresh(value => value + 1)
  }

  async function copyItemLink(node: Node) {
    try {
      const url = new URL('/', location.origin)
      url.hash = `item=${node.id}`
      await navigator.clipboard.writeText(url.href)
      setMessage('链接已复制，仅已有访问权限的人可打开')
    } catch {
      setMessage('无法复制链接，请检查浏览器剪贴板权限')
    }
  }

  async function executeRecycle(node: Node) {
    if (recycling) return
    setRecycling(true)
    try {
      const { response } = await api.DELETE('/tree/{id}', { params: { path: { id: node.id } } })
      if (response.ok) {
        setSelected(ids => ids.filter(id => id !== node.id))
        setInspector(previous => previous?.node.id === node.id ? undefined : previous)
        setDeletingFolder(undefined)
        update(`「${node.name}」已移入回收站`)
      } else {
        setDeletingFolder(undefined)
        setMessage(response.status === 403 ? '当前账户没有删除权限' : '移入回收站失败，请刷新后重试')
      }
    } catch {
      setDeletingFolder(undefined)
      setMessage('无法连接服务，请重试')
    } finally {
      setRecycling(false)
    }
  }

  function requestRecycle(node: Node) {
    if (node.isFile) void executeRecycle(node)
    else setDeletingFolder(node)
  }

  const hasGrant = current?.rights && current.rights & GRANT
  const currentLocationLabel = ['全部文件', ...path.map(node => node.name)].join(' / ')
  const inspectorLocation = query && inspectedNode?.parentPath ? {
    label: inspectedNode.parentPath === '/' ? '全部文件' : inspectedNode.parentPath,
    href: inspectedNode.parentId ? `/#item=${inspectedNode.parentId}` : '/',
    open: () => openFolder(inspectedNode.parentId),
  } : undefined

  return <>
    <DirectorySidebar visible={active && !grantId} browsing={browsing && !query} rootSelected={browsing && !query && !current}
      recycle={recycle} recycleHref={recycleHref} openRecycle={openRecycle} openFolder={openFolder}
      path={path} branches={branches} revision={revision} width={sidebarWidth} resize={resizeSidebar}
      collapsed={sidebarCollapsed}
      drawerOpen={directoryOpen} closeDrawer={() => setDirectoryOpen(false)}
    />
    <main id={browsing ? 'main-content' : undefined} tabIndex={browsing ? -1 : undefined} className="shell-main explorer" ref={explorerRef} hidden={!browsing} onScroll={event => {
      if (browsing && !pending && restoredLocation.current === scrollKey) scrollPositions.current.set(scrollKey, event.currentTarget.scrollTop)
    }}>
      <div className="explorer-workspace">
        <section aria-label="共享目录">
          <nav className="breadcrumbs" aria-label="目录路径">
            <button className="directory-trigger" aria-haspopup="dialog" aria-expanded={directoryOpen} aria-controls="file-directories"
              onClick={() => setDirectoryOpen(true)}><PanelLeft size={16} />目录</button>
            {query ? <button className="ghost" onClick={() => navigate(hash)}><ArrowLeft size={16} />返回目录</button> : <>
              <button className="ghost" aria-label="根目录" onClick={() => openFolder()}>全部文件</button>
              {path.map((node, index) => <span className="crumb" key={node.id}><ChevronRight size={14} />
                <button className="ghost" aria-current={index === path.length - 1 ? 'location' : undefined}
                  onClick={() => openFolder(node.id)}>{node.name}</button>
              </span>)}
            </>}
          </nav>

          <div className="explorer-heading">
            <div className="explorer-location">
              <h1>{query ? '搜索结果' : current?.name ?? '全部文件'}</h1>
              <p className="explorer-meta">
                {query && <span className="search-term">“{query}”</span>}
                {(!pending || retainDirectory) && !failed && <span>{rows.length} 项</span>}
                {retainDirectory && showDirectoryProgress && <span role="status">正在打开目录…</span>}
                {!query && current && <span className="pill">{rightsLabel(current)}</span>}
              </p>
            </div>
            {!query && (canCreate || !!hasGrant) && <div className="explorer-actions">
              {canUpload && <UploadPickers parentId={currentId} disabled={locationPending} state={fileUpload} />}
              {canCreate && <button disabled={locationPending} className={canUpload ? '' : 'primary'}
                onClick={() => setCreatingFolder(true)}>
                <FolderPlus size={16} aria-hidden="true" />新建文件夹
              </button>}
              {!!hasGrant && <button className="button" aria-label="管理当前权限" disabled={locationPending}
                onClick={() => current && showGrants(current.id)}>
                <ShieldCheck size={16} aria-hidden="true" />管理权限
              </button>}
            </div>}
          </div>

          {!query && current && !(current.rights & BROWSE) && <p className="notice">
            {canUpload ? '这是投递箱。你可以上传文件，并查看自己上传的内容。' : '此目录内容不可浏览；仅显示可访问的路径。'}
          </p>}

          <div className="file-table" ref={setDropZone} data-dragging={dragTarget || undefined}
            onDragEnter={event => {
              if (canUpload && !query && !locationPending && event.dataTransfer.types.includes('Files')) {
                dragDepth.current++
                setDragTarget(true)
              }
            }} onDragLeave={() => {
              dragDepth.current = Math.max(0, dragDepth.current - 1)
              if (!dragDepth.current) setDragTarget(false)
            }} onDrop={event => {
              setDragTarget(false)
              dragDepth.current = 0
              if (!canUpload || query || locationPending || !event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              if (event.dataTransfer.items.length > 1) setMessage('一次拖入一个文件，或上传整个文件夹')
            }}>
            {dragTarget && <div className="drop-hint">上传到「{current?.name}」</div>}
            <table aria-label="文件列表" aria-busy={pending} inert={retainDirectory}>
              <thead><tr>
                <th><input type="checkbox" aria-label="选择全部" checked={!!rows.length && selectedIds.length === rows.length}
                  ref={input => { if (input) input.indeterminate = selectedIds.length > 0 && selectedIds.length < rows.length }}
                  disabled={pending || failed || !rows.length} onChange={event => setSelected(event.target.checked ? rows.map(node => node.id) : [])} /></th>
                <SortHeader column="name" label="名称" sort={sort} setSort={setSort} />
                <SortHeader column="username" label="修改人" sort={sort} setSort={setSort} />
                <SortHeader column="createdAt" label="修改时间" sort={sort} setSort={setSort} />
                <SortHeader column="size" label="大小" sort={sort} setSort={setSort} />
                <th><span className="visually-hidden">操作</span></th>
              </tr></thead>
              <tbody>
                {uploadPaths.map(target => {
                  const id = target.at(-1)!.id
                  const report = (kind: string, value: boolean) => setUploadActivity(previous => ({ ...previous, [`${kind}:${id}`]: value }))
                  const describe = (kind: string, label: string) => setTaskLabels(previous => ({
                    ...previous, [`${kind}:${id}`]: label,
                  }))
                  const reportStatus = (kind: string, value: boolean) => setUploadStatus(previous => ({ ...previous, [`${kind}:${id}`]: value }))
                  const visible = browsing && !locationPending && !query && canUpload && id === currentId
                  const hasStatus = uploadStatus[`file:${id}`] || uploadStatus[`folder:${id}`]
                  return <tr key={id} className="transfer-row" hidden={!visible || !hasStatus}>
                    <td colSpan={6}>
                      <UploadRow onTaskChange={label => describe('file', label)} parentId={id} visible={visible} dropZone={visible ? dropZone : null} onActivityChange={state => {
                        setFileUploads(previous => ({ ...previous, [id]: state }))
                        report('file', state !== 'idle')
                      }}
                        onStatusChange={value => reportStatus('file', value)} completed={() => refresh(v => v + 1)} />
                      <FolderUpload onTaskChange={label => describe('folder', label)} parentId={id} visible={visible} dropZone={visible ? dropZone : null} onActivityChange={value => report('folder', value)}
                        onStatusChange={value => reportStatus('folder', value)} completed={() => refresh(v => v + 1)} />
                    </td>
                  </tr>
                })}
                {pending && !retainDirectory ? <tr><td colSpan={6} className="table-loading" role="status">正在加载…</td></tr> :
                  !failed && rows.map(node => {
                    const isDropBox = !node.isFile && !(node.rights & BROWSE) && Boolean(node.rights & UPLOAD)
                    const hasOfficeEdit = officeEditing && Boolean(editableOfficeVersion(node))
                    const hasTextEdit = !hasOfficeEdit && canEditText(node)
                    const textEditWarning = hasTextEdit && node.latestVersion
                      ? editQuotaWarning(availableQuotaBytes, node.latestVersion.size)
                      : undefined
                    const isMenuOpen = menuNode?.id === node.id

                    return <tr key={node.id}
                      className={selectedIds.includes(node.id) ? 'selected' : undefined}
                      data-menu-open={isMenuOpen || undefined}
                      onContextMenu={event => {
                        if (event.target instanceof HTMLInputElement) return
                        event.preventDefault()
                        menuTrigger.current = document.getElementById(`detail-trigger-${node.id}`)
                        setMenu({ node, anchor: { kind: 'point', x: event.clientX, y: event.clientY } })
                      }}>
                      <td><input type="checkbox" aria-label={node.name} checked={selectedIds.includes(node.id)}
                        onChange={event => setSelected(ids => event.target.checked ? [...ids, node.id] : ids.filter(id => id !== node.id))} /></td>
                      <td>
                        {officePreview && canPreviewOffice(node) ? <a className="button file-name ghost" title={node.name} aria-label={node.name}
                          href={`/api/files/${node.id}/office-edits`} data-ftp-office-preview="1" data-ftp-office-version={node.latestVersion?.id}
                          onClick={event => { event.preventDefault(); setMenu(undefined) }}>
                          <FileIcon node={node} tile /><ListName name={node.name} />
                        </a> : <button className="file-name ghost" onClick={() => {
                          setMenu(undefined)
                          if (node.isFile) setViewedFile(node)
                          else openFolder(node.id)
                        }} title={node.name} aria-label={node.name}><FileIcon node={node} tile /><ListName name={node.name} /></button>}
                        {(node.traversable || isDropBox) && <small className="access-note">{isDropBox ? '投递箱' : '仅通行'}</small>}
                        {query && node.parentPath && <a className="file-subtitle file-parent ellipsis" title={node.parentPath}
                          aria-label={`打开所在目录 ${node.parentPath}`}
                          href={node.parentId ? `/#item=${node.parentId}` : '/'}
                          onClick={event => {
                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                            event.preventDefault()
                            openFolder(node.parentId)
                          }}>{node.parentPath === '/' ? '全部文件' : node.parentPath}</a>}
                      </td>
                      <td className="file-author">{node.latestVersion?.username
                        ? <span className="ellipsis" title={node.latestVersion.username}>{node.latestVersion.username}</span>
                        : <span className="muted" aria-hidden="true">—</span>}</td>
                      <td className="file-time muted">{node.latestVersion?.createdAt
                        ? <time dateTime={node.latestVersion.createdAt} title={new Date(node.latestVersion.createdAt).toLocaleString('zh-CN')}>{formatFileTime(node.latestVersion.createdAt)}</time>
                        : <span aria-hidden="true">—</span>}</td>
                      <td className="file-size">{node.latestVersion ? formatSize(node.latestVersion.size) : <span aria-hidden="true">—</span>}</td>
                      <td><div className="row-actions">
                        {hasOfficeEdit && <OfficeEditAction node={node} onOpen={trackOfficeEdit} icon className="row-hover-action" availableQuotaBytes={availableQuotaBytes} />}
                        {hasTextEdit && <button type="button" className={textEditWarning ? 'icon row-hover-action text-edit-indicator quota-tight' : 'icon row-hover-action text-edit-indicator'}
                          title={textEditWarning ? `编辑文本（${textEditWarning}）` : '编辑文本'} aria-label={`编辑文本 ${node.name}`}
                          onClick={() => setTextEditNode(node)}>
                          <Pencil size={16} aria-hidden="true" />
                        </button>}
                        {node.isFile && !!(node.rights & DOWNLOAD) && <a className="button icon row-hover-action"
                          href={`/api/tree/${node.id}/download`} download title="下载" aria-label={`下载 ${node.name}`}>
                          <Download size={16} aria-hidden="true" />
                        </a>}
                        <button id={`detail-trigger-${node.id}`} type="button" className="icon row-menu-trigger"
                          aria-haspopup="menu" aria-expanded={isMenuOpen}
                          title="更多操作" aria-label={`更多操作 ${node.name}`}
                          onClick={event => {
                            if (isMenuOpen) {
                              closeMenu(false)
                              return
                            }
                            menuTrigger.current = event.currentTarget
                            setMenu({ node, anchor: { kind: 'button', rect: event.currentTarget.getBoundingClientRect() } })
                          }}>
                          <MoreHorizontal size={16} aria-hidden="true" />
                        </button>
                      </div></td>
                    </tr>
                  })}
              </tbody>
            </table>
            {(!pending || retainDirectory) && (failed || !rows.length) && (
              !failed && !query && canUpload ? (
                <button type="button" className="table-empty" disabled={locationPending || fileUpload !== 'idle'}
                  onClick={() => chooseUploadFile(currentId)}>
                  <span className="empty-icon"><Upload size={24} aria-hidden="true" /></span>
                  <strong>点击选择文件，或拖到这里上传</strong>
                </button>
              ) : (
                <div className="table-empty">
                  <span className="empty-icon"><EmptyIcon size={24} aria-hidden="true" /></span>
                  {failed ? <>
                    <strong role="alert">{query ? '无法完成搜索' : '无法加载目录内容'}</strong>
                    <button onClick={() => refresh(value => value + 1)}>重试</button>
                  </> : <>
                    <strong>{query ? '没有匹配文件' : '此目录暂无文件'}</strong>
                    {query && <span>试试更短的文件名关键词</span>}
                    {!query && !current && canCreate && <span>新建文件夹后，即可在文件夹中上传文件</span>}
                  </>}
                </div>
              )
            )}
          </div>

          {!!selectedIds.length && <div className="selection-bar">
            <span>已选 {selectedIds.length} 项</span><ZipDownload key={selectedIds.join(',')} selected={selectedIds} />
            {checkedNode && !!(checkedNode.rights & DELETE) && <button className="ghost" disabled={pending || recycling}
              onClick={() => requestRecycle(checkedNode)}><Trash2 size={16} aria-hidden="true" />移入回收站</button>}
            <button className="ghost icon" title="取消选择" aria-label="取消选择" onClick={() => setSelected([])}><X size={16} aria-hidden="true" /></button>
          </div>}
        </section>
      </div>

      {browsing && menu && menuNode && <ItemActionMenu
        node={menuNode}
        anchor={menu.anchor}
        officeEditing={officeEditing}
        canMove={canMoveNode(menuNode)}
        availableQuotaBytes={availableQuotaBytes}
        onClose={closeMenu}
        onEditText={node => setTextEditNode(node)}
        onOfficeEditOpen={trackOfficeEdit}
        onCopyLink={node => void copyItemLink(node)}
        onRename={node => setRenamingNode(node)}
        onMove={node => setMovingNode(node)}
        onManageGrants={node => showGrants(node.id)}
        onInspect={(node, tab) => setInspector({ node, tab })}
        onRecycle={node => requestRecycle(node)}
      />}

      {browsing && inspector && inspectedNode && <ItemInspectorDialog
        key={inspectedNode.id}
        node={inspectedNode}
        initialTab={inspector.tab}
        location={inspectorLocation}
        onClose={() => { setInspector(undefined); menuTrigger.current?.focus() }}
        onRestored={() => refresh(value => value + 1)}
        onManageGrants={node => showGrants(node.id)}
      />}

      {browsing && creatingFolder && <CreateFolderDialog
        parentId={current?.id}
        close={() => setCreatingFolder(false)}
        created={() => {
          setCreatingFolder(false)
          update('目录已创建')
        }}
      />}

      {browsing && renamingNode && <RenameDialog
        key={renamingNode.id}
        node={renamingNode}
        close={() => { setRenamingNode(undefined); menuTrigger.current?.focus() }}
        renamed={() => {
          setRenamingNode(undefined)
          update('名称已更新')
        }}
      />}

      {browsing && movingNode && <MoveDialog
        key={movingNode.id}
        node={movingNode}
        administrator={administrator}
        close={() => { setMovingNode(undefined); menuTrigger.current?.focus() }}
        moved={parentId => {
          setMovingNode(undefined)
          keepMessageOnNextHash.current = true
          openFolder(parentId ?? ROOT)
          update('项目已移动')
        }}
      />}

      {browsing && deletingFolder && <DeleteFolderDialog
        key={deletingFolder.id}
        node={deletingFolder}
        location={currentLocationLabel}
        busy={recycling}
        close={() => { setDeletingFolder(undefined); menuTrigger.current?.focus() }}
        confirm={() => void executeRecycle(deletingFolder)}
      />}

      {browsing && textEditNode && <TextEditorDialog
        key={textEditNode.id}
        node={textEditNode}
        availableQuotaBytes={availableQuotaBytes}
        close={() => setTextEditNode(undefined)}
        saved={() => refresh(value => value + 1)}
      />}

      {browsing && viewerNode && <FileViewer key={viewerNode.id} node={viewerNode} officePreview={officePreview}
        viewerUser={viewerUser} availableQuotaBytes={availableQuotaBytes}
        close={() => setViewedFile(undefined)} saved={() => refresh(value => value + 1)} />}
    </main>

    {active && recycle && <main id="main-content" tabIndex={-1} className="shell-main"><button className="directory-trigger" aria-haspopup="dialog" aria-expanded={directoryOpen} aria-controls="file-directories"
      onClick={() => setDirectoryOpen(true)}><PanelLeft size={16} />目录</button><RecycleBin administrator={administrator} changed={() => refresh(v => v + 1)} /></main>}
    {active && grantId && grantNode?.id !== grantId && <main id="main-content" tabIndex={-1} className="shell-main"><button onClick={() => navigate(hash)}>返回目录</button></main>}
    {grantNode && <main id={active && grantNode.id === grantId ? 'main-content' : undefined} tabIndex={active && grantNode.id === grantId ? -1 : undefined} className="shell-main" hidden={!active || grantNode.id !== grantId}><GrantsPanel key={grantNode.id} administrator={administrator} node={grantNode} onDirtyChange={setGrantDirty}
      close={() => { navigate(hash); refresh(v => v + 1) }} /></main>}
    {active && message && <div className="toast">
      <span role="status">{message}</span>
      {message.endsWith('」已移入回收站') && <a href={recycleHref} onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        setMessage('')
        openRecycle()
      }}>前往回收站</a>}
      <button className="icon ghost" title="关闭提示" aria-label="关闭提示" onClick={() => setMessage('')}><X size={15} aria-hidden="true" /></button>
    </div>}
    {transferSlot && !!otherUploads.length && createPortal(<details className="upload-indicator">
      <summary><Upload size={16} /><span className="upload-indicator-label">其他目录上传 {otherUploads.length}</span></summary>
      <div className="popup">{uploadPaths.filter(target => otherUploads.some(key => key.endsWith(`:${target.at(-1)!.id}`))).map(target => {
        const id = target.at(-1)!.id
        const label = target.map(node => node.name).join('/')
        const state = fileUploads[id]
        const status = state && state !== 'idle' ? {
          resume: '等待选择原文件', conflict: '需要处理同名文件', uploading: '文件上传中',
        }[state] : undefined
        return <button key={id} aria-label={label} aria-describedby={status ? `upload-status-${id}` : undefined}
          onClick={event => { event.currentTarget.closest('details')!.open = false; openFolder(id) }}>
          <span>{label}</span>{['file', 'folder'].map(kind => {
            const key = `${kind}:${id}`
            return uploadActivity[key] && taskLabels[key] ? <small key={key}>{taskLabels[key]}</small> : null
          })}{status && <small id={`upload-status-${id}`}>{status}</small>}
        </button>
      })}</div>
    </details>, transferSlot)}
  </>
}

function ListName({ name }: { name: string }) {
  const chars = Array.from(name)
  return <span className="list-name"><span>{chars.slice(0, -13).join('')}</span><span>{chars.slice(-13).join('')}</span></span>
}

function rightsLabel(node: Node) {
  if (node.rights & GRANT) return '完全控制'
  if (node.rights & MODIFY) return '可修改'
  if (node.rights & UPLOAD) return node.rights & BROWSE ? '可上传' : '仅投递'
  if (node.rights & DOWNLOAD) return '可下载'
  return node.rights & BROWSE ? '可浏览' : '仅通行'
}

function SortHeader({ column, label, sort, setSort }: {
  column: SortKey
  label: string
  sort: { key: SortKey; descending: boolean }
  setSort: (sort: { key: SortKey; descending: boolean }) => void
}) {
  const active = sort.key === column
  const Arrow = sort.descending ? ArrowDown : ArrowUp
  return <th scope="col" className={`file-${column}-header`} aria-sort={active ? sort.descending ? 'descending' : 'ascending' : undefined}>
    <button className="ghost" onClick={() => setSort({ key: column, descending: active && !sort.descending })}>
      {label}{active && <Arrow size={12} />}
    </button>
  </th>
}

function chooseUploadFile(parentId: number) {
  document.getElementById(`upload-file-${parentId}`)?.click()
}

function formatFileTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function UploadPickers({ parentId, disabled, state }: { parentId: number; disabled: boolean; state: FileUploadState }) {
  const label = { idle: '上传文件', resume: '继续上传', uploading: '正在上传…', conflict: '等待处理同名文件' }[state]
  return <div className="upload-pickers">
    <button className="primary" disabled={disabled || (state !== 'idle' && state !== 'resume')} onClick={() => {
      if (state === 'resume') document.getElementById(`resume-file-${parentId}`)?.click()
      else chooseUploadFile(parentId)
    }}><Upload size={16} aria-hidden="true" />{label}</button>
    <button disabled={disabled} onClick={() => document.getElementById(`upload-folder-${parentId}`)?.click()}>
      <FolderOpen size={16} aria-hidden="true" />上传文件夹</button>
  </div>
}
