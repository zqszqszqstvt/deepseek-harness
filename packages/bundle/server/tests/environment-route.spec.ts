/** Project environment management through the real Server HTTP route. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import ServerEnvironments, { ServerDeviceId } from '../src/environments.ts'
import * as Server from '../src/index.ts'
import type { ServerStartupValues } from '../src/startup.ts'
import { getJson, postJson } from './http-testkit.ts'

let context: Context | undefined
let dataDir: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true })
  dataDir = undefined
})

async function start(): Promise<number> {
  dataDir = await mkdtemp(join(tmpdir(), 'dsh-server-environment-route-'))
  context = new Context()
  await context.plugin(SessionStore)
  await context.plugin(Storage)
  await context.plugin(StorageJson, { root: join(dataDir, 'storage') })
  await context.plugin(StorageDomain, { backend: 'json' })
  await context.plugin(ServerEnvironments)
  const api = {
    sessions: {
      create: async (request: { rpcId: string; payload: { cwd: string; sessionId: string } }) => {
        const sessionId = SessionId(request.payload.sessionId)
        if (context?.sessions.get(sessionId) === undefined) {
          context?.sessions.create(sessionId, { meta: { cwd: request.payload.cwd } })
        }
        return { rpcId: request.rpcId, result: { ok: true as const, value: { sessionId } } }
      },
    },
  } as unknown as ApiProxy
  context.provide('apiProxy', api)
  context.provide('agents', { get: () => undefined } as never)
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

describe('server environment routes', () => {
  it('lists, switches, and retains an offline active local environment', async () => {
    const port = await start()
    const unregister = context!.serverEnvironments.registerExecutor({
      userId: 'alice',
      deviceId: ServerDeviceId('desktop-1'),
      deviceName: 'Alice PC',
      platform: 'win32',
      arch: 'x64',
      shell: 'powershell',
      capabilities: ['filesystem', 'subprocess'],
      workspaces: [{ projectId: 'alpha', rootPath: 'D:\\projects\\alpha' }],
    })
    const path = '/v1/users/alice/projects/alpha'

    const listed = await getJson(port, `${path}/environments`)
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({
      ok: true,
      value: {
        activeBindingId: 'cloud',
        environmentEpoch: 0,
        environments: expect.arrayContaining([
          expect.objectContaining({ bindingId: 'cloud', status: 'online' }),
          expect.objectContaining({
            bindingId: 'local:desktop-1', status: 'online', rootPath: 'D:\\projects\\alpha',
          }),
        ]),
      },
    })

    expect(await postJson(port, `${path}/environment`, { bindingId: 'local:desktop-1' }))
      .toMatchObject({ status: 200, body: { ok: true, value: {
        activeBindingId: 'local:desktop-1', environmentEpoch: 1,
      } } })

    unregister()
    expect(await getJson(port, `${path}/environments`)).toMatchObject({
      status: 200,
      body: { ok: true, value: {
        activeBindingId: 'local:desktop-1',
        environmentEpoch: 1,
        environments: expect.arrayContaining([
          expect.objectContaining({ bindingId: 'local:desktop-1', status: 'offline' }),
        ]),
      } },
    })
  })

  it('validates switch requests and reports unavailable targets as a conflict', async () => {
    const port = await start()
    const path = '/v1/users/alice/projects/alpha/environment'

    expect(await postJson(port, path, null)).toEqual({
      status: 400,
      body: { ok: false, error: 'request body must be a JSON object' },
    })
    expect(await postJson(port, path, { bindingId: '' })).toEqual({
      status: 400,
      body: { ok: false, error: 'bindingId must be a non-empty string' },
    })
    expect(await postJson(port, path, { bindingId: 'local:missing' })).toEqual({
      status: 409,
      body: { ok: false, error: 'environment unavailable' },
    })
  })
})
