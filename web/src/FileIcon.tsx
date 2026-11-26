import type { components } from './api/schema.gen'
import { formatFileTypeLabel, resolveFileIcon } from './fileIconKind'
import { AppIcon } from './icons/AppIcon'

type Node = components['schemas']['TreeNode']

export function FileIcon({ node, size = 16, tile = false }: { node: Node; size?: number; tile?: boolean }) {
  const { kind, icon } = resolveFileIcon(node)
  const iconSize = tile ? Math.max(size, 28) : size
  return <span aria-hidden="true" className={tile ? 'file-icon icon-tile' : 'file-icon'} data-format={kind}>
    <AppIcon name={icon} size={iconSize} />
  </span>
}

export function fileTypeLabel(node: Node) {
  return formatFileTypeLabel(node)
}

export { formatSize } from './formatSize'
