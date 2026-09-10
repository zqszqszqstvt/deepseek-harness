/** Environment-neutral shell tool behavior. */

import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobId, type JobHooks, type JobStart } from '@deepseek-ai/dsh-jobs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { ShellExecutor, ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { ServerBindingId, ServerDeviceId } from '../src/environments.ts'
import { parseProjectRoute, projectSessionState } from '../src/project-session.ts'
import type { ServerRuntimeRouter, ServerRuntimeSelection } from '../src/runtime-router.ts'
import * as ToolShell from '../src/tool-shell.ts'

let context: Context | undefined
const tempRoots: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** An existing canonical directory, so containment compares one filesystem identity on every platform. */
async function canonicalDir(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'dsh-server-shell-')))
  tempRoots.push(dir)
  return dir
}

async function start(
  selection: ServerRuntimeSelection,
  policy?: SandboxExecutionPolicy,
  runResult?: ShellRunResult,
  background?: { process: ShellProcess; capture(hooks: JobHooks): void },
) {
  context = new Context()
  const resolve = vi.fn((request: ShellExecRequest) => request as ShellExecSpec)
  const run = vi.fn().mockResolvedValue(runResult ?? {
    exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 60_000,
    stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
  })
  const startProcess = vi.fn(() => {
    if (background === undefined) throw new Error('unexpected background shell start')
    return background.process
  })
  context.provide('shell', { resolve, run, start: startProcess, sandboxMode: 'workspace-write' } as unknown as ShellExecutor)
  context.provide('shellEnv', { collect: () => ({ DSH_TEST: '1' }) } as never)
  context.provide('serverRuntimeRouter', { current: () => selection } as unknown as ServerRuntimeRouter)
  if (policy !== undefined) {
    context.provide('sandboxPolicy', { resolve: () => policy } as unknown as SandboxPolicyService)
  }
  if (background !== undefined) {
    context.provide('jobs', {
      start(spec: JobStart) {
        background.capture(spec.run())
        return JobId('shell-1')
      },
    } as never)
  }
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(ToolShell)
  return { resolve, run, start: startProcess }
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

/** A cloud selection whose project workspace lives under an existing canonical root. */
async function cloudSelection(): Promise<{ selection: ServerRuntimeSelection; workspace: string }> {
  const root = await canonicalDir()
  const route = parseProjectRoute('/v1/users/alice/projects/alpha/environments')
  if (route === undefined) throw new Error('test project route is invalid')
  const state = projectSessionState(root, route.identity)
  await mkdir(state.cwd, { recursive: true })
  return {
    workspace: state.cwd,
    selection: {
      state,
      view: {
        sessionId: String(state.sessionId), activeBindingId: ServerBindingId('cloud'), environmentEpoch: 1,
        environments: [],
      },
      environment: {
        bindingId: ServerBindingId('cloud'), environmentId: 'cloud', type: 'cloud', status: 'online',
        rootPath: state.cwd, platform: 'linux', arch: 'x64', shell: 'bash',
        capabilities: ['filesystem', 'subprocess', 'shell'],
      },
    },
  }
}

function workspaceWritePolicy(workspaceRoot: string): SandboxExecutionPolicy {
  return { mode: 'workspace-write', workspaceRoot }
}

/** Run one shell call and return its result. */
async function callShell(workdir?: string) {
  return context!.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('shell-cloud'),
    name: 'shell',
    arguments: {
      command: 'pwd', description: 'Print the working directory',
      ...(workdir === undefined ? {} : { workdir }),
    },
  })
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

  it('confines a cloud workdir to the policy root before resolving the command', async () => {
    const { selection, workspace } = await cloudSelection()
    const shell = await start(selection, workspaceWritePolicy(workspace))

    const relative = await callShell('src')
    expect(relative).toMatchObject({ isError: false })
    expect(shell.resolve).toHaveBeenCalledWith(expect.objectContaining({ workdir: join(workspace, 'src') }))

    const inside = await callShell(join(workspace, 'nested'))
    expect(inside).toMatchObject({ isError: false })
    expect(shell.resolve).toHaveBeenCalledWith(expect.objectContaining({ workdir: join(workspace, 'nested') }))
  })

  it('defaults a cloud workdir to the policy root', async () => {
    const { selection, workspace } = await cloudSelection()
    const shell = await start(selection, workspaceWritePolicy(workspace))

    expect(await callShell()).toMatchObject({ isError: false })
    expect(shell.resolve).toHaveBeenCalledWith(expect.objectContaining({ workdir: workspace }))
  })

  it('publishes a cloud collector spill path inside the project workspace', async () => {
    const { selection, workspace } = await cloudSelection()
    const source = join(workspace, '..', 'private-shell-output.log')
    await writeFile(source, 'complete output')
    await start(selection, workspaceWritePolicy(workspace), {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 60_000,
      stdout: { text: 'tail', truncated: true, spillPath: source },
      stderr: { text: '', truncated: false },
    })

    const result = await callShell()
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected a text tool result')
    const match = /full output: (.+)]/.exec(block.text)

    expect(result.isError).toBe(false)
    expect(match?.[1]?.startsWith(join(workspace, '.dsh', 'spill'))).toBe(true)
    expect(await readFile(String(match?.[1]), 'utf8')).toBe('complete output')
  })

  it('contains cloud spill publication failure and keeps the bounded tail', async () => {
    const { selection, workspace } = await cloudSelection()
    const source = join(workspace, '..', 'private-shell-output.log')
    await writeFile(source, 'complete output')
    await writeFile(join(workspace, '.dsh'), 'occupied')
    await start(selection, workspaceWritePolicy(workspace), {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 60_000,
      stdout: { text: 'tail', truncated: true, spillPath: source },
      stderr: { text: '', truncated: false },
    })
    const warn = vi.spyOn(context!.logger, 'warn').mockImplementation(() => undefined)

    const result = await callShell()
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected a text tool result')

    expect(result.isError).toBe(false)
    expect(block.text).toContain('tail\n[output truncated; full output: (unavailable)]')
    expect(warn).toHaveBeenCalledWith('server shell could not publish %s spill output: %o', 'shell-stdout', expect.any(Error))
  })

  it('preserves a local executor spill path without applying Server host paths', async () => {
    const spillPath = 'D:\\executor-private\\stdout.log'
    await start(localSelection(), undefined, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 60_000,
      stdout: { text: 'tail', truncated: true, spillPath },
      stderr: { text: '', truncated: false },
    })

    const result = await callShell()
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected a text tool result')

    expect(result.isError).toBe(false)
    expect(block.text).toContain(`full output: ${spillPath}`)
  })

  it('publishes lossy background output before the job settles', async () => {
    const { selection, workspace } = await cloudSelection()
    const source = join(workspace, '..', 'private-background-output.log')
    await writeFile(source, 'complete background output')
    let finish!: () => void
    let hooks: JobHooks | undefined
    const reads = [
      { delta: 'running tail', lossy: true, stdoutSpillPath: source },
      { delta: 'final tail', lossy: false },
    ]
    const process: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: new Promise<void>((resolve) => { finish = resolve }),
      readOutput: () => reads.shift() ?? { delta: '', lossy: false },
      kill: () => true,
    }
    await start(selection, workspaceWritePolicy(workspace), undefined, {
      process,
      capture(next) { hooks = next },
    })

    const result = await context!.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('shell-background'),
      name: 'shell',
      arguments: { command: 'long-command', description: 'Run a long command', run_in_background: true },
    })
    expect(result).toMatchObject({ isError: false, value: { kind: 'background', jobId: 'shell-1' } })
    const running = hooks?.readOutput?.()
    expect(running).toContain('full output will be available after the job completes')
    expect(running).not.toContain(source)

    process.status = 'completed'
    process.exitCode = 0
    finish()
    await hooks?.done
    const settled = hooks?.readOutput?.() ?? ''
    const published = /full output: (.+)]/.exec(settled)?.[1]
    expect(published?.startsWith(join(workspace, '.dsh', 'spill'))).toBe(true)
    expect(await readFile(String(published), 'utf8')).toBe('complete background output')
  })

  it.each(['../outside', '/etc', 'nested/../../outside'])(
    'rejects the escaping cloud workdir %s before any spawn',
    async (workdir) => {
      const { selection, workspace } = await cloudSelection()
      const shell = await start(selection, workspaceWritePolicy(workspace))

      const result = await callShell(workdir)

      expect(result).toMatchObject({ isError: true })
      const block = result.content[0]
      expect(block?.type).toBe('text')
      if (block?.type !== 'text') throw new Error('expected a text tool result')
      expect(block.text).toContain('outside the session workspace')
      expect(shell.resolve).not.toHaveBeenCalled()
      expect(shell.run).not.toHaveBeenCalled()
    },
  )

  it('rejects an absolute cloud workdir that is a real directory outside the workspace', async () => {
    const { selection, workspace } = await cloudSelection()
    const outside = await canonicalDir()
    const shell = await start(selection, workspaceWritePolicy(workspace))

    const result = await callShell(outside)

    expect(result).toMatchObject({ isError: true })
    expect(shell.resolve).not.toHaveBeenCalled()
  })

  it('leaves a cloud workdir unresolved without a sandbox policy', async () => {
    const { selection, workspace } = await cloudSelection()
    const shell = await start(selection)

    expect(await callShell('/srv/deployment')).toMatchObject({ isError: false })
    expect(shell.resolve).toHaveBeenCalledWith(expect.objectContaining({ workdir: '/srv/deployment' }))
    expect(workspace).not.toBe('/srv/deployment')
  })

  it('passes an absolute local workdir through for the executor\'s own physical boundary', async () => {
    const shell = await start(localSelection(), workspaceWritePolicy('/cloud/users/x/workspace'))

    expect(await callShell('D:\\elsewhere\\alpha')).toMatchObject({ isError: false })
    expect(shell.resolve).toHaveBeenCalledWith(expect.objectContaining({ workdir: 'D:\\elsewhere\\alpha' }))
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
    const block = result.content[0]
    expect(block?.type).toBe('text')
    if (block?.type !== 'text') throw new Error('expected a text tool result')
    expect(block.text).toContain('not supported yet')
    expect(shell.resolve).not.toHaveBeenCalled()
    expect(shell.run).not.toHaveBeenCalled()
  })
})
