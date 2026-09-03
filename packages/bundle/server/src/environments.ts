/** Durable active-environment state and live local-executor publication. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { ProjectSessionState } from './project-session.ts'

/** Stable id of one device-local executor. */
export type ServerDeviceId = Branded<'ServerDeviceId'>
/** Stable id of one execution environment and project workspace binding. */
export type ServerBindingId = Branded<'ServerBindingId'>

/**
 * Brand a validated wire device id.
 * @param value - device id already validated at the transport boundary.
 * @returns branded Server device id.
 */
export function ServerDeviceId(value: string): ServerDeviceId {
  return value as ServerDeviceId
}

/**
 * Brand a validated environment binding id.
 * @param value - binding id already validated at its input boundary.
 * @returns branded Server binding id.
 */
export function ServerBindingId(value: string): ServerBindingId {
  return value as ServerBindingId
}

/** One project workspace reported by a connected local executor. */
export interface LocalWorkspaceRegistration {
  readonly projectId: string
  readonly rootPath: string
}

/** Runtime facts published by one connected local executor. */
export interface LocalExecutorRegistration {
  readonly userId: string
  readonly deviceId: ServerDeviceId
  readonly deviceName: string
  readonly platform: string
  readonly arch: string
  readonly shell: string
  readonly capabilities: readonly string[]
  readonly workspaces: readonly LocalWorkspaceRegistration[]
}

/** One cloud or local environment available to a project Session. */
export interface ServerEnvironmentView {
  readonly bindingId: ServerBindingId
  readonly environmentId: string
  readonly type: 'cloud' | 'local'
  readonly status: 'online' | 'offline'
  readonly rootPath?: string
  readonly deviceId?: ServerDeviceId
  readonly deviceName?: string
  readonly platform: string
  readonly arch: string
  readonly shell: string
  readonly capabilities: readonly string[]
}

/** Current environment projection for one project Session. */
export interface ProjectEnvironmentsView {
  readonly sessionId: string
  readonly activeBindingId: ServerBindingId
  readonly environmentEpoch: number
  readonly environments: readonly ServerEnvironmentView[]
}

interface ProjectEnvironmentRecord {
  readonly activeBindingId: ServerBindingId
  readonly environmentEpoch: number
}

const bindingIdSchema = z.string().min(1).transform(ServerBindingId)
const projectEnvironmentRecord = z.object({
  activeBindingId: bindingIdSchema,
  environmentEpoch: z.number().int().nonnegative(),
})

const environmentDomainSpec = defineDomain({
  name: 'server_environments',
  version: 0,
  tables: {
    sessions: domainTable<string, ProjectEnvironmentRecord>(projectEnvironmentRecord),
  },
})

const CLOUD_BINDING_ID = ServerBindingId('cloud')

/** Requested binding is not currently usable by the project Session. */
export class ServerEnvironmentUnavailableError extends Error {
  override readonly name = 'ServerEnvironmentUnavailableError'
}

/** A Session cannot switch while a tool call still owns its current environment. */
export class ServerEnvironmentBusyError extends Error {
  override readonly name = 'ServerEnvironmentBusyError'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    serverEnvironments: ServerEnvironments
  }
}

function localBindingId(deviceId: ServerDeviceId): ServerBindingId {
  return ServerBindingId(`local:${deviceId}`)
}

function localEnvironment(registration: LocalExecutorRegistration, rootPath: string): ServerEnvironmentView {
  return {
    bindingId: localBindingId(registration.deviceId),
    environmentId: `local:${registration.deviceId}`,
    type: 'local',
    status: 'online',
    rootPath,
    deviceId: registration.deviceId,
    deviceName: registration.deviceName,
    platform: registration.platform,
    arch: registration.arch,
    shell: registration.shell,
    capabilities: registration.capabilities,
  }
}

/**
 * Server-owned environment registry. Active binding state is durable; local
 * device facts exist only while the executor connection owns its registration.
 */
export class ServerEnvironments extends Service {
  static inject = ['storageDomain']

  private sessions?: KvTable<string, ProjectEnvironmentRecord>
  private readonly executors = new Map<string, Map<ServerDeviceId, LocalExecutorRegistration>>()
  private readonly projects = new Map<string, ProjectSessionState>()
  private readonly activeExecutions = new Map<string, number>()

  constructor(ctx: Context) {
    super(ctx, 'serverEnvironments')
  }

  /** Open the environment domain and own its lifecycle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(environmentDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'serverEnvironments.domainClose')
    this.sessions = domain.table('sessions')
  }

  /**
   * Publish one connected executor until the returned disposer runs.
   * @param registration - validated device facts and project workspaces.
   * @returns disposer that removes only this exact registration.
   */
  registerExecutor(registration: LocalExecutorRegistration): () => void {
    let devices = this.executors.get(registration.userId)
    if (devices === undefined) {
      devices = new Map()
      this.executors.set(registration.userId, devices)
    }
    if (devices.has(registration.deviceId)) {
      throw new Error(`server environments: device '${registration.deviceId}' is already connected`)
    }
    devices.set(registration.deviceId, registration)
    return () => {
      if (devices?.get(registration.deviceId) !== registration) return
      devices.delete(registration.deviceId)
      if (devices.size === 0) this.executors.delete(registration.userId)
    }
  }

  /**
   * Associate one deterministic Server Session with its validated project identity.
   * Repeated route access is idempotent; a conflicting identity fails closed.
   * @param state - validated project Session state derived from the Server route.
   */
  bindProject(state: ProjectSessionState): void {
    const key = String(state.sessionId)
    const existing = this.projects.get(key)
    if (existing !== undefined
      && (existing.userId !== state.userId
        || existing.projectId !== state.projectId
        || existing.cwd !== state.cwd)) {
      throw new Error('server environments: session ' + JSON.stringify(key) + ' is already bound to another project')
    }
    this.projects.set(key, state)
  }

  /**
   * Resolve the current environment view from a live Agent Session id.
   * @param sessionId - deterministic Server Session id.
   * @returns current project state and environment view, or undefined outside Server-owned Sessions.
   */
  projectForSession(sessionId: string): {
    readonly state: ProjectSessionState
    readonly view: ProjectEnvironmentsView
  } | undefined {
    const state = this.projects.get(sessionId)
    return state === undefined ? undefined : { state, view: this.project(state) }
  }

  /**
   * Commit an approved switch for a live Agent Session.
   * @param sessionId - deterministic Server Session id.
   * @param bindingId - requested available binding.
   * @returns committed environment projection.
   */
  async switchForSession(sessionId: string, bindingId: ServerBindingId): Promise<ProjectEnvironmentsView> {
    const state = this.projects.get(sessionId)
    if (state === undefined) {
      throw new ServerEnvironmentUnavailableError(
        'server environments: session ' + JSON.stringify(sessionId) + ' has no project binding',
      )
    }
    return this.switch(state, bindingId)
  }

  /**
   * Hold the exact active binding and epoch for one tool operation.
   * @param sessionId - owning Server Session.
   * @param bindingId - binding selected before the operation starts.
   * @param environmentEpoch - epoch selected before the operation starts.
   * @returns idempotent release callback.
   */
  leaseExecution(
    sessionId: string,
    bindingId: ServerBindingId,
    environmentEpoch: number,
  ): () => void {
    const project = this.projectForSession(sessionId)
    if (project === undefined
      || project.view.activeBindingId !== bindingId
      || project.view.environmentEpoch !== environmentEpoch) {
      throw new ServerEnvironmentUnavailableError(
        'server environments: execution environment changed before the operation started',
      )
    }
    this.activeExecutions.set(sessionId, (this.activeExecutions.get(sessionId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.activeExecutions.get(sessionId) ?? 1) - 1
      if (remaining === 0) this.activeExecutions.delete(sessionId)
      else this.activeExecutions.set(sessionId, remaining)
    }
  }

  /**
   * Project the durable selection and currently connected environments.
   * @param state - project Session identity and cloud workspace.
   * @returns current environment view; an unavailable selected local binding remains visible as offline.
   */
  project(state: ProjectSessionState): ProjectEnvironmentsView {
    const stored = this.requireSessions().get(String(state.sessionId))
    const activeBindingId = stored?.activeBindingId ?? CLOUD_BINDING_ID
    const environments: ServerEnvironmentView[] = [{
      bindingId: CLOUD_BINDING_ID,
      environmentId: 'cloud',
      type: 'cloud',
      status: 'online',
      rootPath: state.cwd,
      platform: process.platform,
      arch: process.arch,
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      capabilities: ['filesystem', 'subprocess', 'shell'],
    }]
    for (const registration of this.executors.get(state.userId)?.values() ?? []) {
      const workspace = registration.workspaces.find(candidate => candidate.projectId === state.projectId)
      if (workspace !== undefined) environments.push(localEnvironment(registration, workspace.rootPath))
    }
    if (!environments.some(environment => environment.bindingId === activeBindingId)) {
      const deviceId = activeBindingId.startsWith('local:')
        ? ServerDeviceId(activeBindingId.slice('local:'.length))
        : undefined
      if (deviceId !== undefined) {
        environments.push({
          bindingId: activeBindingId,
          environmentId: activeBindingId,
          type: 'local',
          status: 'offline',
          deviceId,
          platform: 'unknown',
          arch: 'unknown',
          shell: 'unknown',
          capabilities: [],
        })
      }
    }
    return {
      sessionId: state.sessionId,
      activeBindingId,
      environmentEpoch: stored?.environmentEpoch ?? 0,
      environments,
    }
  }

  /**
   * Commit a user-approved environment switch after verifying availability.
   * @param state - project Session whose active binding changes.
   * @param bindingId - requested binding from the current project view.
   * @returns the committed environment view.
   */
  async switch(state: ProjectSessionState, bindingId: ServerBindingId): Promise<ProjectEnvironmentsView> {
    const current = this.project(state)
    const target = current.environments.find(environment => environment.bindingId === bindingId)
    if (target === undefined || target.status !== 'online') {
      throw new ServerEnvironmentUnavailableError(
        `server environments: binding '${bindingId}' is unavailable for session '${state.sessionId}'`,
      )
    }
    if (current.activeBindingId === bindingId) return current
    if ((this.activeExecutions.get(String(state.sessionId)) ?? 0) > 0) {
      throw new ServerEnvironmentBusyError(
        'server environments: active tool calls must settle before switching',
      )
    }
    await this.requireSessions().put(String(state.sessionId), {
      activeBindingId: bindingId,
      environmentEpoch: current.environmentEpoch + 1,
    })
    return this.project(state)
  }

  /**
   * Permanently remove one project's durable selection and live binding.
   * Active execution leases reject deletion so a tool cannot outlive its
   * environment identity.
   * @param state - project Session being deleted.
   */
  async deleteProject(state: ProjectSessionState): Promise<void> {
    const key = String(state.sessionId)
    if ((this.activeExecutions.get(key) ?? 0) > 0) {
      throw new ServerEnvironmentBusyError(
        'server environments: active tool calls must settle before deletion',
      )
    }
    await this.requireSessions().delete(key)
    if (this.projects.get(key) === state) this.projects.delete(key)
  }

  private requireSessions(): KvTable<string, ProjectEnvironmentRecord> {
    if (this.sessions === undefined) throw new Error('server environments: storage is not initialized')
    return this.sessions
  }
}

export default ServerEnvironments
