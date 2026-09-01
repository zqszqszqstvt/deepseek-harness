/** Durable environment selection and live executor publication. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import ServerEnvironments, { ServerBindingId, ServerDeviceId } from '../src/environments.ts'
import { parseProjectRoute, projectSessionState, type ProjectSessionState } from '../src/project-session.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function state(root: string, userId: string, projectId: string): ProjectSessionState {
  const route = parseProjectRoute(`/v1/users/${userId}/projects/${projectId}/environments`)
  if (route === undefined) throw new Error('test project route is invalid')
  return projectSessionState(root, route.identity)
}

async function start(root?: string): Promise<{ context: Context; root: string }> {
  const storageRoot = root ?? await mkdtemp(join(tmpdir(), 'dsh-server-environments-'))
  if (root === undefined) roots.push(storageRoot)
  const context = new Context()
  contexts.push(context)
  await context.plugin(Storage)
  await context.plugin(StorageJson, { root: join(storageRoot, 'storage') })
  await context.plugin(StorageDomain, { backend: 'json' })
  await context.plugin(ServerEnvironments)
  return { context, root: storageRoot }
}

describe('server environments', () => {
  it('binds one project identity to each Server Session and rejects conflicts', async () => {
    const harness = await start()
    const alpha = state(harness.root, 'alice', 'alpha')
    const conflicting = { ...state(harness.root, 'alice', 'other-project'), sessionId: alpha.sessionId }

    harness.context.serverEnvironments.bindProject(alpha)
    harness.context.serverEnvironments.bindProject({ ...alpha })
    expect(harness.context.serverEnvironments.projectForSession(String(alpha.sessionId)))
      .toMatchObject({ state: alpha, view: { activeBindingId: 'cloud', environmentEpoch: 0 } })
    expect(() => harness.context.serverEnvironments.bindProject(conflicting))
      .toThrow(/already bound to another project/)
  })

  it('starts every project on its own cloud workspace', async () => {
    const harness = await start()
    const alpha = state(harness.root, 'alice', 'alpha')

    expect(harness.context.serverEnvironments.project(alpha)).toEqual({
      sessionId: alpha.sessionId,
      activeBindingId: 'cloud',
      environmentEpoch: 0,
      environments: [{
        bindingId: 'cloud',
        environmentId: 'cloud',
        type: 'cloud',
        status: 'online',
        rootPath: alpha.cwd,
        platform: process.platform,
        arch: process.arch,
        shell: process.platform === 'win32' ? 'powershell' : 'bash',
        capabilities: ['filesystem', 'subprocess', 'shell'],
      }],
    })
  })

  it('publishes only executor workspaces bound to the requested user project', async () => {
    const harness = await start()
    const alpha = state(harness.root, 'alice', 'alpha')
    const beta = state(harness.root, 'alice', 'beta')
    const otherUser = state(harness.root, 'bob', 'alpha')
    const dispose = harness.context.serverEnvironments.registerExecutor({
      userId: 'alice',
      deviceId: ServerDeviceId('desktop-1'),
      deviceName: 'Alice PC',
      platform: 'win32',
      arch: 'x64',
      shell: 'powershell',
      capabilities: ['filesystem', 'subprocess'],
      workspaces: [{ projectId: 'alpha', rootPath: 'D:\\projects\\alpha' }],
    })

    expect(harness.context.serverEnvironments.project(alpha).environments[1]).toMatchObject({
      bindingId: 'local:desktop-1',
      status: 'online',
      rootPath: 'D:\\projects\\alpha',
    })
    expect(harness.context.serverEnvironments.project(beta).environments).toHaveLength(1)
    expect(harness.context.serverEnvironments.project(otherUser).environments).toHaveLength(1)

    dispose()
    expect(harness.context.serverEnvironments.project(alpha).environments).toHaveLength(1)
  })

  it('persists selection and epoch while retaining a disconnected active local binding', async () => {
    const first = await start()
    const alpha = state(first.root, 'alice', 'alpha')
    const unregister = first.context.serverEnvironments.registerExecutor({
      userId: 'alice',
      deviceId: ServerDeviceId('desktop-1'),
      deviceName: 'Alice PC',
      platform: 'win32',
      arch: 'x64',
      shell: 'powershell',
      capabilities: ['filesystem'],
      workspaces: [{ projectId: 'alpha', rootPath: 'D:\\projects\\alpha' }],
    })

    const selected = await first.context.serverEnvironments.switch(alpha, ServerBindingId('local:desktop-1'))
    expect(selected).toMatchObject({ activeBindingId: 'local:desktop-1', environmentEpoch: 1 })
    expect(await first.context.serverEnvironments.switch(alpha, ServerBindingId('local:desktop-1')))
      .toMatchObject({ environmentEpoch: 1 })

    unregister()
    expect(first.context.serverEnvironments.project(alpha)).toMatchObject({
      activeBindingId: 'local:desktop-1',
      environmentEpoch: 1,
      environments: expect.arrayContaining([expect.objectContaining({
        bindingId: 'local:desktop-1',
        status: 'offline',
      })]),
    })

    await first.context.fiber.dispose()
    contexts.splice(contexts.indexOf(first.context), 1)
    const second = await start(first.root)
    expect(second.context.serverEnvironments.project(state(second.root, 'alice', 'alpha'))).toMatchObject({
      activeBindingId: 'local:desktop-1',
      environmentEpoch: 1,
      environments: expect.arrayContaining([expect.objectContaining({ status: 'offline' })]),
    })
  })

  it('rejects unknown and offline switch targets without changing the active environment', async () => {
    const harness = await start()
    const alpha = state(harness.root, 'alice', 'alpha')

    await expect(harness.context.serverEnvironments.switch(alpha, ServerBindingId('local:missing')))
      .rejects.toThrow(/unavailable/)
    expect(harness.context.serverEnvironments.project(alpha)).toMatchObject({
      activeBindingId: 'cloud',
      environmentEpoch: 0,
    })
  })

  it('blocks switching while an execution lease owns the active epoch', async () => {
    const harness = await start()
    const alpha = state(harness.root, 'alice', 'alpha')
    harness.context.serverEnvironments.bindProject(alpha)
    harness.context.serverEnvironments.registerExecutor({
      userId: 'alice',
      deviceId: ServerDeviceId('desktop-1'),
      deviceName: 'Alice PC',
      platform: 'win32',
      arch: 'x64',
      shell: 'powershell',
      capabilities: ['filesystem', 'subprocess'],
      workspaces: [{ projectId: 'alpha', rootPath: 'D:\\projects\\alpha' }],
    })
    const release = harness.context.serverEnvironments.leaseExecution(
      String(alpha.sessionId),
      ServerBindingId('cloud'),
      0,
    )

    await expect(harness.context.serverEnvironments.switch(alpha, ServerBindingId('local:desktop-1')))
      .rejects.toThrow(/must settle before switching/)
    expect(harness.context.serverEnvironments.project(alpha)).toMatchObject({
      activeBindingId: 'cloud', environmentEpoch: 0,
    })

    release()
    release()
    await expect(harness.context.serverEnvironments.switch(alpha, ServerBindingId('local:desktop-1')))
      .resolves.toMatchObject({ activeBindingId: 'local:desktop-1', environmentEpoch: 1 })
  })
})
