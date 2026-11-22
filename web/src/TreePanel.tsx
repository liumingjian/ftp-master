import { useEffect, useRef, useState, type Ref } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, Download, FolderOpen, FolderPlus, MoreHorizontal, PanelLeft, Search, ShieldCheck, Upload, X } from 'lucide-react'
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
import { UploadRow } from './UploadRow'
import { GrantsPanel, PermissionInspection } from './GrantsPanel'
import { FileIcon, formatSize } from './FileIcon'
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
  const [selected, setSelected] = useState<number[]>([])
  const [detail, setDetail] = useState<{ node: Node; mode: 'info' | 'versions' | 'permission' }>()
  const [viewedFile, setViewedFile] = useState<Node>()
  const [action, setAction] = useState<'create' | 'rename' | 'move'>()
  const [grantNode, setGrantNode] = useState<Node>()
  const [grantDirty, setGrantDirty] = useState(false)
  const [uploadActivity, setUploadActivity] = useState<Record<string, boolean>>({})
  const [uploadStatus, setUploadStatus] = useState<Record<string, boolean>>({})
  const [uploadPaths, setUploadPaths] = useState<Node[][]>([])
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [dropZone, setDropZone] = useState<HTMLDivElement | null>(null)
  const drawerTrigger = useRef<HTMLButtonElement>(null)
  const detailCloseButton = useRef<HTMLButtonElement>(null)
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
  const otherUploads = Object.keys(uploadActivity).filter(key =>
    uploadActivity[key] && (!browsing || !!query || Number(key.split(':')[1]) !== currentId))
  const selectedNode = detail && (nodes.find(node => node.id === detail.node.id) ?? detail.node)
  const canMoveSelected = query ? selectedNode?.canMoveFromParent : current ? !!(current.rights & DELETE) : administrator
  const viewerNode = viewedFile && (nodes.find(node => node.id === viewedFile.id) ?? viewedFile)
  const pending = locationPending || (query ? searching : loading)
  const failed = query ? searchFailed : loadFailed
  const EmptyIcon = query ? Search : FolderOpen
  const detailId = selectedNode?.id
  const drawer = usePanelDismissal(browsing && (!!detail || action === 'create'), closeDrawer, !action)

  useEffect(() => {
    if (detailId && browsing) detailCloseButton.current?.focus()
  }, [detailId, browsing])

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
    setDetail(undefined)
    setAction(undefined)
    if (restoreFocus) drawerTrigger.current?.focus()
    drawerTrigger.current = null
  }

  function update(message: string) {
    setMessage(message)
    refresh(value => value + 1)
  }

  async function create(form: FormData) {
    const { response } = await api.POST('/tree', {
      body: { name: String(form.get('name')), parentId: current?.id },
    })
    if (response.ok) closeDrawer()
    update(response.ok ? '目录已创建' : `HTTP ${response.status}`)
  }

  async function rename(node: Node, form: FormData) {
    const name = String(form.get('name'))
    const { response } = await api.POST('/tree/{id}/rename', {
      params: { path: { id: node.id } }, body: { name },
    })
    if (response.ok) {
      setAction(undefined)
      setDetail({ node: { ...node, name }, mode: 'info' })
    }
    update(response.ok ? '名称已更新' : response.status === 409 ? '目标位置已有同名项目' : `HTTP ${response.status}`)
  }

  async function deleteNode(id: number) {
    const { response } = await api.DELETE('/tree/{id}', { params: { path: { id } } })
    if (response.ok) setDetail(undefined)
    update(response.ok ? '已移入回收站' : `HTTP ${response.status}`)
  }

  const hasGrant = current?.rights && current.rights & GRANT
  return <>
    <DirectorySidebar visible={active && !grantId} browsing={browsing && !query} rootSelected={browsing && !query && !current}
      recycle={recycle} recycleHref={recycleHref} openRecycle={openRecycle} openFolder={openFolder}
      path={path} branches={branches} revision={revision} width={sidebarWidth} resize={resizeSidebar}
      drawerOpen={directoryOpen} closeDrawer={() => setDirectoryOpen(false)}
    />
    <main className="shell-main explorer" hidden={!browsing}>
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
            {!!hasGrant && <button className="button" aria-label="管理当前权限" disabled={locationPending}
              onClick={() => current && showGrants(current.id)}>
              <ShieldCheck size={16} />管理权限
            </button>}
            {canCreate && <button data-panel-trigger disabled={locationPending} className={canUpload ? '' : 'primary'} onClick={event => {
              drawerTrigger.current = event.currentTarget
              setDetail(undefined)
              setAction('create')
            }}>
              <FolderPlus size={16} />新建文件夹
            </button>}
            {canUpload && <UploadPickers parentId={currentId} disabled={locationPending} />}
          </div>}
        </div>
        {!query && current && !(current.rights & BROWSE) && <p className="notice">
          {canUpload ? '这是投递箱。你可以上传文件，并查看自己上传的内容。' : '此目录内容不可浏览；仅显示可访问的路径。'}
        </p>}

        <div className="file-table" ref={setDropZone}>
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
                const reportStatus = (kind: string, value: boolean) => setUploadStatus(previous => ({ ...previous, [`${kind}:${id}`]: value }))
                const visible = browsing && !locationPending && !query && canUpload && id === currentId
                const hasStatus = uploadStatus[`file:${id}`] || uploadStatus[`folder:${id}`]
                return <tr key={id} className="transfer-row" hidden={!visible || !hasStatus}>
                  <td colSpan={6}>
                    <UploadRow parentId={id} visible={visible} dropZone={visible ? dropZone : null} onActivityChange={value => report('file', value)}
                      onStatusChange={value => reportStatus('file', value)} completed={() => refresh(v => v + 1)} />
                    <FolderUpload parentId={id} visible={visible} dropZone={visible ? dropZone : null} onActivityChange={value => report('folder', value)}
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
                    {officePreview && canPreviewOffice(node) ? <a className="button file-name ghost" title={node.name}
                      href={`/api/files/${node.id}/office-edits`} data-ftp-office-preview="1" data-ftp-office-version={node.latestVersion?.id}
                      onClick={event => { event.preventDefault(); closeDrawer(false) }}>
                      <FileIcon node={node} tile /><span className="ellipsis">{node.name}</span>
                    </a> : <button className="file-name ghost" data-panel-trigger={node.isFile || undefined} onClick={() => {
                      setAction(undefined)
                      if (node.isFile) {
                        closeDrawer(false)
                        setViewedFile(node)
                      } else openFolder(node.id)
                    }} title={node.name}><FileIcon node={node} tile /><span className="ellipsis">{node.name}</span></button>}
                    {node.traversable && <small className="access-note">仅通行</small>}
                  </td>
                  <td className="file-author">{node.latestVersion?.username && <><span className="avatar">{node.latestVersion.username.slice(-1)}</span><span className="ellipsis">{node.latestVersion.username}</span></>}</td>
                  <td className="file-time muted">{node.latestVersion?.createdAt && <time dateTime={node.latestVersion.createdAt}>{new Date(node.latestVersion.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>}</td>
                  <td className="file-size">{node.latestVersion && formatSize(node.latestVersion.size)}</td>
                  <td><div className="row-actions">
                    <OfficeEditAction node={node} officePlugin={officePlugin} onOpen={trackOfficeEdit} icon />
                    {node.isFile && !!(node.rights & DOWNLOAD) && <a className="button icon" href={`/api/tree/${node.id}/download`}
                      download aria-label={`下载 ${node.name}`} title="下载"><Download size={15} /></a>}
                    <button className="icon" data-panel-trigger aria-expanded={selectedNode?.id === node.id}
                      title="更多操作" aria-label={`更多操作 ${node.name}`} onClick={event => {
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
              <button type="button" className="table-empty" disabled={uploadActivity[`file:${currentId}`]}
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
          <span>已选 {selectedIds.length} 项</span><ZipDownload selected={selectedIds} />
          <button className="ghost icon" aria-label="取消选择" onClick={() => setSelected([])}><X size={16} /></button>
        </div>}
      </section>
      {action === 'create' && <section ref={drawer} className="drawer" aria-label="新建文件夹">
        <DrawerHeading title="新建文件夹" close={() => closeDrawer()} />
        <form className="stack" action={create}>
          <label>目录名称<input name="name" autoFocus required maxLength={255} /></label>
          <button className="primary">创建目录</button>
        </form>
      </section>}
      {detail && selectedNode && action !== 'create' && <aside ref={drawer} className="drawer" aria-label="项目详情" key={selectedNode.id}>
        <DrawerHeading title={selectedNode.name} node={selectedNode} close={() => closeDrawer()} closeRef={detailCloseButton} />
        {detail.mode === 'versions' ? <VersionsPanel node={selectedNode} close={() => {
          setDetail({ node: selectedNode, mode: 'info' })
          refresh(v => v + 1)
        }} /> : detail.mode === 'permission' ? <PermissionInspection node={selectedNode} administrator={administrator} /> : <>
          <dl className="file-metadata">
            <dt>访问权限</dt><dd>{rightsLabel(selectedNode)}</dd>
            {selectedNode.latestVersion && <>
              <dt>大小</dt><dd>{formatSize(selectedNode.latestVersion.size)}</dd>
              {selectedNode.latestVersion.username && <><dt>修改人</dt><dd>{selectedNode.latestVersion.username}</dd></>}
              {selectedNode.latestVersion.createdAt && <><dt>修改时间</dt><dd><time dateTime={selectedNode.latestVersion.createdAt}>
                {new Date(selectedNode.latestVersion.createdAt).toLocaleString('zh-CN', { hour12: false })}
              </time></dd></>}
            </>}
          </dl>
          <div className="detail-actions">
            {selectedNode.isFile && !!(selectedNode.rights & BROWSE) && <>
              {previewKind(selectedNode) && <button onClick={() => setViewedFile(selectedNode)}>预览</button>}
              <button onClick={() => setDetail({ node: selectedNode, mode: 'versions' })}>文件版本</button>
            </>}
            <OfficeEditAction node={selectedNode} officePlugin={officePlugin} onOpen={trackOfficeEdit} />
            <CopyItemLink node={selectedNode} />
            <button onClick={() => setDetail({ node: selectedNode, mode: 'permission' })}>查看有效权限</button>
            {selectedNode.isFile && <TextEditor node={selectedNode} saved={() => refresh(value => value + 1)} />}
          </div>
          <div className="detail-actions detail-management">
            {!!(selectedNode.rights & GRANT) && <button onClick={() => showGrants(selectedNode.id)}>管理权限</button>}
            {!!(selectedNode.rights & MODIFY) && <button onClick={() => setAction('rename')}>重命名</button>}
            {canMoveSelected && <button aria-label={`移动 ${selectedNode.name}`}
              onClick={() => setAction('move')}>移动</button>}
            {!!(selectedNode.rights & DELETE) && <button className="danger" aria-label={`删除 ${selectedNode.name}`}
              onClick={() => void deleteNode(selectedNode.id)}>移入回收站</button>}
          </div>
          {action === 'rename' && <form className="stack" action={form => rename(selectedNode, form)}>
            <label>新名称<input name="name" defaultValue={selectedNode.name} autoFocus required maxLength={255} /></label>
            <div className="detail-actions">
              <button type="button" onClick={() => setAction(undefined)}>取消</button>
              <button className="primary">保存名称</button>
            </div>
          </form>}
          {action === 'move' && <MovePicker node={selectedNode} administrator={administrator}
            close={() => setAction(undefined)} moved={() => { setAction(undefined); setDetail(undefined) }} report={update} />}
        </>}
      </aside>}
      {browsing && viewerNode && <FileViewer key={viewerNode.id} node={viewerNode} officePreview={officePreview}
        close={() => setViewedFile(undefined)} saved={() => refresh(value => value + 1)} />}
    </main>

    {active && recycle && <main className="shell-main"><button className="directory-trigger" aria-haspopup="dialog" aria-expanded={directoryOpen} aria-controls="file-directories"
      onClick={() => setDirectoryOpen(true)}><PanelLeft size={16} />目录</button><RecycleBin administrator={administrator} changed={() => refresh(v => v + 1)} /></main>}
    {active && grantId && grantNode?.id !== grantId && <main className="shell-main"><button onClick={() => navigate(hash)}>返回目录</button></main>}
    {grantNode && <main className="shell-main" hidden={!active || grantNode.id !== grantId}><GrantsPanel key={grantNode.id} administrator={administrator} node={grantNode} onDirtyChange={setGrantDirty}
      close={() => { navigate(hash); refresh(v => v + 1) }} /></main>}
    {active && message && <p className="toast" role="status">{message}<button className="icon ghost" aria-label="关闭提示" onClick={() => setMessage('')}><X size={15} /></button></p>}
    {transferSlot && !!otherUploads.length && createPortal(<details className="upload-indicator">
      <summary><Upload size={16} /><span className="upload-indicator-label">其他目录上传 {otherUploads.length}</span></summary>
      <div className="popup">{uploadPaths.filter(target => otherUploads.some(key => key.endsWith(`:${target.at(-1)!.id}`))).map(target =>
        <button key={target.at(-1)!.id} onClick={event => { event.currentTarget.closest('details')!.open = false; openFolder(target.at(-1)!.id) }}>
          {target.map(node => node.name).join('/')}
        </button>)}</div>
    </details>, transferSlot)}
  </>
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

function UploadPickers({ parentId, disabled }: { parentId: number; disabled: boolean }) {
  return <div className="upload-pickers">
    <button className="primary" disabled={disabled} onClick={() => chooseUploadFile(parentId)}><Upload size={16} />上传文件</button>
    <button className="icon" disabled={disabled} aria-label="上传文件夹" title="上传文件夹"
      onClick={() => document.getElementById(`upload-folder-${parentId}`)?.click()}><FolderOpen size={16} /></button>
  </div>
}

function MovePicker({ node, administrator, close, moved, report }: {
  node: Node; administrator: boolean; close: () => void; moved: () => void; report: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  async function move(parentId: number | null) {
    if (busy) return
    setBusy(true)
    try {
      const { response } = await api.POST('/tree/{id}/move', {
        params: { path: { id: node.id } }, body: { parentId },
      })
      if (response.ok) moved()
      report(response.ok ? '项目已移动' : response.status === 409 ? '目标位置已有同名项目，或目标位于自身子目录' : `HTTP ${response.status}`)
    } catch {
      report('无法连接服务器，移动失败')
    } finally {
      setBusy(false)
    }
  }
  return <DirectoryPicker label="移动目标" submitLabel="移动到此目录" administrator={administrator}
    excludeId={node.id} busy={busy} choose={id => void move(id)} close={close} />
}
