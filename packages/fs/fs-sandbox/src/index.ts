/**
 * `SandboxedFileSystem`: the sandbox-enforcing implementation of the
 * `@deepseek-ai/dsh-fs` Service Definition. It extends `LocalFileSystem` so all
 * text-storage mechanics — resolve, stat, read/stream, list, the atomic
 * write and the read-match-write edit critical section — are the local
 * implementation's, verbatim; this package adds per-call policy fences for
 * mutations and, when strictReads is enabled, for in-process reads.
 *
 * The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path,
 * NOT a kernel boundary — the operations are the seam's own (open, rename),
 * and only the target path is untrusted, so canonicalize-then-contain is the
 * complete answer to this surface. Kernel-grade isolation of untrusted CODE
 * stays `ctx.shell`'s job (`@deepseek-ai/dsh-bash-sandbox`). This mirrors the
 * `code-runtime` stance: containment, not a security boundary. The residual
 * TOCTOU (an ancestor symlink swapped between the containment re-check and the
 * syscall) is narrowed by re-canonicalizing immediately before delegating and
 * is accepted for this threat model.
 *
 * Per-call policy: `read-only` denies every mutation; `workspace-write` allows
 * a mutation only when the target canonicalizes under the policy's workspace
 * root or a platform temp area (the SAME writable-root set Seatbelt grants,
 * derived from the one `writableRoots` function so bash and fs cannot drift);
 * `danger-full-access` delegates unfenced. A denial throws the structured
 * `FS_SANDBOX_DENIED` — no text inference is needed (unlike bash's kernel
 * stderr), because an in-process fence knows exactly what it refused. The
 * escalation retry lives in the tool layer (`@deepseek-ai/dsh-tool-fs`),
 * exactly as bash's does.
 *
 * @module @deepseek-ai/dsh-fs-sandbox
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolve as resolvePath } from 'node:path'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isPathUnder } from './containment.ts'

/**
 * Plugin config: the local backend's knobs verbatim (`cwd` resolution default
 * and `diffBasisMaxBytes` overwrite-presentation bound). The sandbox default
 * (mode + `workspace-write` fallback root) is NOT here — `ctx.sandboxPolicy`
 * resolves each calling session for every enforcing capability.
 */
export interface Config extends LocalConfig {
  /** When true, every in-process filesystem read is contained in the session workspace. */
  strictReads?: boolean
}

/**
 * Sandbox-enforcing filesystem backend. Registers as `ctx.fs` (loading it
 * INSTEAD OF `dsh-fs-local`, together with a `ctx.sandboxPolicy`, is the whole
 * swap — the model-facing tools are untouched). Its configured default mode is
 * the capability fact exposed by {@link sandboxMode}; `dsh-tool-fs` resolves
 * each session's mode and cwd into a policy for every operation, while an
 * approved escalation may stamp a strictly wider mode for one call.
 */
export class SandboxedFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy']
  static override Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
    diffBasisMaxBytes: z.number().default(10 * 1024 * 1024),
    strictReads: z.boolean().default(false),
  })

  private readonly defaultMode: SandboxMode
  private readonly strictReads: boolean
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
    this.strictReads = config.strictReads === true
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  override async stat(target: FsTarget, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsInfo | undefined> {
    await this.checkedReadTarget(target, sandboxPolicy)
    return super.stat(target, signal)
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsPathInfo | undefined> {
    await this.checkedReadPath(path, opts?.cwd, sandboxPolicy)
    return super.lstat(path, opts, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<string> {
    await this.checkedReadTarget(target, sandboxPolicy)
    return super.readText(target, signal)
  }

  override async streamText(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<AsyncIterable<string>> {
    await this.checkedReadTarget(target, sandboxPolicy)
    return super.streamText(target, signal)
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<Uint8Array> {
    await this.checkedReadTarget(target, sandboxPolicy)
    return super.readBytes(target, signal, maxBytes)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsDirEntry[]> {
    await this.checkedReadTarget(target, sandboxPolicy)
    const entries = await super.listDir(target, signal)
    if (!this.strictReads) return entries
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    for (const entry of entries) await this.checkedReadTarget(entry.target, policy)
    return entries
  }

  /**
   * Fence the write by the per-call policy, then delegate to the inherited
   * atomic write. See {@link checkedTarget}.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the write outcome from the inherited backend.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
  }

  /**
   * Fence the edit by the per-call policy, then delegate to the inherited
   * atomic edit. See {@link checkedTarget}.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the edit outcome from the inherited backend.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal)
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target the
   * mutation must use, so the checked identity is the mutated one (no
   * check-here-write-there TOCTOU). `read-only` denies; `workspace-write`
   * re-canonicalizes NOW (`resolve` realpaths the deepest existing ancestor,
   * reflecting a concurrently swapped symlink), requires containment under a
   * writable root, and returns THAT fresh target; `danger-full-access` returns
   * the caller's target unfenced. Throws the structured `FS_SANDBOX_DENIED` on
   * refusal — the tool layer maps it to the model-facing `[sandbox: …]` marker
   * and the escalation hint.
   */
  private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    // workspace-write: containment on the FRESH canonical path (catches a
    // symlink ancestor swapped since the tool resolved this target), and the
    // mutation delegates with THIS fresh target — never the stale one.
    const fresh = await this.resolve(target.displayPath)
    let contained = false
    for (const root of writableRoots(policy)) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }

  /** Enforce the session workspace boundary for an already resolved target. */
  private async checkedReadTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<void> {
    if (!this.strictReads) return
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    if (policy.mode === 'danger-full-access') return
    if (!await isPathUnder(String(target.targetKey), policy.workspaceRoot)) {
      throw new FsError(`cannot read "${target.displayPath}": file access denied outside the session workspace`, 'FS_SANDBOX_DENIED')
    }
  }

  /** Enforce containment for path-shaped lstat calls before following nothing. */
  private async checkedReadPath(path: string, cwd: string | undefined, sandboxPolicy?: SandboxExecutionPolicy): Promise<void> {
    if (!this.strictReads) return
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    if (policy.mode === 'danger-full-access') return
    const displayPath = resolvePath(cwd ?? this.config.cwd, path)
    if (!await isPathUnder(displayPath, policy.workspaceRoot)) {
      throw new FsError(`cannot inspect "${displayPath}": file access denied outside the session workspace`, 'FS_SANDBOX_DENIED')
    }
  }
}

export default SandboxedFileSystem
