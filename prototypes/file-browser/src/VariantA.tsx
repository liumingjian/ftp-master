// PROTOTYPE Variant A: classic two-pane explorer.
// Tree on the left, dense sortable table in the middle, tabbed inspector on the right.
// Bet: users think in folders; power users want density, multi-select and a toolbar.
import { useState } from 'react'
import { Node, RECYCLE_BIN, ROOT } from './data'
import type { VariantProps } from './main'
import { LEVELS, actionsFor, fmtSize, grantSources, icon, kids, level, pathOf, stub, traversable } from './perm'

export function VariantA({ user, plugin }: VariantProps) {
  const [cwd, setCwd] = useState<Node>(ROOT)
  const [open, setOpen] = useState<Set<string>>(new Set([ROOT.id]))
  const [sel, setSel] = useState<Node | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<'info' | 'versions' | 'grants' | 'audit'>('info')
  const [bin, setBin] = useState(false)

  const go = (n: Node) => {
    setCwd(n)
    setSel(null)
    setChecked(new Set())
    setBin(false)
    setOpen((o) => new Set([...o, ...pathOf(n).map((x) => x.id)]))
  }
  const toggle = (n: Node) => setOpen((o) => (o.has(n.id) ? new Set([...o].filter((x) => x !== n.id)) : new Set([...o, n.id])))

  const Tree = ({ n, depth }: { n: Node; depth: number }) => {
    const ch = kids(user, n).filter((c) => c.type === 'dir')
    const trav = n !== ROOT && traversable(user, n)
    return (
      <>
        <div
          className={`a-tree-row ${cwd === n && !bin ? 'active' : ''} ${trav ? 'muted' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => go(n)}
          title={trav ? '仅可经过：只显示通往你有权限内容的路径' : ''}
        >
          <span className="a-caret" onClick={(e) => (e.stopPropagation(), toggle(n))}>
            {ch.length ? (open.has(n.id) ? '▾' : '▸') : ' '}
          </span>
          {n === ROOT ? '🗂️' : trav ? '🚪' : '📁'} {n.name}
        </div>
        {open.has(n.id) && ch.map((c) => <Tree key={c.id} n={c} depth={depth + 1} />)}
      </>
    )
  }

  const rows = kids(user, cwd)
  const cwdActions = actionsFor(user, cwd, plugin)
  const target = sel ?? cwd
  const bulk = [...checked].length

  return (
    <div className="a-shell">
      <header className="a-top">
        <b>ftp-master</b>
        <input className="a-search" placeholder="在当前目录中搜索…" />
        <span className="muted">
          {user.name} · {user.orgLabel}
        </span>
      </header>
      <aside className="a-side">
        <Tree n={ROOT} depth={0} />
        <div className="a-side-foot">
          <div className={`a-tree-row ${bin ? 'active' : ''}`} onClick={() => setBin(true)}>
            🗑️ 回收站
          </div>
        </div>
      </aside>

      <main className="a-main">
        {bin ? (
          <>
            <div className="a-crumbs">回收站</div>
            <table className="a-table">
              <thead>
                <tr><th>名称</th><th>原位置</th><th>删除人</th><th>删除时间</th><th>剩余保留</th><th /></tr>
              </thead>
              <tbody>
                {RECYCLE_BIN.map((r) => (
                  <tr key={r.name}>
                    <td>{r.name}</td><td className="muted">{r.from}</td><td>{r.by}</td><td>{r.at}</td><td>{r.purgeIn}</td>
                    <td><button onClick={() => stub('还原')}>还原</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <>
            <div className="a-crumbs">
              {pathOf(cwd).map((n, i) => (
                <span key={n.id}>
                  {i > 0 && ' / '}
                  <a onClick={() => go(n)} className={n !== ROOT && traversable(user, n) ? 'muted' : ''}>
                    {n.name}
                  </a>
                </span>
              ))}
              <span className="badge">{cwd === ROOT ? '—' : traversable(user, cwd) ? '仅可经过' : LEVELS[level(user, cwd)]}</span>
            </div>
            <div className="a-toolbar">
              {bulk > 0 ? (
                <>
                  <b>已选 {bulk} 项</b>
                  <button onClick={() => stub('批量下载')}>下载</button>
                  <button onClick={() => stub('批量移动')}>移动</button>
                  <button onClick={() => stub('批量删除')}>删除</button>
                  <button onClick={() => setChecked(new Set())}>取消选择</button>
                </>
              ) : (
                cwdActions
                  .filter((a) => ['upload', 'mkdir'].includes(a.key))
                  .map((a) => (
                    <button key={a.key} disabled={!a.ok} onClick={() => stub(a.label, cwd)} title={a.ok ? '' : '需要“编辑”权限'}>
                      {a.label}
                    </button>
                  ))
              )}
            </div>
            {traversable(user, cwd) && cwd !== ROOT && (
              <div className="hint">你在此目录没有权限，这里只显示通往你被授权内容的路径。</div>
            )}
            <table className="a-table">
              <thead>
                <tr><th style={{ width: 24 }} /><th>名称</th><th>大小</th><th>修改时间</th><th>修改人</th><th>我的权限</th></tr>
              </thead>
              <tbody>
                {rows.map((n) => {
                  const trav = traversable(user, n)
                  return (
                    <tr
                      key={n.id}
                      className={sel === n ? 'sel' : ''}
                      onClick={() => setSel(n)}
                      onDoubleClick={() => (n.type === 'dir' ? go(n) : stub('预览', n))}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        {!trav && (
                          <input
                            type="checkbox"
                            checked={checked.has(n.id)}
                            onChange={() => setChecked((c) => (c.has(n.id) ? new Set([...c].filter((x) => x !== n.id)) : new Set([...c, n.id])))}
                          />
                        )}
                      </td>
                      <td className={trav ? 'muted' : ''}>
                        {trav ? '🚪' : icon(n)} {n.name}
                        {n.versions?.[0]?.stale && <span className="badge warn">过期保存</span>}
                      </td>
                      <td>{fmtSize(n.size)}</td>
                      <td>{trav ? '—' : n.modified}</td>
                      <td>{trav ? '—' : n.modifiedBy}</td>
                      <td>{trav ? <span className="muted">仅可经过</span> : LEVELS[level(user, n)]}</td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 40 }}>空目录</td></tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </main>

      <aside className="a-inspector">
        {target === ROOT || bin ? (
          <div className="muted" style={{ padding: 16 }}>选中一个项目查看详情</div>
        ) : traversable(user, target) ? (
          <div className="muted" style={{ padding: 16 }}>“{target.name}”仅可经过，无详情可查看。</div>
        ) : (
          <>
            <div className="a-insp-head">
              <div style={{ fontSize: 32 }}>{icon(target)}</div>
              <b>{target.name}</b>
              <div className="a-insp-actions">
                {actionsFor(user, target, plugin)
                  .filter((a) => a.ok && !['upload', 'mkdir'].includes(a.key))
                  .map((a) => (
                    <button key={a.key} className={a.key === 'office' ? 'primary' : ''} onClick={() => stub(a.label, target)}>
                      {a.label}
                    </button>
                  ))}
              </div>
            </div>
            <div className="tabs">
              {(['info', 'versions', 'grants', 'audit'] as const).map((t) => (
                <a key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  {{ info: '信息', versions: '版本', grants: '授权', audit: '审计' }[t]}
                </a>
              ))}
            </div>
            <div className="a-insp-body">
              {tab === 'info' && (
                <dl>
                  <dt>位置</dt><dd>/{pathOf(target).slice(1, -1).map((n) => n.name).join('/')}</dd>
                  <dt>大小</dt><dd>{fmtSize(target.size)}</dd>
                  <dt>修改</dt><dd>{target.modified} · {target.modifiedBy}</dd>
                  <dt>我的权限</dt><dd>{LEVELS[level(user, target)]}</dd>
                </dl>
              )}
              {tab === 'versions' &&
                (target.versions ? (
                  target.versions.map((v, i) => (
                    <div key={v.v} className="row-item">
                      <b>v{v.v}</b> {i === 0 && <span className="badge">当前</span>}
                      {v.stale && <span className="badge warn">过期保存</span>}
                      <div className="muted">{v.at} · {v.by} · {fmtSize(v.size)}</div>
                      {i > 0 && level(user, target) >= 3 && <button onClick={() => stub(`恢复 v${v.v}`, target)}>恢复</button>}
                    </div>
                  ))
                ) : (
                  <div className="muted">目录没有版本</div>
                ))}
              {tab === 'grants' &&
                grantSources(target).map(({ grant, from }, i) => (
                  <div key={i} className="row-item">
                    {grant.kind === 'user' ? '👤' : grant.kind === 'org' ? '🏢' : '👥'} {grant.label} · <b>{LEVELS[grant.level]}</b>
                    <div className="muted">{from === target ? '直接授权' : `继承自 ${from.name}`}</div>
                  </div>
                ))}
              {tab === 'grants' && level(user, target) >= 4 && <button onClick={() => stub('添加授权', target)}>+ 添加授权</button>}
              {tab === 'audit' &&
                (target.audit ?? []).map((e, i) => (
                  <div key={i} className="row-item">
                    {e.ok ? '✅' : '⛔'} {e.who} {e.what}
                    <div className="muted">{e.at} · {e.ip}</div>
                  </div>
                ))}
            </div>
          </>
        )}
      </aside>
    </div>
  )
}
