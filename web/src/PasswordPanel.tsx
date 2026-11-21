import { useState, type FormEvent } from 'react'
import { api } from './api/client'

export function PasswordPanel({ administrator }: { administrator: boolean }) {
  const [message, setMessage] = useState('')
  async function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const { response } = await api.PUT('/password', { body: {
      currentPassword: String(values.get('currentPassword')),
      newPassword: String(values.get('newPassword')),
    } })
    setMessage(response.ok ? '密码已修改' : '修改失败，请检查当前密码')
    if (response.ok) form.reset()
  }
  async function reset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const { response } = await api.PUT('/users/{userId}/password', {
      params: { path: { userId: Number(values.get('userId')) } },
      body: { newPassword: String(values.get('resetPassword')) },
    })
    setMessage(response.ok ? '密码已重置' : '重置失败')
    if (response.ok) form.reset()
  }
  return <section>
    <h2>修改密码</h2>
    <form onSubmit={change}>
      <label>当前密码<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={1024} /></label>
      <label>新密码<input name="newPassword" type="password" autoComplete="new-password" required maxLength={1024} /></label>
      <button>修改密码</button>
    </form>
    {administrator && <><h2>重置用户密码</h2><form onSubmit={reset}>
      <label>用户编号<input name="userId" type="number" min="1" required /></label>
      <label>重置密码<input name="resetPassword" type="password" autoComplete="new-password" required maxLength={1024} /></label>
      <button>重置密码</button>
    </form></>}
    <p role="status">{message}</p>
  </section>
}
