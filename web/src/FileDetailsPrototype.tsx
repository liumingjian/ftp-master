// Compare three layouts with the same file identity and direct actions via ?variant=.
import { useEffect, type ReactNode, type Ref } from 'react'
import { ArrowLeft, ArrowRight, Folder, X } from 'lucide-react'
import { FileIcon } from './FileIcon'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']

export const prototypeEnabled = import.meta.env.DEV && import.meta.env.MODE === 'file-details-prototype'
const variants = [
  ['inline', '行内展开'],
  ['card', '居中浮窗'],
  ['dock', '底部详情栏'],
] as const
export type DetailsVariant = typeof variants[number][0]
export function readDetailsVariant(): DetailsVariant {
  const variant = new URLSearchParams(window.location.search).get('variant')
  return variants.find(([key]) => key === variant)?.[0] ?? 'inline'
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
  location?: { label: string; href: string; open: () => void }
  tools: ReactNode
  close: () => void
  closeRef: Ref<HTMLButtonElement>
}

const modifiedFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
})

function FileIdentity({ node, location }: Pick<LayoutProps, 'node' | 'location'>) {
  const month = /（\d{4}年\d{1,2}月）\.[a-z\d]+$/i.exec(node.name)
  const { createdAt, username } = node.latestVersion ?? {}
  return <div className="prototype-identity">
    <h2 className="prototype-file-name">
      {month ? <>{node.name.slice(0, month.index)}<wbr /><span>{month[0]}</span></> : node.name}
    </h2>
    {(createdAt || username) && <p className="prototype-modified">
      {createdAt && <time dateTime={createdAt}>{modifiedFormat.format(new Date(createdAt))}</time>}
      {createdAt && username && ' · '}{username}
    </p>}
    {location && <a className="prototype-location" href={location.href} aria-label={'打开所在目录 ' + location.label} onClick={event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      location.open()
    }}><Folder size={15} aria-hidden="true" /><span>{location.label}</span></a>}
  </div>
}

function Close({ close, closeRef }: Pick<LayoutProps, 'close' | 'closeRef'>) {
  return <button className="ghost icon prototype-close" onClick={close} ref={closeRef} aria-label="关闭详情">
    <X size={18} aria-hidden="true" />
  </button>
}

export function InlineDetails(props: LayoutProps) {
  return <>
    <FileIdentity node={props.node} location={props.location} />
    {props.tools}
    <Close close={props.close} closeRef={props.closeRef} />
  </>
}

export function CardDetails(props: LayoutProps) {
  return <>
    <Close close={props.close} closeRef={props.closeRef} />
    <header className="prototype-card-header">
      <FileIcon node={props.node} size={24} tile />
      <FileIdentity node={props.node} location={props.location} />
    </header>
    {props.tools}
  </>
}

export function DockDetails(props: LayoutProps) {
  return <>
    <div className="prototype-dock-file">
      <FileIcon node={props.node} size={22} tile />
      <FileIdentity node={props.node} location={props.location} />
    </div>
    {props.tools}
    <Close close={props.close} closeRef={props.closeRef} />
  </>
}
