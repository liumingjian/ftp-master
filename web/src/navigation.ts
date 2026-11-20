// Page-level navigation. Pages are whole documents: moving between signed-in
// and signed-out pages reloads, so no state from one session survives into the next.

export const SIGN_IN_PATH = '/sign-in'

/** Leaves for the sign-in page, remembering where to come back to. */
export function redirectToSignIn() {
  if (window.location.pathname === SIGN_IN_PATH) return
  const here = window.location.pathname + window.location.search + window.location.hash
  window.location.replace(`${SIGN_IN_PATH}?next=${encodeURIComponent(here)}`)
}

/**
 * Where to go after signing in: the `next` parameter if it is a path on this
 * site, otherwise the home page. Anything else could send a freshly signed-in
 * User to another site.
 */
export function pathAfterSignIn(search: string): string {
  const next = new URLSearchParams(search).get('next')
  const local = next !== null && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
  if (!local || next.startsWith(SIGN_IN_PATH)) return '/'
  return next
}
