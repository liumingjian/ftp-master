import { useId } from 'react'
import { AlertTriangle, XCircle } from 'lucide-react'
import { formatBytes, formatDurationMs, formatRate, type TransferProfileSummary } from './transferProfile'

const WIDTH = 74
const HEIGHT = 22
const PAD_X = 2
const PAD_TOP = 3
const PAD_BOTTOM = 2

export function TransferSparklineSvg({
  profile,
  width = WIDTH,
  height = HEIGHT,
}: {
  profile: TransferProfileSummary
  width?: number
  height?: number
}) {
  const gradientId = useId()
  const points = profile.sparkline
  const peak = Math.max(...points, 1)
  const plotW = width - PAD_X * 2
  const plotH = height - PAD_TOP - PAD_BOTTOM

  const coords = points.map((value, idx) => {
    const x = PAD_X + (points.length === 1 ? plotW / 2 : (idx / (points.length - 1)) * plotW)
    const y = PAD_TOP + plotH - (Math.max(0, value) / peak) * plotH
    return { x, y }
  })

  const linePath = coords
    .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(' ')
  const last = coords[coords.length - 1]!
  const first = coords[0]!
  const baseY = PAD_TOP + plotH
  const areaPath = `${linePath} L${last.x.toFixed(1)},${baseY.toFixed(1)} L${first.x.toFixed(1)},${baseY.toFixed(1)} Z`

  return (
    <svg
      className="tp-sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.26" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line
        x1={PAD_X}
        y1={baseY}
        x2={width - PAD_X}
        y2={baseY}
        className="tp-spark-baseline"
      />
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {profile.anomaly === 'failed' && (
        <circle cx={last.x} cy={last.y} r="2.3" fill="currentColor" />
      )}
    </svg>
  )
}

export function TransferSparklineCell({
  profile,
  onInspectTrend,
}: {
  profile?: TransferProfileSummary
  onInspectTrend?: () => void
}) {
  if (!profile) {
    return <span className="tp-empty">—</span>
  }

  const isInstant = profile.activeDurationMs < 2000 || profile.sparkline.length < 2
  if (isInstant) {
    const tooltip = `瞬时传输 · ${formatBytes(profile.bytesTransferred)} · 耗时 ${formatDurationMs(profile.activeDurationMs)} · 平均 ${formatRate(profile.avgBps)}`
    return (
      <span className="tp-instant" title={tooltip}>
        瞬时 · {formatBytes(profile.bytesTransferred)}
      </span>
    )
  }

  const tone =
    profile.anomaly === 'failed'
      ? 'failed'
      : profile.anomaly === 'stall'
        ? 'stall'
        : 'normal'

  const statusText =
    profile.anomaly === 'failed'
      ? profile.statusReason ?? '传输中断'
      : profile.anomaly === 'stall'
        ? `检测到 ${profile.stallCount ?? 1} 次掉速卡顿`
        : '传输平稳'

  const cellTitle = `点击查看每秒流量曲线 · ${statusText} · 平均 ${formatRate(profile.avgBps)} · 峰值 ${formatRate(profile.peakBps)} · 耗时 ${formatDurationMs(profile.activeDurationMs)}`

  return (
    <button
      type="button"
      className={`tp-spark-trigger tp-tone-${tone}`}
      title={cellTitle}
      aria-label={`查看每秒流量曲线（${statusText}，平均 ${formatRate(profile.avgBps)}）`}
      onClick={event => {
        event.stopPropagation()
        onInspectTrend?.()
      }}
    >
      <TransferSparklineSvg profile={profile} />
      <span className="tp-rate-wrap">
        {tone === 'stall' && (
          <AlertTriangle size={13} className="tp-status-icon" aria-hidden="true" />
        )}
        {tone === 'failed' && (
          <XCircle size={13} className="tp-status-icon" aria-hidden="true" />
        )}
        <span className="tp-rate-text">{formatRate(profile.avgBps)}</span>
      </span>
    </button>
  )
}
