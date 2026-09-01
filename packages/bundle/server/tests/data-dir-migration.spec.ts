/** Server data-root relocation through the real JSONL persistence backend. */

import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import SessionStore, { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Server from '../src/index.ts'
import type { ServerStartupValues } from '../src/startup.ts'
import { provideCloudEnvironment } from './environment-testkit.ts'
import { getJson } from './http-testkit.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function identity(userId: string): { key: string; sessionId: SessionId } {
  const key = createHash('sha256').update(userId).digest('hex')
  return { key, sessionId: SessionId(`mu_${key.slice(0, 40)}`) }
}

const EVENTS: SessionEvent[] = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

async function start(storedCwd: (root: string, key: string) => string): Promise<{
  context: Context
  persistence: JsonlSessionPersistence
  port: number
  root: string
  sessionId: SessionId
  currentCwd: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-server-relocation-'))
  roots.push(root)
  const dataDir = join(root, 'new-data')
  const sessionsDir = join(dataDir, 'sessions')
  const { key, sessionId } = identity('alice')
  const currentCwd = join(dataDir, 'users', key, 'workspace')
  const context = new Context()
  contexts.push(context)
  await context.plugin(SessionStore)
  await context.plugin(JsonlSessionPersistence, { root: sessionsDir, compression: 'none' })
  const persistence = context.sessionPersistence as JsonlSessionPersistence
  const header: SessionHeader = {
    version: 0,
    id: sessionId,
    createdAt: 1,
    cwd: storedCwd(root, key),
  }
  await persistence.create(header)
  await persistence.append(sessionId, EVENTS)

  const api = {
    sessions: {
      create: async (request: { rpcId: string; payload: { cwd: string; sessionId: SessionId } }) => {
        const stored = await persistence.load(request.payload.sessionId)
        if (stored.meta.cwd !== request.payload.cwd) {
          return {
            rpcId: request.rpcId,
            result: {
              ok: false as const,
              error: {
                code: 'session-conflict' as const,
                message: 'cwd conflict',
                details: {
                  sessionId: request.payload.sessionId,
                  requestedCwd: request.payload.cwd,
                  existingCwd: stored.meta.cwd,
                },
              },
            },
          }
        }
        if (context.sessions.get(request.payload.sessionId) === undefined) {
          context.sessions.create(request.payload.sessionId, {
            seed: structuredClone(stored.events),
            meta: {
              cwd: stored.meta.cwd,
              createdAt: stored.meta.createdAt,
              ...(stored.meta.agentPreset === undefined ? {} : { agentPreset: stored.meta.agentPreset }),
            },
          })
        }
        return { rpcId: request.rpcId, result: { ok: true as const, value: { sessionId: request.payload.sessionId } } }
      },
      history: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: { ok: true as const, value: { events: [], hasMore: false } },
      }),
    },
  } as unknown as ApiProxy
  context.provide('apiProxy', api)
  context.provide('agents', { get: () => undefined } as never)
  provideCloudEnvironment(context)
  context.provide('serverStartup', {
    dataDir,
    sessionsDir,
    maxConcurrentTurns: 2,
    maxSseConnections: 8,
    maxSseConnectionsPerUser: 2,
    sseClientBufferBytes: 64 * 1024,
  } satisfies ServerStartupValues)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(Server, {
    host: '127.0.0.1', port: 0, dataDir, maxConcurrentTurns: 2,
    maxSseConnections: 8, maxSseConnectionsPerUser: 2, sseClientBufferBytes: 64 * 1024,
  })
  return { context, persistence, port: context.webServer.port, root, sessionId, currentCwd }
}

describe('server data directory relocation', () => {
  it('moves a copied user session from its prior Server data root', async () => {
    const harness = await start((root, key) => join(root, 'old-data', 'users', key, 'workspace'))

    await expect(getJson(harness.port, '/v1/users/alice/history')).resolves.toEqual({
      status: 200,
      body: { ok: true, value: { events: [], hasMore: false } },
    })
    expect((await harness.persistence.inspect(harness.sessionId)).meta.cwd).toBe(harness.currentCwd)
    expect((await stat(harness.currentCwd)).isDirectory()).toBe(true)
  })

  it('does not relocate a same-id session outside the Server user layout', async () => {
    const harness = await start(root => join(root, 'unrelated-project'))
    const logged = vi.spyOn(harness.context.logger, 'error').mockImplementation(() => undefined)

    const result = await getJson(harness.port, '/v1/users/alice/history')

    expect(result).toEqual({ status: 500, body: { ok: false, error: 'server request failed' } })
    expect(logged).toHaveBeenCalledOnce()
    expect((await harness.persistence.inspect(harness.sessionId)).meta.cwd).toBe(join(harness.root, 'unrelated-project'))
  })
})
