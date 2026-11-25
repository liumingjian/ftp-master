import { HardDrive } from 'lucide-react'
import type { components } from './api/schema.gen'
import { sidebarStorageView } from './quota'

export type SelfStorageSummary = components['schemas']['SelfStorageSummary']

type Props = {
  summary?: SelfStorageSummary
  collapsed?: boolean
  accountHref: string
  openAccount: () => void
}

export function SidebarStorageBar({ summary, collapsed = false, accountHref, openAccount }: Props) {
  if (collapsed || !summary) return null
  const view = sidebarStorageView(summary)
  if (!view) return null

  return (
    <a
      className={`sidebar-storage is-${view.tone}`}
      href={accountHref}
      data-storage-tone={view.tone}
      aria-label={`${view.label} ${view.usageText}${view.statusTag ? `，${view.statusTag}` : ''}，查看账户存储`}
      title={`查看存储详情与待完成上传（当前可用 ${view.availableText}）`}
      onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        openAccount()
      }}
    >
      <div className="sidebar-storage-head">
        <span className="sidebar-storage-label">
          <HardDrive size={14} aria-hidden="true" />
          <span>{view.label}</span>
        </span>
        {view.statusTag && <span className={`sidebar-storage-tag ${view.tone}`}>{view.statusTag}</span>}
      </div>
      <div
        className="sidebar-storage-track"
        role="progressbar"
        aria-label={view.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(view.barPercent)}
      >
        <span className={`sidebar-storage-fill ${view.tone}`} style={{ width: `${view.barPercent}%` }} />
      </div>
      <div className="sidebar-storage-meta">
        <span className="tabular-nums">{view.usageText}</span>
        {view.pendingCount > 0 && <span className="sidebar-storage-pending tabular-nums">预占 {view.pendingCount} 项</span>}
      </div>
    </a>
  )
}
