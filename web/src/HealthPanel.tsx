import { useEffect, useState } from 'react'
import { api, type Health } from './api/client'

type State = { kind: 'loading' } | { kind: 'loaded'; health: Health } | { kind: 'unreachable'; message: string }

export function HealthPanel() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    api
      .GET('/health')
      .then(({ data, error, response }) => {
        if (cancelled) return
        // 503 still carries a Health body describing which store is down.
        const health = data ?? error
        if (health) setState({ kind: 'loaded', health })
        else setState({ kind: 'unreachable', message: `HTTP ${response.status}` })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'unreachable', message: String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="health" aria-labelledby="health-title">
      <h2 id="health-title">服务状态</h2>
      <HealthView state={state} />
    </section>
  )
}

function HealthView({ state }: { state: State }) {
  if (state.kind === 'loading') return <p>检查中…</p>
  if (state.kind === 'unreachable') {
    return (
      <p className="bad" data-testid="health-status">
        无法连接服务（{state.message}）
      </p>
    )
  }
  const { health } = state
  return (
    <>
      <p className={health.status === 'ok' ? 'good' : 'bad'} data-testid="health-status">
        {health.status === 'ok' ? '正常' : '降级'}
      </p>
      <dl>
        <dt>数据库</dt>
        <dd data-testid="health-database">
          {health.database.up ? `正常，架构版本 ${health.database.schemaVersion}` : '不可用'}
        </dd>
        <dt>对象存储</dt>
        <dd>{dependencyText(health.objectStorage)}</dd>
        <dt>缓存</dt>
        <dd>{dependencyText(health.cache)}</dd>
        <dt>检查时间</dt>
        <dd>{new Date(health.checkedAt).toLocaleString('zh-CN')}</dd>
      </dl>
    </>
  )
}

function dependencyText(d: Health['cache']) {
  return d.up ? '正常' : '不可用'
}
