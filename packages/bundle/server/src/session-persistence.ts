/** Server-owned JSONL session persistence rooted below the configured data directory. */

import type { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ServerStartupValues } from './startup.ts'

/** Cordis plugin name. */
export const name = 'server-session-persistence'
/** Server command-line configuration required before persistence starts. */
export const inject = ['serverStartup']

/**
 * Mount the shared persistence backend after server command-line configuration resolves.
 * @param ctx - Server profile context carrying the resolved startup values.
 */
export function apply(ctx: Context): void {
  const startup = ctx.serverStartup as ServerStartupValues
  ctx.plugin(JsonlSessionPersistence, { root: startup.sessionsDir })
}
