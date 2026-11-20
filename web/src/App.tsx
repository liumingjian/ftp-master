import { SIGN_IN_PATH } from './navigation'
import { SignedInShell } from './SignedInShell'
import { SignInPage } from './SignInPage'

// Every page but sign-in needs a signed-in User; SignedInShell sends anyone
// else to sign-in.
export function App() {
  return window.location.pathname === SIGN_IN_PATH ? <SignInPage /> : <SignedInShell />
}
