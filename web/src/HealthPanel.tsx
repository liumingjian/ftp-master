import { useEffect, useState } from 'react'
import { CheckCircle2, Database, HardDrive, RefreshCw, TriangleAlert, Zap } from 'lucide-react'
import { api, type Health } from './api/client'
import { PageHeading } from './PageHeading'

export function HealthPanel() {
  const [health, setHealth] = useState<Health>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function check(signal?: AbortSignal) {
    setLoading(true)
    setError('')
    try {
      const result = await api.GET('/health', { signal })
      if (signal?.aborted) return
      // A degraded service responds with health details and HTTP 503.
      const health = result.data ?? result.error
      if (health) setHealth(health)
      else setError(`无法读取服务状态（HTTP ${result.response.status}）`)
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

  const services = health ? [
    { label: '数据库', icon: Database, up: health.database.up, testId: 'health-database',
      status: health.database.up ? `正常，架构版本 ${health.database.schemaVersion}` : '不可用' },
    { label: '对象存储', icon: HardDrive, up: health.objectStorage.up, status: health.objectStorage.up ? '正常' : '不可用' },
    { label: '缓存', icon: Zap, up: health.cache.up, status: health.cache.up ? '正常' : '不可用' },
  ] : []

  return <section className="workspace-page" aria-label="服务状态">
    <PageHeading title="服务状态"
      actions={<button disabled={loading} type="button" onClick={() => void check()}><RefreshCw size={15} />{loading ? '检查中…' : '重新检查'}</button>} />
    {loading && !health && <p className="banner" role="status">正在检查服务状态…</p>}
    {error && <p className="banner error" role="alert">{error}</p>}
    {health && <>
      <div className={`health-overview panel ${health.status === 'ok' ? 'positive' : 'warning'}`}>
        {health.status === 'ok' ? <CheckCircle2 size={24} /> : <TriangleAlert size={24} />}
        <div><h3>运行状态</h3><strong data-testid="health-status">{health.status === 'ok' ? '正常' : '降级'}</strong></div>
        <small>上次检查 <time dateTime={health.checkedAt}>{new Date(health.checkedAt).toLocaleString('zh-CN')}</time></small>
      </div>
      <div className="status-grid">{services.map(({ label, icon: Icon, up, status, testId }) =>
        <section key={label} className="panel">
          <div className="section-heading"><Icon size={18} /><h3>{label}</h3></div>
          <p className={`pill ${up ? 'positive' : 'warning'}`} data-testid={testId}>{status}</p>
        </section>)}</div>
    </>}
  </section>
}
