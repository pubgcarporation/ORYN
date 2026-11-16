import { useId } from 'react'

export function LogoMark({ size = 26 }: { size?: number }) {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="350 300 610 620" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-arch`} x1="655" y1="312" x2="655" y2="726" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" />
          <stop offset="1" stopColor="#b8a4ff" />
        </linearGradient>
        <linearGradient id={`${id}-gem`} x1="560" y1="640" x2="750" y2="900" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f3efff" />
          <stop offset="1" stopColor="#b8a4ff" />
        </linearGradient>
      </defs>
      <path d="M627 322C642 308 668 308 683 322L910 555C956 602 950 680 884 726L655 472 428 726C362 680 356 602 402 555L627 322Z" fill={`url(#${id}-arch)`} />
      <rect x="-103" y="-103" width="206" height="206" rx="15" transform="translate(655 761) rotate(45)" fill={`url(#${id}-gem)`} />
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
