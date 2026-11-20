import { MembershipPanel } from './MembershipPanel'
import { api, type CurrentUser } from './api/client'
import { HealthPanel } from './HealthPanel'
import { SIGN_IN_PATH } from './navigation'
import { unreachableText, useRequestOnMount, type Unreachable } from './requestOnMount'

type State = { kind: 'checking' } | { kind: 'signed-in'; user: CurrentUser } | Unreachable

/** The frame of every signed-in page. Without a session it leaves for sign-in. */
export function SignedInShell() {
  const state = useRequestOnMount<State>({ kind: 'checking' }, async () => {
    const { data, response } = await api.GET('/session')
    if (data) return { kind: 'signed-in', user: data }
    // 401 has already sent the browser to sign-in.
    if (response.status === 401) return undefined
    return { kind: 'unreachable', message: `HTTP ${response.status}` }
  })

  if (state.kind === 'checking') return null
  if (state.kind === 'unreachable') {
    return <p className="bad">{unreachableText(state.message)}</p>
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
        {state.user.isAdministrator && <MembershipPanel />}
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
