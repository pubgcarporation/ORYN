import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'

const listeners = new Set<() => void>()

function subscribe(callback: () => void) {
  listeners.add(callback)
  window.addEventListener('popstate', callback)
  return () => {
    listeners.delete(callback)
    window.removeEventListener('popstate', callback)
  }
}

const getPath = () => window.location.pathname

/** The current pathname, kept in step with browser back and forward. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, getPath)
}

export function navigate(to: string, options?: { replace?: boolean }) {
  if (to === window.location.pathname + window.location.search) return
  if (options?.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  listeners.forEach((callback) => callback())
  window.scrollTo({ top: 0 })
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string }

/** In-app link: plain anchor semantics, client-side navigation on a normal click. */
export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  )
}
