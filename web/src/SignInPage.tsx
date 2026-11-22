import { useState, type FormEvent } from 'react'
import { AuthLayout } from './AuthLayout'
import { PasswordInput } from './PasswordInput'
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
    <AuthLayout title="登录" hideHeading
      onSubmit={submit} footer={<a href="/register">注册新用户</a>}>
        <label>
          用户名
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={150}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <PasswordInput name="password" autoComplete="current-password" required maxLength={1024}
          value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && (
          <p className="banner error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={submitting}>
          {submitting ? "正在登录…" : "登录"}
        </button>
    </AuthLayout>
  )
}
