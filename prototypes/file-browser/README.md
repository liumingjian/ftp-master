# PROTOTYPE — file browser UI variants (throwaway)

Question: what should the file browser over the Shared Tree look like?

Round 1 compared three layouts (A explorer, B columns, C entry/search first); A's layout won.
Round 2 varied A's interaction model (A1 hover-to-act, A2 keyboard, A3 proactive, A4 preview); A1 won.
Round 3 keeps A1 and asks how it should move and feel. Folders the User can only pass through
(Traversable Ancestors) are no longer shown; permitted items beneath them are hoisted up with a path hint.

- `F`  **round 3 pick**: M2's calm motion, plus M1's delete-flies-into-the-bin
- `A1` round 2 winner, as a baseline
- `M1` spring: physical springs, directional navigation, staggered rows, deletes fly into the bin
- `M2` calm: fast fades, cursor spotlight, skeletons and a top progress bar, nothing bounces
- `M3` glass: frosted panels over an ambient gradient, depth transitions, tilting cards, floating inspector

Shared in M1–M3: hover peek, lasso / shift-click / ⌘A selection, spring-loaded folders while dragging,
drag onto the bin to delete, stacked drag ghost, upload button that becomes a progress ring, animated
sorting, dark mode with a circular reveal, prefers-reduced-motion respected.

Verdict of round 3: M2 as the base, borrowing only M1's fly-to-bin delete. That is variant `F`.

Earlier variants are in this branch's git history.

Round 4 keeps F and asks: what should making and explaining Grants look like? (spec #1, stories 30–38)

- `P1` **共享弹窗**: item-centric modal. Add a person/Organization/User Group with a level; direct Grants editable,
  inherited ones grouped by source with a link to go change them there; "N more specific Grants inside"; check anyone's permission.
- `P2` **侧栏刻度条**: inside the inspector. One 4-step bar per principal; inherited levels are a grey locked floor,
  direct Grants fill above it; click a step to set, click again to revoke. "Why can I…" card on top.
- `P3` **权限矩阵**: a page (sidebar "权限总览"). Folders × principals over a subtree; solid = direct, faint = inherited,
  a small struck tag = a direct Grant that does nothing. Hover explains, click edits.
- `P4` **以人为中心**: a page (sidebar "按人查看权限"). Pick a person/Organization/User Group, see every folder they
  reach, from where and why, and grant from there. Only shows what the acting User can see.

Shared rules the UIs must make visible: no deny, so a direct Grant at or below the inherited level has no effect;
inherited Grants change only at their source; Manage holders grant only within their scope; changing a Grant that would
remove your own Manage asks first; deactivated Users keep inert Grants. Logic in `src/grants.ts`; changes apply at once
with an undo toast. Good identities to try: 张三 (Manage on 研发部 only), 王管理 (Administrator), 赵六 (no Manage).

Switch via `?variant=`, the floating bottom bar, or ← →. The bar also switches the signed-in User (`?user=`)
and whether the Office Plugin is present (`?plugin=1`).

Data is in memory (`src/data.ts`, mutated by `src/store.ts`); reload to reset. Open/edit/download are stubs.

    pnpm install && pnpm dev

Round 5 asks the same question at real scale (~200 people, 13 Organizations, 5 User Groups, one folder with 23 stray
individual Grants under 研发部/后端组/发布包), borrowing from Confluence's permission management:

- `C1` **空间权限表** (Confluence Space permissions): top-level folders are spaces; principals × levels checkbox table,
  tabs 组织与用户组 / 个人 / 子文件夹例外, filter, paging, bulk set, and edit-then-"保存全部" (batched, not instant).
- `C2` **访问限制弹窗** (Confluence Restrictions): 沿用上级 / 在上级基础上追加 / 仅限指定的人, with an impact preview
  ("保存后 N 人失去访问"). The third mode stops inheritance, which contradicts "Grants only ever allow" and is out of
  spec scope; it is here to decide whether that is worth changing. Implemented via `Node.isolated` + `scopePath()`.
- `C3` **权限检查** (Confluence Inspect permissions): person + location → verdict, capability checklist, identity chain ×
  folder chain; reverse tab "谁能访问这里" with counts per level and people grouped by the Grant that gives them access.
- `C4` **用户组优先** (Confluence's "grant to groups"): inspector shows group cards with reach, folds individual Grants away,
  warns when they pile up, merges them into a new User Group in one click, and nudges toward a group when picking a person.

The principal picker now caps results per kind and asks you to keep typing, since 200 rows is not browsable.

Round 6 (`D1`, default) takes C1's table to every level and swaps the four levels for FTP-convention rights:

- Left tree of the space (folders, plus files carrying Grants; badges = Grants made there, orange = many individual),
  right a C1-style table for the selected folder or file, drafted and saved together with an impact preview.
- Columns 浏览 / 下载 / 上传 / 修改 / 删除 / 授权 (Serv-U, FileZilla Server and NTFS split rights this way), with a
  preset per row: 仅浏览, 只读, 读写, 读写删, 完全控制, 投递箱. Dependencies are kept coherent (授权 ⇒ all; no 浏览 ⇒ no
  下载/修改/删除). You can only hand out rights you hold.
- Scope per folder Grant: 本层及以下 / 仅本层 (Serv-U "inherit", NTFS "applies to"); granting a big Organization
  tree-wide over a large subtree warns and suggests 仅本层. Still no deny: inherited rights are grey and locked.
- A file's creator gets a pinned, locked "创建者" row with every right (an automatic Grant, `origin: 'creator'`).
  Without 授权 on the folder, a creator can share only with people who can already see the folder.
- Try: 王管理 on 研发部/后端组/发布包; 张三 on 项目/2026-智慧园区/合同/付款计划.xlsx (⋯ → 授权), search 赵六;
  公共资料/资料投递 is a 投递箱 for 全公司 at 仅本层.
