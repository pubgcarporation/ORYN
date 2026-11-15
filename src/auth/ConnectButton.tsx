import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, Copy, Droplets, ExternalLink, LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { erc20Abi } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ARC_ID, ASSETS, fmtToken } from '@/lib/pool'
import { ConnectCta } from '@/auth/ConnectCta'
import { useAuth } from '@/auth/useAuth'

const FAUCET_URL = 'https://faucet.circle.com'

export function ConnectButton() {
  const { isConnected } = useAccount()
  if (!isConnected) return <ConnectCta className="btn-primary !min-h-11 !px-4 !text-sm sm:!px-5" />
  return <WalletMenu />
}

function WalletMenu() {
  const { address } = useAccount()
  const auth = useAuth()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const { data: balance } = useReadContract({
    address: ASSETS.USDC.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ARC_ID,
    query: { enabled: Boolean(address), refetchInterval: 10_000 },
  })

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!address) return null
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`
  const initials = (auth.identity ?? address.slice(2)).slice(0, 2).toUpperCase()

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      toast.success('Address copied')
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error('Could not copy. Select the address and copy it manually.')
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        className="btn-ghost !min-h-11 gap-2 !pl-1.5"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex size-8 items-center justify-center rounded-full text-[11px] font-bold" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
          {initials}
        </span>
        <span className="num hidden sm:inline">{short}</span>
        <ChevronDown className="size-3.5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            className="card absolute right-0 top-full z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] p-3"
            style={{ background: 'rgba(18,36,58,0.97)' }}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
          >
            <div className="px-2 pb-3 pt-1">
              {auth.viaGoogle && auth.identity && (
                <div className="mb-2 flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                  <span className="rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={{ background: 'var(--surface-strong)' }}>
                    Google
                  </span>
                  <span className="truncate">{auth.identity}</span>
                </div>
              )}
              <div className="label">Wallet</div>
              <button onClick={() => void copy()} className="mt-1 flex w-full items-center justify-between gap-2 text-left" aria-label="Copy address">
                <span className="num break-all text-xs font-medium">{address}</span>
                {copied ? <Check className="size-4 shrink-0" style={{ color: 'var(--success)' }} /> : <Copy className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />}
              </button>
              <div className="inner mt-3 flex items-center justify-between px-3 py-2.5 text-sm">
                <span style={{ color: 'var(--muted)' }}>USDC balance</span>
                <span className="num font-semibold">{fmtToken(balance ?? 0n, ASSETS.USDC.decimals)}</span>
              </div>
            </div>
            <MenuLink href={FAUCET_URL} icon={<Droplets className="size-4" />}>
              Get test USDC
            </MenuLink>
            <MenuLink href={buildAddressExplorerUrl(ARC_ID, address)} icon={<ExternalLink className="size-4" />}>
              View on explorer
            </MenuLink>
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-sm font-semibold transition-colors hover:bg-white/5"
              style={{ color: 'var(--danger)' }}
              onClick={() => {
                setOpen(false)
                auth.logout()
              }}
            >
              <LogOut className="size-4" /> Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function MenuLink({ href, icon, children }: { href: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <a
      role="menuitem"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-sm font-semibold transition-colors hover:bg-white/5"
    >
      {icon}
      {children}
    </a>
  )
}
