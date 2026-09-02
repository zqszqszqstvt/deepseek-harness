import { request } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'

interface JsonResponse { status: number; body: unknown }

function requestJson(port: number, path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<JsonResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const headers = payload === undefined
    ? undefined
    : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/** Read JSON from one test server endpoint over Node's unrestricted HTTP client. */
export function getJson(port: number, path: string): Promise<JsonResponse> {
  return requestJson(port, path, 'GET')
}

/** Send JSON to one test server endpoint over Node's unrestricted HTTP client. */
export function postJson(port: number, path: string, body: unknown): Promise<JsonResponse> {
  return requestJson(port, path, 'POST', body)
}

/** Send an idempotent JSON request to one test server endpoint. */
export function putJson(port: number, path: string, body?: unknown): Promise<JsonResponse> {
  return requestJson(port, path, 'PUT', body)
}

/** One persistent SSE response controlled by a test. */
export interface SseProbe {
  readonly status: number
  readonly text: string
  readonly ended: Promise<void>
  /** Wait until the accumulated response text satisfies one assertion. */
  waitFor(assertion: (text: string) => void): Promise<void>
  /** Destroy the client request and release the server response. */
  close(): void
}

/** Open one Server SSE response without buffering it to completion. */
export function openSse(port: number, path: string): Promise<SseProbe> {
  return new Promise((resolve, reject) => {
    const req: ClientRequest = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res: IncomingMessage) => {
      let text = ''
      let resolveEnded!: () => void
      const ended = new Promise<void>((resolveEnd) => { resolveEnded = resolveEnd })
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.once('end', resolveEnded)
      res.once('close', resolveEnded)
      resolve({
        status: res.statusCode ?? 0,
        get text() { return text },
        ended,
        waitFor: async (assertion) => {
          const deadline = Date.now() + 2_000
          while (true) {
            try {
              assertion(text)
              return
            } catch (error) {
              if (Date.now() >= deadline) throw error
              await new Promise(resolveWait => setTimeout(resolveWait, 10))
            }
          }
        },
        close: () => { req.destroy() },
      })
    })
    req.once('error', reject)
    req.end()
  })
}
