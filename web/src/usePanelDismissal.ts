import { useEffect, useRef } from 'react'

export function usePanelDismissal(open: boolean, dismiss: (restoreFocus: boolean) => void, dismissOnOutside = true) {
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return

    function closeOnOutside(event: MouseEvent) {
      if (!dismissOnOutside || !panel.current || document.querySelector('dialog[open]')) return
      const path = event.composedPath()
      if (path.includes(panel.current) ||
          path.some(target => target instanceof Element && target.hasAttribute('data-panel-trigger'))) return
      dismiss(false)
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return
      event.preventDefault()
      dismiss(true)
    }

    document.addEventListener('click', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('click', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, dismiss, dismissOnOutside])

  return panel
}
