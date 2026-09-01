/** Session-aware filesystem Provider routing cloud and local targets. */

import { randomUUID } from 'node:crypto'
import { posix, relative as hostRelative, win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
} from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { z } from 'zod'
import {
  RemoteExecutionError,
  type ServerRuntimeRouter,
  type ServerRuntimeSelection,
} from './runtime-router.ts'
import type {} from './runtime-router.ts'

const REQUEST_TIMEOUT_MS = 120_000

const targetResult = z.object({
  targetKey: z.string(),
  displayPath: z.string(),
  processPath: z.string(),
  fileUrl: z.string(),
})
const infoResult = z.object({
  version: z.string(),
  type: z.enum(['file', 'directory', 'other']),
  size: z.number().nonnegative().optional(),
}).nullable()
const pathInfoResult = z.object({
  version: z.string(),
  type: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.number().nonnegative().optional(),
}).nullable()
const dirEntriesResult = z.array(z.object({
  name: z.string(),
  type: z.enum(['file', 'directory', 'other']),
  target: z.object({ targetKey: z.string(), displayPath: z.string() }),
  version: z.string().optional(),
  size: z.number().nonnegative().optional(),
}))
const writeResult = z.object({
  operation: z.enum(['create', 'update']),
  version: z.string(),
  before: z.string().nullable(),
  after: z.string(),
})
const editResult = z.object({
  version: z.string(),
  before: z.string(),
  after: z.string(),
})
const bytesResult = z.object({
  encoding: z.literal('base64'),
  data: z.string(),
  byteLength: z.number().int().nonnegative(),
})

interface RoutedTarget {
  readonly sessionId: string
  readonly bindingId: string
  readonly environmentEpoch: number
  readonly type: 'cloud' | 'local'
  readonly platform: string
  readonly target: FsTarget
  readonly processPath: string
  readonly fileUrl: string
}

function fsCode(error: RemoteExecutionError): FsErrorCode {
  switch (error.code) {
    case 'FS_NOT_FOUND':
    case 'FS_NOT_DIRECTORY':
    case 'FS_NOT_TEXT':
    case 'FS_NOT_REGULAR_FILE':
    case 'FS_TOO_LARGE':
    case 'FS_PERMISSION_DENIED':
    case 'FS_SANDBOX_DENIED':
    case 'FS_IO_ERROR':
    case 'FS_STALE_VERSION':
    case 'FS_NOT_OBSERVED':
    case 'FS_AMBIGUOUS_EDIT':
    case 'FS_EDIT_NOT_FOUND':
    case 'FS_ABORTED':
      return error.code
    case 'WORKSPACE_ROOT_PROTECTED':
    case 'REQUEST_SCOPE_MISMATCH':
      return 'FS_SANDBOX_DENIED'
    default:
      return 'FS_IO_ERROR'
  }
}

/** Root Provider that keeps every target pinned to the environment that created it. */
export class ServerFileSystemRouter extends FileSystem {
  static inject = ['serverRuntimeRouter']

  private readonly runtime: ServerRuntimeRouter
  private readonly targets = new Map<string, RoutedTarget>()

  constructor(ctx: Context) {
    super(ctx)
    this.runtime = ctx.serverRuntimeRouter
  }

  override get sandboxMode() {
    return this.runtime.cloud.fs.sandboxMode
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const selection = this.runtime.current()
    if (selection.environment.type === 'cloud') {
      return this.runtime.run(selection, async () => {
        const target = await this.runtime.cloud.fs.resolve(path, opts)
        return this.wrap(
          selection,
          target,
          this.runtime.cloud.fs.processPath(target),
          this.runtime.cloud.fs.fileUrl(target),
        )
      })
    }
    const requestedPath = this.localPath(selection, path)
    const cwd = opts?.cwd === undefined ? undefined : this.localPath(selection, opts.cwd)
    const value = await this.remote(selection, {
      kind: 'fs.resolve',
      path: requestedPath,
      ...(cwd === undefined ? {} : { cwd }),
    }, opts?.signal)
    const result = targetResult.parse(value)
    return this.wrap(
      selection,
      { targetKey: FsTargetKey(result.targetKey), displayPath: result.displayPath },
      result.processPath,
      result.fileUrl,
    )
  }

  override processPath(target: FsTarget): string {
    return this.requireTarget(target).processPath
  }

  override fileUrl(target: FsTarget): string {
    return this.requireTarget(target).fileUrl
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentRoute = this.requireTarget(parent)
    const childRoute = this.requireTarget(child)
    if (parentRoute.bindingId !== childRoute.bindingId
      || parentRoute.environmentEpoch !== childRoute.environmentEpoch) return false
    if (parentRoute.type === 'cloud') {
      return this.runtime.cloud.fs.contains(parentRoute.target, childRoute.target)
    }
    const paths = parentRoute.platform === 'win32' ? win32 : posix
    const path = paths.relative(parentRoute.processPath, childRoute.processPath)
    return path === '' || (path !== '..' && !path.startsWith('../') && !path.startsWith('..\\')
      && !paths.isAbsolute(path))
  }

  override async stat(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsInfo | undefined> {
    const route = this.requireTarget(target)
    if (route.type === 'cloud') {
      const selection = this.runtime.current()
      return this.runtime.run(selection, () => this.runtime.cloud.fs.stat(route.target, signal, sandboxPolicy))
    }
    const result = infoResult.parse(await this.remoteForTarget(route, {
      kind: 'fs.stat',
      targetKey: String(route.target.targetKey),
    }, signal))
    return result === null ? undefined : {
      version: FsVersion(result.version),
      type: result.type,
      ...(result.size === undefined ? {} : { size: result.size }),
    }
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsPathInfo | undefined> {
    const selection = this.runtime.current()
    if (selection.environment.type === 'cloud') {
      return this.runtime.run(
        selection,
        () => this.runtime.cloud.fs.lstat(path, opts, signal, sandboxPolicy),
      )
    }
    const result = pathInfoResult.parse(await this.remote(selection, {
      kind: 'fs.lstat',
      path: this.localPath(selection, path),
      ...(opts?.cwd === undefined ? {} : { cwd: this.localPath(selection, opts.cwd) }),
    }, signal))
    return result === null ? undefined : {
      version: FsVersion(result.version),
      type: result.type,
      ...(result.size === undefined ? {} : { size: result.size }),
    }
  }

  override async readText(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<string> {
    const route = this.requireTarget(target)
    if (route.type === 'cloud') {
      const selection = this.runtime.current()
      return this.runtime.run(
        selection,
        () => this.runtime.cloud.fs.readText(route.target, signal, sandboxPolicy),
      )
    }
    return z.string().parse(await this.remoteForTarget(route, {
      kind: 'fs.readText',
      targetKey: String(route.target.targetKey),
    }, signal))
  }

  override async streamText(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<AsyncIterable<string>> {
    const route = this.requireTarget(target)
    if (route.type === 'cloud') {
      const selection = this.runtime.current()
      const release = this.runtime.lease(selection)
      try {
        const chunks = await this.runtime.cloud.fs.streamText(route.target, signal, sandboxPolicy)
        return (async function* (): AsyncIterable<string> {
          try {
            yield* chunks
          } finally {
            release()
          }
        })()
      } catch (error) {
        release()
        throw error
      }
    }
    const text = await this.readText(target, signal, sandboxPolicy)
    return (async function* (): AsyncIterable<string> { yield text })()
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<Uint8Array> {
    const route = this.requireTarget(target)
    if (route.type === 'cloud') {
      const selection = this.runtime.current()
      return this.runtime.run(
        selection,
        () => this.runtime.cloud.fs.readBytes(route.target, signal, maxBytes, sandboxPolicy),
      )
    }
    const result = bytesResult.parse(await this.remoteForTarget(route, {
      kind: 'fs.readBytes',
      targetKey: String(route.target.targetKey),
      maxBytes,
    }, signal))
    const bytes = Buffer.from(result.data, 'base64')
    if (bytes.byteLength !== result.byteLength || bytes.byteLength > maxBytes) {
      throw new FsError('local executor returned invalid byte content', 'FS_IO_ERROR')
    }
    return bytes
  }

  override async listDir(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsDirEntry[]> {
    const route = this.requireTarget(target)
    if (route.type === 'cloud') {
      const selection = this.runtime.current()
      const entries = await this.runtime.run(
        selection,
        () => this.runtime.cloud.fs.listDir(route.target, signal, sandboxPolicy),
      )
      return entries.map(entry => ({
        ...entry,
        target: this.wrap(
          selection,
          entry.target,
          this.runtime.cloud.fs.processPath(entry.target),
          this.runtime.cloud.fs.fileUrl(entry.target),
        ),
      }))
    }
    const selection = this.runtime.current()
    const entries = dirEntriesResult.parse(await this.remoteForTarget(route, {
      kind: 'fs.listDir',
      targetKey: String(route.target.targetKey),
    }, signal))
    return entries.map(entry => ({
      name: entry.name,
      type: entry.type,
      target: this.wrap(
        selection,
        { targetKey: FsTargetKey(entry.target.targetKey), displayPath: entry.target.displayPath },
        entry.target.displayPath,
        this.fileUrlFromPath(route.platform, entry.target.displayPath),
      ),
      ...(entry.version === undefined ? {} : { version: FsVersion(entry.version) }),
      ...(entry.size === undefined ? {} : { size: entry.size }),
    }))
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const route = this.requireTarget(target)
    if (route.type === 'cloud') {
      const selection = this.runtime.current()
      return this.runtime.run(
        selection,
        () => this.runtime.cloud.fs.writeText(route.target, content, expected, signal, sandboxPolicy),
      )
    }
    const result = writeResult.parse(await this.remoteForTarget(route, {
      kind: 'fs.writeText',
      targetKey: String(route.target.targetKey),
      content,
      ...(expected === undefined ? {} : {
        expected: expected.kind === 'createIfAbsent'
          ? { kind: 'createIfAbsent' as const }
          : { kind: 'replaceIfVersion' as const, version: String(expected.version) },
      }),
    }, signal))
    return {
      operation: result.operation,
      version: FsVersion(result.version),
      before: result.before,
      after: result.after,
    }
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const route = this.requireTarget(target)
    if (route.type === 'cloud') {
      const selection = this.runtime.current()
      return this.runtime.run(
        selection,
        () => this.runtime.cloud.fs.editText(route.target, edit, expected, signal, sandboxPolicy),
      )
    }
    const result = editResult.parse(await this.remoteForTarget(route, {
      kind: 'fs.editText',
      targetKey: String(route.target.targetKey),
      oldString: edit.oldString,
      newString: edit.newString,
      replaceAll: edit.replaceAll,
      ...(expected === undefined ? {} : { expectedVersion: String(expected.version) }),
    }, signal))
    return {
      version: FsVersion(result.version),
      before: result.before,
      after: result.after,
    }
  }

  private wrap(
    selection: ServerRuntimeSelection,
    target: FsTarget,
    processPath: string,
    fileUrl: string,
  ): FsTarget {
    const targetKey = FsTargetKey('server-runtime:' + randomUUID())
    this.targets.set(String(targetKey), {
      sessionId: String(selection.state.sessionId),
      bindingId: String(selection.view.activeBindingId),
      environmentEpoch: selection.view.environmentEpoch,
      type: selection.environment.type,
      platform: selection.environment.platform,
      target,
      processPath,
      fileUrl,
    })
    return { targetKey, displayPath: target.displayPath }
  }

  private requireTarget(target: FsTarget): RoutedTarget {
    const route = this.targets.get(String(target.targetKey))
    if (route === undefined) throw new FsError('filesystem target is not owned by this runtime', 'FS_IO_ERROR')
    const selection = this.runtime.current()
    if (route.sessionId !== String(selection.state.sessionId)
      || route.bindingId !== selection.view.activeBindingId
      || route.environmentEpoch !== selection.view.environmentEpoch) {
      throw new FsError(
        'filesystem target belongs to a previous execution environment; resolve the path again',
        'FS_STALE_VERSION',
      )
    }
    return route
  }

  private async remoteForTarget(
    _route: RoutedTarget,
    operation: Parameters<ServerRuntimeRouter['executeLocal']>[1],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.remote(this.runtime.current(), operation, signal)
  }

  private async remote(
    selection: ServerRuntimeSelection,
    operation: Parameters<ServerRuntimeRouter['executeLocal']>[1],
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.runtime.executeLocal(
        selection,
        operation,
        REQUEST_TIMEOUT_MS,
        signal === undefined ? {} : { signal },
      )
    } catch (error) {
      if (signal?.aborted) throw new FsError('filesystem operation aborted', 'FS_ABORTED', { cause: error })
      if (error instanceof RemoteExecutionError) {
        throw new FsError(error.message, fsCode(error), { cause: error })
      }
      throw error
    }
  }

  private localPath(selection: ServerRuntimeSelection, value: string): string {
    const root = selection.environment.rootPath
    if (root === undefined) return value
    if (value === selection.state.cwd) return root
    const relative = hostRelative(selection.state.cwd, value)
    if (relative !== '' && relative !== '..' && !relative.startsWith('../')
      && !relative.startsWith('..\\')) {
      const paths = selection.environment.platform === 'win32' ? win32 : posix
      return paths.join(root, ...relative.split(/[\\/]+/))
    }
    return value
  }

  private fileUrlFromPath(platform: string, value: string): string {
    const normalized = value.replace(/\\/g, '/').split('/').map((part, index) =>
      platform === 'win32' && index === 0 && /^[a-zA-Z]:$/.test(part)
        ? part
        : encodeURIComponent(part)).join('/')
    return platform === 'win32' ? 'file:///' + normalized : 'file://' + normalized
  }
}

export default ServerFileSystemRouter
