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
  /** Maximum open Server SSE responses across all users. */
  maxSseConnections: number
  /** Maximum open Server SSE responses for one user. */
  maxSseConnectionsPerUser: number
  /** Maximum encoded bytes waiting behind one slow SSE response. */
  sseClientBufferBytes: number
}

interface ServerOptions {
  host?: string
  port?: string
  dataDir?: string
  maxConcurrent?: string
  maxSseConnections?: string
  maxSseConnectionsPerUser?: string
  sseBufferBytes?: string
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
    .option('--max-sse-connections <n>', 'maximum open SSE responses across users (default: 128)')
    .option('--max-sse-connections-per-user <n>', 'maximum open SSE responses per user (default: 2)')
    .option('--sse-buffer-bytes <n>', 'maximum queued bytes per slow SSE response (default: 1048576)')
    .addHelpText('after', `
Deployment contract:
  dsh server does not authenticate clients. Keep it on loopback or a trusted
  backend network. The authenticating backend must derive each URL userId from
  the authenticated principal; never accept a caller-controlled userId.

Examples:
  dsh server --port 13080
  dsh server --host 0.0.0.0 --port 13080 --data-dir /srv/dsh-data  # trusted backend network only
`)
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
    const maxSseConnections = options.maxSseConnections === undefined ? 128 : Number(options.maxSseConnections)
    const maxSseConnectionsPerUser = options.maxSseConnectionsPerUser === undefined ? 2 : Number(options.maxSseConnectionsPerUser)
    const sseClientBufferBytes = options.sseBufferBytes === undefined ? 1048576 : Number(options.sseBufferBytes)
    if (!Number.isSafeInteger(maxSseConnections) || maxSseConnections < 1) program.error('error: --max-sse-connections must be at least 1')
    if (!Number.isSafeInteger(maxSseConnectionsPerUser) || maxSseConnectionsPerUser < 1) program.error('error: --max-sse-connections-per-user must be at least 1')
    if (maxSseConnectionsPerUser > maxSseConnections) program.error('error: --max-sse-connections-per-user cannot exceed --max-sse-connections')
    if (!Number.isSafeInteger(sseClientBufferBytes) || sseClientBufferBytes < 1) program.error('error: --sse-buffer-bytes must be at least 1')
    const dataDir = options.dataDir === undefined ? undefined : resolve(options.dataDir)
    ctx.provide(SERVER_STARTUP_SERVICE, {
      host,
      ...options.port === undefined ? {} : { port: Number(options.port) },
      ...dataDir === undefined ? {} : { dataDir },
      sessionsDir: resolve(dataDir ?? dshHomePath('server-data'), 'sessions'),
      maxConcurrentTurns,
      maxSseConnections,
      maxSseConnectionsPerUser,
      sseClientBufferBytes,
    })
  })
  parseCmdline(ctx, program)
}
