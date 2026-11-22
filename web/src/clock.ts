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
