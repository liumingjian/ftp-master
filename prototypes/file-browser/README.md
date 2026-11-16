# PROTOTYPE — file browser UI variants (throwaway)

Question: what should the file browser over the Shared Tree look like?

Round 1 compared three layouts (A explorer, B columns, C entry/search first); A's layout won.
Round 2 varied A's interaction model (A1 hover-to-act, A2 keyboard, A3 proactive, A4 preview); A1 won.
Round 3 keeps A1 and asks how it should move and feel. Folders the User can only pass through
(Traversable Ancestors) are no longer shown; permitted items beneath them are hoisted up with a path hint.

- `A1` round 2 winner, as a baseline
- `M1` spring: physical springs, directional navigation, staggered rows, deletes fly into the bin
- `M2` calm: fast fades, cursor spotlight, skeletons and a top progress bar, nothing bounces
- `M3` glass: frosted panels over an ambient gradient, depth transitions, tilting cards, floating inspector

Shared in M1–M3: hover peek, lasso / shift-click / ⌘A selection, spring-loaded folders while dragging,
drag onto the bin to delete, stacked drag ghost, upload button that becomes a progress ring, animated
sorting, dark mode with a circular reveal, prefers-reduced-motion respected.

Earlier variants are in this branch's git history.

Switch via `?variant=`, the floating bottom bar, or ← →. The bar also switches the signed-in User (`?user=`)
and whether the Office Plugin is present (`?plugin=1`).

Data is in memory (`src/data.ts`, mutated by `src/store.ts`); reload to reset. Open/edit/download are stubs.

    pnpm install && pnpm dev
