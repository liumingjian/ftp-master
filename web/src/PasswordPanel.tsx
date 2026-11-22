import { useState, type FormEvent } from 'react'
import { KeyRound, LockKeyhole } from 'lucide-react'
import { api, type CurrentUser } from './api/client'
import { PageHeading } from './PageHeading'

type Action = 'change' | 'reset'

export function PasswordPanel({ user }: { user: CurrentUser }) {
  const [busy, setBusy] = useState<Action>()
  const [feedback, setFeedback] = useState<{ action: Action; text: string; ok: boolean }>()

  async function submit(event: FormEvent<HTMLFormElement>, action: Action) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const values = new FormData(form)
    setBusy(action)
    setFeedback(undefined)
    try {
      const { response } = action === 'change'
        ? await api.PUT('/password', { body: {
          currentPassword: String(values.get('currentPassword')), newPassword: String(values.get('newPassword')),
        } })
        : await api.PUT('/users/{userId}/password', {
          params: { path: { userId: Number(values.get('userId')) } }, body: { newPassword: String(values.get('resetPassword')) },
        })
      const text = action === 'change'
        ? response.ok ? '密码已修改' : '修改失败，请检查当前密码'
        : response.ok ? '密码已重置' : '重置失败'
      setFeedback({ action, text, ok: response.ok })
      if (response.ok) form.reset()
    } catch {
      setFeedback({ action, text: '无法连接服务，请重试', ok: false })
    } finally {
      setBusy(undefined)
    }
  }

  function status(action: Action) {
    return feedback?.action === action && <p className={`banner ${feedback.ok ? 'success' : 'error'}`} role="status">{feedback.text}</p>
  }

  return <section className="workspace-page" aria-label="账户设置">
    <PageHeading title="账户设置" />
    <div className="panel profile">
      <span className="avatar">{user.displayName.slice(-1)}</span>
      <div><strong>{user.displayName}</strong><small>{user.username} · 编号 {user.id}</small></div>
      {user.isAdministrator && <span className="pill">管理员</span>}
    </div>
    <div className="admin-grid">
      <section className="panel" aria-labelledby="password-heading">
        <div className="section-heading"><LockKeyhole size={18} /><h3 id="password-heading">修改密码</h3></div>
        <form className="panel-form" onSubmit={event => void submit(event, 'change')}>
          <input type="hidden" name="username" value={user.username} autoComplete="username" />
          <label>当前密码<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={1024} /></label>
          <label>新密码<input name="newPassword" type="password" autoComplete="new-password" required maxLength={1024} /></label>
          <div className="form-actions"><button className="primary" disabled={!!busy}>{busy === 'change' ? '正在修改…' : '修改密码'}</button></div>
          {status('change')}
        </form>
      </section>
      {user.isAdministrator && <section className="panel" aria-labelledby="reset-heading">
        <div className="section-heading"><KeyRound size={18} /><h3 id="reset-heading">重置用户密码</h3></div>
        <form className="panel-form" onSubmit={event => void submit(event, 'reset')}>
          <label>用户编号<input name="userId" type="number" min="1" required /></label>
          <label>重置密码<input name="resetPassword" type="password" autoComplete="new-password" required maxLength={1024} /></label>
          <div className="form-actions"><button disabled={!!busy}>{busy === 'reset' ? '正在重置…' : '重置密码'}</button></div>
          {status('reset')}
        </form>
      </section>}
    </div>
  </section>
}
