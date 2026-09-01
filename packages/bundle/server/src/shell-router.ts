/** Session-aware Shell Provider selecting syntax from the active environment. */

import { relative as hostRelative, posix, win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type {
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type {
  ServerRuntimeRouter,
  ServerRuntimeSelection,
} from './runtime-router.ts'
import type {} from './runtime-router.ts'

interface Config {
  readonly timeoutMs?: number
  readonly maxTimeoutMs?: number
  readonly maxOutputBytes?: number
  readonly graceMs?: number
}

interface ResolvedConfig {
  readonly timeoutMs: number
  readonly maxTimeoutMs: number
  readonly maxOutputBytes: number
  readonly graceMs: number
}

interface RoutedSpec {
  readonly selection: ServerRuntimeSelection
  readonly sessionId: string
  readonly bindingId: string
  readonly environmentEpoch: number
  readonly type: 'cloud' | 'local'
  readonly cloudSpec?: ShellExecSpec
}

const DEFAULT_CONFIG: ResolvedConfig = {
  timeoutMs: 60_000,
  maxTimeoutMs: 120_000,
  maxOutputBytes: 64_000,
  graceMs: 3_000,
}

function readFinal(reader: SubprocessOutputReader | undefined): CollectedOutput {
  if (reader === undefined) return { text: '', truncated: false }
  const output = reader.readFrom(0)
  return { text: output.text, truncated: output.lossy }
}

function clampTimeout(value: number | undefined, config: ResolvedConfig): number {
  const timeout = value ?? config.timeoutMs
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('server shell router: timeoutMs must be a positive finite number')
  }
  return Math.min(timeout, config.maxTimeoutMs)
}

/** Root Shell Provider; cloud calls retain the original Provider and local calls use its reported shell. */
export class ServerShellRouter extends ShellExecutor {
  static inject = ['serverRuntimeRouter', 'subprocess']

  static Config: z<Config> = z.object({
    timeoutMs: z.number().default(DEFAULT_CONFIG.timeoutMs),
    maxTimeoutMs: z.number().default(DEFAULT_CONFIG.maxTimeoutMs),
    maxOutputBytes: z.number().default(DEFAULT_CONFIG.maxOutputBytes),
    graceMs: z.number().default(DEFAULT_CONFIG.graceMs),
  })

  private readonly runtime: ServerRuntimeRouter
  private readonly config: ResolvedConfig
  private readonly specs = new WeakMap<ShellExecSpec, RoutedSpec>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.runtime = ctx.serverRuntimeRouter
    this.config = config as ResolvedConfig
    for (const [name, value] of Object.entries(this.config)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('server shell router: ' + name + ' must be a positive finite number')
      }
    }
  }

  override get sandboxMode() {
    return this.runtime.cloud.shell.sandboxMode
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const selection = this.runtime.current()
    if (selection.environment.type === 'cloud') {
      const spec = this.runtime.cloud.shell.resolve(request)
      this.specs.set(spec, this.routedSpec(selection, spec))
      return spec
    }
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    if (!Number.isFinite(stdoutMaxBytes) || stdoutMaxBytes <= 0) {
      throw new Error('server shell router: stdoutMaxBytes must be a positive finite number')
    }
    const spec: ShellExecSpec = {
      command: request.command,
      workdir: this.localWorkdir(selection, request.workdir),
      timeoutMs: clampTimeout(request.timeoutMs, this.config),
      stdoutMaxBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
      sandboxPolicy: request.sandboxPolicy,
    }
    this.specs.set(spec, this.routedSpec(selection))
    return spec
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const route = this.requireSpec(spec)
    if (route.type === 'cloud') {
      return this.runtime.run(route.selection, () => this.runtime.cloud.shell.run(route.cloudSpec ?? spec))
    }
    const controller = new AbortController()
    let timedOut = false
    let aborted = false
    const abortFromCaller = (): void => {
      aborted = true
      controller.abort(spec.signal?.reason ?? new Error('shell command aborted'))
    }
    if (spec.signal?.aborted) abortFromCaller()
    else spec.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return
      timedOut = true
      controller.abort(new Error('shell command timed out'))
    }, spec.timeoutMs)
    try {
      const handle = this.spawnLocal(route.selection, spec, controller.signal)
      const outcome = await handle.done
      return {
        ...outcome,
        timedOut,
        aborted: aborted && !timedOut,
        timeoutMs: spec.timeoutMs,
        stdout: readFinal(handle.collected.stdout),
        stderr: readFinal(handle.collected.stderr),
      }
    } finally {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  override start(spec: ShellExecSpec): ShellProcess {
    const route = this.requireSpec(spec)
    if (route.type === 'cloud') {
      const release = this.runtime.lease(route.selection)
      try {
        const process = this.runtime.cloud.shell.start(route.cloudSpec ?? spec)
        void process.done.finally(release).catch(() => {})
        return process
      } catch (error) {
        release()
        throw error
      }
    }
    throw new Error('local executor background commands are not supported yet')
  }

  private spawnLocal(
    selection: ServerRuntimeSelection,
    spec: ShellExecSpec,
    signal: AbortSignal | undefined,
  ): SubprocessHandle {
    const collect = (maxBytes: number) => ({ maxBytes })
    const env: NodeJS.ProcessEnv = { ...spec.env, ...spec.dshEnv }
    const spawnSpec: SubprocessSpawnSpec = {
      argv: this.shellArgv(selection, spec.command),
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
        stdout: collect(spec.stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      env,
    }
    return this.ctx.subprocess.spawn(spawnSpec)
  }

  private requireSpec(spec: ShellExecSpec): RoutedSpec {
    const route = this.specs.get(spec)
    if (route === undefined) throw new Error('server shell router: spec was not produced by resolve()')
    const selection = this.runtime.current()
    if (route.sessionId !== String(selection.state.sessionId)
      || route.bindingId !== selection.view.activeBindingId
      || route.environmentEpoch !== selection.view.environmentEpoch) {
      throw new Error('server shell router: execution environment changed after command resolution')
    }
    return route
  }

  private routedSpec(selection: ServerRuntimeSelection, cloudSpec?: ShellExecSpec): RoutedSpec {
    return {
      selection,
      sessionId: String(selection.state.sessionId),
      bindingId: String(selection.view.activeBindingId),
      environmentEpoch: selection.view.environmentEpoch,
      type: selection.environment.type,
      ...(cloudSpec === undefined ? {} : { cloudSpec }),
    }
  }

  private localWorkdir(selection: ServerRuntimeSelection, workdir: string | undefined): string {
    const root = selection.environment.rootPath
    if (root === undefined) throw new Error('server shell router: local workspace root is unavailable')
    if (workdir === undefined || workdir === selection.state.cwd) return root
    const paths = selection.environment.platform === 'win32' ? win32 : posix
    if (paths.isAbsolute(workdir)) return workdir
    const relative = hostRelative(selection.state.cwd, workdir)
    if (relative === '' || relative !== '..' && !relative.startsWith('../') && !relative.startsWith('..\\')) {
      return paths.join(root, ...relative.split(/[\\/]+/))
    }
    return paths.join(root, ...workdir.split(/[\\/]+/))
  }

  private shellArgv(selection: ServerRuntimeSelection, command: string): readonly string[] {
    const shell = selection.environment.shell
    if (selection.environment.platform === 'win32') {
      const executable = shell.toLowerCase().includes('pwsh') ? shell : 'powershell'
      return [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    }
    const executable = shell === 'unknown' || shell.length === 0 ? '/bin/bash' : shell
    return [executable, '-lc', command]
  }
}

export default ServerShellRouter
