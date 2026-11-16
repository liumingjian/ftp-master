# PROTOTYPE — file browser UI variants (throwaway)

Question: what should the file browser over the Shared Tree look like?

Round 1 compared three layouts (A explorer, B columns, C entry/search first); A's layout won.
Round 2 keeps A's skeleton (tree / table / details) and varies the interaction model:

- `A`  original, as a baseline
- `A1` hover to act: row actions on hover, drop files anywhere to upload, drag rows onto folders to move, undo instead of confirm
- `A2` keyboard and command palette: ⌘K runs anything, keyboard cursor, details follow the cursor, dark theme
- `A3` proactive: entry-point sidebar, attention cards with one-click fixes, smart primary button per row, filter chips, inline granting
- `A4` see before you open: single click previews, version slider with restore, folder summaries, sibling jump from the path bar

Switch via `?variant=`, the floating bottom bar, or ← →. The bar also switches the signed-in User (`?user=`)
and whether the Office Plugin is present (`?plugin=1`).

Data is in memory (`src/data.ts`, mutated by `src/store.ts`); reload to reset. Open/edit/download are stubs.

    pnpm install && pnpm dev
