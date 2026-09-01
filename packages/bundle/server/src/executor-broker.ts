/** WebSocket gateway between cloud execution requests and local executors. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ExecutorExecutionRequest,
  ExecutorOutputMessage,
  ExecutorRegisterMessage,
  ExecutorResultMessage,
  ExecutorServerMessage,
} from '@deepseek-ai/dsh-executor-protocol'
import {
  EXECUTOR_PROTOCOL_VERSION,
  ExecutorRequestId,
  parseExecutorClientMessage,
} from '@deepseek-ai/dsh-executor-protocol'
import z from '@deepseek-ai/schemastery'
import WebSocket, { WebSocketServer } from 'ws'
import { ServerDeviceId } from './environments.ts'
import type {} from './environments.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Broker configuration for connection and request lifecycle bounds. */
export interface Config {
  readonly registrationTimeoutMs: number
  readonly heartbeatIntervalMs: number
  readonly heartbeatTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly maxMessageBytes: number
}

/** One output event delivered to the execution caller. */
export type ExecutorBrokerOutput = Pick<ExecutorOutputMessage, 'sequence' | 'stream' | 'data'>

/** Request fields owned by a caller; the Broker allocates correlation ids. */
export type ExecutorBrokerRequest = Omit<ExecutorExecutionRequest, 'type' | 'requestId'>

/** Options controlling one Broker execution. */
export interface ExecutorBrokerExecuteOptions {
  readonly signal?: AbortSignal
  readonly onOutput?: (output: ExecutorBrokerOutput) => void
}

/** No registered local executor currently owns the requested device. */
export class ExecutorUnavailableError extends Error {
  override readonly name = 'ExecutorUnavailableError'
}

/** A connected executor disappeared before completing a request. */
export class ExecutorDisconnectedError extends Error {
  override readonly name = 'ExecutorDisconnectedError'
}

interface PendingExecution {
  readonly resolve: (result: ExecutorResultMessage['result']) => void
  readonly reject: (error: Error) => void
  readonly onOutput?: (output: ExecutorBrokerOutput) => void
  readonly signal?: AbortSignal
  readonly abort: () => void
  readonly timeout: ReturnType<typeof setTimeout>
  nextSequence: number
  receivedOutputBytes: number
  readonly outputLimitBytes: number
  readonly environmentId: string
  readonly bindingId: string
  readonly environmentEpoch: number
}

interface ExecutorConnection {
  readonly socket: WebSocket
  registration?: ExecutorRegisterMessage
  unregisterEnvironment?: () => void
  registrationTimer?: ReturnType<typeof setTimeout>
  heartbeatTimer?: ReturnType<typeof setInterval>
  heartbeatNonce?: string
  lastHeartbeatAt: number
  readonly pending: Map<ExecutorRequestId, PendingExecution>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    executorBroker: ExecutorBroker
  }
}

function connectionKey(userId: string, deviceId: string): string {
  return `${userId}\0${deviceId}`
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Executor connection registry and request dispatcher. */
export class ExecutorBroker extends Service {
  static inject = ['webServer', 'serverEnvironments']

  static Config: z<Config> = z.object({
    registrationTimeoutMs: z.number().min(100).default(10_000),
    heartbeatIntervalMs: z.number().min(100).default(15_000),
    heartbeatTimeoutMs: z.number().min(200).default(45_000),
    requestTimeoutMs: z.number().min(100).default(120_000),
    maxMessageBytes: z.number().min(1_024).default(2 * 1024 * 1024),
  })

  private readonly websocketServer: WebSocketServer
  private readonly connections = new Map<string, ExecutorConnection>()
  private readonly accepted = new Set<ExecutorConnection>()
  private disposeUpgrade?: () => void
  private closing = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'executorBroker')
    if (config.heartbeatTimeoutMs <= config.heartbeatIntervalMs) {
      throw new Error('executor broker: heartbeatTimeoutMs must exceed heartbeatIntervalMs')
    }
    this.websocketServer = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes })
  }

  /** Register the WebSocket upgrade route and own complete connection teardown. */
  protected [Service.init](): void {
    this.disposeUpgrade = this.ctx.webServer.registerUpgrade({
      path: '/v1/executors/connect',
      handler: (request, socket, head) => { this.upgrade(request, socket, head) },
    })
    this.ctx.effect(() => async () => { await this.close() }, 'executorBroker.close')
  }

  /**
   * Execute one request on its exact registered device.
   * @param request - complete Session and environment ownership plus operation.
   * @param options - cancellation and output observer.
   * @returns executor's final structured result.
   */
  execute(
    request: ExecutorBrokerRequest,
    options: ExecutorBrokerExecuteOptions = {},
  ): Promise<ExecutorResultMessage['result']> {
    if (this.closing) return Promise.reject(new ExecutorDisconnectedError('executor broker is closing'))
    const connection = this.connections.get(connectionKey(request.userId, request.deviceId))
    if (connection === undefined || connection.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ExecutorUnavailableError(
        `executor '${request.deviceId}' is not connected for user '${request.userId}'`,
      ))
    }
    if (request.timeoutMs > this.config.requestTimeoutMs) {
      return Promise.reject(new Error(
        `executor request timeout ${request.timeoutMs} exceeds broker maximum ${this.config.requestTimeoutMs}`,
      ))
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(asError(options.signal.reason ?? new Error('executor request cancelled')))
    }
    const requestId = ExecutorRequestId(randomUUID())
    const message: ExecutorExecutionRequest = { type: 'execution/request', requestId, ...request }
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (complete: () => void): void => {
        if (settled) return
        settled = true
        const pending = connection.pending.get(requestId)
        if (pending !== undefined) {
          clearTimeout(pending.timeout)
          pending.signal?.removeEventListener('abort', pending.abort)
          connection.pending.delete(requestId)
        }
        complete()
      }
      const cancel = (): void => {
        this.send(connection.socket, {
          type: 'execution/cancel', requestId, reason: String(options.signal?.reason ?? 'cancelled'),
        }).catch(() => {})
      }
      const timeout = setTimeout(() => {
        cancel()
        finish(() => reject(new Error(`executor request '${requestId}' timed out`)))
      }, request.timeoutMs)
      const pending: PendingExecution = {
        resolve: result => finish(() => resolve(result)),
        reject: error => finish(() => reject(error)),
        ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        abort: cancel,
        timeout,
        nextSequence: 0,
        receivedOutputBytes: 0,
        outputLimitBytes: request.operation.kind === 'subprocess.run'
          ? request.operation.outputLimitBytes
          : 0,
        environmentId: request.environmentId,
        bindingId: request.bindingId,
        environmentEpoch: request.environmentEpoch,
      }
      connection.pending.set(requestId, pending)
      options.signal?.addEventListener('abort', pending.abort, { once: true })
      this.send(connection.socket, message).catch(error => pending.reject(asError(error)))
    })
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closing) {
      socket.destroy()
      return
    }
    this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      const connection: ExecutorConnection = {
        socket: websocket,
        lastHeartbeatAt: Date.now(),
        pending: new Map(),
      }
      this.accepted.add(connection)
      connection.registrationTimer = setTimeout(() => {
        websocket.close(1008, 'registration timeout')
      }, this.config.registrationTimeoutMs)
      websocket.on('message', (data, isBinary) => {
        if (isBinary) {
          websocket.close(1003, 'text frames required')
          return
        }
        try {
          const message = parseExecutorClientMessage(data.toString())
          this.onMessage(connection, message)
        } catch (error) {
          this.ctx.logger.warn(asError(error))
          websocket.close(1008, 'invalid executor message')
        }
      })
      websocket.once('close', () => { this.release(connection) })
      websocket.once('error', () => { this.release(connection) })
    })
  }

  private onMessage(
    connection: ExecutorConnection,
    message: ReturnType<typeof parseExecutorClientMessage>,
  ): void {
    if (connection.registration === undefined) {
      if (message.type !== 'executor/register') {
        connection.socket.close(1008, 'registration required')
        return
      }
      this.register(connection, message)
      return
    }
    if (message.type === 'executor/register') {
      connection.socket.close(1008, 'already registered')
      return
    }
    if (message.type === 'executor/pong') {
      if (message.nonce === connection.heartbeatNonce) {
        connection.lastHeartbeatAt = Date.now()
        delete connection.heartbeatNonce
      }
      return
    }
    const pending = connection.pending.get(message.requestId)
    if (pending === undefined) {
      connection.socket.close(1008, 'unknown request id')
      return
    }
    if (message.environmentId !== pending.environmentId
      || message.bindingId !== pending.bindingId
      || message.environmentEpoch !== pending.environmentEpoch) {
      pending.reject(new Error('executor response environment identity does not match its request'))
      connection.socket.close(1008, 'execution environment mismatch')
      return
    }
    if (message.type === 'execution/result') {
      pending.resolve(message.result)
      return
    }
    if (message.sequence !== pending.nextSequence) {
      pending.reject(new Error(`executor output sequence ${message.sequence} expected ${pending.nextSequence}`))
      connection.socket.close(1008, 'invalid output sequence')
      return
    }
    pending.receivedOutputBytes += Buffer.byteLength(message.data)
    if (pending.outputLimitBytes === 0 || pending.receivedOutputBytes > pending.outputLimitBytes) {
      pending.reject(new Error(`executor output exceeds request limit ${pending.outputLimitBytes}`))
      connection.socket.close(1009, 'execution output limit exceeded')
      return
    }
    pending.nextSequence++
    try {
      pending.onOutput?.({ sequence: message.sequence, stream: message.stream, data: message.data })
    } catch (error) {
      this.ctx.logger.warn(asError(error))
    }
  }

  private register(connection: ExecutorConnection, registration: ExecutorRegisterMessage): void {
    if (this.closing) {
      connection.socket.close(1012, 'server shutdown')
      return
    }
    const key = connectionKey(registration.userId, registration.deviceId)
    const previous = this.connections.get(key)
    if (previous !== undefined) {
      previous.unregisterEnvironment?.()
      delete previous.unregisterEnvironment
      this.send(previous.socket, { type: 'broker/close', reason: 'connection-replaced' })
        .finally(() => { previous.socket.close(4001, 'connection replaced') })
        .catch(() => {})
    }
    connection.registration = registration
    connection.unregisterEnvironment = this.ctx.serverEnvironments.registerExecutor({
      userId: registration.userId,
      deviceId: ServerDeviceId(registration.deviceId),
      deviceName: registration.deviceName,
      platform: registration.platform,
      arch: registration.arch,
      shell: registration.shell,
      capabilities: registration.capabilities,
      workspaces: registration.workspaces,
    })
    this.connections.set(key, connection)
    if (connection.registrationTimer !== undefined) clearTimeout(connection.registrationTimer)
    delete connection.registrationTimer
    connection.lastHeartbeatAt = Date.now()
    connection.heartbeatTimer = setInterval(() => { this.heartbeat(connection) }, this.config.heartbeatIntervalMs)
    void this.send(connection.socket, {
      type: 'broker/registered',
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
    })
  }

  private heartbeat(connection: ExecutorConnection): void {
    if (Date.now() - connection.lastHeartbeatAt >= this.config.heartbeatTimeoutMs) {
      connection.socket.close(1008, 'heartbeat timeout')
      return
    }
    if (connection.heartbeatNonce !== undefined) return
    const nonce = randomUUID()
    connection.heartbeatNonce = nonce
    void this.send(connection.socket, { type: 'broker/ping', nonce }).catch(() => {
      connection.socket.terminate()
    })
  }

  private release(connection: ExecutorConnection): void {
    if (!this.accepted.delete(connection)) return
    if (connection.registrationTimer !== undefined) clearTimeout(connection.registrationTimer)
    if (connection.heartbeatTimer !== undefined) clearInterval(connection.heartbeatTimer)
    connection.unregisterEnvironment?.()
    const registration = connection.registration
    if (registration !== undefined) {
      const key = connectionKey(registration.userId, registration.deviceId)
      if (this.connections.get(key) === connection) this.connections.delete(key)
    }
    const error = new ExecutorDisconnectedError('executor disconnected before request completion')
    for (const pending of [...connection.pending.values()]) pending.reject(error)
  }

  private send(socket: WebSocket, message: ExecutorServerMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new ExecutorDisconnectedError('executor socket is not open'))
        return
      }
      socket.send(JSON.stringify(message), (error) => {
        if (error == null) resolve()
        else reject(error)
      })
    })
  }

  private async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.disposeUpgrade?.()
    delete this.disposeUpgrade
    const closures = [...this.accepted].map(async (connection) => {
      try {
        await this.send(connection.socket, { type: 'broker/close', reason: 'server-shutdown' })
      } catch {
        // A lost socket has no peer left to receive the shutdown notice.
      }
      connection.socket.terminate()
    })
    await Promise.all(closures)
    await new Promise<void>((resolve, reject) => {
      this.websocketServer.close((error) => { if (error == null) resolve(); else reject(error) })
    })
    for (const connection of [...this.accepted]) this.release(connection)
  }
}

export default ExecutorBroker
