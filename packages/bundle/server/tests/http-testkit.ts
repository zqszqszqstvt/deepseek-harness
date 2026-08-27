import { request } from 'node:http'

interface JsonResponse { status: number; body: unknown }

function requestJson(port: number, path: string, method: 'GET' | 'POST', body?: unknown): Promise<JsonResponse> {
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
