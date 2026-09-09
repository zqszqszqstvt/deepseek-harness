import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SandboxedProcessInternals } from '../src/process-peer.ts'
import {
  createSandboxedProcessPeerFactory,
  resolveSandboxedProcessPaths,
  SandboxedProcessPeer,
  sandboxedProcessArgv,
  workflowBwrapPathEnv,
} from '../src/process-peer.ts'
import { WorkerToHostType } from '../src/protocol.ts'

const INIT = {
  meta: { name: 'process-test', description: 'process transport test' },
  body: 'return null',
  limits: { maxConcurrentAgents: 1, maxTotalAgents: 1, maxItemsPerCall: 1, syncTimeoutMs: 100 },
}

type FakeChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
}

function fakeChild(pid: number | null = 1234): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: pid ?? undefined,
  }) as unknown as FakeChild
}

function fakeInternals(child: FakeChild, pathEnv: string | null = '/host/bin') {
  const spawn = vi.fn(() => child) as unknown as SandboxedProcessInternals['spawn']
  const kill = vi.fn() as unknown as SandboxedProcessInternals['kill']
  const internals: SandboxedProcessInternals = {
    paths: () => ({ nodePath: '/node', workerPath: '/worker.cjs' }),
    spawn,
    kill,
    cwd: () => '/host/cwd',
    pathEnv: () => pathEnv ?? undefined,
  }
  return { internals, spawn, kill }
}

describe('sandboxed process bubblewrap arguments', () => {
  it('exposes only runtime libraries, Node, and the single process worker artifact', () => {
    const argv = sandboxedProcessArgv(
      { nodePath: '/host/node', workerPath: '/repo/lib/process-worker.cjs' },
      () => true,
    )

    expect(argv).toContain('--unshare-net')
    expect(argv).toContain('--unshare-pid')
    expect(argv).toContain('--unshare-ipc')
    expect(argv).toContain('--unshare-uts')
    expect(argv).not.toContain('/run')
    expect(argv).not.toContain('/usr')
    expect(argv).not.toContain('/usr/local')
    expect(argv).not.toContain('/home')
    expect(argv).not.toContain('/root')
    expect(argv).not.toContain('/repo/lib')
    expect(argv).toEqual(expect.arrayContaining([
      '--ro-bind', '/host/node', '/dsh-workflow-runtime/node',
      '--ro-bind', '/repo/lib/process-worker.cjs', '/dsh-workflow-runtime/process-worker.cjs',
    ]))
    expect(argv.indexOf('--remount-ro')).toBeLessThan(argv.indexOf('--tmpfs', 2))
    expect(argv.slice(-3)).toEqual([
      '--', '/dsh-workflow-runtime/node', '/dsh-workflow-runtime/process-worker.cjs',
    ])
  })

  it('omits library roots absent on the host', () => {
    const argv = sandboxedProcessArgv(
      { nodePath: '/node', workerPath: '/worker.cjs' },
      path => path === '/lib',
    )
    expect(argv).toContain('/lib')
    expect(argv).not.toContain('/lib64')
    expect(argv).not.toContain('/usr/lib')
    expect(argv).not.toContain('/usr/lib64')
  })

  it('resolves source and built worker artifact locations and fails when absent', () => {
    const sourceUrl = new URL('../src/process-peer.ts', import.meta.url).href
    const builtUrl = new URL('../lib/index.js', import.meta.url).href
    const sourceDir = dirname(fileURLToPath(sourceUrl))
    const builtDir = dirname(fileURLToPath(builtUrl))
    expect(resolveSandboxedProcessPaths(sourceUrl, '/node', () => true)).toEqual({
      nodePath: '/node',
      workerPath: join(resolve(sourceDir, '../lib'), 'process-worker.cjs'),
    })
    expect(resolveSandboxedProcessPaths(builtUrl, '/node', () => true)).toEqual({
      nodePath: '/node',
      workerPath: join(builtDir, 'process-worker.cjs'),
    })
    expect(() => resolveSandboxedProcessPaths(sourceUrl, '/node', () => false)).toThrow(
      'requires the built process-worker.cjs artifact',
    )
    expect(workflowBwrapPathEnv()).toBe(process.env.PATH)
  })

  it('spawns with a scrubbed environment and decodes ordered process messages', async () => {
    const child = fakeChild()
    let stdin = ''
    child.stdin.setEncoding('utf8').on('data', (chunk: string) => { stdin += chunk })
    const { internals, spawn } = fakeInternals(child)
    const peer = new SandboxedProcessPeer(INIT, { bwrapPath: '/bwrap', maxProtocolFrameBytes: 128 }, internals)
    const messages: unknown[] = []
    const errors: unknown[] = []
    const exits: number[] = []
    peer.on('message', (message) => { messages.push(message) })
    peer.on('error', (error) => { errors.push(error) })
    peer.on('exit', (code: number) => { exits.push(code) })
    child.stdout.write('{"type":"rea')
    child.stdout.write('dy"}\n{"type":"log","message":"ok"}\n')
    child.stderr.write('bounded diagnostic')
    peer.postMessage({ type: 'go' })
    child.emit('error', new Error('spawn failed'))
    child.emit('close', 0)

    expect(spawn).toHaveBeenCalledWith('/bwrap', expect.any(Array), expect.objectContaining({
      cwd: '/host/cwd',
      detached: true,
      env: { PATH: '/host/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }))
    expect(JSON.parse(stdin.split('\n')[0]!)).toEqual({ init: INIT })
    expect(stdin).toContain('{"type":"go"}\n')
    expect(messages).toEqual([
      { type: WorkerToHostType.Ready },
      { type: WorkerToHostType.Log, message: 'ok' },
    ])
    expect(errors).toEqual([expect.objectContaining({ message: 'spawn failed' })])
    expect(exits).toEqual([0])
    expect(await peer.terminate()).toBe(0)
    const before = stdin
    peer.postMessage({ type: 'ignored' })
    expect(stdin).toBe(before)
  })

  it('fails closed on malformed stdout and kills the detached process group once', async () => {
    const child = fakeChild(77)
    const { internals, kill } = fakeInternals(child, null)
    const peer = createSandboxedProcessPeerFactory(
      { bwrapPath: 'bwrap', maxProtocolFrameBytes: 32 },
      internals,
    )(INIT)
    const failures: unknown[] = []
    peer.on('messageerror', (error) => { failures.push(error) })
    child.stdout.write('{"type":"unknown"}\n')
    child.stdout.write('also-ignored\n')
    expect(failures).toHaveLength(1)
    expect(kill).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledWith(-77, 'SIGKILL')
    child.emit('close', null)
    await expect(peer.terminate()).resolves.toBe(1)
  })

  it('fails closed when stdout frames or total stderr exceed the bound', () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const child = fakeChild()
      const { internals, kill } = fakeInternals(child)
      const peer = new SandboxedProcessPeer(INIT, { bwrapPath: 'bwrap', maxProtocolFrameBytes: 8 }, internals)
      const failures: unknown[] = []
      peer.on('messageerror', (error) => { failures.push(error) })
      child[stream].write('123456789')
      child[stream].write('ignored')
      expect(failures).toHaveLength(1)
      expect(kill).toHaveBeenCalledOnce()
      child.emit('close', 1)
    }
  })

  it('fails closed when a protocol frame is not JSON', () => {
    const child = fakeChild()
    const { internals, kill } = fakeInternals(child)
    const peer = new SandboxedProcessPeer(INIT, { bwrapPath: 'bwrap', maxProtocolFrameBytes: 32 }, internals)
    const failures: unknown[] = []
    peer.on('messageerror', (error) => { failures.push(error) })
    child.stdout.write('not-json\n')
    expect(failures).toHaveLength(1)
    expect(kill).toHaveBeenCalledOnce()
    child.emit('close', 1)
  })

  it('tolerates a vanished process group and a child without a pid', async () => {
    for (const pid of [88, null]) {
      const child = fakeChild(pid)
      const { internals, kill } = fakeInternals(child)
      if (pid !== null) vi.mocked(kill).mockImplementation(() => { throw new Error('already gone') })
      const peer = new SandboxedProcessPeer(INIT, { bwrapPath: 'bwrap', maxProtocolFrameBytes: 32 }, internals)
      const terminated = peer.terminate()
      child.emit('close', 2)
      await expect(terminated).resolves.toBe(2)
      expect(kill).toHaveBeenCalledTimes(pid === null ? 0 : 1)
    }
  })
})
