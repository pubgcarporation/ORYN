// Vercel serverless entry. The same handler runs locally through server/index.ts.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handle } from './_lib/http.js'

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handle(req, res)
}
