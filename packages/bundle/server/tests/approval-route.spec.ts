/** HTTP interactive response bridges for the multi-user server. */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ApiProxy, ClientResponse, RpcReceipt } from '@deepseek-ai/dsh-host-apiproxy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Server from '../src/index.ts'
import type { ServerStartupValues } from '../src/startup.ts'
import { provideCloudEnvironment } from './environment-testkit.ts'
import { getJson, postJson } from './http-testkit.ts'

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
  await context.plugin(SessionStore)
  const api = {
    sessions: {
      create: async (request: { rpcId: string; payload: { cwd: string; sessionId: string } }) => {
        if (context?.sessions.get(SessionId(request.payload.sessionId)) !== undefined) {
          return { rpcId: request.rpcId, result: { ok: false as const, error: { code: 'session-conflict', message: 'exists', details: {} } } }
        }
        context?.sessions.create(SessionId(request.payload.sessionId), { meta: { cwd: request.payload.cwd } })
        return { rpcId: request.rpcId, result: { ok: true as const, value: {} } }
      },
      history: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: {
          ok: false as const,
          error: {
            code: 'internal' as const,
            message: 'could not read /srv/dsh-data/users/private/session.jsonl',
            details: {},
          },
        },
      }),
    },
    respond,
  } as unknown as ApiProxy
  context.provide('apiProxy', api)
  context.provide('agents', { get: () => undefined } as never)
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
  return context.webServer.port
}

async function post(port: number, userId: string, approvalId: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return postJson(port, `/v1/users/${encodeURIComponent(userId)}/approvals/${encodeURIComponent(approvalId)}`, body)
}

async function postQuestion(port: number, userId: string, rpcId: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return postJson(port, `/v1/users/${encodeURIComponent(userId)}/questions/${encodeURIComponent(rpcId)}`, body)
}

describe('server approval route', () => {
  it('bridges an allowed-once answer with the session derived from the URL user', async () => {
    const seen: ClientResponse[] = []
    const port = await start((message) => {
      seen.push(message)
      return Promise.resolve({ accepted: true })
    })

    const result: { status: number; body: unknown } = await post(
      port,
      'alice',
      'approval-1',
      { rpcId: 'request-1', outcome: 'allowed-once' },
    )

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

  it('keeps thrown host paths in server logs and out of HTTP responses', async () => {
    const port = await start(() => Promise.reject(new Error('permission denied: /srv/dsh-data/users/private')))
    let reported: unknown
    vi.spyOn(context!.logger, 'error').mockImplementation((value: unknown) => { reported = value })

    const result = await post(port, 'alice', 'approval-1', { rpcId: 'request-1', outcome: 'allowed-once' })

    expect(result).toEqual({ status: 500, body: { ok: false, error: 'server request failed' } })
    expect(JSON.stringify(result)).not.toContain('/srv/dsh-data')
    expect(reported).toBeInstanceOf(Error)
    if (!(reported instanceof Error)) throw new Error('expected one logged Error')
    expect(String(reported.cause)).toContain('/srv/dsh-data')
  })

  it('keeps ApiProxy failure details out of HTTP responses', async () => {
    const port = await start(() => Promise.resolve({ accepted: true }))
    const logged = vi.spyOn(context!.logger, 'error').mockImplementation(() => undefined)

    const result: { status: number; body: unknown } = await getJson(port, '/v1/users/alice/history')

    expect(result).toEqual({ status: 500, body: { ok: false, error: 'server request failed' } })
    expect(JSON.stringify(result)).not.toContain('/srv/dsh-data')
    expect(logged).toHaveBeenCalledWith('dsh server history failed: %o', expect.objectContaining({ ok: false }))
  })
})

describe('server question route', () => {
  it('bridges the complete answer batch with the session derived from the URL user', async () => {
    const seen: ClientResponse[] = []
    const port = await start((message) => {
      seen.push(message)
      return Promise.resolve({ accepted: true })
    })
    const answer = {
      answers: [
        { id: 'runtime', selected: ['Docker'] },
        { id: 'notes', selected: [], custom: 'Use the internal registry' },
      ],
    }

    const result = await postQuestion(port, 'alice', 'question-1', answer)

    expect(result).toEqual({ status: 200, body: { accepted: true } })
    expect(seen).toEqual([{
      type: 'client-response',
      rpcId: 'question-1',
      result: {
        ok: true,
        value: { sessionId: sessionIdFor('alice'), answer },
      },
    }])
  })

  it('cannot answer another user session through a different user route', async () => {
    const aliceSessionId = sessionIdFor('alice')
    const port = await start(async (message) => {
      const value = message.result.ok ? message.result.value as { sessionId?: unknown } : undefined
      return message.rpcId === 'alice-question' && value?.sessionId === aliceSessionId
        ? { accepted: true }
        : { accepted: false, reason: 'bad-response' }
    })

    expect(await postQuestion(port, 'bob', 'alice-question', { answers: [{ id: 'runtime', selected: ['Docker'] }] }))
      .toEqual({ status: 200, body: { accepted: false, reason: 'bad-response' } })
    expect(await postQuestion(port, 'alice', 'alice-question', { answers: [{ id: 'runtime', selected: ['Docker'] }] }))
      .toEqual({ status: 200, body: { accepted: true } })
  })

  it('rejects non-object bodies and delegates answer validation to ApiProxy', async () => {
    const seen: ClientResponse[] = []
    const port = await start((message) => {
      seen.push(message)
      return Promise.resolve({ accepted: false, reason: 'bad-response' })
    })

    expect(await postQuestion(port, 'alice', 'question-1', null))
      .toEqual({ status: 400, body: { ok: false, error: 'request body must be a JSON object' } })
    expect(await postQuestion(port, 'alice', 'question-1', { answers: 'not-an-array' }))
      .toEqual({ status: 200, body: { accepted: false, reason: 'bad-response' } })
    expect(seen).toHaveLength(1)
  })
})
