import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Download, Eye, Pencil, X } from 'lucide-react'
import { previewKind } from './BrowseTools'
import { FileIcon } from './FileIcon'
import { TextEditor } from './TextEditor'
import { formatCurrentLocalMinute } from './clock'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']
export interface ViewerUser {
  displayName: string
  username: string
  organizationName?: string
}

const officeFormats = new Set(['doc', 'docx', 'wps', 'xls', 'xlsx'])
const officeLimit = 25 * 1024 * 1024

export function editableOfficeVersion(node: Node) {
  const version = node.latestVersion
  if (node.isFile && (node.rights & 8) && version &&
      officeFormats.has(version.format) && version.size <= officeLimit) return version
}

export function officeMissingPluginMessage() {
  return `当前站点未检测到可用的 WPS 编辑插件。请确认已安装并启用 ftp-master WPS 编辑插件，且插件配置的站点为 ${window.location.origin}，然后刷新页面重试。`
}

export function canPreviewOffice(node: Node) {
  const version = node.latestVersion
  return node.isFile && !!(node.rights & 1) && version &&
    officeFormats.has(version.format) && version.size <= officeLimit
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char] ?? char))
}

function buildWatermarkDataUri(user: ViewerUser, timestamp: string) {
  const line1 = escapeXml(`${user.displayName} (${user.username})`)
  const line2 = escapeXml(user.organizationName ? `${user.organizationName} · ${timestamp}` : timestamp)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="190" viewBox="0 0 320 190">` +
    `<g transform="rotate(-24 160 95)" fill="#5e6b70" fill-opacity="0.16" font-family="system-ui, PingFang SC, Microsoft YaHei, sans-serif" text-anchor="middle">` +
    `<text x="160" y="88" font-size="14" font-weight="600">${line1}</text>` +
    `<text x="160" y="109" font-size="12">${line2}</text>` +
    `</g></svg>`
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`
}

export function OfficeEditAction({ node, onOpen, icon = false, className }: {
  node: Node
  onOpen: () => void
  icon?: boolean
  className?: string
}) {
  const version = editableOfficeVersion(node)
  if (!version) return null

  const baseClass = icon ? 'button icon office-edit-indicator' : 'button office-edit'
  return <a className={className ? `${baseClass} ${className}` : baseClass} href={`/api/files/${node.id}/office-edits`}
    data-ftp-office-edit="1" data-ftp-office-version={version.id} target="_blank" rel="noopener"
    title="在线编辑"
    onAuxClick={event => event.preventDefault()}
    onClick={event => {
      // The extension claims the trusted click in its document capture listener.
      const editorHandledClick = event.defaultPrevented
      event.preventDefault()
      if (editorHandledClick) onOpen()
      else if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        window.alert(officeMissingPluginMessage())
      }
    }} aria-label={`在线编辑 ${node.name}`}>
    <Pencil size={16} aria-hidden="true" />{!icon && '在线编辑'}
  </a>
}

export function FileViewer({ node, officePreview, viewerUser, close, saved }: {
  node: Node
  officePreview: boolean
  viewerUser?: ViewerUser
  close: () => void
  saved: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const version = node.latestVersion
  const kind = previewKind(node)
  const office = version && officeFormats.has(version.format)
  const download = !!(node.rights & 2)
  const [openedAt] = useState(() => formatCurrentLocalMinute())
  const watermarkImage = useMemo(
    () => viewerUser && kind && kind !== 'audio' ? buildWatermarkDataUri(viewerUser, openedAt) : undefined,
    [viewerUser, kind, openedAt],
  )

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
          {!download && <span className="pill neutral viewer-readonly-pill" title="当前账户对该文件无下载权限">
            <Eye size={13} aria-hidden="true" />仅在线预览
          </span>}
          <TextEditor node={node} saved={saved} />
          {download && <a className="button" href={`/api/tree/${node.id}/download`} download>
            <Download size={16} aria-hidden="true" />下载
          </a>}
          <button type="button" className="icon ghost" aria-label="关闭文件查看" title="关闭文件查看" autoFocus onClick={dismiss}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      {kind ? <section aria-label="文件预览" className={`file-viewer-body ${kind}`}>
        <PreviewContent key={version?.id} node={node} kind={kind} />
        {watermarkImage && <div className="preview-watermark" aria-hidden="true" style={{ backgroundImage: watermarkImage }} />}
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
