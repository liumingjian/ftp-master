const BROWSE = 1
const UPLOAD = 4

export type FileIconName =
  | 'file-folder'
  | 'file-folder-dropbox'
  | 'file-folder-traversable'
  | 'file-word'
  | 'file-sheet'
  | 'file-slides'
  | 'file-pdf'
  | 'file-text'
  | 'file-image'
  | 'file-video'
  | 'file-audio'
  | 'file-archive'
  | 'file-generic'

export interface FileIconNode {
  isFile: boolean
  name: string
  rights: number
  traversable?: boolean
  latestVersion?: { format: string } | null
}

const wordFormats = new Set(['doc', 'docx', 'wps'])
const sheetFormats = new Set(['xls', 'xlsx', 'csv'])
const slideFormats = new Set(['ppt', 'pptx', 'dps'])
const textFormats = new Set(['txt', 'md', 'json', 'xml', 'log', 'yaml', 'yml', 'toml', 'ini', 'conf'])
const imageFormats = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp'])
const videoFormats = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi'])
const audioFormats = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'])
const archiveFormats = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function resolveFileIcon(node: FileIconNode): { kind: string; icon: FileIconName } {
  if (!node.isFile) {
    if (!(node.rights & BROWSE) && Boolean(node.rights & UPLOAD)) {
      return { kind: 'folder-dropbox', icon: 'file-folder-dropbox' }
    }
    if (node.traversable && !node.rights) {
      return { kind: 'folder-traversable', icon: 'file-folder-traversable' }
    }
    return { kind: 'folder', icon: 'file-folder' }
  }

  const format = (node.latestVersion?.format || extensionOf(node.name)).toLowerCase()
  if (wordFormats.has(format)) return { kind: 'word', icon: 'file-word' }
  if (sheetFormats.has(format)) return { kind: 'sheet', icon: 'file-sheet' }
  if (slideFormats.has(format)) return { kind: 'slides', icon: 'file-slides' }
  if (format === 'pdf') return { kind: 'pdf', icon: 'file-pdf' }
  if (textFormats.has(format)) return { kind: 'text', icon: 'file-text' }
  if (imageFormats.has(format)) return { kind: 'image', icon: 'file-image' }
  if (videoFormats.has(format)) return { kind: 'video', icon: 'file-video' }
  if (audioFormats.has(format)) return { kind: 'audio', icon: 'file-audio' }
  if (archiveFormats.has(format)) return { kind: 'archive', icon: 'file-archive' }
  return { kind: format || 'generic', icon: 'file-generic' }
}

const typeLabels: Record<string, string> = {
  doc: 'Word 文档',
  docx: 'Word 文档',
  wps: 'WPS 文档',
  xls: 'Excel 表格',
  xlsx: 'Excel 表格',
  csv: 'CSV 表格',
  ppt: 'PPT 演示文稿',
  pptx: 'PPT 演示文稿',
  dps: 'WPS 演示文稿',
  txt: '文本文档',
  md: 'Markdown 文档',
  pdf: 'PDF 文档',
  json: 'JSON 文件',
  xml: 'XML 文件',
  yaml: 'YAML 文件',
  yml: 'YAML 文件',
  log: '日志文件',
  png: 'PNG 图片',
  jpg: 'JPEG 图片',
  jpeg: 'JPEG 图片',
  webp: 'WebP 图片',
  gif: 'GIF 图片',
  svg: 'SVG 图片',
  mp4: 'MP4 视频',
  webm: 'WebM 视频',
  mov: 'MOV 视频',
  mp3: 'MP3 音频',
  wav: 'WAV 音频',
  ogg: 'OGG 音频',
  m4a: 'M4A 音频',
  zip: 'ZIP 压缩包',
  rar: 'RAR 压缩包',
  '7z': '7Z 压缩包',
  tar: 'TAR 归档',
  gz: 'GZ 压缩包',
}

export function formatFileTypeLabel(node: FileIconNode): string {
  if (!node.isFile) return '文件夹'
  const format = node.latestVersion?.format.toLowerCase()
  return format ? typeLabels[format] ?? `${format.toUpperCase()} 文件` : '文件'
}
