import { useState, type FormEvent } from 'react'
import { api } from './api/client'
import { pathAfterSignIn } from './navigation'
import { unreachableText } from './requestOnMount'

export function SignInPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const { data, response, error: apiError } = await api.POST('/session', { body: { username, password } })
      if (data) {
        window.location.replace(pathAfterSignIn(window.location.search))
        return
      }
      setError(response.status === 403 && apiError?.code === 'registration_pending' ? '注册等待管理员审批' : response.status === 401 ? '用户名或密码错误' : `登录失败（HTTP ${response.status}）`)
    } catch (err: unknown) {
      setError(unreachableText(String(err)))
    }
    setPassword('')
    setSubmitting(false)
  }

  return (
    <div className="sign-in">
      <form className="sign-in-form" onSubmit={submit}>
        <h1>ftp-master</h1>
        <h2>登录</h2>
        <label>
          用户名
          <input
            name="username"
            autoComplete="username"
            required
            maxLength={150}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="bad" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting}>
          登录
        </button>
      <a href="/register">注册新用户</a>
      </form>
    </div>
  )
}
