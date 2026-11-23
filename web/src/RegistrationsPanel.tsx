import { useEffect, useState } from 'react'
import { Inbox, RefreshCw } from 'lucide-react'
import { api } from './api/client'
import { avatarInitial } from './avatar'
import type { components } from './api/schema.gen'
import { PageHeading } from './PageHeading'

export function RegistrationsPanel() {
  const [rows, setRows] = useState<components['schemas']['Registration'][]>([])
  const [organizations, setOrganizations] = useState<components['schemas']['Organization'][]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState<number>()
  const [rejecting, setRejecting] = useState<number>()

  async function load(signal?: AbortSignal) {
    setLoading(true)
    setError('')
    try {
      const [registrations, orgs] = await Promise.all([
        api.GET('/registrations', { signal }), api.GET('/organizations', { signal }),
      ])
      if (signal?.aborted) return
      if (!registrations.data || !orgs.data) {
        setError('无法加载注册申请')
        return
      }
      setRows(registrations.data)
      setOrganizations(orgs.data)
    } catch {
      if (!signal?.aborted) setError('无法连接服务器')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [])

  async function process(id: number, action: 'activate' | 'reject', organizationId?: number) {
    if (pending !== undefined) return
    setError('')
    setMessage('')
    setPending(id)
    try {
      const params = { path: { id } }
      const { response } = action === 'activate' && organizationId !== undefined
        ? await api.POST('/registrations/{id}/activate', { params, body: { organizationId } })
        : await api.POST('/registrations/{id}/reject', { params })
      if (response.ok) {
        setRows(current => current.filter(row => row.id !== id))
        setRejecting(undefined)
        setMessage(action === 'activate' ? '注册申请已批准，账户已激活' : '注册申请已拒绝')
      } else setError('处理失败，请刷新列表后重试')
    } catch {
      setError('无法连接服务器')
    } finally {
      setPending(undefined)
    }
  }

  return <section className="workspace-page" aria-label="注册审批">
    <PageHeading title="注册审批"
      actions={<button disabled={loading || pending !== undefined} type="button" onClick={() => void load()}>
        <RefreshCw size={15} className={loading ? 'spin' : undefined} aria-hidden="true" />刷新列表
      </button>} />
    {error && <p className="banner error" role="alert">{error}</p>}
    {message && <p className="banner success" role="status">{message}</p>}
    <section className="panel" aria-labelledby="pending-heading">
      <div className="section-heading"><h2 id="pending-heading">待审批注册</h2>{!loading && <span className="pill">{rows.length} 条</span>}</div>
      {loading && <p className="panel-empty" role="status">正在加载申请…</p>}
      {!loading && !error && !rows.length && <div className="panel-empty"><Inbox size={26} />暂无待审批的申请</div>}
      <ul className="record-list approval-list">
        {rows.map(row => <li key={row.id}>
          <div className="identity-row">
            <span className="avatar" aria-hidden="true">{avatarInitial(row.displayName)}</span>
            <span><strong>{row.displayName}</strong><small>{row.username}</small></span>
          </div>
          <div className="approval-organization"><small>申请人填写的组织</small><strong>{row.organizationHint || '—'}</strong></div>
          {rejecting === row.id
            ? <div className="approval-actions"><span>拒绝此注册申请？</span>
              <button type="button" className="danger" disabled={pending !== undefined} onClick={() => void process(row.id, 'reject')}>确认拒绝</button>
              <button type="button" disabled={pending !== undefined} onClick={() => setRejecting(undefined)}>取消</button>
            </div>
            : <form className="approval-actions" onSubmit={event => {
              event.preventDefault()
              const organizationId = Number(new FormData(event.currentTarget).get('organizationId'))
              if (organizationId) void process(row.id, 'activate', organizationId)
            }}>
              <label>分配组织<select name="organizationId" required defaultValue="" disabled={loading || pending !== undefined}>
                <option value="">请选择组织</option>
                {organizations.map(organization => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
              </select></label>
              <button className="primary" disabled={loading || pending !== undefined}>激活</button>
              <button className="danger ghost" type="button" disabled={loading || pending !== undefined} onClick={() => setRejecting(row.id)}>拒绝</button>
            </form>}
        </li>)}
      </ul>
    </section>
  </section>
}
