/** Deleting an initialized project must release its live agent/session handle. */

import { createHash } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import * as Server from '../src/index.ts'
import type { ServerStartupValues } from '../src/startup.ts'
import { provideCloudEnvironment } from './environment-testkit.ts'
import { deleteJson, putJson } from './http-testkit.ts'

const contexts: Context[] = []
const dataDirs: string[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose().catch(() => {})
  for (const dataDir of dataDirs.splice(0)) await rm(dataDir, { recursive: true, force: true })
})

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Production-shaped harness: the mock apiProxy routes creation through the real
 * AgentRegistry (like Host.ensureSession) and keeps the returned handle for
 * sessions.release — the exact path the DELETE route depends on.
 */
async function start(): Promise<{ port: number; dataDir: string; userKey: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-server-delete-live-'))
  dataDirs.push(dataDir)
  const context = new Context()
  contexts.push(context)
  await context.plugin(SessionStore)
  await context.plugin(AgentRegistry)
  await context.plugin(JsonlSessionPersistence, { root: join(dataDir, 'sessions'), compression: 'none' })
  // Scripted factory shaped like dsh-agent-loop: prepare + enter + announce,
  // with the handle owning both detach closures.
  context.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      const session = context.sessions.prepare(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const detachSession = context.sessions.enter(session)
      context.sessions.announce(session)
      let idle = Promise.resolve()
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        options: options.agentOptions ?? {},
        session,
        inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
        status: 'idle',
        ctx: agentCtx,
        cancel: () => {},
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (_message: UserMessage) => {},
        steer: () => {},
        inject: () => {},
        whenIdle: () => idle,
      } satisfies Partial<Agent>)
      await options.setup?.(agentCtx)
      const detachAgent = context.agents.register(agent)
      return {
        agent,
        dispose: async () => {
          idle = idle.then(() => undefined)
          detachAgent()
          detachSession()
        },
      }
    },
    resume: () => Promise.reject(new Error('not used')),
  })
  const handles = new Map<string, AgentHandle>()
  const api = {
    sessions: {
      create: async (request: { rpcId: string; payload: { cwd: string; sessionId: string } }) => {
        const handle = await context.agents.create({
          sessionId: SessionId(request.payload.sessionId),
          meta: { cwd: request.payload.cwd },
        })
        handles.set(request.payload.sessionId, handle)
        return {
          rpcId: request.rpcId,
          result: { ok: true as const, value: { sessionId: handle.agent.id } },
        }
      },
      release: async (request: { rpcId: string; payload: { sessionId: string } }) => {
        const handle = handles.get(request.payload.sessionId)
        if (handle === undefined) {
          return { rpcId: request.rpcId, result: { ok: true as const, value: { released: false } } }
        }
        handles.delete(request.payload.sessionId)
        await handle.dispose()
        return { rpcId: request.rpcId, result: { ok: true as const, value: { released: true } } }
      },
      history: async (request: { rpcId: string; payload: { sessionId: string } }) => ({
        rpcId: request.rpcId,
        result: { ok: true as const, value: { sessionId: request.payload.sessionId } },
      }),
    },
  } as unknown as ApiProxy
  context.provide('apiProxy', api)
  provideCloudEnvironment(context)
  context.provide('serverStartup', {
    dataDir,
    sessionsDir: join(dataDir, 'sessions'),
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
  return { port: context.webServer.port, dataDir, userKey: digest('alice') }
}

describe('deleting initialized projects', () => {
  it('releases the live session before removing persisted state', async () => {
    const harness = await start()
    const path = '/v1/users/alice/projects/alpha/session'
    // PUT provisions the project: the session becomes live in the store with an agent.
    await putJson(harness.port, path)
    const context = contexts[contexts.length - 1]
    if (context === undefined) throw new Error('server context was not registered')
    const sessionId = SessionId(`mp_${digest('alice\0alpha').slice(0, 40)}`)
    expect(context.sessions.get(sessionId)).toBeDefined()
    expect(context.agents.get(sessionId)).toBeDefined()

    await expect(deleteJson(harness.port, path)).resolves.toEqual({
      status: 200,
      body: { ok: true, value: { deleted: true } },
    })
    expect(context.sessions.get(sessionId)).toBeUndefined()
    expect(context.agents.get(sessionId)).toBeUndefined()

    const directory = join(harness.dataDir, 'users', harness.userKey, 'projects', digest('alpha'))
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    // Idempotent: deleting again stays successful.
    await expect(deleteJson(harness.port, path)).resolves.toMatchObject({ status: 200 })
  })
})
