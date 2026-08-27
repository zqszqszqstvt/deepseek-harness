import { Command } from 'commander'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

declare module '@deepseek-ai/cordis' {
  interface Context { serverStartup: ServerStartupValues }
}

export const name = 'server-startup'
export const inject = ['cmdlineArgs']
/** Cordis service key carrying parsed Server startup values. */
export const SERVER_STARTUP_SERVICE = 'serverStartup'

/** Parsed Server command-line values shared by the HTTP and persistence plugins. */
export interface ServerStartupValues {
  /** HTTP bind address, or undefined before the command applies its default. */
  host?: '127.0.0.1' | '0.0.0.0'
  /** HTTP listen port, or undefined to use the consumer default. */
  port?: number
  /** Root for per-user workspaces and Server-owned state. */
  dataDir?: string
  /** Absolute directory for Server-owned session persistence. */
  sessionsDir: string
  /** Maximum user turns allowed to execute concurrently. */
  maxConcurrentTurns: number
}

interface ServerOptions {
  host?: string
  port?: string
  dataDir?: string
  maxConcurrent?: string
}

function serverCommand(): Command {
  return new Command()
    .name('dsh server')
    .description('Serve the multi-user dsh API in one long-lived process.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host (127.0.0.1 or 0.0.0.0)')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--data-dir <path>', 'root directory for per-user workspaces and state')
    .option('--max-concurrent <n>', 'maximum active turns across users (default: 8)')
    .addHelpText('after', '\nExamples:\n  dsh server --port 8080\n  dsh server --host 0.0.0.0 --data-dir /srv/dsh-data\n')
}

export function apply(ctx: Context): void {
  const program = serverCommand()
  program.action(() => {
    const options = program.opts<ServerOptions>()
    const host = options.host ?? '127.0.0.1'
    if (host !== '127.0.0.1' && host !== '0.0.0.0') program.error(`error: --host must be 127.0.0.1 or 0.0.0.0, got ${JSON.stringify(host)}`)
    if (options.port !== undefined && !/^\d+$/.test(options.port)) program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    if (options.maxConcurrent !== undefined && !/^\d+$/.test(options.maxConcurrent)) program.error('error: --max-concurrent must be a positive number')
    const maxConcurrentTurns = options.maxConcurrent === undefined ? 8 : Number(options.maxConcurrent)
    if (!Number.isSafeInteger(maxConcurrentTurns) || maxConcurrentTurns < 1) program.error('error: --max-concurrent must be at least 1')
    const dataDir = options.dataDir === undefined ? undefined : resolve(options.dataDir)
    ctx.provide(SERVER_STARTUP_SERVICE, {
      host,
      ...options.port === undefined ? {} : { port: Number(options.port) },
      ...dataDir === undefined ? {} : { dataDir },
      sessionsDir: resolve(dataDir ?? dshHomePath('server-data'), 'sessions'),
      maxConcurrentTurns,
    })
  })
  parseCmdline(ctx, program)
}
