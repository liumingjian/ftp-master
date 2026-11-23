import { FileArchive, FileImage, FileSpreadsheet, FileText, Folder } from 'lucide-react'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']

export function FileIcon({ node, size = 16, tile = false }: { node: Node; size?: number; tile?: boolean }) {
  const format = node.latestVersion?.format ?? node.name.split('.').at(-1)?.toLowerCase() ?? ''
  const word = ['doc', 'docx', 'wps'].includes(format)
  const sheet = ['xls', 'xlsx', 'csv'].includes(format)
  const image = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(format)
  const archive = ['zip', 'rar', '7z', 'tar', 'gz'].includes(format)
  const kind = !node.isFile ? 'folder' : sheet ? 'sheet' : word ? 'word' : image ? 'image' : archive ? 'archive' : format
  const Icon = !node.isFile ? Folder : sheet ? FileSpreadsheet : image ? FileImage : archive ? FileArchive : FileText
  return <span aria-hidden="true" className={tile ? 'file-icon icon-tile' : 'file-icon'} data-format={kind}>
    <Icon size={size} />
  </span>
}

const typeLabels: Record<string, string> = {
  doc: 'Word 文档', docx: 'Word 文档', wps: 'WPS 文档', xls: 'Excel 表格', xlsx: 'Excel 表格',
  txt: '文本文档', md: 'Markdown 文档', pdf: 'PDF 文档',
}

export function fileTypeLabel(node: Node) {
  if (!node.isFile) return '文件夹'
  const format = node.latestVersion?.format.toLowerCase()
  return format ? typeLabels[format] ?? `${format.toUpperCase()} 文件` : '文件'
}

export function formatSize(bytes: number) {
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)))
  return `${(bytes / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`
}
