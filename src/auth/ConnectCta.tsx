import { Loader2 } from 'lucide-react'
import { SIGN_IN_LABEL, useAuth } from '@/auth/useAuth'

/** Full-width sign-in button used inside sheets and cards when no wallet is connected. */
export function ConnectCta({ className = 'btn-primary w-full', label }: { className?: string; label?: string }) {
  const auth = useAuth()
  return (
    <button className={className} onClick={auth.login} disabled={!auth.ready}>
      {!auth.ready && <Loader2 className="size-4 animate-spin" />}
      {label ?? SIGN_IN_LABEL}
    </button>
  )
}
