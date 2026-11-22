import { useLayoutEffect, useRef, useState } from 'react'
import { Download, Pencil, X } from 'lucide-react'
import { previewKind } from './BrowseTools'
import { FileIcon } from './FileIcon'
import { TextEditor } from './TextEditor'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']
const officeFormats = new Set(['doc', 'docx', 'wps', 'xls', 'xlsx'])
const officeLimit = 25 * 1024 * 1024

function editableOfficeVersion(node: Node) {
  const version = node.latestVersion
  if (node.isFile && (node.rights & 8) && version &&
      officeFormats.has(version.format) && version.size <= officeLimit) return version
}

export function canPreviewOffice(node: Node) {
  const version = node.latestVersion
  return node.isFile && !!(node.rights & 1) && version &&
    officeFormats.has(version.format) && version.size <= officeLimit
}

export function OfficeEditAction({ node, officePlugin, onOpen, icon = false }: {
  node: Node
  officePlugin: boolean
  onOpen: () => void
  icon?: boolean
}) {
  const version = editableOfficeVersion(node)
  if (!version) return null

  if (!officePlugin && icon) return <span className="office-edit-indicator" title="在线编辑需要 WPS 插件">
    <button type="button" className="icon" disabled aria-label={`在线编辑 ${node.name}`}>
      <Pencil size={15} aria-hidden="true" />
    </button>
  </span>

  if (!officePlugin) return <button type="button" className="office-edit" disabled
    aria-label={`在线编辑 ${node.name}，需要 WPS 插件`}>
    <span>在线编辑</span>
    <small>需 WPS 插件</small>
  </button>

  return <a className={icon ? 'button icon office-edit-indicator' : 'button office-edit'} href={`/api/files/${node.id}/office-edits`}
    data-ftp-office-edit="1" data-ftp-office-version={version.id} target="_blank" rel="noopener"
    title="在线编辑"
    onClick={event => { event.preventDefault(); onOpen() }} aria-label={`在线编辑 ${node.name}`}>
    <Pencil size={15} aria-hidden="true" />{!icon && '在线编辑'}
  </a>
}

export function FileViewer({ node, officePreview, close, saved }: {
  node: Node
  officePreview: boolean
  close: () => void
  saved: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const version = node.latestVersion
  const kind = previewKind(node)
  const office = version && officeFormats.has(version.format)
  const download = !!(node.rights & 2)

  useLayoutEffect(() => {
    const viewer = dialog.current
    if (viewer && !viewer.open) viewer.showModal()
  }, [])

  function dismiss() {
    dialog.current?.close()
    close()
  }

  return <dialog ref={dialog} className={kind ? 'file-viewer' : 'file-viewer compact'}
    aria-labelledby="file-viewer-title" onCancel={event => {
      if (event.target !== event.currentTarget) return
      event.preventDefault()
      dismiss()
    }}
    onClick={event => { if (event.target === event.currentTarget) dismiss() }}>
    <div className="file-viewer-layout">
      <header className="file-viewer-header">
        <FileIcon node={node} tile />
        <h2 id="file-viewer-title" title={node.name}>{node.name}</h2>
        <div className="file-viewer-actions">
          <TextEditor node={node} saved={saved} />
          {download && <a className="button" href={`/api/tree/${node.id}/download`} download>
            <Download size={16} aria-hidden="true" />下载
          </a>}
          <button type="button" className="icon ghost" aria-label="关闭文件查看" autoFocus onClick={dismiss}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      {kind ? <section aria-label="文件预览" className={`file-viewer-body ${kind}`}>
        <PreviewContent key={version?.id} node={node} kind={kind} />
      </section> : <div className="file-viewer-notice">
        {office && canPreviewOffice(node) && officePreview
          ? <p><a className="button" href={`/api/files/${node.id}/office-edits`} data-ftp-office-preview="1"
            data-ftp-office-version={version.id} onClick={event => { event.preventDefault(); dismiss() }}>预览</a></p>
          : <p>{office ? version.size > officeLimit ? '超过 25 MiB 的 Office 文件无法在线预览'
            : '在线预览需要支持预览的 ftp-master WPS 插件' : '此文件类型暂不支持在线预览'}</p>}
      </div>}
    </div>
  </dialog>
}

function PreviewContent({ node, kind }: { node: Node; kind: NonNullable<ReturnType<typeof previewKind>> }) {
  const [failed, setFailed] = useState(false)
  const src = `/api/tree/${node.id}/preview`
  const onError = () => setFailed(true)
  if (failed) return <p role="status">浏览器无法加载此文件的预览</p>
  if (kind === 'image') return <img src={src} alt={node.name} onError={onError} />
  if (kind === 'audio') return <audio src={src} controls onError={onError} />
  if (kind === 'video') return <video src={src} controls playsInline onError={onError} />
  return <iframe title={`预览 ${node.name}`} src={src} sandbox={kind === 'text' ? '' : undefined} />
}
