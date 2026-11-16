// Local development server for the assistant and the agent wallet. On Vercel the same code runs from api/.
import { createServer } from 'node:http'
import { aiStatus } from '../api/_lib/ai.js'
import { handle } from '../api/_lib/http.js'

const PORT = Number(process.env.AI_SERVER_PORT || 3001)

const server = createServer((req, res) => {
  void handle(req, res)
})

server.listen(PORT, '127.0.0.1', () => {
  const ai = aiStatus()
  console.log(`API on 127.0.0.1:${PORT} (${ai.configured ? `AI: ${ai.provider}` : 'no AI key set, plain commands only'})`)
})
