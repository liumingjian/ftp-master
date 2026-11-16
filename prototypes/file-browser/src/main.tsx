// PROTOTYPE: three file-browser variants on one page, switchable via ?variant=A|B|C.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { USERS, User } from './data'
import { PrototypeSwitcher } from './PrototypeSwitcher'
import { VariantA } from './VariantA'
import { VariantB } from './VariantB'
import { VariantC } from './VariantC'
import './styles.css'

export type VariantProps = { user: User; plugin: boolean }

const VARIANTS = [
  { key: 'A', name: '经典双栏资源管理器', C: VariantA },
  { key: 'B', name: '分栏浏览 + 预览', C: VariantB },
  { key: 'C', name: '入口与搜索优先', C: VariantC },
]

function useParams() {
  const [, tick] = useState(0)
  useEffect(() => {
    const on = () => tick((x) => x + 1)
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  const p = new URLSearchParams(window.location.search)
  const set = (k: string, v: string) => {
    const q = new URLSearchParams(window.location.search)
    q.set(k, v)
    history.replaceState(null, '', `?${q}`)
    tick((x) => x + 1)
  }
  return { p, set }
}

function App() {
  const { p, set } = useParams()
  const variant = VARIANTS.find((v) => v.key === p.get('variant')) ?? VARIANTS[0]
  const user = USERS.find((u) => u.id === p.get('user')) ?? USERS[0]
  const plugin = p.get('plugin') === '1'
  const V = variant.C
  return (
    <>
      {/* key forces a fresh mount so each variant/user starts from its own initial state */}
      <V key={`${variant.key}-${user.id}`} user={user} plugin={plugin} />
      {!import.meta.env.PROD && (
        <PrototypeSwitcher
          variants={VARIANTS.map(({ key, name }) => ({ key, name }))}
          current={variant.key}
          onVariant={(k) => set('variant', k)}
          user={user}
          onUser={(id) => set('user', id)}
          plugin={plugin}
          onPlugin={(on) => set('plugin', on ? '1' : '0')}
        />
      )}
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
