// PROTOTYPE shared presentational bits for the modern variants (icons, toasts, smart default action).
// Layouts are deliberately NOT shared; each variant owns its own.
import { Folder, FolderLock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Node, User } from './data'
import { ext, level, officeEditable } from './perm'

const TYPE: Record<string, [string, string]> = {
  doc: ['W', '#2b6af3'], docx: ['W', '#2b6af3'], wps: ['W', '#2b6af3'],
  xls: ['X', '#1f9d55'], xlsx: ['X', '#1f9d55'],
  pptx: ['P', '#e8590c'], pdf: ['PDF', '#e03131'],
  png: ['IMG', '#7048e8'], jpg: ['IMG', '#7048e8'],
  zip: ['ZIP', '#868e96'], gz: ['TGZ', '#868e96'], md: ['MD', '#495057'],
}

export function FileIcon({ n, size = 20, traverse = false }: { n: Node; size?: number; traverse?: boolean }) {
  if (n.type === 'dir')
    return traverse ? <FolderLock size={size} color="#adb5bd" /> : <Folder size={size} fill="#ffd43b" color="#f59f00" strokeWidth={1.5} />
  const [label, color] = TYPE[ext(n)] ?? ['FILE', '#868e96']
  return (
    <span className="ficon" style={{ width: size, height: size, background: color, fontSize: size * (label.length > 1 ? 0.3 : 0.5) }}>
      {label}
    </span>
  )
}

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size >= 26 ? size * 0.36 : size * 0.48, background: `hsl(${hue} 60% 52%)` }} title={name}>
      {name.slice(size >= 26 ? -2 : -1)}
    </span>
  )
}

export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>
}

/** The single most likely thing a User wants to do with an item: one click, no menu. */
export function primaryAction(u: User, n: Node, plugin: boolean): { key: string; label: string } {
  if (n.type === 'dir') return { key: 'open', label: '打开' }
  if (officeEditable(u, n, plugin)) return { key: 'office', label: '编辑' }
  if (level(u, n) >= 2 && ['zip', 'gz'].includes(ext(n))) return { key: 'download', label: '下载' }
  return { key: 'preview', label: '预览' }
}

// ---- toasts with undo ----
type Toast = { id: number; msg: string; action?: { label: string; run: () => void } }
let toasts: Toast[] = []
let tid = 0
const subs = new Set<() => void>()
export function toast(msg: string, action?: Toast['action']) {
  const t = { id: tid++, msg, action }
  toasts = [...toasts, t]
  subs.forEach((f) => f())
  setTimeout(() => {
    toasts = toasts.filter((x) => x !== t)
    subs.forEach((f) => f())
  }, 6000)
}
export function Toaster() {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick((x) => x + 1)
    subs.add(f)
    return () => void subs.delete(f)
  }, [])
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.msg}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run()
                toasts = toasts.filter((x) => x !== t)
                subs.forEach((f) => f())
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** A fake rendered document, so previews look like previews. */
export function FakeDoc({ n }: { n: Node }) {
  const e = ext(n)
  if (['xls', 'xlsx'].includes(e))
    return (
      <div className="fake-sheet">
        {Array.from({ length: 12 }, (_, r) => (
          <div key={r} className="fs-row">
            {Array.from({ length: 6 }, (_, c) => (
              <span key={c} className={r === 0 ? 'fs-h' : ''}>{r === 0 ? 'ABCDEF'[c] : c === 0 ? r : ((r * 37 + c * 91) % 1000).toLocaleString()}</span>
            ))}
          </div>
        ))}
      </div>
    )
  if (['png', 'jpg'].includes(e)) return <div className="fake-img" />
  return (
    <div className="fake-page">
      <div className="fp-title">{n.name.replace(/\.[^.]+$/, '')}</div>
      {[92, 100, 96, 60, 0, 100, 88, 97, 40, 0, 94, 100, 70].map((w, i) => (
        <div key={i} className="fp-line" style={{ width: `${w}%`, opacity: w ? 1 : 0 }} />
      ))}
    </div>
  )
}
