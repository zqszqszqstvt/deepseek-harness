/** Package companion for the pure executor wire protocol. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-executor-protocol'

/** Cordis companion plugin name. */
export const name = 'executor-protocol-invariant'
/** Service required before package ownership can be registered. */
export const inject = ['invariants']

/** No runtime invariant: both wire endpoints own validated lifecycle behavior. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
