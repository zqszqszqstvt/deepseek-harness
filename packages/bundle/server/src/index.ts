import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ApiProxy, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ServerStartupValues } from './startup.ts'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'server'
export const inject = ['webServer', 'apiProxy', 'serverStartup']

const MAX_BODY_BYTES = 1024 * 1024

interface UserState { userId: string; key: string; cwd: string; sessionId: ReturnType<typeof SessionId> }
interface TurnBody { message?: unknown; mode?: unknown }
interface ApprovalBody { rpcId?: unknown; outcome?: unknown }

function userState(root: string, userId: string): UserState {
  const key = createHash('sha256').update(userId).digest('hex')
  return { userId, key, cwd: join(root, 'users', key, 'workspace'), sessionId: SessionId(`mu_${key.slice(0, 40)}`) }
}

async function ensureUser(state: UserState, api: ApiProxy): Promise<void> {
  await mkdir(state.cwd, { recursive: true })
  const created = await api.sessions.create({ rpcId: RpcId(randomUUID()), payload: { cwd: state.cwd, sessionId: state.sessionId } })
  if (!created.result.ok && created.result.error.code !== 'session-conflict') {
    throw new Error(created.result.error.message)
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function userIdFrom(pathname: string): string | undefined {
  const match = /^\/v1\/users\/([^/]+)(?:\/.*)?$/.exec(pathname)
  if (match === null) return undefined
  try {
    return decodeURIComponent(match[1] as string)
  } catch {
    return undefined
  }
}

function approvalIdFrom(pathname: string): string | undefined {
  const match = /^\/v1\/users\/[^/]+\/approvals\/([^/]+)$/.exec(pathname)
  if (match === null) return undefined
  try {
    return decodeURIComponent(match[1] as string)
  } catch {
    return undefined
  }
}

function sendResult(res: ServerResponse, result: { ok: boolean; [key: string]: unknown }): void {
  json(res, result.ok ? 200 : 400, result)
}

async function eventsFor(api: ApiProxy, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(': connected\n\n')
  try {
    for await (const frame of api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, controller.signal)) {
      const payload = frame.payload as MuxFrame
      if ('sessionId' in payload && payload.sessionId !== sessionId) continue
      res.write(`data: ${JSON.stringify(frame)}\n\n`)
    }
  } catch (error) {
    if (!controller.signal.aborted) res.write(`data: ${JSON.stringify({ type: 'error', message: String(error) })}\n\n`)
  } finally {
    if (!res.writableEnded) res.end()
  }
}

export interface Config {
  host: '127.0.0.1' | '0.0.0.0'
  port: number
  dataDir?: string
  maxConcurrentTurns: number
}

export function apply(ctx: Context, config: Config): void {
  const startup = ctx.serverStartup as ServerStartupValues
  const root = resolve(config.dataDir ?? startup.dataDir ?? dshHomePath('server-data'))
  const active = new Map<string, Promise<void>>()
  const limit = config.maxConcurrentTurns ?? startup.maxConcurrentTurns
  let running = 0
  const queue: (() => void)[] = []
  const acquire = async (): Promise<() => void> => {
    if (running >= limit) await new Promise<void>(resolveWait => queue.push(resolveWait))
    running++
    return () => { running--; queue.shift()?.() }
  }
  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://dsh').pathname
    if (pathname === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true })
    if (pathname === '/readyz' && req.method === 'GET') return json(res, 200, { ok: true, running, limit })
    const userId = userIdFrom(pathname)
    if (userId === undefined || userId.length === 0 || userId.length > 256) return json(res, 404, { ok: false, error: 'user route not found' })
    const state = userState(root, userId)
    try {
      await ensureUser(state, ctx.apiProxy)
      if (pathname.endsWith('/events') && req.method === 'GET') return eventsFor(ctx.apiProxy, state.sessionId, req, res)
      const approvalId = approvalIdFrom(pathname)
      if (approvalId !== undefined && req.method === 'POST') {
        const parsedBody = await readJson(req)
        if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
          return json(res, 400, { ok: false, error: 'request body must be a JSON object' })
        }
        const body = parsedBody as ApprovalBody
        if (approvalId.length === 0 || approvalId.length > 512) {
          return json(res, 400, { ok: false, error: 'approvalId must be a non-empty string' })
        }
        if (typeof body.rpcId !== 'string' || body.rpcId.length === 0 || body.rpcId.length > 512) {
          return json(res, 400, { ok: false, error: 'rpcId must be a non-empty string' })
        }
        if (body.outcome !== 'allowed-once' && body.outcome !== 'rejected') {
          return json(res, 400, { ok: false, error: 'outcome must be allowed-once or rejected' })
        }
        const receipt = await ctx.apiProxy.respond({
          type: 'client-response',
          rpcId: RpcId(body.rpcId),
          result: {
            ok: true,
            value: { sessionId: state.sessionId, approvalId, outcome: body.outcome },
          },
        })
        return json(res, 200, receipt)
      }
      if (pathname.endsWith('/history') && req.method === 'GET') {
        const result = await ctx.apiProxy.sessions.history({ rpcId: RpcId(randomUUID()), payload: { sessionId: state.sessionId } })
        return sendResult(res, result.result)
      }
      if (pathname.endsWith('/turns') && req.method === 'DELETE') {
        const result = await ctx.apiProxy.sessions.cancel({ rpcId: RpcId(randomUUID()), payload: { sessionId: state.sessionId } })
        return sendResult(res, result.result)
      }
      if (pathname.endsWith('/turns') && req.method === 'POST') {
        const body = await readJson(req) as TurnBody
        if (typeof body.message !== 'string' || body.message.length === 0) return json(res, 400, { ok: false, error: 'message must be a non-empty string' })
        const release = await acquire()
        const previous = active.get(state.userId)
        if (previous !== undefined) await previous
        const work = (async () => {
          const result = await ctx.apiProxy.sessions.prompt({ rpcId: RpcId(randomUUID()), payload: {
            sessionId: state.sessionId, mode: body.mode === 'steer' ? 'steer' : 'queue', content: [{ type: 'text', text: body.message as string }],
          } })
          sendResult(res, result.result)
        })().finally(release)
        active.set(state.userId, work)
        await work
        if (active.get(state.userId) === work) active.delete(state.userId)
        return
      }
      return json(res, 404, { ok: false, error: 'user route not found' })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/v1', handler: route })
  const disposeHealth = ctx.webServer.register({ kind: 'exact', path: '/healthz', handler: route })
  const disposeReady = ctx.webServer.register({ kind: 'exact', path: '/readyz', handler: route })
  ctx.effect(() => () => { dispose(); disposeHealth(); disposeReady() })
  console.log(`dsh server: http://${ctx.webServer.host}:${String(ctx.webServer.port)}`)
}
