export function avatarInitial(displayName: string): string {
  const trimmed = displayName.trim()
  if (!trimmed) return '?'
  const first = Array.from(trimmed)[0] ?? '?'
  return /[a-z]/.test(first) ? first.toUpperCase() : first
}
