// PROTOTYPE Variant B: column view (Miller columns) with a large preview pane.
// No tree, no table: every level of the path stays visible side by side, and the
// rightmost pane is a file "card" with preview, actions and version timeline.
// Bet: the Shared Tree is deep and permissions are path-shaped, so keeping the whole path
// on screen makes Traversable Ancestors and inheritance obvious.
import { useState } from 'react'
import { Node, ROOT } from './data'
import type { VariantProps } from './main'
import { LEVELS, actionsFor, fmtSize, grantSources, icon, kids, level, stub, traversable } from './perm'

export function VariantB({ user, plugin }: VariantProps) {
  // path[0] is ROOT; each subsequent entry is the selection in the previous column.
  const [path, setPath] = useState<Node[]>([ROOT])
  const pick = (col: number, n: Node) => setPath([...path.slice(0, col + 1), n])
  const last = path[path.length - 1]
  const dirs = path.filter((n) => n.type === 'dir')

  return (
    <div className="b-shell">
      <header className="b-top">
        <span className="b-logo">ftp-master</span>
        <div className="b-pathbar">
          {path.map((n, i) => (
            <span key={n.id}>
              {i > 0 && <span className="muted"> › </span>}
              <a onClick={() => setPath(path.slice(0, i + 1))} className={n !== ROOT && traversable(user, n) ? 'muted' : ''}>
                {n === ROOT ? '🗂️' : traversable(user, n) ? '🚪' : ''} {n.name}
              </a>
            </span>
          ))}
        </div>
        <input className="b-search" placeholder="⌘K 跳转到…" />
        <span className="b-avatar" title={user.orgLabel}>{user.name.slice(0, 1)}</span>
      </header>

      <div className="b-columns">
        {dirs.map((dir, col) => {
          const items = kids(user, dir)
          const canWrite = dir !== ROOT && level(user, dir) >= 3
          return (
            <section key={dir.id} className="b-col">
              <div className="b-col-head">
                {dir.name}
                <span className="muted">{dir === ROOT ? '' : traversable(user, dir) ? '仅可经过' : LEVELS[level(user, dir)]}</span>
              </div>
              {items.map((n) => {
                const trav = traversable(user, n)
                const on = path[col + 1] === n
                return (
                  <div key={n.id} className={`b-item ${on ? 'on' : ''} ${trav ? 'muted' : ''}`} onClick={() => pick(col, n)}>
                    <span>{trav ? '🚪' : icon(n)}</span>
                    <span className="b-name">{n.name}</span>
                    {n.versions?.[0]?.stale && <span className="dot warn" title="最近一次为过期保存" />}
                    {n.type === 'dir' && <span className="muted">›</span>}
                  </div>
                )
              })}
              {items.length === 0 && <div className="muted" style={{ padding: 12 }}>空</div>}
              {canWrite && (
                <div className="b-drop" onClick={() => stub('上传到', dir)}>
                  ⬆ 拖放文件到此列上传
                  <br />
                  <a onClick={(e) => (e.stopPropagation(), stub('新建文件夹', dir))}>+ 新建文件夹</a>
                </div>
              )}
            </section>
          )
        })}

        {last.type === 'file' && <Preview n={last} {...{ user, plugin }} />}
        {last.type === 'dir' && last !== ROOT && traversable(user, last) && (
          <section className="b-preview muted">
            <div style={{ fontSize: 48 }}>🚪</div>
            <p>你在“{last.name}”没有权限。</p>
            <p>这里只列出通往你被授权内容的路径。</p>
          </section>
        )}
      </div>
    </div>
  )
}

function Preview({ n, user, plugin }: { n: Node } & VariantProps) {
  const acts = actionsFor(user, n, plugin).filter((a) => a.ok && a.key !== 'preview')
  const office = acts.find((a) => a.key === 'office')
  return (
    <section className="b-preview">
      <div className="b-thumb" onClick={() => stub('全屏预览', n)}>
        <div style={{ fontSize: 64 }}>{icon(n)}</div>
        <div className="muted">点击全屏预览</div>
      </div>
      <h2>{n.name}</h2>
      <div className="muted">
        {fmtSize(n.size)} · {n.modified} · {n.modifiedBy}
      </div>
      <div className="b-actions">
        {office && (
          <button className="primary big" onClick={() => stub(office.label, n)}>
            ✏️ {office.label}
          </button>
        )}
        {!office && level(user, n) >= 3 && ['docx', 'xlsx', 'doc', 'xls', 'wps'].some((e) => n.name.endsWith(e)) && (
          <div className="hint">{n.size > 25 * 1024 * 1024 ? '文件超过 25 MB，无法在线编辑' : '需要在奇安信浏览器中安装 Office 插件才能编辑'}</div>
        )}
        {acts
          .filter((a) => a.key !== 'office')
          .map((a) => (
            <button key={a.key} onClick={() => stub(a.label, n)}>
              {a.label}
            </button>
          ))}
      </div>

      <h3>版本</h3>
      <ol className="b-timeline">
        {(n.versions ?? []).map((v, i) => (
          <li key={v.v} className={v.stale ? 'warn' : ''}>
            <b>v{v.v}</b> {v.by} · {v.at}
            {v.stale && <div className="warn-text">⚠ 过期保存：编辑起点不是最新版本，可能覆盖了 v{v.v - 1} 的修改</div>}
            {i > 0 && level(user, n) >= 3 && <a onClick={() => stub(`恢复 v${v.v}`, n)}> 恢复</a>}
          </li>
        ))}
      </ol>

      <h3>谁能访问</h3>
      <div className="b-chips">
        {grantSources(n).map(({ grant, from }, i) => (
          <span key={i} className="chip" title={`继承自 ${from.name}`}>
            {grant.label} · {LEVELS[grant.level]}
          </span>
        ))}
        <span className="chip ghost">你：{LEVELS[level(user, n)]}</span>
      </div>
    </section>
  )
}
