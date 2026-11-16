/** An error that maps straight to an HTTP answer. Messages are safe to show to the person using the app. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}
