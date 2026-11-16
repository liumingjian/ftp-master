// PROTOTYPE: file-browser variants on one page, switchable via ?variant=A1|M1|M2|M3.
// Earlier rounds (A, B, C, A2–A4) are in this branch's git history.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { USERS, User } from './data'
import { PrototypeSwitcher } from './PrototypeSwitcher'
import { VariantA1 } from './VariantA1'
import { VariantM1, VariantM2, VariantM3 } from './VariantMotion'
import './styles.css'
import './modern.css'
import './motion.css'

export type VariantProps = { user: User; plugin: boolean }

const VARIANTS = [
  { key: 'A1', name: '上一轮 A1（基准）', C: VariantA1 },
  { key: 'M1', name: '灵动 · 弹簧物理', C: VariantM1 },
  { key: 'M2', name: '克制 · 精准迅捷', C: VariantM2 },
  { key: 'M3', name: '通透 · 玻璃景深', C: VariantM3 },
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
  const variant = VARIANTS.find((v) => v.key === p.get('variant')) ?? VARIANTS[1]
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
