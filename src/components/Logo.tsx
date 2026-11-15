import { useId } from 'react'

export function LogoMark({ size = 26 }: { size?: number }) {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="16" y1="2" x2="16" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" />
          <stop offset="1" stopColor="#b9a6ff" />
        </linearGradient>
      </defs>
      <path d="M16 2.5 28 27.5 16 21 4 27.5 16 2.5Z" fill={`url(#${id})`} />
      <path d="M16 11.5 21 22.2 16 19.4 11 22.2 16 11.5Z" fill="#0a0814" />
    </svg>
  )
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="display text-xl font-semibold tracking-[0.04em]">ORYN</span>
    </span>
  )
}
