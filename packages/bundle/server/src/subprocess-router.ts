/** Session-aware subprocess Provider with remote collected and piped output handles. */

import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import {
  type ServerRuntimeRouter,
} from './runtime-router.ts'
import type {} from './runtime-router.ts'

const REQUEST_TIMEOUT_MS = 120_000
const PIPE_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024
const outcomeResult = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
})

class RemoteOutputReader implements SubprocessOutputReader {
  private value = Buffer.alloc(0)
  private totalBytes = 0
  private droppedBytes = 0

  constructor(private readonly maxBytes: number) {}

  append(text: string): void {
    const chunk = Buffer.from(text)
    this.totalBytes += chunk.byteLength
    this.value = Buffer.concat([this.value, chunk])
    if (this.value.byteLength <= this.maxBytes) return
    const drop = this.value.byteLength - this.maxBytes
    this.value = this.value.subarray(drop)
    this.droppedBytes += drop
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    const retainedStart = this.totalBytes - this.value.byteLength
    const lossy = fromByte < retainedStart
    const start = lossy ? 0 : Math.max(0, fromByte - retainedStart)
    return {
      text: this.value.subarray(start).toString('utf8'),
      nextOffset: this.totalBytes,
      lossy: lossy || this.droppedBytes > 0 && fromByte === 0,
    }
  }
}

interface RemoteHandleState {
  readonly controller: AbortController
  readonly done: Promise<unknown>
}

function outputLimit(mode: SubprocessOutputMode): number {
  return typeof mode === 'object' ? mode.maxBytes : PIPE_OUTPUT_LIMIT_BYTES
}

/** Root subprocess Provider; unsupported PTY allocation fails instead of falling back to cloud. */
export class ServerSubprocessRouter extends SubprocessRuntime {
  static inject = ['serverRuntimeRouter']

  private readonly runtime: ServerRuntimeRouter
  private readonly live = new Set<RemoteHandleState>()

  constructor(ctx: Context) {
    super(ctx)
    this.runtime = ctx.serverRuntimeRouter
    ctx.effect(() => async () => {
      for (const state of this.live) state.controller.abort(new Error('server subprocess router disposed'))
      await Promise.allSettled([...this.live].map(state => state.done))
      this.live.clear()
    }, 'server subprocess router teardown')
  }

  override async resolveExecutable(
    command: string,
    _env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted()
    if (command.length === 0) throw new Error('server subprocess router: executable must be non-empty')
    const selection = this.runtime.current()
    if (selection.environment.type === 'cloud') {
      return this.runtime.run(
        selection,
        () => this.runtime.cloud.subprocess.resolveExecutable(command, _env, signal),
      )
    }
    if (command.includes('/') || command.includes('\\')) {
      const absolute = selection.environment.platform === 'win32'
        ? /^[a-zA-Z]:[\\/]/.test(command)
        : command.startsWith('/')
      if (!absolute) {
        throw new Error('server subprocess router: relative executable paths are not supported')
      }
    }
    return command
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const selection = this.runtime.current()
    if (selection.environment.type === 'cloud') {
      const release = this.runtime.lease(selection)
      try {
        const handle = this.runtime.cloud.subprocess.spawn(spec)
        const settle = (): Promise<void> => handle.waitForExit().then(() => { release() })
        void handle.done.then(settle, settle).catch(() => { release() })
        return handle
      } catch (error) {
        release()
        throw error
      }
    }
    if (spec.stdio.stdin === 'pipe') {
      return this.failedHandle(new Error('local executor does not support streaming stdin'))
    }
    const stdout = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    const stderr = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    const stdoutReader = typeof spec.stdio.stdout === 'object'
      ? new RemoteOutputReader(spec.stdio.stdout.maxBytes)
      : undefined
    const stderrReader = typeof spec.stdio.stderr === 'object'
      ? new RemoteOutputReader(spec.stdio.stderr.maxBytes)
      : undefined
    const controller = new AbortController()
    const abort = (): void => controller.abort(spec.signal?.reason ?? new Error('subprocess cancelled'))
    if (spec.signal?.aborted) abort()
    else spec.signal?.addEventListener('abort', abort, { once: true })
    const operation = {
      kind: 'subprocess.run' as const,
      argv: spec.argv,
      cwd: spec.cwd,
      ...(typeof spec.stdio.stdin === 'object' ? { stdin: spec.stdio.stdin.data } : {}),
      ...(spec.env === undefined ? {} : {
        env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, value ?? null])),
      }),
      graceMs: spec.graceMs,
      outputLimitBytes: Math.max(
        1,
        outputLimit(spec.stdio.stdout) + outputLimit(spec.stdio.stderr),
      ),
    }
    const execution = this.runtime.executeLocal(selection, operation, REQUEST_TIMEOUT_MS, {
      signal: controller.signal,
      onOutput: (output) => {
        const stream = output.stream === 'stdout' ? stdout : stderr
        const reader = output.stream === 'stdout' ? stdoutReader : stderrReader
        if (stream !== undefined) stream.write(output.data)
        else if (reader !== undefined) reader.append(output.data)
        else if ((output.stream === 'stdout' ? spec.stdio.stdout : spec.stdio.stderr) === 'inherit') {
          const destination = output.stream === 'stdout' ? process.stdout : process.stderr
          destination.write(output.data)
        }
      },
    }).then((value) => {
      const outcome = outcomeResult.parse(value)
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal as NodeJS.Signals | null,
      }
    }).finally(() => {
      stdout?.end()
      stderr?.end()
      spec.signal?.removeEventListener('abort', abort)
      this.live.delete(state)
    })
    const done = execution.catch((error) => {
      if (controller.signal.aborted) {
        return { exitCode: null, signal: 'SIGTERM' as NodeJS.Signals }
      }
      throw error
    })
    const state: RemoteHandleState = { controller, done }
    this.live.add(state)
    return {
      pid: -1,
      stdin: undefined,
      stdout,
      stderr,
      collected: {
        ...(stdoutReader === undefined ? {} : { stdout: stdoutReader }),
        ...(stderrReader === undefined ? {} : { stderr: stderrReader }),
      },
      done,
      terminate: () => { controller.abort(new Error('subprocess terminated')) },
      waitForExit: signal => this.wait(done, signal),
    }
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const selection = this.runtime.current()
    if (selection.environment.type === 'cloud') {
      const release = this.runtime.lease(selection)
      return this.runtime.cloud.subprocess.spawnTerminal(_spec).then((handle) => {
        const settle = (): Promise<void> => handle.terminate().finally(release)
        void handle.done.then(settle, settle).catch(() => { release() })
        return handle
      }, (error) => {
        release()
        throw error
      })
    }
    return Promise.reject(new Error('local executor terminal sessions are not supported yet'))
  }

  private failedHandle(error: Error): SubprocessHandle {
    const done = Promise.reject(error)
    void done.catch(() => {})
    return {
      pid: -1,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {},
      done,
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  private async wait(done: Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) {
      await done.catch(() => {})
      return true
    }
    if (signal.aborted) return false
    return new Promise((resolve) => {
      const abort = (): void => resolve(false)
      signal.addEventListener('abort', abort, { once: true })
      void done.then(
        () => {
          signal.removeEventListener('abort', abort)
          resolve(true)
        },
        () => {
          signal.removeEventListener('abort', abort)
          resolve(true)
        },
      )
    })
  }
}

export default ServerSubprocessRouter
