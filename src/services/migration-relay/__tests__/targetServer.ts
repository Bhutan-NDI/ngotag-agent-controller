import type { IncomingMessage, ServerResponse } from 'http'

import { createServer } from 'http'

export interface ReceivedRequest {
  method?: string
  contentType?: string
  body: string
}

export interface TargetServer {
  url: string
  port: number
  received: ReceivedRequest[]
  close: () => Promise<void>
}

export type TargetHandler = (request: ReceivedRequest, res: ServerResponse) => void

/** A stand-in for an organisation's agent: records what it is sent and answers as the handler says. */
export const startTarget = (
  handler: TargetHandler = (_request, res) => res.writeHead(200).end(),
  port = 0,
): Promise<TargetServer> =>
  new Promise((resolve, reject) => {
    const received: ReceivedRequest[] = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const request = {
          method: req.method,
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        }
        received.push(request)
        handler(request, res)
      })
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        port: address.port,
        received,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            server.closeAllConnections()
          }),
      })
    })
  })

export const freePort = async (): Promise<number> => {
  const target = await startTarget()
  const { port } = target
  await target.close()
  return port
}
