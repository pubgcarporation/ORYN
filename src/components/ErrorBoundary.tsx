import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
  /** Changing this value clears a caught error, for example when the visitor moves to another page. */
  resetKey?: string
}

interface State {
  failed: boolean
}

/** Keeps one broken page from blanking the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="card mx-auto max-w-md p-8 text-center" role="alert">
        <AlertTriangle className="mx-auto size-8" style={{ color: 'var(--warn)' }} />
        <h2 className="display mt-3 text-xl font-semibold">This page hit a problem</h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          Your funds are not affected. Try again, or switch to another tab.
        </p>
        <button className="btn-primary mt-5" onClick={() => this.setState({ failed: false })}>
          Try again
        </button>
      </div>
    )
  }
}
