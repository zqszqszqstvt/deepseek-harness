/** Model-facing shell Consumer whose dialect follows the active execution environment. */

import { isAbsolute, join, relative as hostRelative, resolve as resolveHostPath, posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { resolveConfinedCwd } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import type { CollectedOutput, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type {
  GenericCallView,
  TerminalCallView,
  ToolExecution,
  ToolResult,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'
import { ServerBackgroundOutput } from './background-spill.ts'
import type { ServerRuntimeRouter, ServerRuntimeSelection } from './runtime-router.ts'
import { publishServerSpillFile } from './spill-store.ts'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from './runtime-router.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    shell: 'shell'
  }
}

export const name = 'tool-server-shell'
export const inject = ['tools', 'shell', 'shellEnv', 'systemPrompt', 'serverRuntimeRouter']

const DEFAULT_BACKGROUND_TIMEOUT_MS = 30 * 60 * 1_000

/** Server shell limits. */
export interface Config {
  /** Maximum lifetime of one cloud background command. */
  backgroundTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  backgroundTimeoutMs: z.number().min(60_000).max(24 * 60 * 60 * 1_000).default(DEFAULT_BACKGROUND_TIMEOUT_MS),
})

interface ShellToolArgs {
  readonly command: string
  readonly description: string
  readonly timeoutMs?: number
  readonly workdir?: string
  readonly run_in_background?: boolean
}

interface ShellForegroundResult {
  readonly kind: 'foreground'
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly timeoutMs: number
  readonly stdout: { readonly text: string; readonly truncated: boolean; readonly spillPath?: string }
  readonly stderr: { readonly text: string; readonly truncated: boolean; readonly spillPath?: string }
  readonly sandbox?: {
    readonly mode: string
    readonly denied: boolean
    readonly enforcement?: string
    readonly runnerFailed?: boolean
  }
}

function validateArgs(args: ShellToolArgs): void {
  if (args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
}

/** Exact environment exposed to one cloud command after ambient inheritance is disabled. */
function cloudEnvironment(workspaceRoot: string): Record<string, string> {
  const home = join(workspaceRoot, '.home')
  const cache = join(workspaceRoot, '.cache')
  return {
    HOME: home,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: '/tmp',
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    UV_CACHE_DIR: join(cache, 'uv'),
    UV_PYTHON_DOWNLOADS: 'never',
    PIP_CACHE_DIR: join(cache, 'pip'),
    npm_config_cache: join(cache, 'npm'),
    npm_config_store_dir: join(cache, 'pnpm-store'),
    PYTHONNOUSERSITE: '1',
  }
}

function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

function renderResult(result: ShellForegroundResult): string {
  const stdout = streamText(result.stdout)
  const stderr = streamText(result.stderr)
  let body = stdout
  if (stderr.length > 0) body += `${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}[stderr]\n${stderr}`
  if (body.length === 0) body = '(no output)'
  const markers: string[] = []
  if (result.sandbox?.denied) markers.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  return markers.length === 0 ? body : `${body}${body.endsWith('\n') ? '' : '\n'}${markers.join('\n')}`
}

async function canonicalResult(
  ctx: Context,
  result: ShellRunResult,
  selection: ServerRuntimeSelection,
): Promise<ShellForegroundResult> {
  const output = async (stream: CollectedOutput, label: string) => {
    let spillPath = stream.spillPath
    if (spillPath !== undefined && selection.environment.type === 'cloud') {
      try {
        spillPath = await publishServerSpillFile(spillPath, selection.state, label)
      } catch (error) {
        ctx.logger.warn('server shell could not publish %s spill output: %o', label, error)
        spillPath = undefined
      }
    }
    return {
      text: stream.text,
      truncated: stream.truncated,
      ...(spillPath === undefined ? {} : { spillPath }),
    }
  }
  return {
    kind: 'foreground' as const,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: await output(result.stdout, 'shell-stdout'),
    stderr: await output(result.stderr, 'shell-stderr'),
    ...(result.sandbox === undefined ? {} : {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...(result.sandbox.enforcement === undefined ? {} : { enforcement: result.sandbox.enforcement }),
        ...(result.sandbox.runnerFailed === undefined ? {} : { runnerFailed: result.sandbox.runnerFailed }),
      },
    }),
  }
}

function processOutcome(process: ShellProcess): { status: 'completed' | 'killed'; detail: string } {
  return process.status === 'killed'
    ? { status: 'killed', detail: process.signal === null ? 'killed before exit' : `signal: ${process.signal}` }
    : { status: 'completed', detail: `exit code: ${process.exitCode ?? 0}` }
}

/**
 * Resolve one shell call's working directory in the active environment.
 *
 * The cloud branch resolves against the SAME per-call identity that confines
 * the execution — the resolved policy root, which the sandbox binds — and then
 * canonicalizes and containment-checks the result, so an escaping absolute or
 * relative `workdir` fails before any spawn instead of relying on the mount
 * namespace to make the target unreachable. Without a policy (a deployment with
 * no `ctx.sandboxPolicy`) the resolved value passes through, exactly as the
 * platform bash tool does.
 *
 * The local branch deliberately does NOT confine here: the workdir is a path on
 * a remote device whose filesystem this process cannot canonicalize, and the
 * executor owns that device's physical boundary (it resolves every directory
 * against the authorized project root before spawning).
 */
function resolveWorkdir(
  requested: string | undefined,
  execution: ToolExecution,
  selection: ServerRuntimeSelection,
  policy: SandboxExecutionPolicy | undefined,
): string {
  const sessionCwd = execution.agent?.session.header.cwd ?? selection.state.cwd
  if (selection.environment.type === 'cloud') {
    const base = policy?.workspaceRoot ?? sessionCwd
    const resolved = requested === undefined
      ? base
      : isAbsolute(requested) ? requested : resolveHostPath(base, requested)
    return policy === undefined ? resolved : resolveConfinedCwd(resolved, policy)
  }
  const root = selection.environment.rootPath
  if (root === undefined) throw new Error('shell: local workspace root is unavailable')
  if (requested === undefined || requested === sessionCwd) return root
  const paths = selection.environment.platform === 'win32' ? win32 : posix
  if (paths.isAbsolute(requested)) return requested
  if (isAbsolute(requested)) {
    const relative = hostRelative(sessionCwd, requested)
    if (relative === '' || relative !== '..' && !relative.startsWith('../') && !relative.startsWith('..\\')) {
      return paths.join(root, ...relative.split(/[\\/]+/))
    }
  }
  return paths.join(root, ...requested.split(/[\\/]+/))
}

function presentCall(args: ShellToolArgs): GenericCallView | TerminalCallView {
  return args.run_in_background === true
    ? {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
    : {
      card: 'terminal',
      title: args.command,
      description: args.description,
      ...(args.workdir === undefined ? {} : { cwd: args.workdir }),
    }
}

function presentResult(args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  if (result.isError || typeof args === 'object' && args !== null
    && (args as { run_in_background?: unknown }).run_in_background === true) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${block.text.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  const { body, ...exit } = parseExitStatus(block.text)
  return { card: 'terminal', output: body, ...exit }
}

/** Register one environment-neutral shell tool for Server Sessions. */
export function apply(ctx: Context, config: Config): void {
  const runtime: ServerRuntimeRouter = ctx.serverRuntimeRouter
  const sandboxPolicy: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
  const backgroundTimeoutMs = config.backgroundTimeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS
  ctx.systemPrompt.section({
    name: 'tool:shell',
    order: 105,
    text: 'Write shell commands for the active execution environment reported in the environment context. Check every exit marker before continuing.',
  })
  ctx.tools.register(defineTool({
    name: 'shell',
    description: 'Execute a command in the active execution environment using that environment\'s reported shell. Use PowerShell syntax and native Windows paths for a Windows environment; use the reported POSIX shell syntax otherwise. Each call starts a fresh shell. Cloud execution supports background jobs; local execution currently supports foreground commands only. Commands never fall back to another environment.',
    parameters: {
      command: { type: 'string', required: true, description: 'Command written for the active environment\'s reported shell.' },
      description: { type: 'string', required: true, description: 'Concise active-voice description shown in the UI.' },
      timeoutMs: { type: 'number', description: 'Foreground timeout in milliseconds, capped at 120000.' },
      workdir: { type: 'string', description: 'Working directory in the active environment. Relative paths resolve from its project root.' },
      run_in_background: { type: 'boolean', description: `Start a cloud command as a background job, capped at ${backgroundTimeoutMs}ms. Local environments reject this option.` },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              timedOut: { type: 'boolean', required: true },
              aborted: { type: 'boolean', required: true },
              timeoutMs: { type: 'number', required: true },
              stdout: {
                type: 'object', required: true, additionalProperties: false,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              stderr: {
                type: 'object', required: true, additionalProperties: false,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              sandbox: {
                type: 'object', additionalProperties: false,
                properties: {
                  mode: { type: 'string', required: true },
                  denied: { type: 'boolean', required: true },
                  enforcement: { type: 'string' },
                  runnerFailed: { type: 'boolean' },
                },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background' ? `started background job ${value.jobId}` : renderResult(value),
      }],
    },
    async execute(args: ShellToolArgs, execution) {
      validateArgs(args)
      const selection = runtime.current()
      const policy: SandboxExecutionPolicy | undefined = sandboxPolicy?.resolve(
        execution.agent === undefined ? {} : { session: execution.agent.session },
      )
      // Resolved before the workdir so one identity decides both the confinement
      // and the directory the command starts in.
      const workdir = resolveWorkdir(args.workdir, execution, selection, policy)
      const workspaceRoot = policy?.workspaceRoot ?? execution.agent?.session.header.cwd ?? selection.state.cwd
      const request = {
        command: args.command,
        workdir,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(selection.environment.type === 'cloud' ? { env: cloudEnvironment(workspaceRoot) } : {}),
        dshEnv: ctx.shellEnv.collect(execution),
        ...(policy === undefined ? {} : { sandboxPolicy: policy }),
      }
      if (args.run_in_background === true) {
        if (selection.environment.type !== 'cloud') {
          throw new Error('local executor background commands are not supported yet')
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) throw new Error('background jobs are unavailable in this deployment')
        if (execution.signal.aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        const id = jobs.start({
          kind: 'shell',
          label: args.command,
          ...(execution.agent === undefined ? {} : { owner: execution.agent }),
          run: () => {
            const process = ctx.shell.start(ctx.shell.resolve(request))
            const output = new ServerBackgroundOutput(ctx, selection.state)
            let expired = false
            const timeout = setTimeout(() => {
              expired = process.kill()
            }, backgroundTimeoutMs)
            timeout.unref()
            return {
              cancel: () => { process.kill() },
              done: process.done.then(async () => {
                await output.settle(process)
                return expired
                  ? { status: 'killed' as const, detail: `timed out after ${backgroundTimeoutMs}ms` }
                  : processOutcome(process)
              }).finally(() => { clearTimeout(timeout) }),
              readOutput: () => output.read(process),
            }
          },
        })
        return { kind: 'background' as const, jobId: id }
      }
      const result = await ctx.shell.run(ctx.shell.resolve({ ...request, signal: execution.signal }))
      if (result.aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return canonicalResult(ctx, result, selection)
    },
    presentCall,
    presentResult,
  }))
}
