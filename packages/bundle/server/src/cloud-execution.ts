/** Captures the original cloud execution Providers inside an isolated realm. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

declare module '@deepseek-ai/cordis' {
  interface Context {
    cloudExecution: CloudExecution
  }
}

/** Stable bridge from root routers to the isolated cloud Providers. */
export class CloudExecution extends Service {
  static inject = ['fs', 'subprocess', 'shell']

  /** Cloud filesystem Provider captured from the isolated Server group. */
  readonly fs: FileSystem
  /** Cloud subprocess Provider captured from the isolated Server group. */
  readonly subprocess: SubprocessRuntime
  /** Cloud shell Provider captured from the isolated Server group. */
  readonly shell: ShellExecutor

  constructor(ctx: Context) {
    super(ctx, 'cloudExecution')
    this.fs = ctx.fs
    this.subprocess = ctx.subprocess
    this.shell = ctx.shell
  }
}

export default CloudExecution
