/** Server-owned spill publication inside one authoritative project workspace. */

import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import { workspaceSpillRoot } from '@deepseek-ai/dsh-home-paths'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import type { ProjectSessionState } from './project-session.ts'
import type {} from './environments.ts'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

function artifactName(suggestedName: string): string {
  const label = createHash('sha256').update(suggestedName).digest('hex').slice(0, 12)
  return `${randomBytes(12).toString('hex')}-${label}.txt`
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === ''
}

async function ensureDirectDirectory(parent: string, name: string): Promise<string> {
  const expected = join(parent, name)
  try {
    await mkdir(expected, { mode: DIRECTORY_MODE })
  } catch (error: unknown) {
    /* v8 ignore next -- non-EEXIST mkdir failures depend on host filesystem fault injection and pass through unchanged. */
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const info = await lstat(expected)
  if (info.isSymbolicLink()) {
    throw new Error(`server spill directory must not be a symbolic link: ${JSON.stringify(expected)}`)
  }
  if (!info.isDirectory()) {
    throw new Error(`server spill path is not a directory: ${JSON.stringify(expected)}`)
  }
  const canonical = await realpath(expected)
  /* v8 ignore next 2 -- this branch requires another host actor to replace the checked directory before realpath. */
  if (!samePath(canonical, expected)) {
    throw new Error(`server spill directory escaped its project workspace: ${JSON.stringify(expected)}`)
  }
  return canonical
}

async function sessionSpillDirectory(state: ProjectSessionState): Promise<string> {
  const workspace = await realpath(resolve(state.cwd))
  const workspaceInfo = await lstat(workspace)
  if (!workspaceInfo.isDirectory()) {
    throw new Error(`server project workspace is not a directory: ${JSON.stringify(state.cwd)}`)
  }
  const dsh = await ensureDirectDirectory(workspace, '.dsh')
  const spill = await ensureDirectDirectory(dsh, 'spill')
  /* v8 ignore next 2 -- ensureDirectDirectory returns this exact canonical child; this retains the named layout invariant. */
  if (!samePath(spill, workspaceSpillRoot(workspace))) {
    throw new Error(`server spill directory escaped its project workspace: ${JSON.stringify(spill)}`)
  }
  const sessionKey = createHash('sha256').update(String(state.sessionId)).digest('hex').slice(0, 12)
  return ensureDirectDirectory(spill, `session-${sessionKey}`)
}

async function removePartial(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    /* v8 ignore next -- a non-ENOENT unlink error requires host filesystem fault injection during failure cleanup. */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function copyExclusive(sourcePath: string, targetPath: string): Promise<void> {
  await using source = await open(sourcePath, 'r')
  await using target = await open(targetPath, 'wx', FILE_MODE)
  const buffer = Buffer.allocUnsafe(64 * 1024)
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) return
    let offset = 0
    while (offset < bytesRead) {
      const written = await target.write(buffer, offset, bytesRead - offset, null)
      offset += written.bytesWritten
    }
  }
}

/**
 * Copy a trusted private collector artifact into the Server Session workspace.
 * @param sourcePath - host-private source produced by the cloud shell collector.
 * @param state - authoritative Server project and Session identity.
 * @param suggestedName - descriptive name hashed into the collision-free filename.
 * @returns the workspace path the Session can reopen.
 */
export async function publishServerSpillFile(
  sourcePath: string,
  state: ProjectSessionState,
  suggestedName: string,
): Promise<string> {
  const directory = await sessionSpillDirectory(state)
  const target = join(directory, artifactName(suggestedName))
  try {
    await copyExclusive(sourcePath, target)
    return target
  } catch (error) {
    try {
      await removePartial(target)
    } catch (cleanupError) {
      /* v8 ignore next -- requires publication failure followed by an independent unlink failure. */
      throw new AggregateError([error, cleanupError], 'server spill publication and cleanup failed')
    }
    throw error
  }
}

/** Server-specific spill backend that derives storage from Server-owned Session state. */
export class ServerSpillStore extends SpillStore {
  static inject = ['serverEnvironments']

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const project = this.ctx.serverEnvironments.projectForSession(String(input.owner.sessionId))
    if (project === undefined) {
      throw new Error(`server spill owner is not a Server Session: ${JSON.stringify(input.owner.sessionId)}`)
    }
    const directory = await sessionSpillDirectory(project.state)
    const path = join(directory, artifactName(input.suggestedName))
    const bytes = Buffer.byteLength(input.content, 'utf8')
    const handle = await open(path, 'wx', FILE_MODE)
    try {
      await handle.writeFile(input.content)
    } catch (error) {
      /* v8 ignore start -- FileHandle write/close/unlink failures require host filesystem fault injection; cleanup remains fail-loud. */
      try {
        await handle.close()
        await removePartial(path)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'server spill write and cleanup failed')
      }
      throw error
      /* v8 ignore stop */
    }
    await handle.close()
    return {
      locator: SpillLocator(path),
      bytes,
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
    }
  }
}

export default ServerSpillStore
