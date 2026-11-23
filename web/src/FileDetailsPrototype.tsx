// In the existing workspace, compare the inspector, Get Info, Quick Look and an inline row via ?variant=.
import { useEffect, type ReactNode, type Ref } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, FileText, Folder, Info, X } from 'lucide-react'
import { FileIcon, fileTypeLabel, formatSize } from './FileIcon'
import { previewKind } from './BrowseTools'
import { report, sampleFileId } from './fileDetailsPrototype.fixture'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']

export const prototypeEnabled = import.meta.env.DEV && import.meta.env.MODE === 'file-details-prototype'
const variants = [
  ['current', '现版'],
  ['sidebar', '窄侧栏'],
  ['info', '简介浮窗'],
  ['preview', '快速查看'],
  ['inline', '行内展开'],
] as const
export type DetailsVariant = typeof variants[number][0]
export function readDetailsVariant(): DetailsVariant {
  const variant = new URLSearchParams(window.location.search).get('variant')
  return variants.find(([key]) => key === variant)?.[0] ?? 'current'
}

export function PrototypeSwitcher({ variant, change }: {
  variant: DetailsVariant
  change: (variant: DetailsVariant) => void
}) {
  const index = variants.findIndex(([key]) => key === variant)
  const previous = variants[(index + variants.length - 1) % variants.length] ?? variants[0]
  const next = variants[(index + 1) % variants.length] ?? variants[0]
  const current = variants[index] ?? variants[0]

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]'))) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      change(event.key === 'ArrowLeft' ? previous[0] : next[0])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [change, previous, next])

  return <nav className="prototype-switcher" aria-label="原型方案切换" data-panel-trigger>
    <button className="ghost icon" onClick={() => change(previous[0])} aria-label={'上一版 · ' + previous[1]}><ArrowLeft size={16} /></button>
    <span><small>原型 {index + 1}/{variants.length}</small><strong aria-live="polite">{current[1]}</strong></span>
    <button className="ghost icon" onClick={() => change(next[0])} aria-label={'下一版 · ' + next[1]}><ArrowRight size={16} /></button>
  </nav>
}

type LayoutProps = {
  node: Node
  path?: string
  modified?: string
  permissions: string
  tools: ReactNode
  links: ReactNode
  close: () => void
  closeRef: Ref<HTMLButtonElement>
}

function Close({ close, closeRef, back = false }: Pick<LayoutProps, 'close' | 'closeRef'> & { back?: boolean }) {
  return <button className={back ? 'ghost prototype-back' : 'ghost icon prototype-close'}
    onClick={close} ref={closeRef} aria-label={back ? '返回文件列表' : '关闭详情'}>
    {back ? <><span><ArrowLeft size={18} />文件列表</span><X size={18} /></> : <X size={18} />}
  </button>
}

function FileName({ name }: { name: string }) {
  const month = name.lastIndexOf('（')
  return <h2 className="prototype-file-name">
    {month < 0 ? name : <>{name.slice(0, month)}<wbr /><span>{name.slice(month)}</span></>}
  </h2>
}

function FileType({ node }: { node: Node }) {
  return <span className="prototype-file-type">
    {fileTypeLabel(node)}{node.latestVersion && ' · ' + formatSize(node.latestVersion.size)}
  </span>
}

function Location({ path }: { path?: string }) {
  if (!path) return null
  const folders = path.split('/').filter(Boolean)
  return <span className="prototype-location">
    <Folder size={15} aria-hidden="true" />
    {folders.length ? folders.map((folder, index) => <span key={index}>
      {index > 0 && <ChevronRight size={12} aria-hidden="true" />}{folder}
    </span>) : '共享目录'}
  </span>
}

function Metadata({ node, path, modified, permissions }: LayoutProps) {
  return <dl className="prototype-metadata">
    {path && <div><dt>所在位置</dt><dd><Location path={path} /></dd></div>}
    {node.latestVersion?.size !== undefined && <div><dt>文件大小</dt><dd>{formatSize(node.latestVersion.size)}</dd></div>}
    {modified && <div><dt>修改时间</dt><dd><time dateTime={node.latestVersion?.createdAt}>{modified}</time></dd></div>}
    {node.latestVersion?.username && <div><dt>修改人</dt><dd>{node.latestVersion.username}</dd></div>}
    <div><dt>我的权限</dt><dd>{permissions}</dd></div>
  </dl>
}

export function SidebarDetails(props: LayoutProps) {
  const { node, path, modified, permissions, tools, links } = props
  return <>
    <header className="prototype-rail-header">
      <FileIcon node={node} tile size={24} />
      <Close {...props} />
    </header>
    <FileName name={node.name} />
    <FileType node={node} />
    {path && <div className="prototype-rail-location"><Location path={path} /></div>}
    {tools}
    <dl className="prototype-metadata">
      {modified && <div><dt>修改时间</dt><dd><time dateTime={node.latestVersion?.createdAt}>{modified}</time></dd></div>}
      {node.latestVersion?.username && <div><dt>修改人</dt><dd>{node.latestVersion.username}</dd></div>}
      <div><dt>我的权限</dt><dd>{permissions}</dd></div>
    </dl>
    {links}
  </>
}

export function InfoDetails(props: LayoutProps) {
  const { node, tools, links } = props
  return <>
    <div className="prototype-window-bar"><span>文件简介</span><Close {...props} /></div>
    <div className="prototype-info-body">
      <header className="prototype-info-header">
        <FileIcon node={node} tile size={26} />
        <div><FileName name={node.name} /><small>{fileTypeLabel(node)}</small></div>
      </header>
      <Metadata {...props} />
      {links}
    </div>
    <footer className="prototype-info-footer">{tools}</footer>
  </>
}

export function PreviewDetails(props: LayoutProps) {
  const { node, tools, links } = props
  const kind = previewKind(node)
  return <>
    <header className="prototype-preview-header">
      <div className="prototype-preview-title"><FileName name={node.name} /><FileType node={node} /></div>
      {tools}
      <Close {...props} back />
    </header>
    <div className="prototype-preview-body">
      {node.id === sampleFileId ? <article className="prototype-report" aria-label="月报预览">
        <div className="prototype-report-date">{report.period} <span>{report.team}</span></div>
        <h3>{report.title}<br />月度简报</h3>
        <p>{report.summary}</p>
        <dl>{report.metrics.map(([count, label]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
        <h4>{report.focus}</h4>
        <p>{report.next}</p>
      </article> : kind === 'text' ? <iframe className="prototype-preview-frame" sandbox="" title={'预览 ' + node.name}
        src={`/api/tree/${node.id}/preview`} /> : <p className="prototype-preview-empty"><FileText size={30} />此文件类型暂无内嵌预览</p>}
    </div>
    <details className="prototype-preview-properties">
      <summary><Info size={16} />文件属性<ChevronDown size={16} /></summary>
      <Metadata {...props} />
      {links}
    </details>
  </>
}

export function InlineDetails(props: LayoutProps) {
  const { node, path, modified, permissions, tools, links } = props
  return <>
    <header className="prototype-inline-header">
      <div><FileName name={node.name} /><FileType node={node} /></div>
      <Close {...props} />
    </header>
    <div className="prototype-inline-fields">
      <div>{path && <Location path={path} />}
        <p>{modified && <time dateTime={node.latestVersion?.createdAt}>{modified}</time>}
          {node.latestVersion?.username && ' · ' + node.latestVersion.username}</p>
      </div>
      <p><span>我的权限</span>{permissions}</p>
    </div>
    <footer className="prototype-inline-actions">{tools}{links}</footer>
  </>
}
