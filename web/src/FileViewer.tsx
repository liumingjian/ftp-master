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

export function OfficeEditIndicator({ node }: { node: Node }) {
  if (!editableOfficeVersion(node)) return null

  return <span className="office-edit-indicator" title="在线编辑暂不可用">
    <button type="button" className="icon" disabled aria-label={`在线编辑 ${node.name}`}>
      <Pencil size={15} aria-hidden="true" />
    </button>
  </span>
}

export function OfficeEditAction({ node, officePlugin, onOpen }: {
  node: Node
  officePlugin: boolean
  onOpen: () => void
}) {
  const version = editableOfficeVersion(node)
  if (!version) return null

  if (!officePlugin) return <button type="button" className="office-edit" disabled
    aria-label={`在线编辑 ${node.name}，需要 WPS 插件`}>
    <span>在线编辑</span>
    <small>需 WPS 插件</small>
  </button>

  return <a className="button office-edit" href={`/api/files/${node.id}/office-edits`}
    data-ftp-office-edit="1" data-ftp-office-version={version.id} target="_blank" rel="noopener"
    onClick={event => { event.preventDefault(); onOpen() }} aria-label={`在线编辑 ${node.name}`}>
    <Pencil size={15} aria-hidden="true" />在线编辑
  </a>
}

export function FileViewer({ node, officePlugin, onOfficeOpen, close, saved }: {
  node: Node
  officePlugin: boolean
  onOfficeOpen: () => void
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
          <OfficeEditAction node={node} officePlugin={officePlugin} onOpen={onOfficeOpen} />
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
        {office ? <OfficeNotice canModify={!!(node.rights & 8)} size={version.size} officePlugin={officePlugin} />
          : <p>此文件类型暂不支持在线预览</p>}
      </div>}
    </div>
  </dialog>
}

function OfficeNotice({ canModify, size, officePlugin }: { canModify: boolean; size: number; officePlugin: boolean }) {
  if (!canModify) return <p>在线编辑需要修改权限</p>
  if (size > officeLimit) return <p>超过 25 MiB 的 Office 文件无法在线编辑</p>
  if (!officePlugin) return <p>当前浏览器未检测到 ftp-master WPS 插件。请在已启用专用插件的奇安信浏览器中打开此文件</p>
  return <p>点击「在线编辑」，在 WPS 中打开此文件</p>
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
