// Local fixture middleware for the file details prototype.
import type { Plugin } from 'vite'
import { reportSource, sampleFileId, sampleFolderId, sampleNodes } from '../src/fileDetailsPrototype.fixture'

export function fileDetailsPrototype(): Plugin {
  return {
    name: 'file-details-prototype-fixtures',
    configureServer(server) {
      server.middlewares.use('/api', (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        function json(data: unknown, status = 200) {
          response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify(data))
        }
        if (request.method !== 'GET') return json({ message: '原型使用只读样例' }, 405)
        if (url.pathname === '/session') {
          return json({ id: 1, username: '林若宁', displayName: '林若宁', organizationId: 1, isAdministrator: false })
        }
        if (url.pathname === '/tree') {
          return json(sampleNodes.filter(node => node.parentId === (Number(url.searchParams.get('parentId')) || undefined)))
        }
        if (url.pathname === '/tree/search') {
          const query = url.searchParams.get('q') ?? ''
          return json(sampleNodes.filter(node => node.name.includes(query)).map(node => ({
            ...node, parentPath: node.parentId === sampleFolderId ? '/项目交付/华东区域/月度简报' : undefined,
            canMoveFromParent: node.parentId === sampleFolderId,
          })))
        }
        if (url.pathname === '/recycle-bin') return json([])

        const match = /^\/tree\/(\d+)(?:\/([\w-]+))?$/.exec(url.pathname)
        const node = match && sampleNodes.find(item => item.id === Number(match[1]))
        if (!node) return json({}, 404)
        const endpoint = match[2]
        if (!endpoint) return json(node)
        if (endpoint === 'grant-draft') return json([{
          sourceId: node.id, sourcePath: '/项目交付/华东区域/月度简报/' + node.name, inherited: false,
          grant: { id: 1, principalId: 1, principalKind: 'user', rights: node.rights, scope: 'this_level_only' },
        }])
        if (endpoint === 'permission') return json({
          userId: 1, rights: node.rights, traversable: false, administrator: false, sources: [{
            sourceId: node.id, sourcePath: '/项目交付/华东区域/月度简报/' + node.name, inherited: false,
            grant: { id: 1, principalId: 1, principalKind: 'user', rights: node.rights, scope: 'this_level_only' },
          }],
        })
        const version = node.latestVersion
        if (endpoint === 'versions' && version) return json([
          { ...version, createdBy: 1 },
          { ...version, id: version.id - 1, createdBy: 2, username: '陈嘉言', createdAt: '2026-11-20T06:35:00Z' },
        ])
        const content = node.id === sampleFileId ? reportSource : node.name
        if (endpoint === 'text' && version) return json({ content, versionId: version.id })
        if (endpoint === 'preview' || endpoint === 'download') {
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          return response.end(content)
        }
        json({}, 404)
      })
    },
  }
}
