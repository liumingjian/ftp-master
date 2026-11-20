import { useEffect, useState } from 'react'

/** A page or panel that could not reach the service. */
export type Unreachable = { kind: 'unreachable'; message: string }

/** What the user is told when the service cannot be reached. */
export function unreachableText(detail: string): string {
  return `无法连接服务（${detail}）`
}

/**
 * Runs request once on mount and returns the state it resolves to, starting
 * from initial. A request that resolves to undefined leaves the state as it
 * is; one that throws makes it Unreachable. Results arriving after unmount
 * are dropped.
 */
export function useRequestOnMount<S>(initial: S, request: () => Promise<S | undefined>): S | Unreachable {
  const [state, setState] = useState<S | Unreachable>(initial)

  useEffect(() => {
    let cancelled = false
    request().then(
      (next) => {
        if (!cancelled && next !== undefined) setState(next)
      },
      (err: unknown) => {
        if (!cancelled) setState({ kind: 'unreachable', message: String(err) })
      },
    )
    return () => {
      cancelled = true
    }
    // Runs once: request is a fresh closure on every render.
  }, [])

  return state
}
