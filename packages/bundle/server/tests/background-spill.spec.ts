/** Background cloud-shell spill publication owned by the Server. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ShellProcess, ShellProcessRead } from '@deepseek-ai/dsh-shell'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerBackgroundOutput } from '../src/background-spill.ts'
import { parseProjectRoute, projectSessionState } from '../src/project-session.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-server-background-spill-'))
  roots.push(root)
  const route = parseProjectRoute('/v1/users/alice/projects/alpha/session')
  if (route === undefined) throw new Error('test project route is invalid')
  const state = projectSessionState(root, route.identity)
  await mkdir(state.cwd, { recursive: true })
  return state
}

function processWith(reads: ShellProcessRead[]): ShellProcess {
  return {
    status: 'completed',
    exitCode: 0,
    signal: null,
    done: Promise.resolve(),
    readOutput: () => reads.shift() ?? { delta: '', lossy: false },
    kill: () => false,
  }
}

describe('ServerBackgroundOutput', () => {
  it('hides private paths while running and publishes both streams after settlement', async () => {
    const state = await project()
    const stdout = join(dirname(state.cwd), 'private-stdout.log')
    const stderr = join(dirname(state.cwd), 'private-stderr.log')
    await writeFile(stdout, 'complete stdout')
    await writeFile(stderr, 'complete stderr')
    const process = processWith([
      { delta: 'running tail\n', lossy: true, stdoutSpillPath: stdout, stderrSpillPath: stderr },
      { delta: 'final tail', lossy: false },
    ])
    const output = new ServerBackgroundOutput(new Context(), state)

    const running = output.read(process)
    expect(running).toContain('full output will be available after the job completes')
    expect(running).not.toContain(stdout)
    expect(running).not.toContain(stderr)

    await output.settle(process)
    const settled = output.read(process)
    const published = /full output: (.+)]/.exec(settled)?.[1]?.split(', ') ?? []
    expect(settled).toContain('final tail\n[some output was dropped from memory')
    expect(published).toHaveLength(2)
    expect(await readFile(published[0]!, 'utf8')).toBe('complete stdout')
    expect(await readFile(published[1]!, 'utf8')).toBe('complete stderr')
    expect(output.read(process)).toBe('')
  })

  it('returns final lossless output without adding a spill notice', async () => {
    const state = await project()
    const process = processWith([
      { delta: 'running\n', lossy: false },
      { delta: 'complete\n', lossy: false },
    ])
    const output = new ServerBackgroundOutput(new Context(), state)

    expect(output.read(process)).toBe('running\n')
    await output.settle(process)

    expect(output.read(process)).toBe('complete\n')
  })

  it('contains a failed publication and reports no private path', async () => {
    const state = await project()
    const privatePath = join(dirname(state.cwd), 'missing-private-output.log')
    const process = processWith([{ delta: '', lossy: true, stdoutSpillPath: privatePath }])
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const output = new ServerBackgroundOutput(ctx, state)

    await output.settle(process)
    const settled = output.read(process)

    expect(settled).toContain('full output: (unavailable)')
    expect(settled).not.toContain(privatePath)
    expect(warn).toHaveBeenCalledWith(
      'server shell could not publish %s background spill output: %o',
      'shell-stdout',
      expect.any(Error),
    )
  })
})
