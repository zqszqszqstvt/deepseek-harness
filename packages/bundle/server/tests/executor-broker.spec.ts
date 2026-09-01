/** Executor Broker registration, replacement, dispatch, cancellation, and disconnect behavior. */

import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  EXECUTOR_PROTOCOL_VERSION,
  ExecutorDeviceId,
  parseExecutorServerMessage,
  type ExecutorClientMessage,
  type ExecutorRegisterMessage,
  type ExecutorServerMessage,
} from '@deepseek-ai/dsh-executor-protocol'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import ServerEnvironments from '../src/environments.ts'
import ExecutorBroker, { ExecutorDisconnectedError } from '../src/executor-broker.ts'
import { parseProjectRoute, projectSessionState } from '../src/project-session.ts'

let context: Context | undefined
let root: string | undefined
const sockets = new Set<WebSocket>()

afterEach(async () => {
  for (const socket of sockets) socket.terminate()
  sockets.clear()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function start(): Promise<number> {
  root = await mkdtemp(join(tmpdir(), 'dsh-executor-broker-'))
  context = new Context()
  await context.plugin(Storage)
  await context.plugin(StorageJson, { root: join(root, 'storage') })
  await context.plugin(StorageDomain, { backend: 'json' })
  await context.plugin(ServerEnvironments)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(ExecutorBroker, {
    registrationTimeoutMs: 500,
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 500,
    requestTimeoutMs: 2_000,
    maxMessageBytes: 64 * 1024,
  })
  return context.webServer.port
}

function registration(): ExecutorRegisterMessage {
  return {
    type: 'executor/register',
    protocolVersion: EXECUTOR_PROTOCOL_VERSION,
    userId: 'alice',
    deviceId: ExecutorDeviceId('desktop-1'),
    deviceName: 'Alice PC',
    platform: 'win32',
    arch: 'x64',
    shell: 'powershell',
    capabilities: ['filesystem', 'subprocess'],
    workspaces: [{ projectId: 'alpha', rootPath: 'D:\\projects\\alpha' }],
  }
}

async function connect(port: number): Promise<{ socket: WebSocket; messages: ExecutorServerMessage[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/executors/connect`)
  sockets.add(socket)
  const messages: ExecutorServerMessage[] = []
  socket.on('message', (data) => {
    const message = parseExecutorServerMessage(data.toString())
    messages.push(message)
    if (message.type === 'broker/ping') {
      send(socket, { type: 'executor/pong', nonce: message.nonce })
    }
  })
  await once(socket, 'open')
  send(socket, registration())
  await waitFor(messages, message => message.type === 'broker/registered')
  return { socket, messages }
}

function send(socket: WebSocket, message: ExecutorClientMessage): void {
  socket.send(JSON.stringify(message))
}

async function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  await once(socket, 'close')
}

async function waitFor<T extends ExecutorServerMessage>(
  messages: readonly ExecutorServerMessage[],
  predicate: (message: ExecutorServerMessage) => message is T,
): Promise<T> {
  let found: T | undefined
  await vi.waitFor(() => {
    found = messages.find(predicate)
    expect(found).toBeDefined()
  })
  return found as T
}

function alphaState() {
  const route = parseProjectRoute('/v1/users/alice/projects/alpha/environments')
  if (route === undefined || root === undefined) throw new Error('test project state is unavailable')
  return projectSessionState(root, route.identity)
}

describe('executor broker', () => {
  it('publishes a registered device and removes it on disconnect', async () => {
    const port = await start()
    const client = await connect(port)

    expect(context!.serverEnvironments.project(alphaState()).environments).toEqual(expect.arrayContaining([
      expect.objectContaining({ bindingId: 'local:desktop-1', status: 'online' }),
    ]))

    client.socket.close()
    await waitForClose(client.socket)
    await vi.waitFor(() => {
      expect(context!.serverEnvironments.project(alphaState()).environments).toHaveLength(1)
    })
  })

  it('lets a new connection replace the same user device without removing the replacement', async () => {
    const port = await start()
    const first = await connect(port)
    const second = await connect(port)

    await waitFor(first.messages, (message): message is Extract<ExecutorServerMessage, { type: 'broker/close' }> =>
      message.type === 'broker/close')
    await waitForClose(first.socket)
    expect(context!.serverEnvironments.project(alphaState()).environments).toEqual(expect.arrayContaining([
      expect.objectContaining({ bindingId: 'local:desktop-1', status: 'online' }),
    ]))

    second.socket.close()
    await waitForClose(second.socket)
  })

  it('routes output and final results, waits for cancellation confirmation, and rejects disconnects', async () => {
    const port = await start()
    const client = await connect(port)
    const output: string[] = []
    const baseRequest = {
      userId: 'alice',
      deviceId: ExecutorDeviceId('desktop-1'),
      sessionId: 'session-1',
      projectId: 'alpha',
      environmentId: 'local:desktop-1',
      bindingId: 'local:desktop-1',
      environmentEpoch: 1,
      timeoutMs: 1_000,
      operation: {
        kind: 'subprocess.run' as const,
        argv: ['git', 'status', '--short'],
        cwd: 'D:\\projects\\alpha',
        graceMs: 1_000,
        outputLimitBytes: 1_024,
      },
    }
    const completed = context!.executorBroker.execute(baseRequest, {
      onOutput: chunk => output.push(`${chunk.stream}:${chunk.data}`),
    })
    const firstRequest = await waitFor(client.messages,
      (message): message is Extract<ExecutorServerMessage, { type: 'execution/request' }> =>
        message.type === 'execution/request')
    send(client.socket, {
      type: 'execution/output', requestId: firstRequest.requestId,
      environmentId: firstRequest.environmentId, bindingId: firstRequest.bindingId,
      environmentEpoch: firstRequest.environmentEpoch,
      sequence: 0, stream: 'stdout', data: 'chunk',
    })
    send(client.socket, {
      type: 'execution/result', requestId: firstRequest.requestId,
      environmentId: firstRequest.environmentId, bindingId: firstRequest.bindingId,
      environmentEpoch: firstRequest.environmentEpoch,
      result: { ok: true, value: { text: 'complete' } },
    })
    await expect(completed).resolves.toEqual({ ok: true, value: { text: 'complete' } })
    expect(output).toEqual(['stdout:chunk'])

    const controller = new AbortController()
    const cancelled = context!.executorBroker.execute(baseRequest, { signal: controller.signal })
    const secondRequest = await waitFor(client.messages,
      (message): message is Extract<ExecutorServerMessage, { type: 'execution/request' }> =>
        message.type === 'execution/request' && message.requestId !== firstRequest.requestId)
    controller.abort(new Error('user cancelled'))
    const cancel = await waitFor(client.messages,
      (message): message is Extract<ExecutorServerMessage, { type: 'execution/cancel' }> =>
        message.type === 'execution/cancel' && message.requestId === secondRequest.requestId)
    expect(cancel.reason).toContain('user cancelled')
    send(client.socket, {
      type: 'execution/result', requestId: secondRequest.requestId,
      environmentId: secondRequest.environmentId, bindingId: secondRequest.bindingId,
      environmentEpoch: secondRequest.environmentEpoch,
      result: { ok: false, error: { code: 'cancelled', message: 'cancelled', retryable: false } },
    })
    await expect(cancelled).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })

    const disconnected = context!.executorBroker.execute(baseRequest)
    await waitFor(client.messages,
      (message): message is Extract<ExecutorServerMessage, { type: 'execution/request' }> =>
        message.type === 'execution/request'
        && message.requestId !== firstRequest.requestId
        && message.requestId !== secondRequest.requestId)
    client.socket.terminate()
    await expect(disconnected).rejects.toBeInstanceOf(ExecutorDisconnectedError)
  })

  it('rejects response frames from a different environment epoch', async () => {
    const port = await start()
    const client = await connect(port)
    const execution = context!.executorBroker.execute({
      userId: 'alice',
      deviceId: ExecutorDeviceId('desktop-1'),
      sessionId: 'session-1',
      projectId: 'alpha',
      environmentId: 'local:desktop-1',
      bindingId: 'local:desktop-1',
      environmentEpoch: 2,
      timeoutMs: 1_000,
      operation: {
        kind: 'fs.resolve',
        path: 'README.md',
      },
    })
    const request = await waitFor(client.messages,
      (message): message is Extract<ExecutorServerMessage, { type: 'execution/request' }> =>
        message.type === 'execution/request')
    send(client.socket, {
      type: 'execution/result',
      requestId: request.requestId,
      environmentId: request.environmentId,
      bindingId: request.bindingId,
      environmentEpoch: request.environmentEpoch + 1,
      result: { ok: true, value: {} },
    })

    await expect(execution).rejects.toThrow('environment identity')
    await waitForClose(client.socket)
  })
})
