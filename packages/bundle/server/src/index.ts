import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rm, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  decodeResourceId,
  isProjectWorkspace,
  parseProjectRoute,
  projectDataDirectory,
  projectSessionState,
  type ProjectSessionState,
} from './project-session.ts'
import {
  ServerBindingId,
  ServerEnvironmentBusyError,
  ServerEnvironmentUnavailableError,
} from './environments.ts'
import type {} from './environments.ts'
import { ServerSseMux } from './sse-mux.ts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { EXECUTOR_PROTOCOL_VERSION } from '@deepseek-ai/dsh-executor-protocol'

export const name = 'server'
export const inject = ['webServer', 'apiProxy', 'agents', 'sessions', 'serverStartup', 'serverEnvironments']

const MAX_BODY_BYTES = 1024 * 1024
const PUBLIC_SERVER_ERROR = 'server request failed'
const SERVER_API_VERSION = 1

interface TurnBody { message?: unknown; mode?: unknown }
interface ApprovalBody { rpcId?: unknown; outcome?: unknown }
interface EnvironmentSwitchBody { bindingId?: unknown }

async function ensureProject(state: ProjectSessionState, api: ApiProxy, persistence: unknown): Promise<void> {
  await mkdir(state.cwd, { recursive: true })
  await Promise.all([
    mkdir(join(state.cwd, '.home'), { recursive: true, mode: 0o700 }),
    mkdir(join(state.cwd, '.cache'), { recursive: true, mode: 0o700 }),
  ])
  if (persistence instanceof JsonlSessionPersistence) {
    const stored = await persistence.readRaw(state.sessionId)
    if (stored !== undefined && stored.meta.cwd !== state.cwd) {
      if (!isProjectWorkspace(stored.meta.cwd, state)) {
        throw new Error(`server session "${state.sessionId}" belongs to unexpected cwd ${JSON.stringify(stored.meta.cwd)}`)
      }
      await persistence.relocateStoredSessionCwd(state.sessionId, state.cwd)
    }
  }
  const created = await api.sessions.create({ rpcId: RpcId(randomUUID()), payload: { cwd: state.cwd, sessionId: state.sessionId } })
  if (!created.result.ok && created.result.error.code !== 'session-conflict') {
    throw new Error(created.result.error.message)
  }
}

async function removeOwnedDirectory(path: string): Promise<void> {
  let identity
  try {
    identity = await lstat(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return
    throw error
  }
  if (identity.isSymbolicLink()) await unlink(path)
  else await rm(path, { recursive: true })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const rawChunk of req) {
    const chunk: unknown = rawChunk
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) throw new Error('request body contains an invalid chunk')
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

function sendResult(ctx: Context, res: ServerResponse, operation: string, result: { ok: boolean; [key: string]: unknown }): void {
  if (result.ok) {
    json(res, 200, result)
    return
  }
  ctx.logger.error(`dsh server ${operation} failed: %o`, result)
  json(res, 500, { ok: false, error: PUBLIC_SERVER_ERROR })
}

function reportRequestError(ctx: Context, pathname: string, error: unknown): void {
  const cause = error instanceof Error ? error : new Error(String(error))
  ctx.logger.error(new Error(`dsh server request failed for ${pathname}`, { cause }))
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
  state: ProjectSessionState,
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
  maxConcurrentTurns?: number
  /** Maximum open Server SSE responses across all users. */
  maxSseConnections: number
  /** Maximum open Server SSE responses for one user. */
  maxSseConnectionsPerUser: number
  /** Maximum encoded bytes waiting behind one slow SSE response. */
  sseClientBufferBytes: number
  /** Browser origin allowed to call the Server directly, or undefined to disable CORS. */
  corsOrigin?: string
}

export function apply(ctx: Context, config: Config): void {
  const startup = ctx.serverStartup
  const root = resolve(config.dataDir ?? startup.dataDir ?? dshHomePath('server-data'))
  const active = new Map<string, Promise<void>>()
  const limit = config.maxConcurrentTurns ?? startup.maxConcurrentTurns
  const corsOrigin = config.corsOrigin ?? startup.corsOrigin
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
  }, (error) => { reportRequestError(ctx, '/v1/users/*/events', error) })
  ctx.on('session/disposed', (session) => { sseMux.dropSession(session.id) })
  const projectInitialization = new Map<string, Promise<void>>()
  const initializeProject = (state: ProjectSessionState): Promise<void> => {
    ctx.serverEnvironments.bindProject(state)
    const key = String(state.sessionId)
    const pending = projectInitialization.get(key)
    if (pending !== undefined) return pending
    const operation = ensureProject(state, ctx.apiProxy, ctx.get('sessionPersistence')).finally(() => {
      if (projectInitialization.get(key) === operation) projectInitialization.delete(key)
    })
    projectInitialization.set(key, operation)
    return operation
  }
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
    if (corsOrigin !== undefined) {
      res.setHeader('access-control-allow-origin', corsOrigin)
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type')
      if (corsOrigin !== '*') res.setHeader('vary', 'origin')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh').pathname
    if (pathname === '/healthz' && req.method === 'GET') {
      json(res, 200, { ok: true })
      return
    }
    if (pathname === '/readyz' && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        running,
        limit,
        sseConnections: sseMux.connections,
        sseConnectionLimit: maxSseConnections,
        sseMuxState: sseMux.muxState,
      })
      return
    }
    if (pathname === '/v1/capabilities' && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        value: {
          apiVersion: SERVER_API_VERSION,
          executorProtocolVersion: EXECUTOR_PROTOCOL_VERSION,
          sessionIdentity: 'user-project',
          features: [
            'session.initialize',
            'session.delete',
            'session.history',
            'session.turns',
            'session.events',
            'session.interactions',
            'execution.environments',
            'executor.websocket',
          ],
        },
      })
      return
    }
    const projectRoute = parseProjectRoute(pathname)
    if (projectRoute === undefined) {
      json(res, 404, { ok: false, error: 'user route not found' })
      return
    }
    const state = projectSessionState(root, projectRoute.identity)
    const resource = projectRoute.resource
    try {
      if (resource.length === 1 && resource[0] === 'session' && req.method === 'DELETE') {
        if (active.has(String(state.sessionId))) {
          json(res, 409, { ok: false, error: 'session is running' })
          return
        }
        const initialization = projectInitialization.get(String(state.sessionId))
        if (initialization !== undefined) await initialization
        // Initialized sessions stay attached through host-level fibers; releasing
        // the owning handle via apiProxy detaches exactly this session. Fiber
        // disposal here would unload every session the fiber owns.
        const released = await ctx.apiProxy.sessions.release({
          rpcId: RpcId(randomUUID()), payload: { sessionId: state.sessionId },
        })
        if (!released.result.ok) throw new Error(released.result.error.message)
        if (ctx.sessions.get(state.sessionId) !== undefined) {
          throw new Error(`session "${state.sessionId}" remained live after release`)
        }
        const persistence = ctx.get('sessionPersistence')
        if (!(persistence instanceof JsonlSessionPersistence)) {
          throw new Error('server project deletion requires JSONL session persistence')
        }
        await persistence.deleteStoredSession(state.sessionId)
        await ctx.serverEnvironments.deleteProject(state)
        sseMux.dropSession(state.sessionId)
        await removeOwnedDirectory(projectDataDirectory(state))
        json(res, 200, { ok: true, value: { deleted: true } })
        return
      }
      await initializeProject(state)
      if (resource.length === 1 && resource[0] === 'session' && req.method === 'PUT') {
        json(res, 200, { ok: true, value: ctx.serverEnvironments.project(state) })
        return
      }
      if (resource.length === 1 && resource[0] === 'environments' && req.method === 'GET') {
        json(res, 200, { ok: true, value: ctx.serverEnvironments.project(state) })
        return
      }
      if (resource.length === 1 && resource[0] === 'environment' && req.method === 'POST') {
        const parsedBody = await readJson(req)
        if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
          json(res, 400, { ok: false, error: 'request body must be a JSON object' })
          return
        }
        const body = parsedBody as EnvironmentSwitchBody
        if (typeof body.bindingId !== 'string' || body.bindingId.length === 0 || body.bindingId.length > 512) {
          json(res, 400, { ok: false, error: 'bindingId must be a non-empty string' })
          return
        }
        const value = await ctx.serverEnvironments.switch(state, ServerBindingId(body.bindingId))
        json(res, 200, { ok: true, value })
        return
      }
      if (resource.length === 1 && resource[0] === 'events' && req.method === 'GET') {
        const session = ctx.sessions.get(state.sessionId)
        if (session === undefined) throw new Error(`session "${state.sessionId}" is unavailable`)
        await eventsFor(sseMux, state, session.seq - 1, res)
        return
      }
      const approvalId = resource.length === 2 && resource[0] === 'approvals'
        ? decodeResourceId(resource[1])
        : undefined
      if (approvalId !== undefined && req.method === 'POST') {
        const parsedBody = await readJson(req)
        if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
          json(res, 400, { ok: false, error: 'request body must be a JSON object' })
          return
        }
        const body = parsedBody as ApprovalBody
        if (approvalId.length === 0 || approvalId.length > 512) {
          json(res, 400, { ok: false, error: 'approvalId must be a non-empty string' })
          return
        }
        if (typeof body.rpcId !== 'string' || body.rpcId.length === 0 || body.rpcId.length > 512) {
          json(res, 400, { ok: false, error: 'rpcId must be a non-empty string' })
          return
        }
        if (body.outcome !== 'allowed-once' && body.outcome !== 'rejected') {
          json(res, 400, { ok: false, error: 'outcome must be allowed-once or rejected' })
          return
        }
        const receipt = await ctx.apiProxy.respond({
          type: 'client-response',
          rpcId: RpcId(body.rpcId),
          result: {
            ok: true,
            value: { sessionId: state.sessionId, approvalId, outcome: body.outcome },
          },
        })
        json(res, 200, receipt)
        return
      }
      const questionRpcId = resource.length === 2 && resource[0] === 'questions'
        ? decodeResourceId(resource[1])
        : undefined
      if (questionRpcId !== undefined && req.method === 'POST') {
        const answer = await readJson(req)
        if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
          json(res, 400, { ok: false, error: 'request body must be a JSON object' })
          return
        }
        if (questionRpcId.length === 0 || questionRpcId.length > 512) {
          json(res, 400, { ok: false, error: 'rpcId must be a non-empty string' })
          return
        }
        const receipt = await ctx.apiProxy.respond({
          type: 'client-response',
          rpcId: RpcId(questionRpcId),
          result: {
            ok: true,
            value: { sessionId: state.sessionId, answer },
          },
        })
        json(res, 200, receipt)
        return
      }
      if (resource.length === 1 && resource[0] === 'history' && req.method === 'GET') {
        // Without pagination the tail page spans the oldest included message group
        // through the end of the log (every tool/chunk event plus views), which grows
        // unbounded in long sessions. Callers may therefore cap the page via ?maxMessages=N.
        const requestUrl = new URL(req.url ?? '/', 'http://dsh')
        const rawMaxMessages = requestUrl.searchParams.get('maxMessages')
        const parsedMaxMessages = rawMaxMessages === null ? Number.NaN : Number(rawMaxMessages)
        const maxMessages = Number.isSafeInteger(parsedMaxMessages) && parsedMaxMessages > 0
          ? parsedMaxMessages
          : undefined
        const rawBeforeSeq = requestUrl.searchParams.get('beforeSeq')
        const parsedBeforeSeq = rawBeforeSeq === null ? Number.NaN : Number(rawBeforeSeq)
        const beforeSeq = Number.isSafeInteger(parsedBeforeSeq) && parsedBeforeSeq >= 0
          ? parsedBeforeSeq
          : undefined
        const result = await ctx.apiProxy.sessions.history({
          rpcId: RpcId(randomUUID()),
          payload: {
            sessionId: state.sessionId,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
            ...(maxMessages === undefined ? {} : { maxMessages }),
          },
        })
        sendResult(ctx, res, 'history', result.result)
        return
      }
      if (resource.length === 1 && resource[0] === 'turns' && req.method === 'DELETE') {
        const result = await ctx.apiProxy.sessions.cancel({ rpcId: RpcId(randomUUID()), payload: { sessionId: state.sessionId } })
        sendResult(ctx, res, 'cancel', result.result)
        return
      }
      if (resource.length === 1 && resource[0] === 'turns' && req.method === 'POST') {
        const body = await readJson(req) as TurnBody
        if (typeof body.message !== 'string' || body.message.length === 0) {
          json(res, 400, { ok: false, error: 'message must be a non-empty string' })
          return
        }
        const message = body.message
        const mode = body.mode === 'steer' ? 'steer' : 'queue'
        const agent = ctx.agents.get(state.sessionId)
        if (agent === undefined) throw new Error(`session "${state.sessionId}" has no live agent`)
        if (mode === 'steer' && agent.status === 'running') {
          const result = await ctx.apiProxy.sessions.prompt({ rpcId: RpcId(randomUUID()), payload: {
            sessionId: state.sessionId, mode, content: [{ type: 'text', text: message }],
          } })
          sendResult(ctx, res, 'steer', result.result)
          return
        }
        const activeKey = String(state.sessionId)
        const previous = active.get(activeKey)
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
            sendResult(ctx, res, 'turn', result.result)
          } finally {
            release()
          }
        })()
        active.set(activeKey, work)
        try {
          await work
        } finally {
          if (active.get(activeKey) === work) active.delete(activeKey)
        }
        return
      }
      json(res, 404, { ok: false, error: 'user route not found' })
      return
    } catch (error) {
      if (error instanceof ServerEnvironmentUnavailableError) {
        json(res, 409, { ok: false, error: 'environment unavailable' })
        return
      }
      if (error instanceof ServerEnvironmentBusyError) {
        json(res, 409, { ok: false, error: 'environment busy' })
        return
      }
      reportRequestError(ctx, pathname, error)
      json(res, 500, { ok: false, error: PUBLIC_SERVER_ERROR })
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
