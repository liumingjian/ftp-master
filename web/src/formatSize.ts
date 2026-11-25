export function formatSize(bytes: number): string {
  const safe = Math.max(0, bytes)
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, safe)) / Math.log(1024)))
  return `${(safe / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`
}
