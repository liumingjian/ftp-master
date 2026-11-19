// Typed client for the HTTP API. Types come from schema.gen.ts, generated from
// api/openapi.yaml; never edit that file by hand, run `make generate`.
import createClient from 'openapi-fetch'
import type { components, paths } from './schema.gen'

export const api = createClient<paths>({ baseUrl: '/api' })

export type Health = components['schemas']['Health']
