import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ServerStartupValues } from './startup.ts'
import { ServerSseMux } from './sse-mux.ts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'server'
export const inject = ['webServer', 'apiProxy', 'agents', 'sessions', 'serverStartup']

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

function questionRpcIdFrom(pathname: string): string | undefined {
  const match = /^\/v1\/users\/[^/]+\/questions\/([^/]+)$/.exec(pathname)
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

async function writeSse(res: ServerResponse, chunk: string | Buffer): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false
  if (res.write(chunk)) return true
  await new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
  return !res.destroyed
}

async function eventsFor(
  mux: ServerSseMux,
  state: UserState,
  lastSeq: number,
  res: ServerResponse,
): Promise<void> {
  const registered = mux.register(state.userId, state.sessionId, lastSeq, () => { res.destroy() })
  if (!registered.ok) {
    json(res, registered.status, { ok: false, error: registered.error })
    return
  }
  const { client } = registered
  const onClose = (): void => { client.close('disconnect') }
  res.once('close', onClose)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  try {
    if (!await writeSse(res, ': connected\n\n')) return
    while (true) {
      const frame = await client.take()
      if (frame === undefined || !await writeSse(res, frame)) return
    }
  } finally {
    res.off('close', onClose)
    client.close('disconnect')
    if (!res.destroyed && !res.writableEnded) res.end()
  }
}

/** Multi-user HTTP Server runtime config resolved by the startup plugin and Loader. */
export interface Config {
  /** HTTP bind address supplied by the shared Server startup parser. */
  host: '127.0.0.1' | '0.0.0.0'
  /** HTTP listen port supplied by the shared Server startup parser. */
  port: number
  /** Root for per-user workspaces and Server-owned session data. */
  dataDir?: string
  /** Maximum user turns executing concurrently before later requests queue. */
  maxConcurrentTurns: number
  /** Maximum open Server SSE responses across all users. */
  maxSseConnections: number
  /** Maximum open Server SSE responses for one user. */
  maxSseConnectionsPerUser: number
  /** Maximum encoded bytes waiting behind one slow SSE response. */
  sseClientBufferBytes: number
}

export function apply(ctx: Context, config: Config): void {
  const startup = ctx.serverStartup as ServerStartupValues
  const root = resolve(config.dataDir ?? startup.dataDir ?? dshHomePath('server-data'))
  const active = new Map<string, Promise<void>>()
  const limit = config.maxConcurrentTurns ?? startup.maxConcurrentTurns
  const { maxSseConnections, maxSseConnectionsPerUser, sseClientBufferBytes } = config
  for (const [field, value] of Object.entries({ maxSseConnections, maxSseConnectionsPerUser, sseClientBufferBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`server: ${field} must be a positive safe integer`)
  }
  if (maxSseConnectionsPerUser > maxSseConnections) {
    throw new Error('server: maxSseConnectionsPerUser cannot exceed maxSseConnections')
  }
  const sseMux = new ServerSseMux(ctx.apiProxy, {
    maxConnections: maxSseConnections,
    maxConnectionsPerUser: maxSseConnectionsPerUser,
    clientBufferBytes: sseClientBufferBytes,
  })
  ctx.on('session/disposed', (session) => { sseMux.dropSession(session.id) })
  let running = 0
  const queue: ((release: () => void) => void)[] = []
  const makeRelease = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = queue.shift()
      if (next === undefined) running--
      else next(makeRelease())
    }
  }
  const acquire = async (): Promise<() => void> => {
    if (running >= limit) return new Promise(resolveWait => queue.push(resolveWait))
    running++
    return makeRelease()
  }
  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://dsh').pathname
    if (pathname === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true })
    if (pathname === '/readyz' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        running,
        limit,
        sseConnections: sseMux.connections,
        sseConnectionLimit: maxSseConnections,
        sseMuxState: sseMux.muxState,
      })
    }
    const userId = userIdFrom(pathname)
    if (userId === undefined || userId.length === 0 || userId.length > 256) return json(res, 404, { ok: false, error: 'user route not found' })
    const state = userState(root, userId)
    try {
      await ensureUser(state, ctx.apiProxy)
      if (pathname.endsWith('/events') && req.method === 'GET') {
        const session = ctx.sessions.get(state.sessionId)
        if (session === undefined) throw new Error(`session "${state.sessionId}" is unavailable`)
        await eventsFor(sseMux, state, session.seq - 1, res)
        return
      }
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
      const questionRpcId = questionRpcIdFrom(pathname)
      if (questionRpcId !== undefined && req.method === 'POST') {
        const answer = await readJson(req)
        if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
          return json(res, 400, { ok: false, error: 'request body must be a JSON object' })
        }
        if (questionRpcId.length === 0 || questionRpcId.length > 512) {
          return json(res, 400, { ok: false, error: 'rpcId must be a non-empty string' })
        }
        const receipt = await ctx.apiProxy.respond({
          type: 'client-response',
          rpcId: RpcId(questionRpcId),
          result: {
            ok: true,
            value: { sessionId: state.sessionId, answer },
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
        const message = body.message
        const mode = body.mode === 'steer' ? 'steer' : 'queue'
        const agent = ctx.agents.get(state.sessionId)
        if (agent === undefined) throw new Error(`session "${state.sessionId}" has no live agent`)
        if (mode === 'steer' && agent.status === 'running') {
          const result = await ctx.apiProxy.sessions.prompt({ rpcId: RpcId(randomUUID()), payload: {
            sessionId: state.sessionId, mode, content: [{ type: 'text', text: message }],
          } })
          return sendResult(res, result.result)
        }
        const previous = active.get(state.userId)
        const work = (async () => {
          if (previous !== undefined) {
            try {
              await previous
            } catch {
              // The preceding handler reports its own failure; later queued work remains independent.
            }
          }
          const release = await acquire()
          try {
            const result = await ctx.apiProxy.sessions.prompt({ rpcId: RpcId(randomUUID()), payload: {
              sessionId: state.sessionId, mode, content: [{ type: 'text', text: message }],
            } })
            if (result.result.ok) await agent.whenIdle()
            sendResult(res, result.result)
          } finally {
            release()
          }
        })()
        active.set(state.userId, work)
        try {
          await work
        } finally {
          if (active.get(state.userId) === work) active.delete(state.userId)
        }
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
  ctx.effect(() => async () => {
    dispose()
    disposeHealth()
    disposeReady()
    await sseMux.dispose()
  })
  console.log(`dsh server: http://${ctx.webServer.host}:${String(ctx.webServer.port)}`)
}
