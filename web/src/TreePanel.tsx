import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type Ref, type ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, Download, Eye, FolderOpen, FolderPlus, History, MoreHorizontal, PanelLeft, Search, ShieldCheck, Trash2, Upload, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { TextEditor } from './TextEditor'
import { copiedItemId, CopyItemLink, previewKind } from './BrowseTools'
import { canPreviewOffice, FileViewer, OfficeEditAction } from './FileViewer'
import { ZipDownload } from './ZipDownload'
import { VersionsPanel } from './VersionsPanel'
import { RecycleBin } from './RecycleBin'
import { DirectoryPicker } from './DirectoryPicker'
import { DirectorySidebar } from './DirectorySidebar'
import { FolderUpload } from './FolderUpload'
import { UploadRow, type FileUploadState } from './UploadRow'
import { GrantsPanel, PermissionInspection, rights } from './GrantsPanel'
import { FileIcon, fileTypeLabel, formatSize } from './FileIcon'
import { api } from './api/client'
import { loadAncestors, loadBranches } from './treePath'
import { usePanelDismissal } from './usePanelDismissal'
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
const modalDetailViewport = '(max-width: 1040px)'
type Props = {
  administrator: boolean
  active: boolean
  hash: string
  query: string
  navigate: (hash: string) => void
  transferSlot: HTMLDivElement | null
  sidebarWidth: number
  resizeSidebar: (width: number) => void
  grantId?: number
  openGrant: (id: number) => void
  recycle: boolean
  openRecycle: () => void
  recycleHref: string
}

export function TreePanel({ administrator, active, hash, query, navigate, transferSlot, sidebarWidth, resizeSidebar, grantId, openGrant, recycle, openRecycle, recycleHref }: Props) {
  const [officePlugin, setOfficePlugin] = useState(false)
  const [officePreview, setOfficePreview] = useState(false)
  const [path, setPath] = useState<Node[]>([])
  const [resolvedHash, setResolvedHash] = useState<string>()
  const [branches, setBranches] = useState<Record<number, Node[]>>({})
  const [results, setResults] = useState<Node[]>([])
  const [message, setMessage] = useState('')
  const [revision, refresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'name', descending: false })
  const [recycling, setRecycling] = useState(false)
  const movedItem = useRef<{ id: number; parentId: number; previousListing?: Node[] }>(undefined)
  const [selected, setSelected] = useState<number[]>([])
  const [detail, setDetail] = useState<{ node: Node; mode: 'info' | 'versions' | 'permission' }>()
  const [viewedFile, setViewedFile] = useState<Node>()
  const [action, setAction] = useState<'create' | 'rename' | 'move'>()
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [grantNode, setGrantNode] = useState<Node>()
  const [grantDirty, setGrantDirty] = useState(false)
  const [uploadActivity, setUploadActivity] = useState<Record<string, boolean>>({})
  const [fileUploads, setFileUploads] = useState<Record<number, FileUploadState>>({})
  const [uploadStatus, setUploadStatus] = useState<Record<string, boolean>>({})
  const [uploadPaths, setUploadPaths] = useState<Node[][]>([])
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [modalDetail, setModalDetail] = useState(() => window.matchMedia(modalDetailViewport).matches)
  const [dropZone, setDropZone] = useState<HTMLDivElement | null>(null)
  const [dragTarget, setDragTarget] = useState(false)
  const [taskLabels, setTaskLabels] = useState<Record<string, string>>({})
  const dragDepth = useRef(0)
  const drawerTrigger = useRef<HTMLElement>(null)
  const detailCloseButton = useRef<HTMLButtonElement>(null)
  const explorerRef = useRef<HTMLElement>(null)
  const scrollPositions = useRef(new Map<string, number>())
  const restoredLocation = useRef<string>(undefined)
  const officeEditStarted = useRef(false)
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
  const selectedNode = detail && (nodes.find(node => node.id === detail.node.id) ?? detail.node)
  const grantedRights = rights.filter(([bit]) => selectedNode && (selectedNode.rights & bit)).map(([, label]) => label)
  const previewOffice = selectedNode && officePreview && canPreviewOffice(selectedNode)
  const previewAvailable = selectedNode && (previewOffice || previewKind(selectedNode))
  const fileUpload = fileUploads[currentId] ?? 'idle'
  const parentLabel = query ? selectedNode?.parentPath : '/' + path.map(node => node.name).join('/')
  const canMoveSelected = query ? selectedNode?.canMoveFromParent : current ? !!(current.rights & DELETE) : administrator
  const viewerNode = viewedFile && (nodes.find(node => node.id === viewedFile.id) ?? viewedFile)
  const pending = locationPending || (query ? searching : loading)
  const failed = query ? searchFailed : loadFailed
  const EmptyIcon = query ? Search : FolderOpen
  const detailId = selectedNode?.id
  const drawer = usePanelDismissal(browsing && (!!detail || action === 'create'), closeDrawer, !action)
  const DetailContainer = modalDetail ? 'dialog' : 'aside'
  const scrollKey = JSON.stringify([hash, query])

  useEffect(() => {
    const viewport = window.matchMedia(modalDetailViewport)
    const update = () => setModalDetail(viewport.matches)
    viewport.addEventListener('change', update)
    return () => viewport.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    if (pending || !browsing || restoredLocation.current === scrollKey || !explorerRef.current) return
    explorerRef.current.scrollTop = scrollPositions.current.get(scrollKey) ?? 0
    restoredLocation.current = scrollKey
  }, [browsing, pending, scrollKey])

  useLayoutEffect(() => {
    if (!detailId || !browsing) return
    const panel = drawer.current
    if (panel instanceof HTMLDialogElement && !panel.open) panel.showModal()
    detailCloseButton.current?.focus()
  }, [detailId, browsing, modalDetail, drawer])

  useEffect(() => {
    const root = document.documentElement
    const update = () => {
      setOfficePlugin(!!root.getAttribute('data-ftp-office-plugin')?.trim())
      setOfficePreview(root.getAttribute('data-ftp-office-preview') === '1')
    }
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['data-ftp-office-plugin', 'data-ftp-office-preview'] })
    update()
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
    const controller = new AbortController()
    async function resolve() {
      setSelected([])
      setAction(undefined)
      setDetail(undefined)
      setViewedFile(undefined)
      setMessage('')
      if (itemId === undefined) {
        setPath([])
        setResolvedHash(hash)
        return
      }
      const lookup = (id: number) => api.GET('/tree/{id}', {
        params: { path: { id } }, signal: controller.signal,
      })
      try {
        const { data: node, response } = await lookup(itemId)
        if (controller.signal.aborted) return
        if (!node) {
          setPath([])
          setMessage(response.status === 404 ? '项目不存在或无权访问' : `HTTP ${response.status}`)
          return
        }
        const ancestors = await loadAncestors(node, controller.signal)
        if (controller.signal.aborted) return
        setPath(node.isFile ? ancestors : [...ancestors, node])
        if (node.isFile) setViewedFile(node)
      } catch {
        if (!controller.signal.aborted) {
          setPath([])
          setMessage('无法加载项目')
        }
      } finally {
        if (!controller.signal.aborted) setResolvedHash(hash)
      }
    }
    void resolve()
    return () => controller.abort()
  }, [itemId, hash])

  useEffect(() => {
    if (!canUpload) return
    setUploadPaths(previous => previous.some(target => target.at(-1)?.id === currentId)
      ? previous.map(target => target.at(-1)?.id === currentId ? path : target)
      : [...previous, path])
  }, [path, canUpload, currentId])

  // The sidebar only expands the active branch, plus its siblings at each level.
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadFailed(false)
    void loadBranches(path, controller.signal).then(next => {
      if (!controller.signal.aborted) setBranches(next)
    }).catch(() => {
      if (!controller.signal.aborted) setLoadFailed(true)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [path, revision])

  useEffect(() => {
    setSelected([])
    setDetail(undefined)
    setAction(undefined)
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
        }
        else setMessage('项目不存在或无权管理')
      }).catch(() => {
        if (!controller.signal.aborted) setMessage('无法加载项目')
      })
    return () => controller.abort()
  }, [grantId, grantNode?.id])

  useEffect(() => {
    dragDepth.current = 0
    setDragTarget(false)
  }, [currentId, browsing, query])

  useEffect(() => {
    const moved = movedItem.current
    if (!moved) return
    if (query || (itemId ?? ROOT) !== moved.parentId) {
      movedItem.current = undefined
      return
    }
    const listing = branches[moved.parentId]
    if (locationPending || currentId !== moved.parentId || loading || !listing || listing === moved.previousListing) return
    const node = listing.find(entry => entry.id === moved.id)
    movedItem.current = undefined
    setMessage('项目已移动')
    if (node) {
      drawerTrigger.current = document.getElementById(`detail-trigger-${node.id}`)
      setDetail({ node, mode: 'info' })
    }
  }, [query, locationPending, currentId, itemId, loading, branches])

  function showGrants(id: number) {
    if (grantDirty && id !== grantNode?.id && !window.confirm('有未保存的更改，确定切换授权项目？')) return
    setMessage('')
    setAction(undefined)
    setDetail(undefined)
    openGrant(id)
  }

  function trackOfficeEdit() {
    officeEditStarted.current = true
    setViewedFile(undefined)
    closeDrawer(false)
  }

  function openFolder(id = ROOT) {
    setDetail(undefined)
    setAction(undefined)
    navigate(id === ROOT ? '' : `#item=${id}`)
  }

  function closeDrawer(restoreFocus = true) {
    if (formBusy) return
    if (drawer.current instanceof HTMLDialogElement) drawer.current.close()
    setDetail(undefined)
    setAction(undefined)
    if (restoreFocus) drawerTrigger.current?.focus()
    drawerTrigger.current = null
  }

  function update(message: string) {
    setMessage(message)
    refresh(value => value + 1)
  }

  async function saveName(event: FormEvent<HTMLFormElement>, node?: Node) {
    event.preventDefault()
    if (formBusy) return
    const name = String(new FormData(event.currentTarget).get('name'))
    setFormBusy(true)
    setFormError('')
    try {
      const { response } = node
        ? await api.POST('/tree/{id}/rename', { params: { path: { id: node.id } }, body: { name } })
        : await api.POST('/tree', { body: { name, parentId: current?.id } })
      if (response.ok) {
        if (node) {
          setAction(undefined)
          setDetail({ node: { ...node, name }, mode: 'info' })
        } else closeDrawer()
        update(node ? '名称已更新' : '目录已创建')
      } else {
        setFormError(response.status === 409 ? '此位置已有同名项目，请更换名称'
          : response.status === 400 ? '名称不可用，请检查后重试'
          : response.status === 403 ? '当前账户没有此操作的权限' : '保存失败，请重试')
      }
    } catch {
      setFormError('无法连接服务，请重试')
    } finally {
      setFormBusy(false)
    }
  }

  async function recycleNode(node: Node) {
    if (recycling || (!node.isFile && !window.confirm(`将文件夹「${node.name}」及其内容移入回收站？`))) return
    setRecycling(true)
    try {
      const { response } = await api.DELETE('/tree/{id}', { params: { path: { id: node.id } } })
      if (response.ok) {
        setSelected(ids => ids.filter(id => id !== node.id))
        setDetail(previous => previous?.node.id === node.id ? undefined : previous)
        update(`「${node.name}」已移入回收站`)
      } else setMessage(response.status === 403 ? '当前账户没有删除权限' : '移入回收站失败，请刷新后重试')
    } catch {
      setMessage('无法连接服务，请重试')
    } finally {
      setRecycling(false)
    }
  }

  const hasGrant = current?.rights && current.rights & GRANT
  return <>
    <DirectorySidebar visible={active && !grantId} browsing={browsing && !query} rootSelected={browsing && !query && !current}
      recycle={recycle} recycleHref={recycleHref} openRecycle={openRecycle} openFolder={openFolder}
      path={path} branches={branches} revision={revision} width={sidebarWidth} resize={resizeSidebar}
      drawerOpen={directoryOpen} closeDrawer={() => setDirectoryOpen(false)}
    />
    <main className="shell-main explorer" ref={explorerRef} hidden={!browsing} onScroll={event => {
      if (browsing && !pending && restoredLocation.current === scrollKey) scrollPositions.current.set(scrollKey, event.currentTarget.scrollTop)
    }}>
      <div className={selectedNode ? 'explorer-workspace has-details' : 'explorer-workspace'}>
      <section aria-label="共享目录">
        <nav className="breadcrumbs" aria-label="目录路径">
          <button className="directory-trigger" aria-haspopup="dialog" aria-expanded={directoryOpen} aria-controls="file-directories"
            onClick={() => setDirectoryOpen(true)}><PanelLeft size={16} />目录</button>
          {query ? <button className="ghost" onClick={() => navigate(hash)}><ArrowLeft size={16} />返回目录</button> : <>
            <button className="ghost" aria-label="根目录" onClick={() => openFolder()}>共享目录</button>
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
              {!pending && !failed && <span>{rows.length} 项</span>}
              {!query && current && <span className="pill">{rightsLabel(current)}</span>}
            </p>
          </div>
          {!query && (canCreate || !!hasGrant) && <div className="explorer-actions">
            {canUpload && <UploadPickers parentId={currentId} disabled={locationPending} state={fileUpload} />}
            <ActionGroup label="更多" compact={canUpload}>
            {canCreate && <button data-panel-trigger disabled={locationPending} className={canUpload ? '' : 'primary'} onClick={event => {
              drawerTrigger.current = event.currentTarget.closest('details')?.querySelector('summary') ?? event.currentTarget
              setDetail(undefined)
              setFormError('')
              setAction('create')
            }}>
              <FolderPlus size={16} />新建文件夹
            </button>}
            {!!hasGrant && <button className="button" aria-label="管理当前权限" disabled={locationPending}
              onClick={() => current && showGrants(current.id)}>
              <ShieldCheck size={16} />管理权限
            </button>}
            </ActionGroup>
          </div>}
        </div>
        {!query && current && !(current.rights & BROWSE) && <p className="notice">
          {canUpload ? '这是投递箱。你可以上传文件，并查看自己上传的内容。' : '此目录内容不可浏览；仅显示可访问的路径。'}
        </p>}

        <label className="compact-sort">排序
          <select value={sort.key + ':' + sort.descending} onChange={event => {
            const [key, direction] = event.target.value.split(':')
            setSort({ key: key as SortKey, descending: direction === 'true' })
          }}>
            {Object.entries({name: '名称', size: '大小', createdAt: '修改时间', username: '修改人'}).flatMap(([key, label]) =>
              [false, true].map(desc => <option key={key + desc} value={key + ':' + desc}>{label} · {desc ? '降序' : '升序'}</option>))}
          </select>
        </label>
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
          <table aria-label="文件列表" aria-busy={pending}>
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
              {pending ? <tr><td colSpan={6} className="table-loading" role="status">正在加载…</td></tr> :
                !failed && rows.map(node => <tr key={node.id} className={selectedIds.includes(node.id) ? 'selected' : undefined}
                  data-detail-open={selectedNode?.id === node.id || undefined}>
                  <td><input type="checkbox" aria-label={node.name} checked={selectedIds.includes(node.id)}
                    onChange={event => setSelected(ids => event.target.checked ? [...ids, node.id] : ids.filter(id => id !== node.id))} /></td>
                  <td>
                    {officePreview && canPreviewOffice(node) ? <a className="button file-name ghost" title={node.name} aria-label={node.name}
                      href={`/api/files/${node.id}/office-edits`} data-ftp-office-preview="1" data-ftp-office-version={node.latestVersion?.id}
                      onClick={event => { event.preventDefault(); closeDrawer(false) }}>
                      <FileIcon node={node} tile /><ListName name={node.name} />
                    </a> : <button className="file-name ghost" data-panel-trigger={node.isFile || undefined} onClick={() => {
                      setAction(undefined)
                      if (node.isFile) {
                        closeDrawer(false)
                        setViewedFile(node)
                      } else openFolder(node.id)
                    }} title={node.name} aria-label={node.name}><FileIcon node={node} tile /><ListName name={node.name} /></button>}
                    {node.traversable && <small className="access-note">仅通行</small>}
                    {query && node.parentPath && <a className="file-subtitle file-parent ellipsis" title={node.parentPath}
                      aria-label={`打开所在目录 ${node.parentPath}`}
                      href={node.parentId ? `/#item=${node.parentId}` : '/'}
                      onClick={event => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                        event.preventDefault()
                        openFolder(node.parentId)
                      }}>{node.parentPath === '/' ? '共享目录' : node.parentPath}</a>}
                    {node.latestVersion?.createdAt && <time className="file-subtitle compact-file-time"
                      dateTime={node.latestVersion.createdAt}>{formatFileTime(node.latestVersion.createdAt)}<span className="compact-size"> · {formatSize(node.latestVersion.size)}</span></time>}
                  </td>
                  <td className="file-author">{node.latestVersion?.username && <span className="ellipsis">{node.latestVersion.username}</span>}</td>
                  <td className="file-time muted">{node.latestVersion?.createdAt && <time dateTime={node.latestVersion.createdAt}>{formatFileTime(node.latestVersion.createdAt)}</time>}</td>
                  <td className="file-size">{node.latestVersion && formatSize(node.latestVersion.size)}</td>
                  <td><div className="row-actions">
                    <OfficeEditAction node={node} officePlugin={officePlugin} onOpen={trackOfficeEdit} icon />
                    {node.isFile && !!(node.rights & DOWNLOAD) && <a className="button icon" href={`/api/tree/${node.id}/download`}
                      download aria-label={`下载 ${node.name}`} title="下载"><Download size={15} /></a>}
                    <button id={`detail-trigger-${node.id}`} className="icon" data-panel-trigger aria-expanded={selectedNode?.id === node.id}
                      title="详情与操作" aria-label={`详情与操作 ${node.name}`} onClick={event => {
                      drawerTrigger.current = event.currentTarget
                      setAction(undefined)
                      setDetail({ node, mode: 'info' })
                    }}><MoreHorizontal size={16} /></button>
                  </div></td>
                </tr>)}
            </tbody>
          </table>
          {!pending && (failed || !rows.length) && (
            !failed && !query && canUpload ? (
              <button type="button" className="table-empty" disabled={fileUpload !== 'idle'}
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
            onClick={() => void recycleNode(checkedNode)}><Trash2 size={16} />移入回收站</button>}
          <button className="ghost icon" aria-label="取消选择" onClick={() => setSelected([])}><X size={16} /></button>
        </div>}
      </section>
      {action === 'create' && <section ref={drawer} className="drawer" aria-label="新建文件夹">
        <DrawerHeading title="新建文件夹" close={() => closeDrawer()} />
        <form className="stack" onSubmit={saveName}>
          <label>目录名称<input name="name" autoFocus readOnly={formBusy} required maxLength={255} /></label>
          {formError && <p className="bad" role="alert">{formError}</p>}
          <button className="primary" disabled={formBusy}>{formBusy ? '正在创建…' : '创建目录'}</button>
        </form>
      </section>}
      {detail && selectedNode && action !== 'create' && <DetailContainer ref={panel => { drawer.current = panel }}
        className="drawer file-details" aria-label="项目详情" key={selectedNode.id} onCancel={event => {
          if (event.target !== event.currentTarget) return
          event.preventDefault()
          closeDrawer()
        }} onClick={event => {
          if (!modalDetail || action || event.target !== event.currentTarget) return
          const bounds = event.currentTarget.getBoundingClientRect()
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDrawer()
        }}>
        {action === 'rename' ? <form className="stack inspector-rename" onSubmit={event => void saveName(event, selectedNode)}>
          <label>新名称<input name="name" defaultValue={selectedNode.name} autoFocus readOnly={formBusy} required maxLength={255} /></label>
          {formError && <p className="bad" role="alert">{formError}</p>}
          <div className="detail-actions">
            <button className="primary" disabled={formBusy}>{formBusy ? '正在保存…' : '保存名称'}</button>
            <button type="button" disabled={formBusy} onClick={() => setAction(undefined)}>取消</button>
          </div>
        </form> : <header className="file-details-header">
          <DrawerHeading title={selectedNode.name} node={selectedNode} close={() => closeDrawer()} closeRef={detailCloseButton} />
          <p>{fileTypeLabel(selectedNode)}{selectedNode.latestVersion && ` · ${formatSize(selectedNode.latestVersion.size)}`}</p>
        </header>}
        {action === 'move' ? <MovePicker node={selectedNode} administrator={administrator}
          close={() => setAction(undefined)} moved={parentId => {
            movedItem.current = { id: selectedNode.id, parentId: parentId ?? ROOT, previousListing: branches[parentId ?? ROOT] }
            openFolder(parentId ?? ROOT)
            update('项目已移动')
          }} /> : action === 'rename' ? null : detail.mode === 'versions' ? <VersionsPanel node={selectedNode}
          restored={() => refresh(v => v + 1)} close={() => setDetail({ node: selectedNode, mode: 'info' })} />
          : detail.mode === 'permission' ? <>
            <button className="ghost inspector-back" onClick={() => setDetail({ node: selectedNode, mode: 'info' })}><ArrowLeft size={16} />返回文件详情</button>
            <dl className="file-metadata"><dt>我的权限</dt><dd>{grantedRights.join('、') || rightsLabel(selectedNode)}</dd></dl>
            <PermissionInspection node={selectedNode} administrator={administrator} />
            {!!(selectedNode.rights & GRANT) && <button onClick={() => showGrants(selectedNode.id)}>管理权限</button>}
          </> : <>
          <div className="detail-actions inspector-tools">
            {previewOffice ? <a className="button primary" href={`/api/files/${selectedNode.id}/office-edits`}
              data-ftp-office-preview="1" data-ftp-office-version={selectedNode.latestVersion?.id} onClick={event => event.preventDefault()}>
              <Eye size={16} />预览</a> : previewAvailable && <button className="primary" onClick={() => setViewedFile(selectedNode)}>
              <Eye size={16} />预览</button>}
            {selectedNode.isFile && !!(selectedNode.rights & DOWNLOAD) && <a className={previewAvailable ? 'button' : 'button primary'}
              href={`/api/tree/${selectedNode.id}/download`} download><Download size={16} />下载</a>}
            <details className="inspector-more" onBlur={event => {
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
            }} onKeyDown={event => {
              if (event.key !== 'Escape' || !event.currentTarget.open || (event.target as Element).closest('.text-dialog')) return
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.open = false
              event.currentTarget.querySelector('summary')?.focus()
            }}>
              <summary className="button" aria-label="更多操作"><MoreHorizontal size={16} />更多</summary>
              <div className="popup">
                <OfficeEditAction node={selectedNode} officePlugin={officePlugin} onOpen={trackOfficeEdit} />
                {selectedNode.isFile && <TextEditor node={selectedNode} saved={() => refresh(value => value + 1)} />}
                <CopyItemLink node={selectedNode} />
                {!!(selectedNode.rights & MODIFY) && <button onClick={() => { setFormError(''); setAction('rename') }}>重命名</button>}
                {canMoveSelected && <button aria-label={`移动 ${selectedNode.name}`} onClick={() => setAction('move')}>移动</button>}
              </div>
            </details>
          </div>
          <dl className="file-metadata">
            {parentLabel && <><dt>所在位置</dt><dd>{parentLabel === '/' ? '共享目录' : parentLabel}</dd></>}
            {selectedNode.latestVersion?.createdAt && <><dt>修改时间</dt><dd><time dateTime={selectedNode.latestVersion.createdAt}>
              {formatFileTime(selectedNode.latestVersion.createdAt, true)}</time></dd></>}
            {selectedNode.latestVersion?.username && <><dt>修改人</dt><dd>{selectedNode.latestVersion.username}</dd></>}
          </dl>
          <nav className="inspector-links" aria-label="项目详情视图">
            {selectedNode.isFile && !!(selectedNode.rights & BROWSE) && <button className="ghost"
              onClick={() => setDetail({ node: selectedNode, mode: 'versions' })}><History size={16} />版本历史<ChevronRight size={16} /></button>}
            <button className="ghost" onClick={() => setDetail({ node: selectedNode, mode: 'permission' })}>
              <ShieldCheck size={16} />我的权限<small>{grantedRights.length > 2
                ? `${grantedRights.length} 项权限`
                : grantedRights.join('、') || rightsLabel(selectedNode)}</small><ChevronRight size={16} /></button>
          </nav>
        </>}
      </DetailContainer>}
      </div>
      {browsing && viewerNode && <FileViewer key={viewerNode.id} node={viewerNode} officePreview={officePreview}
        close={() => setViewedFile(undefined)} saved={() => refresh(value => value + 1)} />}
    </main>

    {active && recycle && <main className="shell-main"><button className="directory-trigger" aria-haspopup="dialog" aria-expanded={directoryOpen} aria-controls="file-directories"
      onClick={() => setDirectoryOpen(true)}><PanelLeft size={16} />目录</button><RecycleBin administrator={administrator} changed={() => refresh(v => v + 1)} /></main>}
    {active && grantId && grantNode?.id !== grantId && <main className="shell-main"><button onClick={() => navigate(hash)}>返回目录</button></main>}
    {grantNode && <main className="shell-main" hidden={!active || grantNode.id !== grantId}><GrantsPanel key={grantNode.id} administrator={administrator} node={grantNode} onDirtyChange={setGrantDirty}
      close={() => { navigate(hash); refresh(v => v + 1) }} /></main>}
    {active && message && <div className="toast">
      <span role="status">{message}</span>
      {message.endsWith('」已移入回收站') && <a href={recycleHref} onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        setMessage('')
        openRecycle()
      }}>前往回收站</a>}
      <button className="icon ghost" aria-label="关闭提示" onClick={() => setMessage('')}><X size={15} /></button>
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

function ListName({name}: {name: string}) {
  const chars = Array.from(name)
  // Keep enough of the suffix to distinguish adjacent monthly versions.
  return <span className="list-name"><span>{chars.slice(0, -13).join('')}</span><span>{chars.slice(-13).join('')}</span></span>
}

function ActionGroup({label, children, compact = true}: {label: string; children: ReactNode; compact?: boolean}) {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 720px)').matches)
  const menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)')
    const resize = () => setNarrow(media.matches)
    media.addEventListener('change', resize)
    return () => media.removeEventListener('change', resize)
  }, [])
  useEffect(() => {
    function outside(event: Event) {
      if (menu.current && !menu.current.contains(event.target as globalThis.Node)) menu.current.open = false
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
    }
  }, [])
  if (!narrow || !compact) return <>{children}</>
  return <details className="action-group" ref={menu} onKeyDown={event => {
    if (event.key === 'Escape') {
      event.currentTarget.open = false
      event.currentTarget.querySelector('summary')?.focus()
    }
  }}>
    <summary className={'button ' + (label === '上传' ? 'primary' : '')}>{label} ▾</summary>
    <div className="popup" onClick={() => { if (menu.current) menu.current.open = false }}>{children}</div>
  </details>
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

function DrawerHeading({ title, node, close, closeRef }: {
  title: string; node?: Node; close: () => void; closeRef?: Ref<HTMLButtonElement>
}) {
  return <div className="drawer-heading">{node && <FileIcon node={node} tile />}
    <h2>{title}</h2><button ref={closeRef} className="icon ghost"
      aria-label="关闭详情" onClick={close}><X size={18} /></button>
  </div>
}

function chooseUploadFile(parentId: number) {
  document.getElementById(`upload-file-${parentId}`)?.click()
}

function formatFileTime(value: string, full = false) {
  return new Date(value).toLocaleString('zh-CN', {
    year: full ? 'numeric' : undefined, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function UploadPickers({ parentId, disabled, state }: { parentId: number; disabled: boolean; state: FileUploadState }) {
  const label = { idle: '上传文件', resume: '继续上传', uploading: '正在上传…', conflict: '等待处理同名文件' }[state]
  return <div className="upload-pickers"><ActionGroup label="上传">
    <button className="primary" disabled={disabled || (state !== 'idle' && state !== 'resume')} onClick={() => {
      if (state === 'resume') document.getElementById(`resume-file-${parentId}`)?.click()
      else chooseUploadFile(parentId)
    }}><Upload size={16} />{label}</button>
    <button disabled={disabled} onClick={() => document.getElementById(`upload-folder-${parentId}`)?.click()}>
      <FolderOpen size={16} />上传文件夹</button>
  </ActionGroup></div>
}

function MovePicker({ node, administrator, close, moved }: {
  node: Node; administrator: boolean; close: () => void; moved: (parentId: number | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function move(parentId: number | null) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const { response } = await api.POST('/tree/{id}/move', {
        params: { path: { id: node.id } }, body: { parentId },
      })
      if (response.ok) {
        moved(parentId)
      } else {
        setError(response.status === 409 ? '目标位置已有同名项目，或目标位于自身子目录'
          : response.status === 403 ? '当前账户没有移动到此目录的权限' : '移动失败，请重试')
      }
    } catch {
      setError('无法连接服务，请重试')
    } finally {
      setBusy(false)
    }
  }
  return <>
    <DirectoryPicker label="移动目标" submitLabel="移动到此目录" administrator={administrator}
      excludeId={node.id} busy={busy} choose={id => void move(id)} close={close} />
    {error && <p className="bad" role="alert">{error}</p>}
  </>
}
