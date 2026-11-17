// PROTOTYPE: file-browser variants on one page, switchable via ?variant=T1–T4|D1|C1–C4|P1–P4|F|A1|M1–M3 (T: round 7 transfer panels on D1; D: round 6; C: round 5; P: round 4).
// Earlier rounds (A, B, C, A2–A4) are in this branch's git history.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { USERS, User } from './data'
import { PrototypeSwitcher } from './PrototypeSwitcher'
import { VariantA1 } from './VariantA1'
import { VariantT1, VariantT2, VariantT3, VariantT4, VariantD1, VariantC1, VariantC2, VariantC3, VariantC4, VariantF, VariantM1, VariantM2, VariantM3, VariantP1, VariantP2, VariantP3, VariantP4 } from './VariantMotion'
import './styles.css'
import './modern.css'
import './motion.css'
import './grant.css'
import './transfer.css'

export type VariantProps = { user: User; plugin: boolean }

const VARIANTS = [
  { key: 'T3', name: '第 7 轮选定 · 传输：就地进度，下载交给浏览器', C: VariantT3 },
  { key: 'T1', name: '第 7 轮 · 传输：角落托盘', C: VariantT1 },
  { key: 'T2', name: '第 7 轮 · 传输：传输页', C: VariantT2 },
  { key: 'T4', name: '第 7 轮 · 传输：先确认后传', C: VariantT4 },
  { key: 'D1', name: '第 6 轮 · 多级权限管理（FTP 权限项 + C1 表格）', C: VariantD1 },
  { key: 'C1', name: 'Confluence · 空间权限表', C: VariantC1 },
  { key: 'C2', name: 'Confluence · 访问限制弹窗', C: VariantC2 },
  { key: 'C3', name: 'Confluence · 权限检查', C: VariantC3 },
  { key: 'C4', name: 'Confluence · 用户组优先', C: VariantC4 },
  { key: 'P1', name: '授权 · 共享弹窗', C: VariantP1 },
  { key: 'P2', name: '授权 · 侧栏刻度条', C: VariantP2 },
  { key: 'P3', name: '授权 · 权限矩阵', C: VariantP3 },
  { key: 'P4', name: '授权 · 以人为中心', C: VariantP4 },
  { key: 'F', name: '选定：M2 克制 + 删除飞入回收站', C: VariantF },
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
