/**
 * `LocalSpillStore`: the host-filesystem implementation of the
 * `@deepseek-ai/dsh-spill` storage seam. Persists a tool's oversized text to a
 * private, session-scoped file (see `./store.ts` for the traversal-safe naming
 * and exclusive owner-only write) and returns a path locator plus local
 * read/grep retrieval guidance.
 *
 * @module @deepseek-ai/dsh-spill-local
 */

import { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { workspaceSpillRoot } from '@deepseek-ai/dsh-home-paths'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { privateRoot, saveTextFile } from './store.ts'

export { encodeSegment, privateRoot, saveTextFile, sessionDir } from './store.ts'
export type { SavedText, SaveTextOptions } from './store.ts'

/** Where one session's spill artifacts live. */
export type SpillPlacement = 'private' | 'session-workspace'

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /**
   * Root directory for spill files. Omitted uses a lazily-created private
   * (0700) per-process directory under the OS temp dir — the safe default for
   * a local deployment. Set it to keep spill files under a known location.
   * Consulted only by the `private` placement.
   */
  root?: string
  /**
   * Which root one request's artifact lands under. `private` keeps the
   * historical host-private {@link Config.root}; `session-workspace` places
   * artifacts under `<workspace>/.dsh/spill` inside the OWNING session's own
   * workspace, which is the placement a deployment that confines session reads
   * to that workspace needs for the returned locator to be retrievable by the
   * very session that produced it.
   */
  placement?: SpillPlacement
}

/**
 * Local-filesystem spill backend. Files land under `<root>/session-<hash>/…`
 * with unpredictable names, an exclusive owner-only (0600) write, and a private
 * (0700) root — a spilled tool result must not be readable by other local users
 * or redirectable via a planted symlink. Under `session-workspace` the root is
 * the owning session's workspace, so the same naming and write discipline
 * applies inside a directory only that session may read.
 */
export class LocalSpillStore extends SpillStore {
  static Config: z<Config> = z.object({
    root: z.string(),
    placement: z.union(['private', 'session-workspace'] as const).default('private'),
  })

  /** Resolved absolute spill root (config `root`, else the private default), fixed at construction. */
  readonly root: string

  /** Configured artifact placement, fixed at construction. */
  readonly placement: SpillPlacement

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = config.root !== undefined ? resolve(config.root) : privateRoot()
    // Schemastery filled the default before construction; the cast records that runtime fact.
    this.placement = config.placement as SpillPlacement
  }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const saved = await saveTextFile({
      root: this.rootFor(input),
      sessionId: input.owner.sessionId,
      suggestedName: input.suggestedName,
      content: input.content,
    })
    return {
      locator: SpillLocator(saved.path),
      bytes: saved.bytes,
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
    }
  }

  /**
   * The root one request's artifact lands under. `session-workspace` REJECTS
   * when the owner carries no workspace: writing to the private root instead
   * would hand the model a locator outside its own read boundary, while a
   * rejection lets the spill policy keep the inline result.
   * @param input - the save request whose owner names the session.
   * @returns the absolute spill root for this request.
   * @throws Error when session-workspace placement has no owner workspace.
   */
  private rootFor(input: SaveTextSpill): string {
    if (this.placement !== 'session-workspace') return this.root
    const workspaceRoot = input.owner.workspaceRoot
    if (workspaceRoot === undefined) {
      throw new Error('spill-local: session-workspace placement requires the owning session workspace')
    }
    return workspaceSpillRoot(workspaceRoot)
  }
}

export default LocalSpillStore
