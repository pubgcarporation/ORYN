import { Link } from '@/lib/router'
import { Logo } from '@/components/Logo'

export function NotFound() {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden p-6">
      <div className="bg-grid pointer-events-none absolute inset-x-0 top-0 h-[480px]" aria-hidden="true" />
      <div className="card relative max-w-md p-8 text-center">
        <div className="mb-5 flex justify-center">
          <Logo />
        </div>
        <div className="display text-gradient text-6xl font-semibold">404</div>
        <h1 className="display mt-2 text-xl font-semibold">This page does not exist</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          The link may be old or mistyped.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Link to="/" className="btn-ghost !min-h-12">
            Home
          </Link>
          <Link to="/app/earn" className="btn-primary">
            Open the app
          </Link>
        </div>
      </div>
    </div>
  )
}
