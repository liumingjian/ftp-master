import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  formatBytes,
  formatLocalTimeOnly,
  formatRate,
  formatShortPause,
  type TransferGap,
  type TransferProfileSummary,
  type TransferSamplePoint,
  type TransferSeries,
} from './transferProfile'

type Props = {
  profile: TransferProfileSummary
  series: TransferSeries
}

type LayoutPoint = {
  point: TransferSamplePoint
  x: number
  y: number
}

type LayoutGap = {
  gap: TransferGap
  xStart: number
  xEnd: number
}

function niceCeilingBps(maxBps: number): number {
  if (maxBps <= 0) return 1024 * 1024
  const MB = 1024 * 1024
  const KB = 1024
  const unit = maxBps >= MB ? MB : maxBps >= KB ? KB : 1
  const scaled = maxBps / unit
  const magnitude = Math.pow(10, Math.floor(Math.log10(scaled)))
  const norm = scaled / magnitude
  const nice = norm <= 1.1 ? 1.2 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : norm <= 7.5 ? 8 : 10
  return nice * magnitude * unit
}

function formatAxisRate(bps: number): string {
  if (bps <= 0) return '0'
  const MB = 1024 * 1024
  const KB = 1024
  if (bps >= MB) {
    const val = bps / MB
    return `${val >= 10 || Number.isInteger(val) ? Math.round(val) : val.toFixed(1)} MB/s`
  }
  if (bps >= KB) {
    return `${Math.round(bps / KB)} KB/s`
  }
  return `${Math.round(bps)} B/s`
}

export function TransferProfileChart({ profile, series }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const gradientId = useId()
  const hatchId = useId()

  const [width, setWidth] = useState(820)
  const height = 304

  const [zoomRange, setZoomRange] = useState<[number, number] | null>(null)
  const [brush, setBrush] = useState<{ startX: number; currentX: number } | null>(null)
  const [hoverLocalIdx, setHoverLocalIdx] = useState<number | null>(null)

  useEffect(() => {
    setZoomRange(null)
    setHoverLocalIdx(null)
    setBrush(null)
  }, [series])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => {
      const next = Math.floor(el.getBoundingClientRect().width)
      if (next > 160) setWidth(next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const startIdx = zoomRange ? zoomRange[0] : 0
  const endIdx = zoomRange ? zoomRange[1] : series.points.length - 1
  const visiblePoints = useMemo(
    () => series.points.slice(startIdx, endIdx + 1),
    [series.points, startIdx, endIdx],
  )
  const visibleGaps = useMemo(
    () => series.gaps.filter(g => g.beforeIndex > startIdx && g.beforeIndex <= endIdx),
    [series.gaps, startIdx, endIdx],
  )

  const padLeft = 62
  const padRight = 18
  const padTop = 20
  const padBottom = 30
  const plotW = Math.max(80, width - padLeft - padRight)
  const plotH = Math.max(60, height - padTop - padBottom)

  const maxBps = useMemo(() => {
    let peak = profile.avgBps
    for (const p of visiblePoints) {
      if (p.bps > peak) peak = p.bps
    }
    return niceCeilingBps(peak * 1.06)
  }, [visiblePoints, profile.avgBps])

  const yForBps = (bps: number) =>
    padTop + plotH - (Math.max(0, Math.min(bps, maxBps)) / maxBps) * plotH

  const { layoutPoints, layoutGaps, segments, stallBands } = useMemo(() => {
    const n = visiblePoints.length
    if (n === 0) {
      return {
        layoutPoints: [] as LayoutPoint[],
        layoutGaps: [] as LayoutGap[],
        segments: [] as LayoutPoint[][],
        stallBands: [] as { x1: number; x2: number }[],
      }
    }

    const gapWidth = 38
    const totalGapWidth = Math.min(visibleGaps.length * gapWidth, plotW * 0.35)
    const actualGapW = visibleGaps.length > 0 ? totalGapWidth / visibleGaps.length : 0
    const usableW = Math.max(20, plotW - totalGapWidth)
    const stepX = n > 1 ? usableW / (n - 1) : 0

    const gapMap = new Map<number, TransferGap>()
    for (const g of visibleGaps) gapMap.set(g.beforeIndex, g)

    const pts: LayoutPoint[] = []
    const gapsOut: LayoutGap[] = []
    const segs: LayoutPoint[][] = []
    let currentSeg: LayoutPoint[] = []
    let accGap = 0

    for (let i = 0; i < n; i++) {
      const point = visiblePoints[i]!
      const gap = gapMap.get(point.index)
      if (gap) {
        if (currentSeg.length > 0) {
          segs.push(currentSeg)
          currentSeg = []
        }
        const prevX = pts.length > 0 ? pts[pts.length - 1]!.x : padLeft
        const xStart = prevX + 2
        accGap += actualGapW
        const xNext = padLeft + i * stepX + accGap
        gapsOut.push({ gap, xStart, xEnd: xNext - 2 })
      }
      const x = n === 1 ? padLeft + plotW / 2 : padLeft + i * stepX + accGap
      const y = yForBps(point.bps)
      const lp: LayoutPoint = { point, x, y }
      pts.push(lp)
      currentSeg.push(lp)
    }
    if (currentSeg.length > 0) segs.push(currentSeg)

    const bands: { x1: number; x2: number }[] = []
    let bandStart: number | null = null
    for (let i = 0; i < pts.length; i++) {
      const lp = pts[i]!
      const isGapBreak = i > 0 && gapMap.has(lp.point.index)
      if (lp.point.stalled && !isGapBreak) {
        if (bandStart === null) bandStart = i
      } else {
        if (bandStart !== null) {
          const leftPt = pts[bandStart]!
          const rightPt = pts[i - 1]!
          bands.push({
            x1: Math.max(padLeft, leftPt.x - stepX * 0.4),
            x2: Math.min(padLeft + plotW, rightPt.x + stepX * 0.4),
          })
          bandStart = null
        }
        if (lp.point.stalled && isGapBreak) bandStart = i
      }
    }
    if (bandStart !== null) {
      const leftPt = pts[bandStart]!
      const rightPt = pts[pts.length - 1]!
      bands.push({
        x1: Math.max(padLeft, leftPt.x - stepX * 0.4),
        x2: Math.min(padLeft + plotW, rightPt.x + stepX * 0.4),
      })
    }

    return { layoutPoints: pts, layoutGaps: gapsOut, segments: segs, stallBands: bands }
  }, [visiblePoints, visibleGaps, plotW, plotH, padLeft, padTop, maxBps])

  const tone =
    profile.anomaly === 'failed'
      ? 'failed'
      : profile.anomaly === 'stall'
        ? 'stall'
        : 'normal'

  const avgY = yForBps(profile.avgBps)
  const baselineY = padTop + plotH
  const yTicks = [0, maxBps / 2, maxBps]

  const xTickIndices = useMemo(() => {
    const n = layoutPoints.length
    if (n === 0) return []
    if (n === 1) return [0]
    const count = 6
    const indices = new Set<number>([0, n - 1])
    for (let i = 1; i < count - 1; i++) {
      indices.add(Math.round((i / (count - 1)) * (n - 1)))
    }
    return Array.from(indices).sort((a, b) => a - b)
  }, [layoutPoints.length])

  function nearestLocalIndex(clientX: number): number | null {
    const svg = svgRef.current
    if (!svg || layoutPoints.length === 0) return null
    const rect = svg.getBoundingClientRect()
    const x = clientX - rect.left
    if (x < padLeft - 8 || x > padLeft + plotW + 8) return null
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < layoutPoints.length; i++) {
      const dist = Math.abs(layoutPoints[i]!.x - x)
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    return best
  }

  function clampPlotX(clientX: number): number {
    const svg = svgRef.current
    if (!svg) return padLeft
    const rect = svg.getBoundingClientRect()
    return Math.max(padLeft, Math.min(padLeft + plotW, clientX - rect.left))
  }

  function handlePointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || layoutPoints.length < 4) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const x = event.clientX - rect.left
    if (x < padLeft || x > padLeft + plotW) return
    svg.setPointerCapture(event.pointerId)
    setBrush({ startX: x, currentX: x })
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    if (brush) {
      setBrush(prev => (prev ? { ...prev, currentX: clampPlotX(event.clientX) } : null))
      setHoverLocalIdx(null)
      return
    }
    setHoverLocalIdx(nearestLocalIndex(event.clientX))
  }

  function handlePointerUp(event: PointerEvent<SVGSVGElement>) {
    if (!brush) return
    const svg = svgRef.current
    if (svg?.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId)
    }
    const minX = Math.min(brush.startX, brush.currentX)
    const maxX = Math.max(brush.startX, brush.currentX)
    setBrush(null)
    if (maxX - minX < 10) return

    let leftLocal = -1
    let rightLocal = -1
    for (let i = 0; i < layoutPoints.length; i++) {
      const x = layoutPoints[i]!.x
      if (x >= minX && leftLocal === -1) leftLocal = i
      if (x <= maxX) rightLocal = i
    }
    if (leftLocal !== -1 && rightLocal !== -1 && rightLocal - leftLocal >= 2) {
      setZoomRange([startIdx + leftLocal, startIdx + rightLocal])
    }
  }

  const hovered = hoverLocalIdx !== null ? layoutPoints[hoverLocalIdx] : undefined
  const lastLayout = layoutPoints[layoutPoints.length - 1]
  const isFailurePointVisible =
    profile.anomaly === 'failed' && endIdx === series.points.length - 1 && !!lastLayout

  const tooltipLeft = hovered
    ? hovered.x > width * 0.58
      ? Math.max(8, hovered.x - 228)
      : Math.min(width - 224, hovered.x + 12)
    : 0

  const avgText = `均 ${formatRate(profile.avgBps)}`
  const avgPillW = Math.max(58, avgText.length * 6.4 + 12)
  const avgPillY = Math.max(padTop + 2, avgY - 19)

  return (
    <div className={`tp-chart-shell tp-tone-${tone}`} ref={containerRef}>
      <div className="tp-chart-controls">
        <span className="tp-chart-hint">
          {zoomRange && visiblePoints.length > 0
            ? `已放大：${formatLocalTimeOnly(visiblePoints[0]!.timestamp)} – ${formatLocalTimeOnly(visiblePoints[visiblePoints.length - 1]!.timestamp)}（${visiblePoints.length} 个采样点 · 每 ${series.bucketSeconds} 秒）`
            : `鼠标在曲线上拖拽框选可放大局部时段 · 每 ${series.bucketSeconds} 秒采样（共 ${series.points.length} 点）`}
        </span>
        {zoomRange && (
          <button type="button" className="ghost tp-reset-zoom" onClick={() => setZoomRange(null)}>
            <RotateCcw size={14} aria-hidden="true" />
            重置缩放
          </button>
        )}
      </div>

      <div className="tp-chart-stage">
        <svg
          ref={svgRef}
          className="tp-chart-svg zoomable"
          width={width}
          height={height}
          role="img"
          aria-label={`传输流量曲线，平均速率 ${formatRate(profile.avgBps)}，峰值 ${formatRate(profile.peakBps)}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => {
            if (!brush) setHoverLocalIdx(null)
          }}
          onDoubleClick={() => {
            if (zoomRange) setZoomRange(null)
          }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
            </linearGradient>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" className="tp-gap-hatch" strokeWidth="1" />
            </pattern>
          </defs>

          {yTicks.map((tick, idx) => {
            const y = yForBps(tick)
            return (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={padLeft + plotW}
                  y2={y}
                  className={idx === 0 ? 'tp-axis-line' : 'tp-grid-line'}
                />
                <text x={padLeft - 8} y={y + 3.5} textAnchor="end" className="tp-axis-label">
                  {formatAxisRate(tick)}
                </text>
              </g>
            )
          })}

          {stallBands.map((band, idx) => (
            <rect
              key={idx}
              x={band.x1}
              y={padTop}
              width={Math.max(2, band.x2 - band.x1)}
              height={plotH}
              className={profile.anomaly === 'failed' ? 'tp-drop-band failed' : 'tp-drop-band'}
            />
          ))}

          {layoutGaps.map((item, idx) => {
            const w = Math.max(8, item.xEnd - item.xStart)
            const cx = item.xStart + w / 2
            return (
              <g key={idx}>
                <rect
                  x={item.xStart}
                  y={padTop}
                  width={w}
                  height={plotH}
                  fill={`url(#${hatchId})`}
                  className="tp-gap-rect"
                />
                <line x1={item.xStart} y1={padTop} x2={item.xStart} y2={baselineY} className="tp-gap-edge" />
                <line x1={item.xEnd} y1={padTop} x2={item.xEnd} y2={baselineY} className="tp-gap-edge" />
                <g transform={`translate(${cx}, ${padTop + 14})`}>
                  <rect x={-30} y={-9} width={60} height={18} rx={4} className="tp-gap-pill" />
                  <text y={3.5} textAnchor="middle" className="tp-gap-text">
                    暂停 {formatShortPause(item.gap.durationSeconds)}
                  </text>
                </g>
              </g>
            )
          })}

          {segments.map((seg, idx) => {
            if (seg.length === 0) return null
            const lineD = seg
              .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
              .join(' ')
            const firstPt = seg[0]!
            const lastPt = seg[seg.length - 1]!
            const areaD = `${lineD} L${lastPt.x.toFixed(1)},${baselineY.toFixed(1)} L${firstPt.x.toFixed(1)},${baselineY.toFixed(1)} Z`
            return (
              <g key={idx}>
                <path d={areaD} fill={`url(#${gradientId})`} />
                <path
                  d={lineD}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            )
          })}

          <line x1={padLeft} y1={avgY} x2={padLeft + plotW} y2={avgY} className="tp-avg-line" />
          <g transform={`translate(${padLeft + plotW - avgPillW - 2}, ${avgPillY})`}>
            <rect width={avgPillW} height={16} rx={4} className="tp-avg-pill" />
            <text x={avgPillW / 2} y={11.5} textAnchor="middle" className="tp-avg-label">
              {avgText}
            </text>
          </g>

          {isFailurePointVisible && lastLayout && (
            <g>
              <circle cx={lastLayout.x} cy={lastLayout.y} r="6.5" className="tp-fail-halo" />
              <circle cx={lastLayout.x} cy={lastLayout.y} r="3.4" className="tp-fail-dot" />
            </g>
          )}

          {xTickIndices.map(idx => {
            const pt = layoutPoints[idx]
            if (!pt) return null
            const anchor = idx === 0 ? 'start' : idx === layoutPoints.length - 1 ? 'end' : 'middle'
            return (
              <text key={idx} x={pt.x} y={height - 6} textAnchor={anchor} className="tp-axis-label">
                {formatLocalTimeOnly(pt.point.timestamp)}
              </text>
            )
          })}

          {hovered && !brush && (
            <g pointerEvents="none">
              <line x1={hovered.x} y1={padTop} x2={hovered.x} y2={baselineY} className="tp-crosshair" />
              <circle cx={hovered.x} cy={hovered.y} r="4" className="tp-hover-dot" />
            </g>
          )}

          {brush && (
            <rect
              x={Math.min(brush.startX, brush.currentX)}
              y={padTop}
              width={Math.max(1, Math.abs(brush.currentX - brush.startX))}
              height={plotH}
              className="tp-brush-rect"
            />
          )}
        </svg>

        {hovered && !brush && (
          <div
            className="tp-tooltip"
            style={{
              left: `${tooltipLeft}px`,
              top: `${Math.max(8, Math.min(height - 92, hovered.y - 40))}px`,
            }}
          >
            <div className="tp-tooltip-time">
              {formatLocalTimeOnly(hovered.point.timestamp)}
              {series.bucketSeconds > 1 && <span>（{series.bucketSeconds}s 均值）</span>}
            </div>
            <div className="tp-tooltip-rate">
              <span>瞬时速率</span>
              <strong>{formatRate(hovered.point.bps)}</strong>
            </div>
            <div className="tp-tooltip-progress">
              <span>累计进度</span>
              <span>
                {formatBytes(hovered.point.cumulativeBytes)} / {formatBytes(profile.totalBytes)}
                {' · '}
                {profile.totalBytes > 0
                  ? `${Math.min(100, (hovered.point.cumulativeBytes / profile.totalBytes) * 100).toFixed(1)}%`
                  : '100%'}
              </span>
            </div>
            {hovered.point.stalled && (
              <div className="tp-tooltip-flag">
                {profile.anomaly === 'failed' ? '断流/超时窗口' : '显著掉速区间'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
