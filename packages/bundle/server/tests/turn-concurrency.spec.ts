/** Server turn admission and whole-agent concurrency ownership. */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Server from '../src/index.ts'
import type { ServerStartupValues } from '../src/startup.ts'
import { getJson, postJson } from './http-testkit.ts'

interface PromptCall { sessionId: string; mode: 'queue' | 'steer'; message: string }

class ControlledAgent {
  status: AgentStatus = 'idle'
  private idle = Promise.resolve()
  private finishIdle: (() => void) | undefined

  start(): void {
    if (this.status === 'running') return
    this.status = 'running'
    this.idle = new Promise((resolve) => { this.finishIdle = resolve })
  }

  finish(): void {
    if (this.status === 'idle') return
    this.status = 'idle'
    this.finishIdle?.()
    this.finishIdle = undefined
  }

  whenIdle(): Promise<void> {
    return this.idle
  }
}

let context: Context | undefined
let dataDir: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true })
  dataDir = undefined
})

function sessionIdFor(userId: string): string {
  const key = createHash('sha256').update(userId).digest('hex')
  return `mu_${key.slice(0, 40)}`
}

async function start(limit: number): Promise<{
  port: number
  agents: Map<string, ControlledAgent>
  created: string[]
  prompts: PromptCall[]
}> {
  dataDir = await mkdtemp(join(tmpdir(), 'dsh-server-turns-'))
  context = new Context()
  const agents = new Map<string, ControlledAgent>()
  const created: string[] = []
  const prompts: PromptCall[] = []
  const api = {
    sessions: {
      create: async (request: { rpcId: string; payload: { sessionId: string } }) => {
        created.push(request.payload.sessionId)
        if (!agents.has(request.payload.sessionId)) agents.set(request.payload.sessionId, new ControlledAgent())
        return { rpcId: request.rpcId, result: { ok: true as const, value: {} } }
      },
      prompt: async (request: { rpcId: string; payload: { sessionId: string; mode: 'queue' | 'steer'; content: { type: string; text: string }[] } }) => {
        const agent = agents.get(request.payload.sessionId)
        if (agent === undefined) throw new Error('prompt reached an unknown test agent')
        prompts.push({
          sessionId: request.payload.sessionId,
          mode: request.payload.mode,
          message: request.payload.content[0]?.text ?? '',
        })
        agent.start()
        return { rpcId: request.rpcId, result: { ok: true as const, value: { accepted: true as const } } }
      },
    },
  } as unknown as ApiProxy
  context.provide('apiProxy', api)
  context.provide('agents', { get: (sessionId: string) => agents.get(sessionId) } as never)
  context.provide('serverStartup', {
    dataDir,
    sessionsDir: join(dataDir, 'sessions'),
    maxConcurrentTurns: limit,
  } satisfies ServerStartupValues)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(Server, { host: '127.0.0.1', port: 0, dataDir, maxConcurrentTurns: limit })
  return { port: context.webServer.port, agents, created, prompts }
}

function postTurn(port: number, userId: string, message: string, mode: 'queue' | 'steer' = 'queue'): Promise<{ status: number; body: unknown }> {
  return postJson(port, `/v1/users/${encodeURIComponent(userId)}/turns`, { message, mode })
}

describe('server turn concurrency', () => {
  it('keeps later same-user queue prompts out of the agent inbox until idle', async () => {
    const harness = await start(2)
    const first = postTurn(harness.port, 'alice', 'first')
    await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
    const second = postTurn(harness.port, 'alice', 'second')
    await vi.waitFor(() => expect(harness.created).toHaveLength(2))
    expect(harness.prompts.map(call => call.message)).toEqual(['first'])

    harness.agents.get(sessionIdFor('alice'))?.finish()
    await expect(first).resolves.toEqual({ status: 200, body: { ok: true, value: { accepted: true } } })
    await vi.waitFor(() => expect(harness.prompts.map(call => call.message)).toEqual(['first', 'second']))
    harness.agents.get(sessionIdFor('alice'))?.finish()
    await expect(second).resolves.toEqual({ status: 200, body: { ok: true, value: { accepted: true } } })
  })

  it('holds the global permit until the running user reaches idle', async () => {
    const harness = await start(1)
    const alice = postTurn(harness.port, 'alice', 'alice work')
    await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
    await expect(getJson(harness.port, '/readyz')).resolves.toEqual({
      status: 200,
      body: { ok: true, running: 1, limit: 1 },
    })
    const bob = postTurn(harness.port, 'bob', 'bob work')
    await vi.waitFor(() => expect(harness.created).toHaveLength(2))
    expect(harness.prompts.map(call => call.sessionId)).toEqual([sessionIdFor('alice')])

    harness.agents.get(sessionIdFor('alice'))?.finish()
    await expect(alice).resolves.toEqual({ status: 200, body: { ok: true, value: { accepted: true } } })
    await vi.waitFor(() => expect(harness.prompts.map(call => call.sessionId)).toEqual([
      sessionIdFor('alice'), sessionIdFor('bob'),
    ]))
    harness.agents.get(sessionIdFor('bob'))?.finish()
    await expect(bob).resolves.toEqual({ status: 200, body: { ok: true, value: { accepted: true } } })
    await expect(getJson(harness.port, '/readyz')).resolves.toEqual({
      status: 200,
      body: { ok: true, running: 0, limit: 1 },
    })
  })

  it('admits steering into a running turn without waiting for its idle boundary', async () => {
    const harness = await start(1)
    const turn = postTurn(harness.port, 'alice', 'start')
    await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

    const steer = postTurn(harness.port, 'alice', 'adjust', 'steer')
    await vi.waitFor(() => expect(harness.prompts).toHaveLength(2))
    await expect(steer).resolves.toEqual({ status: 200, body: { ok: true, value: { accepted: true } } })
    expect(harness.prompts.map(call => call.mode)).toEqual(['queue', 'steer'])

    harness.agents.get(sessionIdFor('alice'))?.finish()
    await expect(turn).resolves.toEqual({ status: 200, body: { ok: true, value: { accepted: true } } })
  })
})
