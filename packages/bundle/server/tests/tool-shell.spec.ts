/** Environment-neutral shell tool behavior. */

import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShellExecutor, ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { ServerBindingId, ServerDeviceId } from '../src/environments.ts'
import { parseProjectRoute, projectSessionState } from '../src/project-session.ts'
import type { ServerRuntimeRouter, ServerRuntimeSelection } from '../src/runtime-router.ts'
import * as ToolShell from '../src/tool-shell.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function start(selection: ServerRuntimeSelection) {
  context = new Context()
  const resolve = vi.fn((request: ShellExecRequest) => request as ShellExecSpec)
  const run = vi.fn().mockResolvedValue({
    exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 60_000,
    stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
  })
  context.provide('shell', { resolve, run, sandboxMode: 'workspace-write' } as unknown as ShellExecutor)
  context.provide('shellEnv', { collect: () => ({ DSH_TEST: '1' }) } as never)
  context.provide('serverRuntimeRouter', { current: () => selection } as unknown as ServerRuntimeRouter)
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(ToolShell)
  return { resolve, run }
}

function localSelection(): ServerRuntimeSelection {
  const route = parseProjectRoute('/v1/users/alice/projects/alpha/environments')
  if (route === undefined) throw new Error('test project route is invalid')
  const state = projectSessionState('/cloud', route.identity)
  return {
    state,
    view: {
      sessionId: String(state.sessionId), activeBindingId: ServerBindingId('local:desktop-1'), environmentEpoch: 1,
      environments: [],
    },
    environment: {
      bindingId: ServerBindingId('local:desktop-1'), environmentId: 'local:desktop-1',
      type: 'local', status: 'online', rootPath: 'D:\\projects\\alpha',
      deviceId: ServerDeviceId('desktop-1'), platform: 'win32', arch: 'x64', shell: 'powershell',
      capabilities: ['filesystem', 'subprocess'],
    },
  }
}

describe('server shell tool', () => {
  it('advertises active-environment syntax and resolves a local Windows workdir', async () => {
    const shell = await start(localSelection())
    expect(context!.tools.schemas().find(schema => schema.name === 'shell')?.description)
      .toContain('active execution environment')

    const result = await context!.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('shell-1'),
      name: 'shell',
      arguments: { command: 'Get-ChildItem', description: 'List project files', workdir: 'src' },
    })

    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'ok\n' }] })
    expect(shell.resolve).toHaveBeenCalledWith(expect.objectContaining({
      command: 'Get-ChildItem',
      workdir: 'D:\\projects\\alpha\\src',
      dshEnv: { DSH_TEST: '1' },
    }))
    expect(shell.run).toHaveBeenCalledOnce()
  })

  it('rejects background execution locally before starting a process', async () => {
    const shell = await start(localSelection())
    const result = await context!.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('shell-2'),
      name: 'shell',
      arguments: {
        command: 'Start-Sleep 10', description: 'Wait in background', run_in_background: true,
      },
    })

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('not supported yet') })
    expect(shell.resolve).not.toHaveBeenCalled()
    expect(shell.run).not.toHaveBeenCalled()
  })
})
