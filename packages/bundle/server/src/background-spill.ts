/** Server publication for lossy background cloud-shell output. */

import type { Context } from '@deepseek-ai/cordis'
import type { ShellProcess, ShellProcessRead } from '@deepseek-ai/dsh-shell'
import type { ProjectSessionState } from './project-session.ts'
import { publishServerSpillFile } from './spill-store.ts'

const PENDING_NOTICE = '[some output was dropped from memory; full output will be available after the job completes]'

function appendNotice(text: string, notice: string): string {
  return `${text}${text.length > 0 && !text.endsWith('\n') ? '\n' : ''}${notice}`
}

/**
 * Hide private collector paths while a process runs, then expose published
 * workspace paths after settlement.
 */
export class ServerBackgroundOutput {
  private readonly sources = new Map<'shell-stdout' | 'shell-stderr', string>()
  private lossy = false
  private settledOutput: string | undefined

  constructor(
    private readonly ctx: Context,
    private readonly state: ProjectSessionState,
  ) {}

  private observe(read: ShellProcessRead): void {
    this.lossy ||= read.lossy
    if (read.stdoutSpillPath !== undefined) this.sources.set('shell-stdout', read.stdoutSpillPath)
    if (read.stderrSpillPath !== undefined) this.sources.set('shell-stderr', read.stderrSpillPath)
  }

  /**
   * Consume the next process delta without exposing a host-private path.
   * @param process - active cloud shell process whose output has one consuming cursor.
   * @returns the delta and, when lossy, a notice that recovery follows settlement.
   */
  read(process: ShellProcess): string {
    if (this.settledOutput !== undefined) {
      const output = this.settledOutput
      this.settledOutput = ''
      return output
    }
    const next = process.readOutput()
    this.observe(next)
    return next.lossy ? appendNotice(next.delta, PENDING_NOTICE) : next.delta
  }

  /**
   * Publish every observed private spill after the collector has closed it.
   * @param process - settled cloud shell process supplying the final unread delta.
   * @returns after publication finishes and the final job output is ready.
   */
  async settle(process: ShellProcess): Promise<void> {
    const final = process.readOutput()
    this.observe(final)
    let output = final.delta
    if (this.lossy) {
      const published = await Promise.all([...this.sources].map(async ([label, source]) => {
        try {
          return await publishServerSpillFile(source, this.state, label)
        } catch (error) {
          this.ctx.logger.warn('server shell could not publish %s background spill output: %o', label, error)
          return undefined
        }
      }))
      const paths = published.filter((path): path is string => path !== undefined)
      const location = paths.length === 0 ? '(unavailable)' : paths.join(', ')
      output = appendNotice(output, `[some output was dropped from memory; full output: ${location}]`)
    }
    this.settledOutput = output
  }
}
