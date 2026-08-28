/** Shared ApiProxy mux consumption and bounded per-session SSE delivery. */

import { randomUUID } from 'node:crypto'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionId } from '@deepseek-ai/dsh-session'

type ClientCloseReason = 'disconnect' | 'mux-ended' | 'overflow' | 'session-disposed' | 'shutdown'

interface CachedSessionFrames {
  readonly questions: Map<string, Buffer>
  readonly approvals: Map<string, Buffer>
  queue?: Buffer
  jobs?: Buffer
}

const PUBLIC_STREAM_ERROR = 'event stream failed'

/** One bounded single-consumer frame queue owned by an HTTP response. */
export class SseClient {
  private readonly frames: Buffer[] = []
  private head = 0
  private bufferedBytes = 0
  private waiter: ((frame: Buffer | undefined) => void) | undefined
  private closed = false

  constructor(
    private readonly highWaterMarkBytes: number,
    private readonly onClose: (reason: ClientCloseReason) => void,
  ) {}

  /** Add one immutable encoded frame, closing the client before its pending bytes exceed the limit. */
  push(frame: Buffer): boolean {
    if (this.closed) return false
    if (frame.byteLength > this.highWaterMarkBytes || this.bufferedBytes + frame.byteLength > this.highWaterMarkBytes) {
      this.close('overflow')
      return false
    }
    const waiter = this.waiter
    if (waiter !== undefined) {
      this.waiter = undefined
      waiter(frame)
      return true
    }
    this.frames.push(frame)
    this.bufferedBytes += frame.byteLength
    return true
  }

  /** Wait for the next encoded frame, or undefined after retained terminal frames drain. */
  take(): Promise<Buffer | undefined> {
    if (this.head < this.frames.length) {
      const frame = this.frames[this.head++] as Buffer
      this.bufferedBytes -= frame.byteLength
      if (this.head === this.frames.length) {
        this.frames.length = 0
        this.head = 0
      }
      return Promise.resolve(frame)
    }
    if (this.closed) return Promise.resolve(undefined)
    return new Promise((resolve) => { this.waiter = resolve })
  }

  /** Stop delivery and release the distributor registration. */
  close(reason: ClientCloseReason): void {
    if (this.closed) return
    this.closed = true
    if (reason !== 'mux-ended') {
      this.frames.length = 0
      this.head = 0
      this.bufferedBytes = 0
    }
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.(undefined)
    this.onClose(reason)
  }
}

export interface SseMuxLimits {
  /** Maximum open Server SSE responses across all users. */
  maxConnections: number
  /** Maximum open Server SSE responses for one user. */
  maxConnectionsPerUser: number
  /** Maximum encoded bytes waiting behind one slow response. */
  clientBufferBytes: number
}

export type SseRegistration =
  | { ok: true; client: SseClient }
  | { ok: false; status: 429 | 503; error: string }

function encode(frame: RpcRequest<MuxFrame>): Buffer {
  return Buffer.from(`data: ${JSON.stringify(frame)}\n\n`)
}

/** One process-wide mux reader with session-indexed bounded response queues. */
export class ServerSseMux {
  private readonly controller = new AbortController()
  private readonly clients = new Map<SessionId, Set<SseClient>>()
  private readonly userCounts = new Map<string, number>()
  private readonly cache = new Map<SessionId, CachedSessionFrames>()
  private state: 'idle' | 'running' | 'failed' | 'disposed' = 'idle'
  private done: Promise<void> = Promise.resolve()
  private connectionCount = 0

  constructor(
    private readonly api: ApiProxy,
    private readonly limits: SseMuxLimits,
    private readonly reportError: (error: unknown) => void,
  ) {}

  /** Number of currently registered SSE responses. */
  get connections(): number {
    return this.connectionCount
  }

  /** Shared mux lifecycle state for readiness diagnostics. */
  get muxState(): 'idle' | 'running' | 'failed' | 'disposed' {
    return this.state
  }

  /** Register one response and replay its current session-specific transient baseline. */
  register(userId: string, sessionId: SessionId, lastSeq: number, closeSocket: () => void): SseRegistration {
    if (this.state === 'failed' || this.state === 'disposed') {
      return { ok: false, status: 503, error: 'event stream is unavailable' }
    }
    if (this.connectionCount >= this.limits.maxConnections) {
      return { ok: false, status: 429, error: 'server SSE connection limit reached' }
    }
    const userCount = this.userCounts.get(userId) ?? 0
    if (userCount >= this.limits.maxConnectionsPerUser) {
      return { ok: false, status: 429, error: 'user SSE connection limit reached' }
    }

    const baseline = encode({
      rpcId: RpcId(randomUUID()),
      payload: { type: 'session/subscribed', sessionId, lastSeq },
    })
    const cached = this.cache.get(sessionId)
    const frames = [
      baseline,
      ...cached?.questions.values() ?? [],
      ...cached?.approvals.values() ?? [],
      ...cached?.queue === undefined ? [] : [cached.queue],
      ...cached?.jobs === undefined ? [] : [cached.jobs],
    ]
    const baselineBytes = frames.reduce((total, frame) => total + frame.byteLength, 0)
    if (baselineBytes > this.limits.clientBufferBytes) {
      return { ok: false, status: 503, error: 'session SSE baseline exceeds the configured buffer limit' }
    }

    const client = new SseClient(this.limits.clientBufferBytes, (reason) => {
      const sessionClients = this.clients.get(sessionId)
      sessionClients?.delete(client)
      if (sessionClients?.size === 0) this.clients.delete(sessionId)
      const remaining = (this.userCounts.get(userId) ?? 1) - 1
      if (remaining === 0) this.userCounts.delete(userId)
      else this.userCounts.set(userId, remaining)
      this.connectionCount--
      if (reason === 'overflow' || reason === 'session-disposed' || reason === 'shutdown') closeSocket()
    })
    let sessionClients = this.clients.get(sessionId)
    if (sessionClients === undefined) this.clients.set(sessionId, sessionClients = new Set())
    sessionClients.add(client)
    this.userCounts.set(userId, userCount + 1)
    this.connectionCount++
    for (const frame of frames) client.push(frame)
    this.start()
    return { ok: true, client }
  }

  /** Drop cached state and close subscribers for a disposed session. */
  dropSession(sessionId: SessionId): void {
    this.cache.delete(sessionId)
    for (const client of [...this.clients.get(sessionId) ?? []]) client.close('session-disposed')
  }

  /** Abort the shared mux and release every response queue. */
  async dispose(): Promise<void> {
    if (this.state === 'disposed') return this.done
    this.state = 'disposed'
    this.controller.abort()
    this.closeAll('shutdown')
    await this.done
  }

  private start(): void {
    if (this.state !== 'idle') return
    this.state = 'running'
    this.done = this.consume()
  }

  private async consume(): Promise<void> {
    try {
      for await (const frame of this.api.events.mux(
        { rpcId: RpcId(randomUUID()), payload: {} },
        this.controller.signal,
      )) {
        if (!this.accept(frame)) return
      }
      if (!this.controller.signal.aborted) this.fail(new Error('ApiProxy event mux ended unexpectedly'))
    } catch (error) {
      if (!this.controller.signal.aborted) this.fail(error)
    } finally {
      if (this.state !== 'disposed' && this.state !== 'failed') this.state = 'failed'
      this.closeAll(this.state === 'disposed' ? 'shutdown' : 'mux-ended')
    }
  }

  private accept(frame: RpcRequest<MuxFrame>): boolean {
    const payload = frame.payload
    if (payload.type === 'session/subscribed') return true
    const encoded = encode(frame)
    if (payload.type === 'stream/error') {
      this.reportError(payload.error)
      this.state = 'failed'
      this.pushAll(encode({
        rpcId: frame.rpcId,
        payload: {
          type: 'stream/error',
          error: { code: 'internal', message: PUBLIC_STREAM_ERROR, details: {} },
        },
      }))
      return false
    }
    this.remember(frame, encoded)
    for (const client of [...this.clients.get(payload.sessionId) ?? []]) client.push(encoded)
    return true
  }

  private remember(frame: RpcRequest<MuxFrame>, encoded: Buffer): void {
    const payload = frame.payload
    if (payload.type === 'stream/error' || payload.type === 'session/subscribed') return
    let cached = this.cache.get(payload.sessionId)
    if (cached === undefined) {
      cached = { questions: new Map(), approvals: new Map() }
      this.cache.set(payload.sessionId, cached)
    }
    if (payload.type === 'question/requested') cached.questions.set(String(frame.rpcId), encoded)
    else if (payload.type === 'question/resolved') cached.questions.delete(String(payload.questionRpcId))
    else if (payload.type === 'approval/requested') cached.approvals.set(String(payload.approvalId), encoded)
    else if (payload.type === 'approval/resolved') cached.approvals.delete(String(payload.approvalId))
    else if (payload.type === 'session/queue') cached.queue = encoded
    else if (payload.type === 'session/jobs') cached.jobs = encoded
  }

  private fail(error: unknown): void {
    this.reportError(error)
    this.state = 'failed'
    this.pushAll(encode({
      rpcId: RpcId(randomUUID()),
      payload: {
        type: 'stream/error',
        error: { code: 'internal', message: PUBLIC_STREAM_ERROR, details: {} },
      },
    }))
  }

  private pushAll(frame: Buffer): void {
    for (const clients of this.clients.values()) {
      for (const client of [...clients]) client.push(frame)
    }
  }

  private closeAll(reason: ClientCloseReason): void {
    for (const clients of [...this.clients.values()]) {
      for (const client of [...clients]) client.close(reason)
    }
  }
}
