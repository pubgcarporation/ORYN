export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="13" stroke="#acc6e9" strokeWidth="2.5" />
      <path d="M8.5 20.5c3.4-8.5 11.6-8.5 15 0" stroke="#f9faf3" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="16" cy="12" r="2.4" fill="#acc6e9" />
    </svg>
  )
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark size={size} />
      <span className="display text-xl font-semibold tracking-tight">ORYN</span>
    </span>
  )
}
