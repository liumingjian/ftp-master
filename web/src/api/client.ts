// Typed client for the HTTP API. Types come from schema.gen.ts, generated from
// api/openapi.yaml; never edit that file by hand, run `make generate`.
import createClient from 'openapi-fetch'
import { redirectToSignIn } from '../navigation'
import type { components, paths } from './schema.gen'

// Where the API is mounted: the contract's server URL.
const baseUrl = '/api'
const sessionPath: keyof paths = '/session'

export const api = createClient<paths>({ baseUrl })

// Any request refused for want of a session means the session is gone (never
// started, idle-expired or signed out elsewhere): go to sign-in. A refused
// sign-in is the sign-in page's own business.
api.use({
  onResponse({ request, response }) {
    const isSignIn = request.method === 'POST' && new URL(request.url).pathname === baseUrl + sessionPath
    if (response.status === 401 && !isSignIn) redirectToSignIn()
  },
})

export type Health = components['schemas']['Health']
export type CurrentUser = components['schemas']['CurrentUser']
