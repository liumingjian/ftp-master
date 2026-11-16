// PROTOTYPE floating switcher bar. Not part of any design being evaluated.
import { useEffect } from 'react'
import { USERS, User } from './data'
import { entryPoints } from './perm'

type Props = {
  variants: { key: string; name: string }[]
  current: string
  onVariant: (k: string) => void
  user: User
  onUser: (id: string) => void
  plugin: boolean
  onPlugin: (on: boolean) => void
}

export function PrototypeSwitcher({ variants, current, onVariant, user, onUser, plugin, onPlugin }: Props) {
  const i = variants.findIndex((v) => v.key === current)
  const go = (d: number) => onVariant(variants[(i + d + variants.length) % variants.length].key)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable]')) return
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="proto-bar">
      <button onClick={() => go(-1)}>←</button>
      <b>
        {current} · {variants[i].name}
      </b>
      <button onClick={() => go(1)}>→</button>
      <span className="proto-sep" />
      <label>
        身份
        <select value={user.id} onChange={(e) => onUser(e.target.value)}>
          {USERS.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}（{u.orgLabel}{u.admin ? '，管理员' : ''}）
            </option>
          ))}
        </select>
      </label>
      <label>
        <input type="checkbox" checked={plugin} onChange={(e) => onPlugin(e.target.checked)} /> Office 插件
      </label>
      <span className="proto-state">入口：{entryPoints(user).map((n) => n.name).join('、') || '—'}</span>
    </div>
  )
}
