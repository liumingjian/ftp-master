export interface Clock {
  now(): number
  after(delayMs: number, callback: () => void): () => void
}

export const systemClock: Clock = {
  now: () => performance.now(),
  after(delayMs, callback) {
    const timer = window.setTimeout(callback, delayMs)
    return () => window.clearTimeout(timer)
  },
}

export function formatCurrentLocalMinute(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}
