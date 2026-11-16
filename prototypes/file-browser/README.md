# PROTOTYPE — file browser UI variants (throwaway)

Question: what should the file browser over the Shared Tree look like?
Three structurally different variants, switchable via `?variant=A|B|C` and the floating bottom bar.
The bar also switches the signed-in User (`?user=`) and whether the Office Plugin is present (`?plugin=1`),
so Effective Permissions and Traversable Ancestors can be judged in each variant.

All data is in-memory mock data (`src/data.ts`); every action is a stub. Not production code.

    pnpm install && pnpm dev
