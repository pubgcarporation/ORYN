import { useCallback, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useAccount } from 'wagmi'
import { ConnectCta } from '@/auth/ConnectCta'
import { ProfilePanel } from '@/auth/ProfilePanel'
import { useAuth } from '@/auth/useAuth'

export function ConnectButton() {
  const { isConnected } = useAccount()
  if (!isConnected) return <ConnectCta className="btn-primary !min-h-11 !px-4 !text-sm sm:!px-5" />
  return <ProfileButton />
}

/** The avatar button in the header. It opens the account side panel. */
function ProfileButton() {
  const { address } = useAccount()
  const auth = useAuth()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  if (!address) return null
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`
  const initials = (auth.identity ?? address.slice(2)).slice(0, 2).toUpperCase()

  return (
    <>
      <button ref={triggerRef} className="btn-ghost !min-h-11 gap-2 !pl-1.5" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-label="Open account">
        <span className="flex size-8 items-center justify-center rounded-full text-[11px] font-bold" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
          {initials}
        </span>
        <span className="num hidden sm:inline">{short}</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      <ProfilePanel address={address} open={open} onClose={close} />
    </>
  )
}
