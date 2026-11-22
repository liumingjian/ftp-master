import { api } from './api/client'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']

export async function loadAncestors(node: Node, signal: AbortSignal) {
  const ancestors: Node[] = []
  let id = node.parentId
  while (id !== undefined) {
    const { data } = await api.GET('/tree/{id}', { params: { path: { id } }, signal })
    if (!data) break
    ancestors.unshift(data)
    id = data.parentId
  }
  return ancestors
}

export async function loadBranches(path: Node[], signal: AbortSignal, { includeGrantCounts }: { includeGrantCounts?: boolean } = {}) {
  const entries = await Promise.all([0, ...path.filter(node => !node.isFile).map(node => node.id)].map(async id => {
    const { data, response } = await api.GET('/tree', {
      params: { query: { parentId: id || undefined, includeGrantCounts } }, signal,
    })
    if (!response.ok) throw Error(`HTTP ${response.status}`)
    return [id, data ?? []] as const
  }))
  return Object.fromEntries(entries)
}
