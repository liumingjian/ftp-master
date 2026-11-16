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
