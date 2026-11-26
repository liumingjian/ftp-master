import { useEffect, useState } from 'react'
import { Clock, Gauge, RefreshCw } from 'lucide-react'
import { api, type Health } from './api/client'
import { systemClock } from './clock'
import { AppIcon, type AppIconName } from './icons/AppIcon'
import { PageHeading } from './PageHeading'

function formatUptime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时 ${minutes} 分钟`
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  if (minutes > 0) return `${minutes} 分钟`
  return `${seconds} 秒`
}

export function HealthPanel() {
  const [health, setHealth] = useState<Health>()
  const [latencyMs, setLatencyMs] = useState<number>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function check(signal?: AbortSignal) {
    setLoading(true)
    setError('')
    const startedAt = systemClock.now()
    try {
      const result = await api.GET('/health', { signal })
      if (signal?.aborted) return
      const elapsed = Math.max(1, Math.round(systemClock.now() - startedAt))
      // A degraded service responds with health details and HTTP 503.
      const next = result.data ?? result.error
      if (next) {
        setHealth(next)
        setLatencyMs(elapsed)
      } else {
        setError(`无法读取服务状态（HTTP ${result.response.status}）`)
      }
    } catch {
      if (!signal?.aborted) setError('无法连接服务')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void check(controller.signal)
    return () => controller.abort()
  }, [])

  const services: Array<{
    label: string
    role: string
    icon: AppIconName
    up: boolean
    testId?: string
    status: string
    impact: string
  }> = health ? [
    {
      label: '数据库',
      role: '元数据、组织架构与权限存储',
      icon: 'service-database',
      up: health.database.up,
      testId: 'health-database',
      status: health.database.up ? `正常，架构版本 ${health.database.schemaVersion}` : '不可用',
      impact: '数据库异常将影响登录鉴权、目录浏览与权限写入。',
    },
    {
      label: '对象存储',
      role: '文件实体与历史版本存储',
      icon: 'service-storage',
      up: health.objectStorage.up,
      status: health.objectStorage.up ? '正常' : '不可用',
      impact: '对象存储异常将影响文件上传、下载与在线预览。',
    },
    {
      label: '缓存',
      role: '会话状态与高频访问缓存',
      icon: 'service-cache',
      up: health.cache.up,
      status: health.cache.up ? '正常' : '不可用',
      impact: '缓存异常可能导致会话校验或接口响应下降。',
    },
  ] : []

  const healthyCount = services.filter(service => service.up).length
  const failedCount = services.length - healthyCount

  return <section className="workspace-page health-page" aria-label="服务状态">
    <PageHeading title="服务状态"
      actions={<button disabled={loading} type="button" onClick={() => void check()}>
        <RefreshCw size={15} className={loading ? 'spin' : undefined} aria-hidden="true" />
        {loading ? '检查中…' : '重新检查'}
      </button>} />
    {loading && !health && <p className="banner" role="status">正在检查服务状态…</p>}
    {error && <p className="banner error" role="alert">{error}</p>}
    {health && <>
      <div className={`health-overview panel ${health.status === 'ok' ? 'positive' : 'warning'}`}>
        <div className="health-overview-lead">
          <span className="health-status-icon" aria-hidden="true">
            <AppIcon name={health.status === 'ok' ? 'health-ok' : 'health-degraded'} size={44} />
          </span>
          <div className="health-overview-text">
            <div className="health-overview-title">
              <h2>运行状态</h2>
              <strong data-testid="health-status">{health.status === 'ok' ? '正常' : '降级'}</strong>
            </div>
            <p className="muted">
              {failedCount === 0
                ? `全部 ${services.length} 项核心依赖运行正常`
                : `当前有 ${failedCount} 项核心依赖异常（${healthyCount}/${services.length} 正常）`}
            </p>
          </div>
        </div>

        <dl className="health-metrics">
          <div className="health-metric">
            <dt><Clock size={14} aria-hidden="true" />连续运行时长</dt>
            <dd>{formatUptime(health.uptimeSeconds)}</dd>
          </div>
          {latencyMs !== undefined && (
            <div className="health-metric">
              <dt><Gauge size={14} aria-hidden="true" />探针响应耗时</dt>
              <dd>{latencyMs} ms</dd>
            </div>
          )}
          <div className="health-metric">
            <dt>上次检查</dt>
            <dd><time dateTime={health.checkedAt}>{new Date(health.checkedAt).toLocaleString('zh-CN')}</time></dd>
          </div>
        </dl>
      </div>

      <div className="status-grid health-services">
        {services.map(({ label, role, icon, up, status, impact, testId }) => (
          <section key={label} className={`panel health-service-card ${up ? 'up' : 'down'}`}>
            <div className="health-service-header">
              <span className="health-service-icon" aria-hidden="true"><AppIcon name={icon} size={36} /></span>
              <div className="health-service-title">
                <h2>{label}</h2>
                <p>{role}</p>
              </div>
            </div>
            <div className="health-service-footer">
              <span className={`pill ${up ? 'positive' : 'warning'}`} data-testid={testId}>{status}</span>
            </div>
            {!up && <p className="health-service-impact" role="alert">{impact}</p>}
          </section>
        ))}
      </div>
    </>}
  </section>
}
