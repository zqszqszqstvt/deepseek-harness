/** Project-scoped Session identity through the real Server HTTP route. */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import * as Server from '../src/index.ts'
import type { ServerStartupValues } from '../src/startup.ts'
import { provideCloudEnvironment } from './environment-testkit.ts'
import { getJson } from './http-testkit.ts'

interface CreateCall {
  readonly cwd: string
  readonly sessionId: string
}

const contexts: Context[] = []
const dataDirs: string[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const dataDir of dataDirs.splice(0)) await rm(dataDir, { recursive: true, force: true })
})

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function projectSessionId(userId: string, projectId: string): string {
  return `mp_${digest(`${userId}\0${projectId}`).slice(0, 40)}`
}

async function start(corsOrigin?: string): Promise<{ port: number; dataDir: string; creates: CreateCall[] }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-server-projects-'))
  dataDirs.push(dataDir)
  const context = new Context()
  contexts.push(context)
  await context.plugin(SessionStore)
  const creates: CreateCall[] = []
  const api = {
    sessions: {
      create: async (request: { rpcId: string; payload: CreateCall }) => {
        creates.push(request.payload)
        const sessionId = SessionId(request.payload.sessionId)
        if (context.sessions.get(sessionId) !== undefined) {
          return {
            rpcId: request.rpcId,
            result: { ok: false as const, error: { code: 'session-conflict', message: 'exists', details: {} } },
          }
        }
        context.sessions.create(sessionId, { meta: { cwd: request.payload.cwd } })
        return { rpcId: request.rpcId, result: { ok: true as const, value: { sessionId } } }
      },
      history: async (request: { rpcId: string; payload: { sessionId: string } }) => ({
        rpcId: request.rpcId,
        result: { ok: true as const, value: { sessionId: request.payload.sessionId } },
      }),
    },
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
    ...corsOrigin === undefined ? {} : { corsOrigin },
  } satisfies ServerStartupValues)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(Server, {
    host: '127.0.0.1', port: 0, dataDir, maxConcurrentTurns: 2,
    maxSseConnections: 8, maxSseConnectionsPerUser: 2, sseClientBufferBytes: 64 * 1024,
    ...corsOrigin === undefined ? {} : { corsOrigin },
  })
  return { port: context.webServer.port, dataDir, creates }
}

function preflight(port: number, path: string): Promise<{ status: number; headers: NodeJS.Dict<string | string[]> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'OPTIONS' }, (res) => {
      res.resume()
      res.once('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
    })
    req.once('error', reject)
    req.end()
  })
}

describe('server project routes', () => {
  it('allows explicit browser preflight without enabling CORS by default', async () => {
    const corsHarness = await start('*')
    const allowed = await preflight(corsHarness.port, '/v1/users/alice/projects/alpha/history')
    expect(allowed).toMatchObject({
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    })

    const defaultHarness = await start()
    const denied = await preflight(defaultHarness.port, '/v1/users/alice/projects/alpha/history')
    expect(denied.status).toBe(404)
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('gives each user project a stable isolated Session and workspace', async () => {
    const harness = await start()
    const alphaPath = '/v1/users/alice/projects/alpha/history'
    const betaPath = '/v1/users/alice/projects/beta/history'

    await expect(getJson(harness.port, alphaPath)).resolves.toEqual({
      status: 200,
      body: { ok: true, value: { sessionId: projectSessionId('alice', 'alpha') } },
    })
    await expect(getJson(harness.port, betaPath)).resolves.toEqual({
      status: 200,
      body: { ok: true, value: { sessionId: projectSessionId('alice', 'beta') } },
    })
    await expect(getJson(harness.port, alphaPath)).resolves.toEqual({
      status: 200,
      body: { ok: true, value: { sessionId: projectSessionId('alice', 'alpha') } },
    })

    const userKey = digest('alice')
    expect(harness.creates).toEqual([
      {
        sessionId: projectSessionId('alice', 'alpha'),
        cwd: join(harness.dataDir, 'users', userKey, 'projects', digest('alpha'), 'workspace'),
      },
      {
        sessionId: projectSessionId('alice', 'beta'),
        cwd: join(harness.dataDir, 'users', userKey, 'projects', digest('beta'), 'workspace'),
      },
      {
        sessionId: projectSessionId('alice', 'alpha'),
        cwd: join(harness.dataDir, 'users', userKey, 'projects', digest('alpha'), 'workspace'),
      },
    ])
  })

  it('maps the legacy user route and explicit default project to the original Session', async () => {
    const harness = await start()
    const userKey = digest('alice')
    const sessionId = `mu_${userKey.slice(0, 40)}`

    await expect(getJson(harness.port, '/v1/users/alice/history')).resolves.toEqual({
      status: 200,
      body: { ok: true, value: { sessionId } },
    })
    await expect(getJson(harness.port, '/v1/users/alice/projects/default/history')).resolves.toEqual({
      status: 200,
      body: { ok: true, value: { sessionId } },
    })
    expect(harness.creates).toEqual([
      { sessionId, cwd: join(harness.dataDir, 'users', userKey, 'workspace') },
      { sessionId, cwd: join(harness.dataDir, 'users', userKey, 'workspace') },
    ])
  })
})
