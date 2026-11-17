// PROTOTYPE round 6 (D1): one permission page for every level of the Shared Tree.
//
//   Left: the space as a tree; only folders, plus files that carry their own Grants. Dots show where Grants are made.
//   Right: a Confluence-style table for the selected folder or file. Columns are FTP-convention rights
//          (浏览 下载 上传 修改 删除 授权) with a preset picker per row (只读 / 读写 / 完全控制 / 投递箱 …) and a scope
//          per folder Grant (本层及以下 / 仅本层, i.e. Serv-U "inherit" or NTFS "applies to").
//   Inherited rights show as grey locked ticks with their source; you can only add on top (Grants only allow).
//   A file's creator holds every right (a pinned, locked row) and may share it, but only with people who can
//   already see the folder; opening it to anyone new needs 授权 on the folder.
//   Changes are drafted and saved together, with an impact preview (people affected, items covered).
import { ArrowLeft, ChevronRight, Crown, Lock, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'
import { Grant, Node, PEOPLE, ROOT, Right } from './data'
import { Principal, keyOf, members, principalOfGrant, subtree } from './grants'
import { entryPoints, kids, scopePath } from './perm'
import { PRESETS, RHINT, RIGHTS, RL, creatorOf, inheritedFor, presetOf, principalRights, rightsOf, toLevel, toggle, userRights } from './rights'
import { replaceGrants, useStore } from './store'
import { FileIcon, toast } from './ui'
import { GrantProps, PIcon, PrincipalPicker, isUnder, reachNote } from './VariantGrant'

type Draft = Map<string, Grant | null>

export function PermissionManager({ n, user, close, go }: GrantProps) {
  useStore()
  const spaces = user.admin ? kids(user, ROOT).filter((x) => x.type === 'dir') : entryPoints(user).filter((e) => userRights(user, e).has('grant'))
  const [root, setRoot] = useState<Node>(() => spaces.find((s) => s === n || isUnder(n, s)) ?? (n === ROOT ? spaces[0] : n.type === 'file' ? n.parent! : n) ?? ROOT)
  const [sel, setSel] = useState<Node>(n === ROOT ? root : n)
  const [draft, setDraft] = useState<Draft>(new Map())
  const [showInh, setShowInh] = useState(true)
  const [adding, setAdding] = useState<{ p: Principal; rights: Right[]; scope: 'tree' | 'here' } | null>(null)
  const [lockWarn, setLockWarn] = useState(false)

  const mine = userRights(user, sel)
  const can = mine.has('grant')
  const creator = creatorOf(sel)
  const isCreator = creator?.id === user.id
  const widen = user.admin || (sel.parent ? userRights(user, sel.parent).has('grant') : false)
  const isDir = sel.type === 'dir'

  // ----- rows: direct Grants on sel (with draft applied) + principals that only inherit
  const actual = new Map(sel.grants.map((g) => [keyOf(g), g]))
  const cur = (k: string) => (draft.has(k) ? draft.get(k)! : actual.get(k) ?? null)
  const inhKeys = new Map<string, Principal>()
  for (const x of scopePath(sel)) if (x !== sel) for (const g of x.grants) inhKeys.set(keyOf(g), principalOfGrant(g))
  const localKeys = [...new Set([...actual.keys(), ...draft.keys()])]
  const order = (k: string) => (cur(k)?.origin === 'creator' ? 0 : k.startsWith('user') ? 2 : 1)
  localKeys.sort((a, b) => order(a) - order(b))
  const onlyInh = [...inhKeys.keys()].filter((k) => !localKeys.includes(k))
  const pOf = (k: string): Principal => (cur(k) ? principalOfGrant(cur(k)!) : actual.get(k) ? principalOfGrant(actual.get(k)!) : inhKeys.get(k)!)

  const changes = [...draft.entries()].filter(([k, g]) => JSON.stringify(g) !== JSON.stringify(actual.get(k) ?? null))
  const finalGrants = (): Grant[] => [...sel.grants.filter((g) => !draft.has(keyOf(g))), ...[...draft.values()].filter((g): g is Grant => !!g)]

  // impact preview: whose effective rights on sel change, and how much of the tree the change covers
  let impact = { people: 0, dirs: 0, files: 0, selfLoses: false }
  if (changes.length) {
    const act = PEOPLE.filter((u) => !u.inactive)
    const before = act.map((u) => [...userRights(u, sel)].join())
    const keep = sel.grants
    sel.grants = finalGrants()
    const after = act.map((u) => [...userRights(u, sel)].join())
    impact.selfLoses = !user.admin && can && !userRights(user, sel).has('grant')
    sel.grants = keep
    impact.people = before.filter((b, i) => b !== after[i]).length
    const treeWide = changes.some(([k, g]) => (g ?? actual.get(k))?.scope !== 'here')
    const below: Node[] = isDir ? (treeWide ? subtree(sel).slice(1).map((x) => x.node) : (sel.children ?? []).filter((x) => x.type === 'file')) : []
    impact.dirs = below.filter((x) => x.type === 'dir').length
    impact.files = below.filter((x) => x.type === 'file').length
  }

  const setRights = (p: Principal, rights: Right[], scope?: 'tree' | 'here') => {
    const k = keyOf(p)
    const g = cur(k)
    const allowed = rights.filter((r) => mine.has(r))
    if (allowed.length < rights.length) toast(`你自己没有“${rights.filter((r) => !mine.has(r)).map((r) => RL[r]).join('、')}”，不能授予`)
    setDraft((m) => new Map(m).set(k, allowed.length ? { kind: p.kind, id: p.id, label: p.label, rights: allowed, level: toLevel(allowed), scope: scope ?? g?.scope ?? 'tree' } : null))
  }

  const click = (k: string, r: Right) => {
    const g = cur(k)
    const inh = inheritedFor(pOf(k), sel)
    if (!can) return toast('你在这里没有“授权”权限，只能查看')
    if (g?.origin === 'creator') return toast('创建者始终拥有全部权限；如需转交，请联系文件夹管理者')
    if (inh.has(r)) return toast(`“${RL[r]}”继承自“${inh.get(r)!.name}”，只能在那里修改（授权只增不减）`)
    const has = g ? rightsOf(g).includes(r) : false
    setRights(pOf(k), toggle(g ? rightsOf(g) : [], r, !has))
  }

  const pick = (s: Node) => {
    if (s === sel) return
    if (changes.length && !confirm('有未保存的更改，确定离开？')) return
    setDraft(new Map()), setAdding(null), setLockWarn(false), setSel(s)
  }

  const save = (force = false) => {
    if (impact.selfLoses && !force) return setLockWarn(true)
    const undo = replaceGrants(sel, finalGrants(), !!sel.isolated)
    setDraft(new Map()), setLockWarn(false)
    toast(`已保存“${sel.name}”的 ${changes.length} 项更改，影响 ${impact.people} 人`, { label: '撤销', run: undo })
  }

  const outside = (p: Principal) => !widen && !!sel.parent && principalRights(p, sel.parent).size === 0

  // ----- left tree: folders, and files that carry Grants (or are selected)
  const tree = subtree(root).filter(({ node }) => node.type === 'dir' || node === sel || node.grants.some((g) => g.origin !== 'creator'))

  return (
    <div className="g-page d-page">
      <div className="g-page-head">
        <button className="m-btn ghost" onClick={close}><ArrowLeft size={15} /> 返回文件</button>
        <b>权限管理</b>
        <div className="c-pills">
          {spaces.map((s) => (
            <button key={s.id} className={`c-pill ${s === root ? 'on' : ''}`} onClick={() => (changes.length && !confirm('有未保存的更改，确定切换？') ? null : (setRoot(s), setSel(s), setDraft(new Map())))}>
              <FileIcon n={s} size={14} /> {s.name}
            </button>
          ))}
        </div>
      </div>

      <div className="d-grid">
        <div className="d-tree">
          {tree.map(({ node, depth }) => {
            const own = node.grants.filter((g) => g.origin !== 'creator')
            const ppl = own.filter((g) => g.kind === 'user').length
            return (
              <a key={node.id} className={`d-tree-row ${node === sel ? 'on' : ''} ${userRights(user, node).has('grant') ? '' : 'ro'}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => pick(node)}>
                <FileIcon n={node} size={15} />
                <span className="grow m-ellipsis">{node.name}</span>
                {node.grants.some((g) => g.scope === 'here') && <span className="d-mini" title="有“仅本层”授权">层</span>}
                {own.length > 0 && <span className={`d-dot ${ppl >= 10 ? 'warn' : ''}`} title={`${own.length} 条授权${ppl ? `，其中个人 ${ppl} 条` : ''}`}>{own.length}</span>}
                {!userRights(user, node).has('grant') && <Lock size={11} className="m-faint" />}
              </a>
            )
          })}
          <div className="m-faint small d-tree-foot">数字 = 在这一层直接授权的条数；橙色 = 个人授权过多</div>
        </div>

        <div className="d-main">
          <div className="d-head">
            <FileIcon n={sel} size={30} />
            <div className="grow">
              <b>{sel.name}</b>
              <div className="d-chain">
                {scopePath(sel).map((x, i) => (
                  <span key={x.id} className="d-chain-item">
                    {i > 0 && <ChevronRight size={12} />}
                    <a className={x === sel ? 'on' : ''} onClick={() => x !== ROOT && (x === root || isUnder(x, root)) && pick(x)}>
                      {x === ROOT ? '全部文件' : x.name}
                      {x.grants.length > 0 && <sup>{x.grants.length}</sup>}
                    </a>
                  </span>
                ))}
              </div>
            </div>
            <span className="d-you">你在这里：<b>{PRESETS.find((p) => p.key === presetOf(RIGHTS.filter((r) => mine.has(r))))?.label ?? '自定义'}</b></span>
          </div>

          {!can && <div className="g-warn"><Lock size={14} /> 你在这里没有“授权”权限，只能查看。</div>}
          {creator && (
            <div className="d-note">
              <Crown size={14} />
              <span>
                {isCreator ? '你是这个文件的创建者，拥有全部权限。' : `${creator.label} 是创建者，拥有全部权限。`}
                {!widen && isCreator && ' 你可以把它共享给已经能看到“' + sel.parent!.name + '”的人；要开放给其他人，需要文件夹的“授权”权限。'}
              </span>
            </div>
          )}

          {can && (
            <div className="d-add">
              {adding ? (
                <>
                  <PIcon p={adding.p} size={26} />
                  <div className="d-add-who"><b>{adding.p.label}</b><div className="m-faint small">{reachNote(adding.p)}</div></div>
                  <PresetSelect rights={adding.rights} onChange={(rights) => setAdding({ ...adding, rights })} />
                  {isDir && <ScopeSelect value={adding.scope} onChange={(scope) => setAdding({ ...adding, scope })} />}
                  <button className="m-btn sm primary" onClick={() => (setRights(adding.p, adding.rights, adding.scope), setAdding(null))}>加入</button>
                  <button className="m-btn sm ghost" onClick={() => setAdding(null)}>取消</button>
                </>
              ) : (
                <div className="grow">
                  <PrincipalPicker
                    placeholder={widen ? '添加人员、组织或用户组' : '共享给能看到这个文件夹的人'}
                    annotate={(p) => (outside(p) ? <span className="m-tag warn">超出文件夹范围</span> : null)}
                    onPick={(p) => (outside(p) ? toast(`${p.label} 看不到“${sel.parent!.name}”，需要文件夹管理者授权`) : setAdding({ p, rights: ['list', 'read'], scope: 'tree' }))}
                  />
                </div>
              )}
            </div>
          )}
          {adding && isDir && adding.scope === 'tree' && adding.p.kind !== 'user' && members(adding.p).length >= 30 && subtree(sel).length > 8 && (
            <div className="g-warn">
              <TriangleAlert size={14} />
              <span>{adding.p.label}（{members(adding.p).length} 人）会获得下面 {subtree(sel).length - 1} 项的权限，且下层无法收回。只想让他们看到这一层的话，选“仅本层”。</span>
            </div>
          )}

          <table className="d-table">
            <thead>
              <tr>
                <th className="c-left">对象</th>
                <th className="c-left">预设</th>
                {RIGHTS.map((r) => <th key={r} title={RHINT[r]}>{RL[r]}</th>)}
                {isDir && <th>范围</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              <tr className="d-group"><td colSpan={10}>在这里授权 · {localKeys.filter((k) => cur(k)).length}</td></tr>
              {localKeys.map((k) => <RowView key={k} k={k} p={pOf(k)} g={cur(k)} orig={actual.get(k) ?? null} sel={sel} can={can} isDir={isDir} click={click} setRights={setRights} />)}
              {!localKeys.length && <tr><td colSpan={10} className="m-faint d-empty">这里没有单独授权，访问权限全部来自上层。</td></tr>}
              {onlyInh.length > 0 && (
                <tr className="d-group link" onClick={() => setShowInh(!showInh)}>
                  <td colSpan={10}><ChevronRight size={12} style={{ transform: showInh ? 'rotate(90deg)' : '' }} /> 从上层继承 · {onlyInh.length}（灰色带锁，只能在来源处修改）</td>
                </tr>
              )}
              {showInh && onlyInh.map((k) => <RowView key={k} k={k} p={pOf(k)} g={null} orig={null} sel={sel} can={can} isDir={isDir} click={click} setRights={setRights} inhOnly addHere={() => setAdding({ p: pOf(k), rights: [], scope: 'tree' })} />)}
            </tbody>
          </table>
          <div className="m-faint small g-scope"><ShieldCheck size={13} /> 鼠标悬停列名查看含义。勾“授权”会自动勾上全部；取消“浏览”会一并取消依赖它的权限。</div>

          {lockWarn && (
            <div className="g-warn danger">
              <TriangleAlert size={14} /> <span className="grow">保存后你将失去“{sel.name}”的授权权限，无法再改回。</span>
              <button className="m-btn sm" onClick={() => setLockWarn(false)}>返回修改</button>
              <button className="m-btn sm danger" onClick={() => save(true)}>仍然保存</button>
            </div>
          )}
          {changes.length > 0 && (
            <div className="c-savebar">
              <span>有 <b>{changes.length}</b> 项未保存的更改</span>
              <span className="m-faint small">
                影响 {impact.people} 人{isDir ? ` · 作用于下面 ${impact.dirs} 个文件夹、${impact.files} 个文件` : ''}
              </span>
              <div className="grow" />
              <button className="m-btn sm ghost" onClick={() => (setDraft(new Map()), setLockWarn(false))}>放弃</button>
              <button className="m-btn sm primary" onClick={() => save()}>保存</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function RowView({ k, p, g, orig, sel, can, isDir, click, setRights, inhOnly, addHere }: {
  k: string; p: Principal; g: Grant | null; orig: Grant | null; sel: Node; can: boolean; isDir: boolean
  click: (k: string, r: Right) => void; setRights: (p: Principal, rs: Right[], scope?: 'tree' | 'here') => void
  inhOnly?: boolean; addHere?: () => void
}) {
  const inh = inheritedFor(p, sel)
  const rs = g ? rightsOf(g) : []
  const isCreator = g?.origin === 'creator'
  const changed = JSON.stringify(g) !== JSON.stringify(orig)
  const off = PEOPLE.find((u) => p.kind === 'user' && u.id === p.id)?.inactive
  const eff = RIGHTS.filter((r) => rs.includes(r) || inh.has(r))
  const sources = [...new Set(inh.values())]
  return (
    <tr className={`${inhOnly ? 'inh' : ''} ${changed ? 'changed' : ''} ${!g && orig ? 'removed' : ''} ${off ? 'off' : ''}`}>
      <td className="c-left">
        <span className="c-who">
          <PIcon p={p} size={24} />
          <span>
            {p.label}
            {isCreator && <span className="m-tag d-crown"><Crown size={10} /> 创建者</span>}
            {off && <span className="m-tag warn">已停用</span>}
            {changed && <span className="m-tag">{!orig ? '新增' : !g ? '将移除' : '已修改'}</span>}
            <div className="m-faint small">
              {p.kind === 'user' ? reachNote(p) : `${members(p).length} 人`}
              {sources.length > 0 && ` · 继承自 ${sources.map((s) => s.name).join('、')}`}
            </div>
          </span>
        </span>
      </td>
      <td className="c-left">
        {inhOnly ? (
          <span className="m-faint small">{PRESETS.find((x) => x.key === presetOf(eff))?.label ?? '自定义'}</span>
        ) : isCreator ? (
          <span className="m-faint small">完全控制</span>
        ) : (
          <PresetSelect rights={rs} disabled={!can} onChange={(r) => setRights(p, r)} />
        )}
      </td>
      {RIGHTS.map((r) => {
        const st = isCreator ? 'creator' : inh.has(r) ? 'inh' : rs.includes(r) ? 'on' : 'off'
        return (
          <td key={r}>
            <span className={`d-box ${st} ${can && st !== 'inh' && st !== 'creator' ? 'can' : ''}`} title={st === 'inh' ? `继承自“${inh.get(r)!.name}”` : RHINT[r]} onClick={() => click(k, r)}>
              {st === 'inh' || st === 'creator' ? <Lock size={10} /> : st === 'on' ? '✓' : ''}
            </span>
          </td>
        )
      })}
      {isDir && (
        <td>
          {g && !isCreator ? <ScopeSelect value={g.scope ?? 'tree'} disabled={!can} onChange={(s) => setRights(p, rs, s)} /> : <span className="m-faint small">—</span>}
        </td>
      )}
      <td>
        {inhOnly ? (
          can && <button className="m-btn sm ghost" onClick={addHere}>在此追加</button>
        ) : (
          can && g && !isCreator && <button className="m-btn icon sm ghost" title="移除这里的授权" onClick={() => setRights(p, [])}><X size={14} /></button>
        )}
      </td>
    </tr>
  )
}

function PresetSelect({ rights, onChange, disabled }: { rights: Right[]; onChange: (r: Right[]) => void; disabled?: boolean }) {
  const v = presetOf(rights)
  return (
    <select className="g-select d-preset" value={v} disabled={disabled} onChange={(e) => onChange(PRESETS.find((p) => p.key === e.target.value)?.rights ?? [])}>
      {v === 'none' && <option value="none">— 选择 —</option>}
      {PRESETS.map((p) => <option key={p.key} value={p.key} title={p.hint}>{p.label}</option>)}
      {v === 'custom' && <option value="custom">自定义</option>}
    </select>
  )
}

function ScopeSelect({ value, onChange, disabled }: { value: 'tree' | 'here'; onChange: (s: 'tree' | 'here') => void; disabled?: boolean }) {
  return (
    <select className="g-select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as 'tree' | 'here')}>
      <option value="tree">本层及以下</option>
      <option value="here">仅本层</option>
    </select>
  )
}
