/** HTTP approval response bridge for the multi-user server. */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ApiProxy, ClientResponse, RpcReceipt } from '@deepseek-ai/dsh-host-apiproxy'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import * as Server from '../src/index.ts'
import type { ServerStartupValues } from '../src/startup.ts'

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

async function start(respond: (message: ClientResponse) => Promise<RpcReceipt>): Promise<number> {
  dataDir = await mkdtemp(join(tmpdir(), 'dsh-server-approval-'))
  context = new Context()
  const api = {
    sessions: {
      create: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: { ok: true as const, value: {} },
      }),
    },
    respond,
  } as unknown as ApiProxy
  context.provide('apiProxy', api)
  context.provide('serverStartup', {
    dataDir,
    sessionsDir: join(dataDir, 'sessions'),
    maxConcurrentTurns: 2,
  } satisfies ServerStartupValues)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(Server, { host: '127.0.0.1', port: 0, dataDir, maxConcurrentTurns: 2 })
  return context.webServer.port
}

async function post(port: number, userId: string, approvalId: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/v1/users/${encodeURIComponent(userId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

describe('server approval route', () => {
  it('bridges an allowed-once answer with the session derived from the URL user', async () => {
    const seen: ClientResponse[] = []
    const port = await start((message) => {
      seen.push(message)
      return Promise.resolve({ accepted: true })
    })

    const result = await post(port, 'alice', 'approval-1', { rpcId: 'request-1', outcome: 'allowed-once' })

    expect(result).toEqual({ status: 200, body: { accepted: true } })
    expect(seen).toEqual([{
      type: 'client-response',
      rpcId: 'request-1',
      result: {
        ok: true,
        value: { sessionId: sessionIdFor('alice'), approvalId: 'approval-1', outcome: 'allowed-once' },
      },
    }])
  })

  it('cannot approve another user session through a different user route', async () => {
    const aliceSessionId = sessionIdFor('alice')
    let pending = true
    const port = await start(async (message) => {
      const value = message.result.ok ? message.result.value as { sessionId?: unknown } : undefined
      if (message.rpcId !== 'alice-request' || value?.sessionId !== aliceSessionId) {
        return { accepted: false, reason: 'bad-response' }
      }
      pending = false
      return { accepted: true }
    })

    expect(await post(port, 'bob', 'approval-1', { rpcId: 'alice-request', outcome: 'allowed-once' }))
      .toEqual({ status: 200, body: { accepted: false, reason: 'bad-response' } })
    expect(pending).toBe(true)
    expect(await post(port, 'alice', 'approval-1', { rpcId: 'alice-request', outcome: 'rejected' }))
      .toEqual({ status: 200, body: { accepted: true } })
    expect(pending).toBe(false)
  })

  it('rejects malformed answers before calling ApiProxy.respond', async () => {
    const seen: ClientResponse[] = []
    const port = await start((message) => {
      seen.push(message)
      return Promise.resolve({ accepted: true })
    })

    expect(await post(port, 'alice', 'approval-1', null))
      .toEqual({ status: 400, body: { ok: false, error: 'request body must be a JSON object' } })
    expect(await post(port, 'alice', 'approval-1', { rpcId: '', outcome: 'always' }))
      .toEqual({ status: 400, body: { ok: false, error: 'rpcId must be a non-empty string' } })
    expect(await post(port, 'alice', 'approval-1', { rpcId: 'request-1', outcome: 'always' }))
      .toEqual({ status: 400, body: { ok: false, error: 'outcome must be allowed-once or rejected' } })
    expect(seen).toEqual([])
  })
})
