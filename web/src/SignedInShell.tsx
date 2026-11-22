import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { Activity, ChevronDown, LogOut, Moon, Search, ScrollText, Settings, Sun, UserRound, UserRoundPlus, Users, X } from 'lucide-react'
import { AuditPanel } from './AuditPanel'
import { TreePanel } from './TreePanel'
import { defaultSidebarWidth, maxSidebarWidth, minSidebarWidth } from './DirectorySidebar'
import { RegistrationsPanel } from './RegistrationsPanel'
import { MembershipPanel } from './MembershipPanel'
import { PasswordPanel } from './PasswordPanel'
import { PlatformBrand } from './PlatformBrand'
import { UploadSettings } from './UploadSettings'
import { api, type CurrentUser } from './api/client'
import { HealthPanel } from './HealthPanel'
import { SIGN_IN_PATH } from './navigation'
import { unreachableText, useRequestOnMount, type Unreachable } from './requestOnMount'

type State = { kind: 'checking' } | { kind: 'signed-in'; user: CurrentUser } | Unreachable

const management = [
  { id: 'membership', label: '组织与用户组管理', icon: Users, panel: MembershipPanel },
  { id: 'registrations', label: '注册审批', icon: UserRoundPlus, panel: RegistrationsPanel },
  { id: 'audit', label: '审计日志', icon: ScrollText, panel: AuditPanel },
  { id: 'settings', label: '上传设置', icon: Settings, panel: UploadSettings },
] as const

const personal = [
  { id: 'account', label: '账户设置', icon: UserRound, panel: PasswordPanel },
  { id: 'status', label: '服务状态', icon: Activity, panel: HealthPanel },
]

export function SignedInShell() {
  const state = useRequestOnMount<State>({ kind: 'checking' }, async () => {
    const { data, response } = await api.GET('/session')
    if (data) return { kind: 'signed-in', user: data }
    if (response.status === 401) return undefined
    return { kind: 'unreachable', message: `HTTP ${response.status}` }
  })

  if (state.kind === 'checking') return <main className="session-feedback" role="status">正在打开工作台…</main>
  if (state.kind === 'unreachable') return <main className="session-feedback">
    <p className="banner error" role="alert">{unreachableText(state.message)}</p>
    <button onClick={() => window.location.reload()}>重试</button>
  </main>
  return <Workspace user={state.user} />
}

function Workspace({ user }: { user: CurrentUser }) {
  const [location, setLocation] = useState(() => new URL(window.location.href))
  const [dark, setDark] = useState(() => localStorage.getItem('ftp-theme') === 'dark')
  const query = location.searchParams.get('q')?.trim().slice(0, 255) ?? ''
  const [draft, setDraft] = useState(query)
  const [transfers, setTransferSlot] = useState<HTMLDivElement | null>(null)
  const headerActions = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('ftp-sidebar-width'))
    return saved >= minSidebarWidth && saved <= maxSidebarWidth ? saved : defaultSidebarWidth
  })
  const view = location.searchParams.get('view')
  const adminPage = user.isAdministrator ? management.find(item => item.id === view) : undefined
  const personalPage = personal.find(item => item.id === view)
  const destination = adminPage ?? personalPage
  const Panel = destination?.panel
  const grantId = view === 'grants' ? Number(location.searchParams.get('grant')) || undefined : undefined

  useEffect(() => {
    function syncLocation() {
      const next = new URL(window.location.href)
      setLocation(next)
      setDraft(next.searchParams.get('q')?.trim().slice(0, 255) ?? '')
    }
    window.addEventListener('popstate', syncLocation)
    window.addEventListener('hashchange', syncLocation)
    return () => {
      window.removeEventListener('popstate', syncLocation)
      window.removeEventListener('hashchange', syncLocation)
    }
  }, [])

  useEffect(() => {
    const actions = headerActions.current
    function dismissMenus(event: PointerEvent | FocusEvent) {
      if (!(event.target instanceof Node)) return
      actions?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(menu => {
        if (!menu.contains(event.target as Node)) menu.open = false
      })
    }
    function escapeMenu(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !(event.target instanceof Element)) return
      const menu = event.target.closest<HTMLDetailsElement>('details[open]')
      if (!menu) return
      event.preventDefault()
      event.stopPropagation()
      menu.open = false
      menu.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', dismissMenus)
    document.addEventListener('focusin', dismissMenus)
    actions?.addEventListener('keydown', escapeMenu)
    return () => {
      document.removeEventListener('pointerdown', dismissMenus)
      document.removeEventListener('focusin', dismissMenus)
      actions?.removeEventListener('keydown', escapeMenu)
    }
  }, [])

  function href(view?: string, hash = location.hash, grant?: number, search = '') {
    const url = new URL(location)
    if (view) url.searchParams.set('view', view)
    else url.searchParams.delete('view')
    if (grant) url.searchParams.set('grant', String(grant))
    else url.searchParams.delete('grant')
    if (search) url.searchParams.set('q', search)
    else url.searchParams.delete('q')
    url.hash = hash
    return url.pathname + url.search + url.hash
  }

  function navigate(view?: string, hash?: string, grant?: number, search = '') {
    const next = href(view, hash, grant, search)
    if (new URL(next, location).href !== location.href) {
      window.history.pushState(null, '', next)
      setLocation(new URL(window.location.href))
    }
    setDraft(search)
  }

  function follow(event: MouseEvent<HTMLAnchorElement>, view?: string, hash?: string) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    const menu = event.currentTarget.closest('details')
    if (menu) menu.open = false
    navigate(view, hash)
  }

  function resizeSidebar(width: number) {
    setSidebarWidth(width)
    localStorage.setItem('ftp-sidebar-width', String(width))
  }

  return (
    <div className={personalPage ? 'shell personal-workspace' : adminPage ? 'shell management-workspace' : grantId ? 'shell permission-workspace' : 'shell'}
      style={{ '--directory-width': `${sidebarWidth}px` } as CSSProperties} data-theme={dark ? 'dark' : 'light'}>
      <header className="shell-header">
        <a className="brand" href={href(undefined, '')} onClick={event => follow(event, undefined, '')}>
          <PlatformBrand />
        </a>
        {user.isAdministrator && <nav className="workspace-tabs" aria-label="工作区">
          <a className="button ghost" href={href()} aria-current={!destination ? 'page' : undefined} onClick={event => follow(event)}>文件</a>
          <a className="button ghost" href={href(adminPage?.id ?? management[0].id)} aria-current={adminPage ? 'page' : undefined}
            onClick={event => follow(event, adminPage?.id ?? management[0].id)}>管理</a>
        </nav>}
        <form className="header-search" role="search" onSubmit={event => {
          event.preventDefault()
          if (draft.trim()) navigate(undefined, location.hash, undefined, draft.trim())
        }}>
          <button className="ghost icon" aria-label="搜索"><Search size={16} aria-hidden="true" /></button>
          <input ref={searchInput} aria-label="按文件名搜索" placeholder="搜索可访问的文件" value={draft} maxLength={255} onChange={event => {
            setDraft(event.target.value)
          }} />
          {(draft || query) && <button type="button" className="ghost icon" aria-label="清除搜索" onClick={() => {
            if (query) navigate()
            else setDraft('')
            searchInput.current?.focus()
          }}><X size={16} /></button>}
        </form>
        <div className="header-actions" ref={headerActions}>
          <div ref={setTransferSlot} />
          <button className="ghost icon" aria-label="切换深色/浅色" aria-pressed={dark}
            title={dark ? '切换浅色模式' : '切换深色模式'} onClick={() => {
            localStorage.setItem('ftp-theme', dark ? 'light' : 'dark')
            setDark(!dark)
          }}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
          <details className="user-menu">
            <summary aria-label={user.displayName + '，账户菜单'}><span className="avatar" aria-hidden="true">{Array.from(user.displayName)[0]}</span><span className="user-identity">
              <span data-testid="current-user">{user.displayName}</span>
              {user.isAdministrator && <small>管理员</small>}
            </span><ChevronDown className="account-chevron" size={16} aria-hidden="true" /></summary>
            <div className="popup">
              {personal.map(({ id, label, icon: Icon }) => <a key={id} href={href(id)}
                aria-current={personalPage?.id === id ? 'page' : undefined}
                onClick={event => follow(event, id)}><Icon size={16} />{label}</a>)}
              <button type="button" onClick={signOut}><LogOut size={16} />退出登录</button>
            </div>
          </details>
        </div>
      </header>
      <TreePanel administrator={user.isAdministrator} active={!destination} hash={location.hash} query={query}
        transferSlot={transfers} navigate={hash => navigate(undefined, hash)}
        grantId={grantId} openGrant={id => navigate('grants', undefined, id)}
        recycle={view === 'recycle'} openRecycle={() => navigate('recycle')} recycleHref={href('recycle')}
        sidebarWidth={sidebarWidth} resizeSidebar={resizeSidebar} />
      {adminPage && <aside className="sidebar management-sidebar">
        <nav aria-label="管理导航">
          {management.map(({ id, label, icon: Icon }) => <a key={id} className="sidebar-link" href={href(id)}
            aria-current={adminPage.id === id ? 'page' : undefined}
            onClick={event => follow(event, id)}><Icon size={16} />{label}</a>)}
        </nav>
      </aside>}
      {Panel && <main className="shell-main destination" key={destination.id}><Panel user={user} /></main>}
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
