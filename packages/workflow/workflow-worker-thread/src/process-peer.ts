/**
 * Linux bubblewrap process transport for workflow scripts. The child receives
 * a private mount, PID, IPC, UTS, and network namespace; only OS runtime paths
 * and the bundled workflow entry are visible, all read-only, with a private
 * writable `/tmp`.
 * @module @deepseek-ai/dsh-workflow-worker-thread/process-peer
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkerToHostMessage } from './protocol.ts'
import type { WorkflowPeer, WorkflowPeerFactory } from './peer.ts'
import type { WorkerInit } from './types.ts'
import { decodeWorkerToHostMessage, JsonLineDecoder } from './wire.ts'

const SANDBOX_RUNTIME_ROOT = '/dsh-workflow-runtime'
// Node is invoked by its private bind mount, so the sandbox needs shared
// libraries but not host commands, /usr/local, global Conda installs, or /etc.
const RUNTIME_LIBRARY_ROOTS = ['/lib', '/lib64', '/usr/lib', '/usr/lib64'] as const

/** Process-transport settings resolved from the workflow engine config. */
export interface SandboxedProcessOptions {
  /** Bubblewrap executable or absolute path. */
  bwrapPath: string
  /** Maximum bytes accepted for one process-to-host JSON frame. */
  maxProtocolFrameBytes: number
}

/** Inputs used to build one bubblewrap invocation; exported for platform-independent tests. */
export interface SandboxedProcessPaths {
  /** Node executable on the host. */
  nodePath: string
  /** Built process-worker bundle on the host. */
  workerPath: string
}

/** Injectable process operations used by transport lifecycle tests. */
export interface SandboxedProcessInternals {
  /** Resolve the two host files exposed to the sandbox. */
  paths(): SandboxedProcessPaths
  /** Spawn bubblewrap. */
  spawn: typeof spawn
  /** Signal the detached process group. */
  kill: typeof process.kill
  /** Host working directory for launching bubblewrap. */
  cwd(): string
  /** Host PATH used only to resolve a non-absolute bubblewrap executable. */
  pathEnv(): string | undefined
}

/**
 * Build the bwrap arguments for one workflow child. The resulting namespace
 * contains no Server data, home directory, `/run`, or network interface.
 * @param paths - host runtime and source/build paths.
 * @param pathExists - host path probe, injectable for deterministic tests.
 * @returns arguments following the bwrap executable.
 */
export function sandboxedProcessArgv(
  paths: SandboxedProcessPaths,
  pathExists: (path: string) => boolean = existsSync,
): string[] {
  const args = [
    '--tmpfs', '/',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--new-session',
    '--die-with-parent',
    '--clearenv',
    '--setenv', 'PATH', SANDBOX_RUNTIME_ROOT,
  ]
  for (const root of RUNTIME_LIBRARY_ROOTS) {
    if (pathExists(root)) args.push('--ro-bind', root, root)
  }
  args.push(
    '--dev', '/dev',
    '--proc', '/proc',
    '--dir', SANDBOX_RUNTIME_ROOT,
    '--ro-bind', paths.nodePath, `${SANDBOX_RUNTIME_ROOT}/node`,
    '--ro-bind', paths.workerPath, `${SANDBOX_RUNTIME_ROOT}/process-worker.cjs`,
    // Freeze the assembled root before overlaying the sole writable mount.
    '--remount-ro', '/',
    '--tmpfs', '/tmp',
    '--chdir', '/tmp',
    '--', `${SANDBOX_RUNTIME_ROOT}/node`, `${SANDBOX_RUNTIME_ROOT}/process-worker.cjs`,
  )
  return args
}

/**
 * Resolve the paths mounted by a built package or a repository source launch.
 * @param moduleUrl - current module URL, injectable for both build shapes.
 * @param nodePath - Node executable to mount.
 * @param pathExists - artifact existence probe.
 * @returns the two exact host files exposed to bubblewrap.
 */
export function resolveSandboxedProcessPaths(
  moduleUrl: string = import.meta.url,
  nodePath: string = process.execPath,
  pathExists: (path: string) => boolean = existsSync,
): SandboxedProcessPaths {
  const modulePath = fileURLToPath(moduleUrl)
  const workerDir = moduleUrl.endsWith('.ts')
    ? resolve(dirname(modulePath), '../lib')
    : dirname(modulePath)
  const workerPath = join(workerDir, 'process-worker.cjs')
  if (!pathExists(workerPath)) {
    throw new Error('workflow sandboxed-process execution requires the built process-worker.cjs artifact')
  }
  return { nodePath, workerPath }
}

/**
 * Read the host PATH used only for locating the configured bwrap command.
 * @returns the host PATH, or undefined when absent.
 */
export const workflowBwrapPathEnv = (): string | undefined => process.env.PATH

const DEFAULT_INTERNALS: SandboxedProcessInternals = {
  paths: resolveSandboxedProcessPaths,
  spawn,
  /* v8 ignore next -- real process-group signaling is exercised by the Linux sandbox e2e. */
  kill: (pid, signal) => process.kill(pid, signal),
  /* v8 ignore next -- real launch cwd wiring is exercised by the Linux sandbox e2e. */
  cwd: () => process.cwd(),
  pathEnv: workflowBwrapPathEnv,
}

/** Host adapter for one isolated JSONL child process. */
export class SandboxedProcessPeer extends EventEmitter implements WorkflowPeer {
  readonly trustedMessages = false
  private readonly child: ChildProcessWithoutNullStreams
  private readonly exited: Promise<number>
  private exitCode: number | undefined
  private protocolFailed = false
  private stderrBytes = 0

  constructor(
    init: WorkerInit,
    options: SandboxedProcessOptions,
    private readonly internals: SandboxedProcessInternals = DEFAULT_INTERNALS,
  ) {
    super()
    const argv = sandboxedProcessArgv(internals.paths())
    const pathEnv = internals.pathEnv()
    const spawnEnv = pathEnv === undefined ? {} : { PATH: pathEnv }
    this.child = internals.spawn(options.bwrapPath, argv, {
      cwd: internals.cwd(),
      detached: true,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const decoder = new JsonLineDecoder(options.maxProtocolFrameBytes)
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.protocolFailed) return
      try {
        for (const line of decoder.push(chunk)) {
          const decoded = decodeWorkerToHostMessage(JSON.parse(line) as unknown)
          if (decoded === undefined) throw new Error('workflow process sent an invalid protocol message')
          this.emit('message', decoded satisfies WorkerToHostMessage)
        }
      } catch (error: unknown) {
        this.failProtocol(error)
      }
    })
    // Escaped code can write directly to stderr. Drain it continuously and
    // fail closed after a bounded diagnostic allowance so the pipe cannot
    // deadlock the child or become an unbounded host-memory sink.
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (this.protocolFailed) return
      this.stderrBytes += chunk.length
      if (this.stderrBytes > options.maxProtocolFrameBytes) {
        this.failProtocol(new Error(`workflow process stderr exceeds ${options.maxProtocolFrameBytes} bytes`))
      }
    })
    this.child.on('error', (error) => { this.emit('error', error) })
    this.exited = new Promise((resolveExit) => {
      this.child.once('close', (code) => {
        this.exitCode = code ?? 1
        this.emit('exit', this.exitCode)
        resolveExit(this.exitCode)
      })
    })
    this.postMessage({ init })
  }

  postMessage(message: unknown): void {
    if (this.exitCode !== undefined || this.child.stdin.destroyed) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private failProtocol(error: unknown): void {
    this.protocolFailed = true
    this.emit('messageerror', error)
    void this.terminate()
  }

  async terminate(): Promise<number> {
    if (this.exitCode !== undefined) return this.exitCode
    const pid = this.child.pid
    if (pid !== undefined) {
      try {
        this.internals.kill(-pid, 'SIGKILL')
      } catch {
        // The process group may have exited between the state check and signal.
      }
    }
    return this.exited
  }
}

/**
 * Create a factory that launches every workflow in the Linux process sandbox.
 * @param options - executable and frame-limit settings.
 * @param internals - process operations; production defaults are replaced only by lifecycle tests.
 * @returns the per-run peer factory.
 */
export function createSandboxedProcessPeerFactory(
  options: SandboxedProcessOptions,
  internals: SandboxedProcessInternals = DEFAULT_INTERNALS,
): WorkflowPeerFactory {
  return init => new SandboxedProcessPeer(init, options, internals)
}
