// PROTOTYPE: file-browser variants on one page, switchable via ?variant=A|A1|A2|A3|A4.
// Round 1 also had B (column view) and C (entry/search first); see git history of this branch.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { USERS, User } from './data'
import { PrototypeSwitcher } from './PrototypeSwitcher'
import { VariantA } from './VariantA'
import { VariantA1 } from './VariantA1'
import { VariantA2 } from './VariantA2'
import { VariantA3 } from './VariantA3'
import { VariantA4 } from './VariantA4'
import './styles.css'
import './modern.css'

export type VariantProps = { user: User; plugin: boolean }

const VARIANTS = [
  { key: 'A', name: '原版（基准）', C: VariantA },
  { key: 'A1', name: '悬停即操作 · 拖拽', C: VariantA1 },
  { key: 'A2', name: '键盘与命令面板', C: VariantA2 },
  { key: 'A3', name: '主动提示 · 一键处理', C: VariantA3 },
  { key: 'A4', name: '即点即看 · 版本滑块', C: VariantA4 },
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
