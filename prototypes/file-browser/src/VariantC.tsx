// PROTOTYPE Variant C: entry points and search first, file as a page.
// The home screen is not the Shared Tree root but "where can I go": the User's Grant entry points,
// recent changes they can see, and one big search box across everything visible.
// Traversable Ancestors are collapsed away entirely; a file opens as its own full page.
// Bet: most Users hold a few deep Grants and never want to walk from the root.
import { useMemo, useState } from 'react'
import { Node, ROOT } from './data'
import type { VariantProps } from './main'
import { LEVELS, actionsFor, allVisible, entryPoints, fmtSize, icon, kids, level, pathOf, stub, traversable } from './perm'

type View = { kind: 'home' } | { kind: 'dir'; n: Node } | { kind: 'file'; n: Node }

export function VariantC({ user, plugin }: VariantProps) {
  const [view, setView] = useState<View>({ kind: 'home' })
  const [q, setQ] = useState('')
  const open = (n: Node) => (setQ(''), setView({ kind: n.type, n } as View))
  const everything = useMemo(() => allVisible(user).filter((n) => !traversable(user, n)), [user])
  const hits = q ? everything.filter((n) => n.name.toLowerCase().includes(q.toLowerCase())) : []
  const recent = everything
    .filter((n) => n.type === 'file')
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, 6)

  return (
    <div className="c-shell">
      <header className="c-top">
        <a className="c-logo" onClick={() => (setQ(''), setView({ kind: 'home' }))}>
          ftp-master
        </a>
        <div className="c-search-wrap">
          <input className="c-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索你能访问的所有文件和文件夹" />
          {q && (
            <div className="c-results">
              {hits.length === 0 && <div className="muted" style={{ padding: 12 }}>没有匹配项</div>}
              {hits.map((n) => (
                <div key={n.id} className="c-hit" onClick={() => open(n)}>
                  {icon(n)} <b>{n.name}</b>
                  <div className="muted small">{shortPath(user, n)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <span className="muted">{user.name}</span>
      </header>

      <div className="c-body">
        {view.kind === 'home' && (
          <>
            <h2>你可以访问</h2>
            <div className="c-entries">
              {entryPoints(user).map((n) => (
                <div key={n.id} className="c-entry" onClick={() => open(n)}>
                  <div className="c-entry-name">📁 {n.name}</div>
                  <div className="muted small">{shortPath(user, n) || '顶层目录'}</div>
                  <span className="badge">{LEVELS[level(user, n)]}</span>
                </div>
              ))}
            </div>
            <h2>最近变更</h2>
            <ul className="c-feed">
              {recent.map((n) => (
                <li key={n.id} onClick={() => open(n)}>
                  <span className="c-feed-time">{n.modified.slice(5)}</span>
                  <span>
                    <b>{n.modifiedBy}</b> {n.versions && n.versions.length > 1 ? `保存了 v${n.versions[0].v}` : '上传了'} {icon(n)} {n.name}
                    {n.versions?.[0]?.stale && <span className="badge warn">过期保存</span>}
                  </span>
                  <span className="muted small">{shortPath(user, n)}</span>
                </li>
              ))}
            </ul>
            <a className="muted small" onClick={() => stub('打开回收站')}>🗑️ 回收站</a>
          </>
        )}

        {view.kind === 'dir' && <DirPage n={view.n} user={user} plugin={plugin} open={open} />}
        {view.kind === 'file' && <FilePage n={view.n} user={user} plugin={plugin} open={open} />}
      </div>
    </div>
  )
}

/** Path with Traversable Ancestors collapsed to "…"; starts at the nearest entry point. */
function shortPath(user: VariantProps['user'], n: Node) {
  const parts = pathOf(n).slice(1, -1)
  const start = parts.findIndex((p) => !traversable(user, p))
  if (start < 0) return parts.length ? '…' : ''
  return (start > 0 ? '… / ' : '') + parts.slice(start).map((p) => p.name).join(' / ')
}

function Crumbs({ n, user, open }: { n: Node; user: VariantProps['user']; open: (n: Node) => void }) {
  const parts = pathOf(n).filter((p) => p !== ROOT && !traversable(user, p))
  return (
    <div className="c-crumbs">
      {parts.length < pathOf(n).length - 1 && <span className="muted" title="你无权访问的上级目录已折叠">… / </span>}
      {parts.map((p, i) => (
        <span key={p.id}>
          {i > 0 && ' / '}
          <a onClick={() => open(p)}>{p.name}</a>
        </span>
      ))}
    </div>
  )
}

type PageProps = VariantProps & { n: Node; open: (n: Node) => void }

function DirPage({ n, user, plugin, open }: PageProps) {
  const items = kids(user, n)
  const acts = actionsFor(user, n, plugin).filter((a) => a.ok && a.key !== 'preview')
  return (
    <>
      <Crumbs n={n} user={user} open={open} />
      <div className="c-dir-head">
        <h1>{n.name}</h1>
        <span className="badge">{LEVELS[level(user, n)]}</span>
        <span style={{ flex: 1 }} />
        {acts.map((a) => (
          <button key={a.key} className={a.key === 'upload' ? 'primary' : ''} onClick={() => stub(a.label, n)}>
            {a.label}
          </button>
        ))}
      </div>
      <ul className="c-list">
        {items.map((c) => (
          <li key={c.id} onClick={() => open(c)}>
            <span className="c-list-icon">{icon(c)}</span>
            <span className="c-list-main">
              <b>{c.name}</b>
              <span className="muted small">
                {c.type === 'dir' ? `${kids(user, c).length} 项` : fmtSize(c.size)} · {c.modifiedBy} 于 {c.modified}
              </span>
            </span>
            {c.versions?.[0]?.stale && <span className="badge warn">过期保存</span>}
            <span className="muted">›</span>
          </li>
        ))}
        {items.length === 0 && <li className="muted">空目录</li>}
      </ul>
    </>
  )
}

function FilePage({ n, user, plugin, open }: PageProps) {
  const acts = actionsFor(user, n, plugin).filter((a) => a.ok && a.key !== 'preview')
  const primary = acts.find((a) => a.key === 'office') ?? acts.find((a) => a.key === 'download')
  return (
    <>
      <Crumbs n={n} user={user} open={open} />
      <div className="c-file">
        <div className="c-file-preview" onClick={() => stub('预览', n)}>
          <div style={{ fontSize: 96 }}>{icon(n)}</div>
          <div className="muted">文档预览区</div>
        </div>
        <div className="c-file-side">
          <h1>{n.name}</h1>
          <div className="muted">
            {fmtSize(n.size)} · 你的权限：{LEVELS[level(user, n)]}
          </div>
          {primary && (
            <button className="primary big" onClick={() => stub(primary.label, n)}>
              {primary.label}
            </button>
          )}
          <div className="c-more">
            {acts
              .filter((a) => a !== primary)
              .map((a) => (
                <a key={a.key} onClick={() => stub(a.label, n)}>
                  {a.label}
                </a>
              ))}
          </div>
          <h3>动态</h3>
          <ul className="c-activity">
            {(n.audit ?? []).map((e, i) => (
              <li key={i} className={e.ok ? '' : 'fail'}>
                <b>{e.who}</b> {e.what}
                {!e.ok && ' （被拒绝）'}
                <div className="muted small">{e.at}</div>
              </li>
            ))}
          </ul>
          <h3>历史版本</h3>
          {(n.versions ?? []).map((v, i) => (
            <div key={v.v} className="c-ver">
              v{v.v} · {v.by} · {v.at.slice(5)} {i === 0 && <span className="badge">当前</span>}
              {v.stale && <span className="badge warn">过期保存</span>}
              {i > 0 && level(user, n) >= 3 && <a onClick={() => stub(`恢复 v${v.v}`, n)}> 恢复</a>}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
