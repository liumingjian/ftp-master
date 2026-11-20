import { useEffect, useState } from 'react'
import { api, type CurrentUser } from './api/client'
import { HealthPanel } from './HealthPanel'
import { SIGN_IN_PATH } from './navigation'

type State = { kind: 'checking' } | { kind: 'signed-in'; user: CurrentUser } | { kind: 'unreachable'; message: string }

/** The frame of every signed-in page. Without a session it leaves for sign-in. */
export function SignedInShell() {
  const [state, setState] = useState<State>({ kind: 'checking' })

  useEffect(() => {
    let cancelled = false
    api
      .GET('/session')
      .then(({ data, response }) => {
        if (cancelled) return
        if (data) setState({ kind: 'signed-in', user: data })
        // 401 has already sent the browser to sign-in.
        else if (response.status !== 401) setState({ kind: 'unreachable', message: `HTTP ${response.status}` })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'unreachable', message: String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (state.kind === 'checking') return null
  if (state.kind === 'unreachable') {
    return <p className="bad">无法连接服务（{state.message}）</p>
  }

  return (
    <div className="shell">
      <header className="shell-header">
        <h1>ftp-master</h1>
        <div className="shell-user">
          <span data-testid="current-user">{state.user.displayName}</span>
          <button type="button" onClick={signOut}>
            退出登录
          </button>
        </div>
      </header>
      <main className="shell-main">
        <HealthPanel />
      </main>
    </div>
  )
}

async function signOut() {
  try {
    await api.DELETE('/session')
  } finally {
    window.location.replace(SIGN_IN_PATH)
  }
}
