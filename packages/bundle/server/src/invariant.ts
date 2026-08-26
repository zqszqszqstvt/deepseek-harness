/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-server`.
 * @module @deepseek-ai/dsh-server/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-server'

/** Cordis companion plugin name. */
export const name = 'server-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: request scheduling is transport-local and route,
 * persistence, workspace, and sandbox registrations belong to their provider
 * packages; this bundle owns no independently queryable Cordis data relation.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
