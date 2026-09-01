/** Project-scoped Server route identity and deterministic Session storage. */

import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'

type ServerUserId = Branded<'ServerUserId'>
type ServerProjectId = Branded<'ServerProjectId'>

const DEFAULT_PROJECT_ID = 'default' as ServerProjectId
const ID_MAX_LENGTH = 256

/** One validated user and project extracted from a Server route. */
export interface ProjectIdentity {
  readonly userId: ServerUserId
  readonly projectId: ServerProjectId
}

/** A parsed Server route relative to one project Session. */
export interface ProjectRoute {
  readonly identity: ProjectIdentity
  readonly resource: readonly string[]
}

/** Deterministic Session and workspace ownership for one user project. */
export interface ProjectSessionState extends ProjectIdentity {
  readonly cwd: string
  readonly sessionId: ReturnType<typeof SessionId>
  readonly storageSegments: readonly string[]
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function decodeId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    const value = decodeURIComponent(raw)
    return value.length > 0 && value.length <= ID_MAX_LENGTH ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse legacy user routes and project routes without accepting an incomplete
 * `/projects` prefix.
 * @param pathname - URL pathname from the HTTP request.
 * @returns project identity and untouched resource segments, or undefined for an invalid route.
 */
export function parseProjectRoute(pathname: string): ProjectRoute | undefined {
  const segments = pathname.split('/')
  if (segments[0] !== '' || segments[1] !== 'v1' || segments[2] !== 'users') return undefined
  const userId = decodeId(segments[3])
  if (userId === undefined) return undefined
  if (segments[4] !== 'projects') {
    return {
      identity: { userId: userId as ServerUserId, projectId: DEFAULT_PROJECT_ID },
      resource: segments.slice(4),
    }
  }
  const projectId = decodeId(segments[5])
  if (projectId === undefined) return undefined
  return {
    identity: { userId: userId as ServerUserId, projectId: projectId as ServerProjectId },
    resource: segments.slice(6),
  }
}

/**
 * Decode one opaque route resource id.
 * @param raw - one percent-encoded pathname segment.
 * @returns the validated decoded id, or undefined.
 */
export function decodeResourceId(raw: string | undefined): string | undefined {
  return decodeId(raw)
}

/**
 * Derive the stable Session id and hashed workspace path for one project.
 * The reserved default project retains the pre-project Server layout.
 * @param root - configured Server data directory.
 * @param identity - validated user and project ids.
 * @returns deterministic Session storage state.
 */
export function projectSessionState(root: string, identity: ProjectIdentity): ProjectSessionState {
  const userKey = digest(identity.userId)
  if (identity.projectId === DEFAULT_PROJECT_ID) {
    const storageSegments = ['users', userKey, 'workspace'] as const
    return {
      ...identity,
      cwd: join(root, ...storageSegments),
      sessionId: SessionId(`mu_${userKey.slice(0, 40)}`),
      storageSegments,
    }
  }
  const projectKey = digest(identity.projectId)
  const sessionKey = digest(`${identity.userId}\0${identity.projectId}`)
  const storageSegments = ['users', userKey, 'projects', projectKey, 'workspace'] as const
  return {
    ...identity,
    cwd: join(root, ...storageSegments),
    sessionId: SessionId(`mp_${sessionKey.slice(0, 40)}`),
    storageSegments,
  }
}

/**
 * Check whether a persisted cwd has the hashed layout owned by one project.
 * The data-root prefix may differ because copied Server data can be relocated.
 * @param cwd - persisted Session cwd.
 * @param state - expected project storage state.
 * @returns true when the path ends in the expected owned layout.
 */
export function isProjectWorkspace(cwd: string | undefined, state: ProjectSessionState): boolean {
  if (cwd === undefined) return false
  let current = resolve(cwd)
  for (let index = state.storageSegments.length - 1; index >= 0; index--) {
    if (basename(current) !== state.storageSegments[index]) return false
    current = dirname(current)
  }
  return true
}
