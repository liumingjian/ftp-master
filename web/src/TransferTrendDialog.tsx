import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  FileText,
  X,
  XCircle,
} from 'lucide-react'
import { actionNames } from './AuditFilters'
import { api } from './api/client'
import { redirectToSignIn } from './navigation'
import { TransferProfileChart } from './TransferProfileChart'
import {
  formatBytes,
  formatDurationMs,
  formatRate,
  type TransferProfileSummary,
  type TransferSeries,
} from './transferProfile'

export type TrendDialogEvent = {
  id: number
  time: string
  username: string
  sourceIp: string
  action: string
  path: string
  archiveCount: number
  profile: TransferProfileSummary
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function TransferDirectionIcon({ action }: { action: string }) {
  if (action === 'upload') return <ArrowUpFromLine size={18} aria-hidden="true" />
  if (action === 'zip_download') return <Archive size={18} aria-hidden="true" />
  return <ArrowDownToLine size={18} aria-hidden="true" />
}

export function TransferTrendDialog({
  event,
  localTime,
  copied,
  onCopySummary,
  onOpenDetail,
  onClose,
}: {
  event: TrendDialogEvent
  localTime: string
  copied: boolean
  onCopySummary: () => void
  onOpenDetail: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [series, setSeries] = useState<TransferSeries>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const el = dialogRef.current
    if (el && !el.open) el.showModal()
    return () => {
      if (el?.open) el.close()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setSeries(undefined)
    void api
      .GET('/audit/{id}/transfer-series', {
        params: {
          path: { id: event.id },
          query: { occurredAt: event.time },
        },
        signal: controller.signal,
      })
      .then(({ data, response }) => {
        if (controller.signal.aborted) return
        if (response.status === 401) {
          redirectToSignIn()
          return
        }
        if (!data) {
          setError(response.status === 404 ? '该记录未保存逐秒采样数据' : `加载流量曲线失败（${response.status}）`)
          return
        }
        setSeries({
          bucketSeconds: data.bucketSeconds,
          points: data.points,
          gaps: data.gaps,
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('无法连接服务，请重试')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [event.id, event.time])

  const { profile } = event
  const tone =
    profile.anomaly === 'failed'
      ? 'failed'
      : profile.anomaly === 'stall'
        ? 'stall'
        : 'normal'

  return (
    <dialog
      ref={dialogRef}
      className={`text-dialog tp-expanded-dialog tp-modal-${tone}`}
      aria-labelledby="tp-trend-heading"
      onCancel={e => {
        e.preventDefault()
        onClose()
      }}
      onClick={e => {
        if (e.target === dialogRef.current) onClose()
      }}
    >
      <div className="tp-expanded-body">
        <div className="tp-modal-accent-bar" aria-hidden="true" />
        <div className="tp-expanded-inner">
          <div className="drawer-heading tp-expanded-head">
            <div className="tp-expanded-identity">
              <span className={`tp-dir-badge tp-tone-${tone}`}>
                <TransferDirectionIcon action={event.action} />
              </span>
              <div className="tp-expanded-title">
                <div className="tp-expanded-title-line">
                  <h2 id="tp-trend-heading">
                    {event.path
                      ? basename(event.path)
                      : `${actionNames[event.action] ?? event.action}（${event.archiveCount} 个文件）`}
                  </h2>
                  <span className="pill tp-action-pill">
                    {actionNames[event.action] ?? event.action}
                  </span>
                  {profile.bucketSeconds > 1 && (
                    <span className="pill tp-bucket-pill">每 {profile.bucketSeconds} 秒采样</span>
                  )}
                  {profile.range && (
                    <span className="pill tp-pill-range">
                      分段 {formatBytes(profile.range.start)} – {formatBytes(profile.range.end + 1)}
                    </span>
                  )}
                </div>
                <p className="tp-expanded-sub">
                  {event.path && <span title={event.path}>{event.path}</span>}
                  {event.path && <span>·</span>}
                  <span>{event.username || '—'}</span>
                  <span>·</span>
                  <span>{event.sourceIp || '—'}</span>
                  <span>·</span>
                  <time dateTime={event.time}>{localTime}</time>
                </p>
              </div>
            </div>
            <button
              type="button"
              className="ghost icon"
              aria-label="关闭流量趋势窗口"
              title="关闭 (Esc)"
              onClick={onClose}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          <div className="tp-expanded-summary">
            <div className="tp-expanded-stat">
              <span>平均速率</span>
              <strong>{formatRate(profile.avgBps)}</strong>
            </div>
            <div className="tp-expanded-stat">
              <span>峰值速率</span>
              <strong>{formatRate(profile.peakBps)}</strong>
            </div>
            <div className="tp-expanded-stat">
              <span>最低速率</span>
              <strong>{formatRate(profile.minBps)}</strong>
            </div>
            <div className="tp-expanded-stat">
              <span>
                {profile.totalSpanMs > profile.activeDurationMs + 10000 ? '有效耗时' : '总耗时'}
              </span>
              <strong>
                {formatDurationMs(profile.activeDurationMs)}
                {profile.totalSpanMs > profile.activeDurationMs + 10000 && (
                  <small>总跨度 {formatDurationMs(profile.totalSpanMs)}</small>
                )}
              </strong>
            </div>
            <div className="tp-expanded-stat">
              <span>已传 / 总大小</span>
              <strong className="tp-size-pair">
                <span>{formatBytes(profile.bytesTransferred)}</span>
                <span className="tp-metric-slash">/</span>
                <span>{formatBytes(profile.totalBytes)}</span>
              </strong>
            </div>
            <div className="tp-expanded-stat tp-expanded-status">
              <span>状态</span>
              {profile.anomaly === 'failed' ? (
                <span className="pill tp-pill-failed">
                  <XCircle size={12} aria-hidden="true" />
                  传输中断
                </span>
              ) : profile.anomaly === 'stall' ? (
                <span className="pill tp-pill-stall">
                  <AlertTriangle size={12} aria-hidden="true" />
                  {profile.stallCount ?? 1} 次显著掉速
                </span>
              ) : (
                <span className="pill audit-outcome-ok">传输平稳</span>
              )}
            </div>
          </div>

          {profile.statusReason && (
            <div className="tp-modal-reason" role="status">
              <XCircle size={15} aria-hidden="true" />
              <span>中断原因：{profile.statusReason}</span>
            </div>
          )}

          {loading && (
            <div className="tp-chart-loading" role="status">
              正在加载每秒流量采样数据…
            </div>
          )}
          {!loading && error && (
            <p className="banner error" role="alert">{error}</p>
          )}
          {!loading && !error && series && (
            <TransferProfileChart profile={profile} series={series} />
          )}

          <div className="tp-modal-footer">
            <span className="tp-modal-record-id">审计记录 #{event.id}</span>
            <div className="tp-modal-footer-actions">
              <button type="button" className="ghost" onClick={onCopySummary}>
                {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                {copied ? '已复制摘要' : '复制流量摘要'}
              </button>
              <button type="button" onClick={onOpenDetail}>
                <FileText size={14} aria-hidden="true" />
                查看完整审计详情
              </button>
            </div>
          </div>
        </div>
      </div>
    </dialog>
  )
}
