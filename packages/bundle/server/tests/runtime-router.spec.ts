/** Session-scoped runtime selection and local dispatch. */

import { Context } from '@deepseek-ai/cordis'
import { ExecutorDeviceId } from '@deepseek-ai/dsh-executor-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudExecution } from '../src/cloud-execution.ts'
import { ServerBindingId, ServerDeviceId, type ServerEnvironments } from '../src/environments.ts'
import type { ExecutorBroker } from '../src/executor-broker.ts'
import { RemoteExecutionError, ServerRuntimeRouter } from '../src/runtime-router.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function start(result: unknown) {
  context = new Context()
  const release = vi.fn()
  const execute = vi.fn().mockResolvedValue(result)
  context.provide('agents', {
    requireInitiator: () => ({ session: { id: 'session-1' } }),
  } as never)
  context.provide('serverEnvironments', {
    projectForSession: (sessionId: string) => sessionId === 'session-1' ? {
      state: {
        sessionId: 'session-1', userId: 'alice', projectId: 'alpha', cwd: '/cloud/alpha',
      },
      view: {
        sessionId: 'session-1', activeBindingId: ServerBindingId('local:desktop-1'), environmentEpoch: 4,
        environments: [{
          bindingId: ServerBindingId('local:desktop-1'),
          environmentId: 'local:desktop-1',
          type: 'local', status: 'online', rootPath: 'D:\\projects\\alpha',
          deviceId: ServerDeviceId('desktop-1'), deviceName: 'Desktop',
          platform: 'win32', arch: 'x64', shell: 'powershell',
          capabilities: ['filesystem', 'subprocess'],
        }],
      },
    } : undefined,
    leaseExecution: vi.fn(() => release),
  } as unknown as ServerEnvironments)
  context.provide('executorBroker', { execute } as unknown as ExecutorBroker)
  context.provide('cloudExecution', {
    fs: {}, subprocess: {}, shell: {},
  } as unknown as CloudExecution)
  await context.plugin(ServerRuntimeRouter)
  return { execute, release }
}

describe('server runtime router', () => {
  it('dispatches the complete Session environment identity and releases its lease', async () => {
    const harness = await start({ ok: true, value: { text: 'hello' } })
    const selection = context!.serverRuntimeRouter.current()

    await expect(context!.serverRuntimeRouter.executeLocal(
      selection,
      { kind: 'fs.readText', targetKey: 'target-1' },
      5_000,
    )).resolves.toEqual({ text: 'hello' })
    expect(harness.execute).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'alice',
      deviceId: ExecutorDeviceId('desktop-1'),
      sessionId: 'session-1',
      projectId: 'alpha',
      environmentId: 'local:desktop-1',
      bindingId: 'local:desktop-1',
      environmentEpoch: 4,
      timeoutMs: 5_000,
      operation: { kind: 'fs.readText', targetKey: 'target-1' },
    }), {})
    expect(harness.release).toHaveBeenCalledOnce()
  })

  it('surfaces executor failures without invoking a cloud provider', async () => {
    const harness = await start({
      ok: false,
      error: { code: 'FS_IO_ERROR', message: 'local disk failed', retryable: false },
    })
    const selection = context!.serverRuntimeRouter.current()

    const failure = context!.serverRuntimeRouter.executeLocal(
      selection,
      { kind: 'fs.readText', targetKey: 'target-1' },
      5_000,
    )
    await expect(failure).rejects.toBeInstanceOf(RemoteExecutionError)
    await expect(failure).rejects.toMatchObject({
      name: 'RemoteExecutionError', code: 'FS_IO_ERROR', message: 'local disk failed', retryable: false,
    })
    expect(harness.execute).toHaveBeenCalledOnce()
    expect(harness.release).toHaveBeenCalledOnce()
  })
})
