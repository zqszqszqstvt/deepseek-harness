/** Resolves the initiating Server Session to one exact execution Provider. */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ExecutorOperation,
  ExecutorResultMessage,
} from '@deepseek-ai/dsh-executor-protocol'
import { ExecutorDeviceId } from '@deepseek-ai/dsh-executor-protocol'
import type { CloudExecution } from './cloud-execution.ts'
import type {
  ProjectEnvironmentsView,
  ServerEnvironmentView,
} from './environments.ts'
import type { ProjectSessionState } from './project-session.ts'
import type { ExecutorBrokerExecuteOptions } from './executor-broker.ts'
import type {} from './cloud-execution.ts'
import type {} from './environments.ts'
import type {} from './executor-broker.ts'
import type {} from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    serverRuntimeRouter: ServerRuntimeRouter
  }
}

/** Active environment snapshot captured before one operation. */
export interface ServerRuntimeSelection {
  readonly state: ProjectSessionState
  readonly view: ProjectEnvironmentsView
  readonly environment: ServerEnvironmentView
}

/** Structured failure returned by a connected local executor. */
export class RemoteExecutionError extends Error {
  override readonly name = 'RemoteExecutionError'

  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

/** Session-aware dispatcher shared by FS, subprocess, and Shell routers. */
export class ServerRuntimeRouter extends Service {
  static inject = ['agents', 'serverEnvironments', 'executorBroker', 'cloudExecution']

  /** Cloud Providers retained behind the root routing services. */
  readonly cloud: CloudExecution

  constructor(ctx: Context) {
    super(ctx, 'serverRuntimeRouter')
    this.cloud = ctx.cloudExecution
  }

  /**
   * Resolve the initiating Agent to its exact current environment.
   * @returns current project, binding, epoch, and environment facts.
   */
  current(): ServerRuntimeSelection {
    const agent = this.ctx.agents.requireInitiator()
    const project = this.ctx.serverEnvironments.projectForSession(String(agent.session.id))
    if (project === undefined) {
      throw new Error('server runtime router: initiating Session is not owned by the Server')
    }
    const environment = project.view.environments.find(
      candidate => candidate.bindingId === project.view.activeBindingId,
    )
    if (environment === undefined || environment.status !== 'online') {
      throw new Error('server runtime router: active execution environment is offline')
    }
    return { state: project.state, view: project.view, environment }
  }

  /**
   * Acquire an environment-switch exclusion lease for one operation.
   * @param selection - environment snapshot captured before the operation.
   * @returns idempotent lease release callback.
   */
  lease(selection: ServerRuntimeSelection): () => void {
    return this.ctx.serverEnvironments.leaseExecution(
      String(selection.state.sessionId),
      selection.view.activeBindingId,
      selection.view.environmentEpoch,
    )
  }

  /**
   * Run one finite cloud or local operation under an environment-switch exclusion lease.
   * @param selection - environment snapshot captured before the operation.
   * @param operation - finite operation to execute while the lease is held.
   * @returns operation result after releasing the lease.
   */
  async run<T>(
    selection: ServerRuntimeSelection,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = this.lease(selection)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  /**
   * Dispatch one structured operation to the selected local device.
   * @param selection - local environment snapshot captured before dispatch.
   * @param operation - validated filesystem or subprocess operation.
   * @param timeoutMs - maximum Broker request lifetime in milliseconds.
   * @param options - optional cancellation signal and output observer.
   * @returns structured successful executor value.
   */
  async executeLocal(
    selection: ServerRuntimeSelection,
    operation: ExecutorOperation,
    timeoutMs: number,
    options: ExecutorBrokerExecuteOptions = {},
  ): Promise<unknown> {
    const environment = selection.environment
    if (environment.type !== 'local' || environment.deviceId === undefined) {
      throw new Error('server runtime router: selected environment is not a local device')
    }
    return this.run(selection, async () => {
      const result: ExecutorResultMessage['result'] = await this.ctx.executorBroker.execute({
        userId: selection.state.userId,
        deviceId: ExecutorDeviceId(String(environment.deviceId)),
        sessionId: String(selection.state.sessionId),
        projectId: selection.state.projectId,
        environmentId: environment.environmentId,
        bindingId: environment.bindingId,
        environmentEpoch: selection.view.environmentEpoch,
        timeoutMs,
        operation,
      }, options)
      if (!result.ok) {
        throw new RemoteExecutionError(result.error.code, result.error.message, result.error.retryable)
      }
      return result.value
    })
  }
}

export default ServerRuntimeRouter
