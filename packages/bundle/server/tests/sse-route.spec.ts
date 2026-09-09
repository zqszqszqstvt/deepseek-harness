/** Shared, bounded SSE delivery for the multi-user Server transport. */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Server from '../src/index.ts'
import { ServerSseMux } from '../src/sse-mux.ts'
import type { ServerStartupValues } from '../src/startup.ts'
import { provideCloudEnvironment } from './environment-testkit.ts'
import { getJson, openSse } from './http-testkit.ts'
import type { SseProbe } from './http-testkit.ts'

class ControlledMux {
  readonly frames: RpcRequest<MuxFrame>[] = []
  calls = 0
  aborted = false
  private wake: (() => void) | undefined

  push(frame: RpcRequest<MuxFrame>): void {
    this.frames.push(frame)
    this.wake?.()
    this.wake = undefined
  }

  async *iterate(signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>> {
    this.calls++
    const abort = (): void => {
      this.aborted = true
      this.wake?.()
      this.wake = undefined
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        const frame = this.frames.shift()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}

function sessionIdFor(userId: string): SessionId {
  const key = createHash('sha256').update(userId).digest('hex')
  return SessionId(`mu_${key.slice(0, 40)}`)
}

function envelope(rpcId: string, payload: MuxFrame): RpcRequest<MuxFrame> {
  return { rpcId: RpcId(rpcId), payload }
}

function approval(
  rpcId: string,
  sessionId: SessionId,
  approvalId: string,
  reason?: string,
): RpcRequest<MuxFrame> {
  return envelope(rpcId, {
    type: 'approval/requested', sessionId, approvalId: approvalId as never, toolName: 'bash',
    ...reason === undefined ? {} : { reason },
  })
}

interface Harness {
  readonly context: Context
  readonly port: number
  readonly source: ControlledMux
}

const contexts: Context[] = []
const dataDirs: string[] = []
const probes: SseProbe[] = []

afterEach(async () => {
  for (const probe of probes.splice(0)) probe.close()
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const dataDir of dataDirs.splice(0)) await rm(dataDir, { recursive: true, force: true })
})

async function start(
  limits: { global?: number; perUser?: number; bufferBytes?: number } = {},
): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-server-sse-'))
  dataDirs.push(dataDir)
  const context = new Context()
  contexts.push(context)
  await context.plugin(SessionStore)
  const source = new ControlledMux()
  const api = {
    sessions: {
      create: async (request: { rpcId: string; payload: { cwd: string; sessionId: string } }) => {
        const sessionId = SessionId(request.payload.sessionId)
        if (context.sessions.get(sessionId) !== undefined) {
          return {
            rpcId: request.rpcId,
            result: { ok: false as const, error: { code: 'session-conflict', message: 'exists', details: {} } },
          }
        }
        context.sessions.create(sessionId, { meta: { cwd: request.payload.cwd } })
        return { rpcId: request.rpcId, result: { ok: true as const, value: {} } }
      },
    },
    events: { mux: (_request: unknown, signal: AbortSignal) => source.iterate(signal) },
  } as unknown as ApiProxy
  const maxSseConnections = limits.global ?? 8
  const maxSseConnectionsPerUser = limits.perUser ?? 2
  const sseClientBufferBytes = limits.bufferBytes ?? 64 * 1024
  context.provide('apiProxy', api)
  context.provide('agents', { get: () => undefined } as never)
  provideCloudEnvironment(context)
  context.provide('serverStartup', {
    dataDir,
    sessionsDir: join(dataDir, 'sessions'),
    maxConcurrentTurns: 2,
    maxSseConnections,
    maxSseConnectionsPerUser,
    sseClientBufferBytes,
  } satisfies ServerStartupValues)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(Server, {
    host: '127.0.0.1', port: 0, dataDir, maxConcurrentTurns: 2,
    maxSseConnections, maxSseConnectionsPerUser, sseClientBufferBytes,
  })
  return { context, port: context.webServer.port, source }
}

async function connect(port: number, userId: string): Promise<SseProbe> {
  const probe = await openSse(port, `/v1/users/${encodeURIComponent(userId)}/events`)
  probes.push(probe)
  return probe
}

describe('server shared SSE route', () => {
  it('opens one ApiProxy mux and dispatches each session frame only to its user', async () => {
    const harness = await start()
    const alice = await connect(harness.port, 'alice')
    const bob = await connect(harness.port, 'bob')
    expect(alice.status).toBe(200)
    expect(bob.status).toBe(200)
    await vi.waitFor(() => { expect(harness.source.calls).toBe(1) })

    harness.source.push(approval('alice-rpc', sessionIdFor('alice'), 'alice-approval'))
    harness.source.push(approval('bob-rpc', sessionIdFor('bob'), 'bob-approval'))
    await alice.waitFor((text) => { expect(text).toContain('alice-approval') })
    await bob.waitFor((text) => { expect(text).toContain('bob-approval') })
    expect(alice.text).not.toContain('bob-approval')
    expect(bob.text).not.toContain('alice-approval')
    await expect(getJson(harness.port, '/readyz')).resolves.toMatchObject({
      status: 200,
      body: { sseConnections: 2, sseConnectionLimit: 8, sseMuxState: 'running' },
    })
  })

  it('replays unresolved interactions and removes them after their resolved frames', async () => {
    const harness = await start()
    const sessionId = sessionIdFor('alice')
    const first = await connect(harness.port, 'alice')
    harness.source.push(envelope('question-rpc', {
      type: 'question/requested', sessionId,
      questions: [{ id: 'runtime', question: 'Runtime?', options: [{ label: 'Docker' }], multiSelect: false }],
    }))
    harness.source.push(approval('approval-rpc', sessionId, 'approval-1'))
    await first.waitFor((text) => { expect(text).toContain('question-rpc') })
    await first.waitFor((text) => { expect(text).toContain('approval-1') })
    first.close()
    await vi.waitFor(async () => {
      const ready = await getJson(harness.port, '/readyz')
      expect(ready.body).toMatchObject({ sseConnections: 0 })
    })

    const replay = await connect(harness.port, 'alice')
    await replay.waitFor((text) => { expect(text).toContain('question-rpc') })
    await replay.waitFor((text) => { expect(text).toContain('approval-1') })
    harness.source.push(envelope('question-resolved', {
      type: 'question/resolved', sessionId, questionRpcId: RpcId('question-rpc'), outcome: 'answered',
    }))
    harness.source.push(envelope('approval-resolved', {
      type: 'approval/resolved', sessionId, approvalId: 'approval-1' as never, outcome: 'rejected',
    }))
    await replay.waitFor((text) => { expect(text).toContain('question/resolved') })
    await replay.waitFor((text) => { expect(text).toContain('approval/resolved') })
    replay.close()
    await vi.waitFor(async () => {
      const ready = await getJson(harness.port, '/readyz')
      expect(ready.body).toMatchObject({ sseConnections: 0 })
    })

    const afterResolution = await connect(harness.port, 'alice')
    await afterResolution.waitFor((text) => { expect(text).toContain('session/subscribed') })
    expect(afterResolution.text).not.toContain('question-rpc')
    expect(afterResolution.text).not.toContain('approval-1')
  })

  it('enforces per-user and process-wide connection limits', async () => {
    const harness = await start({ global: 2, perUser: 1 })
    expect((await connect(harness.port, 'alice')).status).toBe(200)
    const duplicate = await connect(harness.port, 'alice')
    expect(duplicate.status).toBe(429)
    await duplicate.ended
    expect(duplicate.text).toContain('user SSE connection limit reached')

    expect((await connect(harness.port, 'bob')).status).toBe(200)
    const excess = await connect(harness.port, 'charlie')
    expect(excess.status).toBe(429)
    await excess.ended
    expect(excess.text).toContain('server SSE connection limit reached')
  })

  it('aborts the one shared mux and closes responses during Context disposal', async () => {
    const harness = await start()
    const alice = await connect(harness.port, 'alice')
    await harness.context.fiber.dispose()
    contexts.splice(contexts.indexOf(harness.context), 1)
    await expect(alice.ended).resolves.toBeUndefined()
    expect(harness.source.aborted).toBe(true)
  })
})

describe('ServerSseMux queue bounds', () => {
  it('drops an overflowing client without affecting the shared mux reader', async () => {
    const source = new ControlledMux()
    const api = { events: { mux: (_request: unknown, signal: AbortSignal) => source.iterate(signal) } } as ApiProxy
    const mux = new ServerSseMux(
      api,
      { maxConnections: 2, maxConnectionsPerUser: 1, clientBufferBytes: 512 },
      vi.fn(),
    )
    const closeSocket = vi.fn()
    const registered = mux.register('alice', sessionIdFor('alice'), -1, closeSocket)
    expect(registered.ok).toBe(true)
    if (!registered.ok) return
    await registered.client.take()
    source.push(approval('oversized', sessionIdFor('alice'), 'approval-1', 'x'.repeat(1_024)))
    await vi.waitFor(() => { expect(closeSocket).toHaveBeenCalledOnce() })
    expect(mux.connections).toBe(0)
    expect(mux.muxState).toBe('running')
    await mux.dispose()
    expect(source.aborted).toBe(true)
  })

  it('forwards one upstream terminal error and accepts registrations after recovery', async () => {
    const source = new ControlledMux()
    const api = { events: { mux: (_request: unknown, signal: AbortSignal) => source.iterate(signal) } } as ApiProxy
    const reportError = vi.fn()
    const mux = new ServerSseMux(
      api,
      { maxConnections: 2, maxConnectionsPerUser: 1, clientBufferBytes: 512 },
      reportError,
      1,
    )
    const registered = mux.register('alice', sessionIdFor('alice'), -1, vi.fn())
    expect(registered.ok).toBe(true)
    if (!registered.ok) return
    await registered.client.take()
    const terminal = registered.client.take()
    source.push(envelope('terminal', {
      type: 'stream/error', error: { code: 'internal', message: 'upstream ended', details: {} },
    }))

    const terminalText = (await terminal)?.toString('utf8') ?? ''
    expect(terminalText).toContain('event stream failed')
    expect(terminalText).not.toContain('upstream ended')
    expect(reportError).toHaveBeenCalledWith({ code: 'internal', message: 'upstream ended', details: {} })
    await expect(registered.client.take()).resolves.toBeUndefined()
    expect(mux.muxState).toBe('recovering')
    expect(mux.register('bob', sessionIdFor('bob'), -1, vi.fn())).toEqual({
      ok: false, status: 503, error: 'event stream is unavailable',
    })
    await vi.waitFor(() => { expect(mux.muxState).toBe('idle') })
    const recovered = mux.register('bob', sessionIdFor('bob'), -1, vi.fn())
    expect(recovered.ok).toBe(true)
    await vi.waitFor(() => { expect(source.calls).toBe(2) })
    await mux.dispose()
  })
})
