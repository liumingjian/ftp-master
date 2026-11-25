import { formatSize } from './formatSize'

export type TransferAnomaly = 'none' | 'stall' | 'failed'

export type TransferRange = {
  start: number
  end: number
}

export type TransferSamplePoint = {
  index: number
  timestamp: string
  bps: number
  cumulativeBytes: number
  stalled?: boolean
}

export type TransferGap = {
  beforeIndex: number
  durationSeconds: number
  startedAt: string
  resumedAt: string
}

export type TransferProfileSummary = {
  bytesTransferred: number
  totalBytes: number
  activeDurationMs: number
  totalSpanMs: number
  avgBps: number
  peakBps: number
  minBps: number
  anomaly: TransferAnomaly
  stallCount?: number
  statusReason?: string
  range?: TransferRange
  bucketSeconds: number
  sparkline: number[]
}

export type TransferSeries = {
  bucketSeconds: number
  points: TransferSamplePoint[]
  gaps: TransferGap[]
}

export function extractTransferProfile(detail: unknown): TransferProfileSummary | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined
  const raw = (detail as Record<string, unknown>).transferProfile
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.avgBps !== 'number' || typeof obj.bytesTransferred !== 'number') return undefined
  const anomaly: TransferAnomaly =
    obj.anomaly === 'failed' || obj.anomaly === 'stall' ? obj.anomaly : 'none'
  const sparkline = Array.isArray(obj.sparkline)
    ? obj.sparkline.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    : []
  const rawRange = obj.range
  let range: TransferRange | undefined
  if (rawRange && typeof rawRange === 'object' && !Array.isArray(rawRange)) {
    const r = rawRange as Record<string, unknown>
    if (typeof r.start === 'number' && typeof r.end === 'number') {
      range = { start: r.start, end: r.end }
    }
  }
  return {
    bytesTransferred: obj.bytesTransferred,
    totalBytes: typeof obj.totalBytes === 'number' ? obj.totalBytes : obj.bytesTransferred,
    activeDurationMs: typeof obj.activeDurationMs === 'number' ? obj.activeDurationMs : 0,
    totalSpanMs: typeof obj.totalSpanMs === 'number' ? obj.totalSpanMs : 0,
    avgBps: obj.avgBps,
    peakBps: typeof obj.peakBps === 'number' ? obj.peakBps : obj.avgBps,
    minBps: typeof obj.minBps === 'number' ? obj.minBps : 0,
    anomaly,
    stallCount: typeof obj.stallCount === 'number' ? obj.stallCount : undefined,
    statusReason: typeof obj.statusReason === 'string' && obj.statusReason ? obj.statusReason : undefined,
    range,
    bucketSeconds: typeof obj.bucketSeconds === 'number' && obj.bucketSeconds >= 1 ? obj.bucketSeconds : 1,
    sparkline,
  }
}

export function formatBytes(bytes: number): string {
  return formatSize(Math.max(0, bytes))
}

export function formatRate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0 B/s'
  if (bps < 1024) return `${Math.round(bps)} B/s`
  const kib = bps / 1024
  if (kib < 1024) return `${kib >= 100 ? kib.toFixed(0) : kib.toFixed(1)} KB/s`
  const mib = kib / 1024
  if (mib < 1024) return `${mib >= 100 ? mib.toFixed(0) : mib.toFixed(1)} MB/s`
  const gib = mib / 1024
  return `${gib.toFixed(2)} GB/s`
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`
  return formatDurationSec(Math.round(ms / 1000))
}

export function formatDurationSec(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec))
  if (sec < 60) return `${sec} 秒`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatShortPause(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const remM = m % 60
    return remM ? `${h}h${remM}m` : `${h}h`
  }
  return s ? `${m}m${s}s` : `${m}m`
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

export function formatLocalTimeOnly(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
