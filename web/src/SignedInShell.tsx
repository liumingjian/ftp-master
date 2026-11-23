import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import {
  Activity,
  ChevronDown,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ScrollText,
  Settings,
  Sun,
  UserRound,
  UserRoundPlus,
  Users,
  X,
} from 'lucide-react'
import { AuditPanel } from './AuditPanel'
import { TreePanel } from './TreePanel'
import { defaultSidebarWidth, maxSidebarWidth, minSidebarWidth } from './DirectorySidebar'
import { RegistrationsPanel } from './RegistrationsPanel'
import { MembershipPanel } from './MembershipPanel'
import { PasswordPanel } from './PasswordPanel'
import { PlatformBrand } from './PlatformBrand'
import { UploadSettings } from './UploadSettings'
import { api, type CurrentUser } from './api/client'
import { avatarInitial } from './avatar'
import { HealthPanel } from './HealthPanel'
import { SIGN_IN_PATH } from './navigation'
import { unreachableText, useRequestOnMount, type Unreachable } from './requestOnMount'

type State = { kind: 'checking' } | { kind: 'signed-in'; user: CurrentUser } | Unreachable

const management = [
  { id: 'membership', label: '组织与用户组管理', icon: Users, panel: MembershipPanel },
  { id: 'registrations', label: '注册审批', icon: UserRoundPlus, panel: RegistrationsPanel },
  { id: 'audit', label: '审计日志', icon: ScrollText, panel: AuditPanel },
  { id: 'settings', label: '系统设置', icon: Settings, panel: UploadSettings },
  { id: 'status', label: '服务状态', icon: Activity, panel: HealthPanel },
] as const

const personal = [
  { id: 'account', label: '账户设置', icon: UserRound, panel: PasswordPanel },
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('ftp-sidebar-collapsed') === '1')
  const [organizationName, setOrganizationName] = useState<string>()
  const [organizationPath, setOrganizationPath] = useState<string>()
  const [pendingRegistrations, setPendingRegistrations] = useState<number>(0)

  const view = location.searchParams.get('view')
  const adminPage = user.isAdministrator ? management.find(item => item.id === view) : undefined
  const personalPage = personal.find(item => item.id === view)
  const destination = adminPage ?? personalPage
  const AdminPanel = adminPage?.panel
  const grantId = view === 'grants' ? Number(location.searchParams.get('grant')) || undefined : undefined
  const hasDesktopSidebar = !personalPage && !grantId

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
    const controller = new AbortController()
    void api.GET('/organizations', { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted || !data) return
      const byId = new Map(data.map(org => [org.id, org]))
      const current = byId.get(user.organizationId)
      if (!current) return
      setOrganizationName(current.name)
      const names: string[] = []
      const seen = new Set<number>()
      let cursor: typeof current | undefined = current
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id)
        names.unshift(cursor.name)
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
      }
      setOrganizationPath(names.join(' / '))
    }).catch(() => {})
    return () => controller.abort()
  }, [user.organizationId])

  useEffect(() => {
    if (!user.isAdministrator) return
    const controller = new AbortController()
    void api.GET('/registrations', { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted && data) setPendingRegistrations(data.length)
    }).catch(() => {})
    return () => controller.abort()
  }, [user.isAdministrator, view])

  useEffect(() => {
    if (!hasDesktopSidebar) return
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'b') return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return
      event.preventDefault()
      setSidebarCollapsed(previous => {
        const next = !previous
        localStorage.setItem('ftp-sidebar-collapsed', next ? '1' : '0')
        return next
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hasDesktopSidebar])

  useEffect(() => {
    if (destination || grantId) return
    function onSearchShortcut(event: KeyboardEvent) {
      if (document.querySelector('dialog[open]')) return
      const target = event.target
      const inField = target instanceof HTMLElement && (target.isContentEditable || !!target.closest('input, textarea, select'))
      const isCmdK = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k'
      const isSlash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !inField
      if (!isCmdK && !isSlash) return
      event.preventDefault()
      searchInput.current?.focus()
      searchInput.current?.select()
    }
    window.addEventListener('keydown', onSearchShortcut)
    return () => window.removeEventListener('keydown', onSearchShortcut)
  }, [destination, grantId])

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

  function toggleSidebar() {
    setSidebarCollapsed(previous => {
      const next = !previous
      localStorage.setItem('ftp-sidebar-collapsed', next ? '1' : '0')
      return next
    })
  }

  function setTheme(nextDark: boolean) {
    localStorage.setItem('ftp-theme', nextDark ? 'dark' : 'light')
    setDark(nextDark)
  }

  const shellClass = [
    'shell',
    personalPage ? 'personal-workspace' : adminPage ? 'management-workspace' : grantId ? 'permission-workspace' : '',
    hasDesktopSidebar && sidebarCollapsed ? 'sidebar-collapsed' : '',
  ].filter(Boolean).join(' ')

  const identitySubtitle = [
    user.isAdministrator ? '管理员' : '',
    organizationName ?? '',
  ].filter(Boolean).join(' · ')

  return (
    <div className={shellClass}
      style={{ '--directory-width': `${sidebarWidth}px` } as CSSProperties} data-theme={dark ? 'dark' : 'light'}>
      <a className="skip-link" href="#main-content">跳至主内容</a>
      <header className="shell-header">
        <a className="brand" href={href(undefined, '')} onClick={event => follow(event, undefined, '')}>
          <PlatformBrand />
        </a>
        {user.isAdministrator && <nav className="workspace-tabs" aria-label="工作区">
          <a className="button ghost" href={href()} aria-current={!destination ? 'page' : undefined} onClick={event => follow(event)}>文件</a>
          <a className="button ghost" href={href(adminPage?.id ?? management[0].id)} aria-current={adminPage ? 'page' : undefined}
            onClick={event => follow(event, adminPage?.id ?? management[0].id)}>
            管理
            {pendingRegistrations > 0 && !adminPage && <span className="nav-badge-dot" aria-hidden="true" title={`${pendingRegistrations} 条待审批注册`} />}
          </a>
        </nav>}
        {hasDesktopSidebar && <button type="button" className="ghost icon sidebar-collapse-toggle"
          aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-pressed={sidebarCollapsed}
          title={sidebarCollapsed ? '展开侧边栏 (⌘/Ctrl+B)' : '收起侧边栏 (⌘/Ctrl+B)'}
          onClick={toggleSidebar}>
          {sidebarCollapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
        </button>}
        {!destination && !grantId && <form className="header-search" role="search" onSubmit={event => {
          event.preventDefault()
          if (draft.trim()) navigate(undefined, location.hash, undefined, draft.trim())
        }}>
          <button className="ghost icon" aria-label="搜索" title="搜索"><Search size={16} aria-hidden="true" /></button>
          <input ref={searchInput} aria-label="按文件名搜索" placeholder="搜索可访问的文件" value={draft} maxLength={255}
            onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.blur() }}
            onChange={event => {
              setDraft(event.target.value)
            }} />
          {(draft || query) ? <button type="button" className="ghost icon" aria-label="清除搜索" title="清除搜索" onClick={() => {
            if (query) navigate()
            else setDraft('')
            searchInput.current?.focus()
          }}><X size={16} aria-hidden="true" /></button> : <kbd className="search-kbd" aria-hidden="true" title="按 / 或 ⌘K 聚焦搜索">/</kbd>}
        </form>}
        <div className="header-actions" ref={headerActions}>
          <div ref={setTransferSlot} />
          <button className="ghost icon" aria-label="切换深色/浅色" aria-pressed={dark}
            title={dark ? '切换浅色模式' : '切换深色模式'} onClick={() => setTheme(!dark)}>{dark ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}</button>
          <details className="user-menu">
            <summary aria-label={user.displayName + '，账户菜单'} title={identitySubtitle ? `${user.displayName} · ${identitySubtitle}` : user.displayName}>
              <span className="avatar" aria-hidden="true">{avatarInitial(user.displayName)}</span>
              <span className="user-identity">
                <span data-testid="current-user">{user.displayName}</span>
                {identitySubtitle && <small>{identitySubtitle}</small>}
              </span>
              <ChevronDown className="account-chevron" size={16} aria-hidden="true" />
            </summary>
            <div className="popup">
              {personal.map(({ id, label, icon: Icon }) => <a key={id} href={href(id)}
                aria-current={personalPage?.id === id ? 'page' : undefined}
                onClick={event => follow(event, id)}><Icon size={16} aria-hidden="true" />{label}</a>)}
              <button type="button" onClick={signOut}><LogOut size={16} aria-hidden="true" />退出登录</button>
            </div>
          </details>
        </div>
      </header>
      <TreePanel administrator={user.isAdministrator} active={!destination} hash={location.hash} query={query}
        transferSlot={transfers} navigate={hash => navigate(undefined, hash)}
        grantId={grantId} openGrant={id => navigate('grants', undefined, id)}
        recycle={view === 'recycle'} openRecycle={() => navigate('recycle')} recycleHref={href('recycle')}
        sidebarWidth={sidebarWidth} resizeSidebar={resizeSidebar}
        sidebarCollapsed={sidebarCollapsed}
        viewerUser={{ displayName: user.displayName, username: user.username, organizationName }} />
      {adminPage && <aside className={sidebarCollapsed ? 'sidebar management-sidebar collapsed' : 'sidebar management-sidebar'}>
        <nav aria-label="管理导航">
          <select className="management-picker" aria-label="管理页面" value={adminPage.id} onChange={event => navigate(event.target.value)}>
            {management.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
          {management.map(({ id, label, icon: Icon }) => {
            const badge = id === 'registrations' && pendingRegistrations > 0 ? pendingRegistrations : 0
            return <a key={id} className="sidebar-link" href={href(id)}
              aria-label={label}
              title={badge ? `${label}（${badge} 条待审批）` : label}
              aria-current={adminPage.id === id ? 'page' : undefined}
              onClick={event => follow(event, id)}>
              <Icon size={18} aria-hidden="true" />
              <span className="sidebar-link-text">{label}</span>
              {badge > 0 && <span className="sidebar-badge" aria-hidden="true">{badge}</span>}
            </a>
          })}
        </nav>
      </aside>}
      {destination && <main id="main-content" tabIndex={-1} className="shell-main destination" key={destination.id}>
        {personalPage
          ? <PasswordPanel user={user} organizationPath={organizationPath} onBackToFiles={() => navigate()} />
          : AdminPanel && <AdminPanel />}
      </main>}
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
