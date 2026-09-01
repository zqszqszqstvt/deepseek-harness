/** Runtime JSON validation for executor WebSocket frames. */

import { z } from 'zod'
import {
  EXECUTOR_PROTOCOL_VERSION,
  ExecutorDeviceId,
  ExecutorRequestId,
  type ExecutorClientMessage,
  type ExecutorServerMessage,
} from './types.ts'

const id = z.string().min(1).max(512)
const path = z.string().min(1).max(32_768)
const finitePositiveInteger = z.number().int().positive().max(2_147_483_647)
const requestId = id.transform(ExecutorRequestId)
const deviceId = id.transform(ExecutorDeviceId)
const environmentIdentity = {
  environmentId: id,
  bindingId: id,
  environmentEpoch: z.number().int().nonnegative(),
}

const registerMessage = z.object({
  type: z.literal('executor/register'),
  protocolVersion: z.literal(EXECUTOR_PROTOCOL_VERSION),
  userId: id,
  deviceId,
  deviceName: id,
  platform: id,
  arch: id,
  shell: id,
  capabilities: z.array(id).max(128),
  workspaces: z.array(z.object({ projectId: id, rootPath: path })).max(256),
})

const fsOperation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fs.resolve'), path, cwd: path.optional() }),
  z.object({ kind: z.literal('fs.stat'), targetKey: path }),
  z.object({ kind: z.literal('fs.lstat'), path, cwd: path.optional() }),
  z.object({ kind: z.literal('fs.readText'), targetKey: path }),
  z.object({ kind: z.literal('fs.readBytes'), targetKey: path, maxBytes: finitePositiveInteger }),
  z.object({ kind: z.literal('fs.listDir'), targetKey: path }),
  z.object({
    kind: z.literal('fs.writeText'),
    targetKey: path,
    content: z.string(),
    expected: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('createIfAbsent') }),
      z.object({ kind: z.literal('replaceIfVersion'), version: id }),
    ]).optional(),
  }),
  z.object({
    kind: z.literal('fs.editText'),
    targetKey: path,
    oldString: z.string().min(1),
    newString: z.string(),
    replaceAll: z.boolean(),
    expectedVersion: id.optional(),
  }),
  z.object({ kind: z.literal('fs.mkdir'), targetKey: path, recursive: z.boolean() }),
  z.object({ kind: z.literal('fs.remove'), targetKey: path, recursive: z.boolean() }),
  z.object({
    kind: z.literal('fs.move'),
    sourceKey: path,
    destinationKey: path,
    overwrite: z.boolean(),
  }),
])

const subprocessOperation = z.object({
  kind: z.literal('subprocess.run'),
  argv: z.array(z.string()).min(1).max(4_096),
  cwd: path,
  env: z.record(z.string(), z.string().nullable()).optional(),
  stdin: z.string().optional(),
  graceMs: finitePositiveInteger,
  outputLimitBytes: finitePositiveInteger,
})

const executionRequest = z.object({
  type: z.literal('execution/request'),
  requestId,
  userId: id,
  deviceId,
  sessionId: id,
  projectId: id,
  ...environmentIdentity,
  timeoutMs: finitePositiveInteger,
  operation: z.union([fsOperation, subprocessOperation]),
})

const clientMessage = z.discriminatedUnion('type', [
  registerMessage,
  z.object({ type: z.literal('executor/pong'), nonce: id }),
  z.object({
    type: z.literal('execution/output'),
    requestId,
    ...environmentIdentity,
    sequence: z.number().int().nonnegative(),
    stream: z.enum(['stdout', 'stderr']),
    data: z.string(),
  }),
  z.object({
    type: z.literal('execution/result'),
    requestId,
    ...environmentIdentity,
    result: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), value: z.unknown() }),
      z.object({
        ok: z.literal(false),
        error: z.object({ code: id, message: z.string(), retryable: z.boolean() }),
      }),
    ]),
  }),
])

const serverMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('broker/registered'),
    protocolVersion: z.literal(EXECUTOR_PROTOCOL_VERSION),
    heartbeatIntervalMs: finitePositiveInteger,
  }),
  z.object({ type: z.literal('broker/ping'), nonce: id }),
  executionRequest,
  z.object({ type: z.literal('execution/cancel'), requestId, reason: z.string() }),
  z.object({
    type: z.literal('broker/close'),
    reason: z.enum(['server-shutdown', 'connection-replaced']),
  }),
])

/**
 * Parse and validate one JSON frame received by the Broker.
 * @param value - serialized executor client frame.
 * @returns validated client message.
 */
export function parseExecutorClientMessage(value: string): ExecutorClientMessage {
  return clientMessage.parse(JSON.parse(value)) as ExecutorClientMessage
}

/**
 * Parse and validate one JSON frame received by a local executor.
 * @param value - serialized Broker frame.
 * @returns validated Server message.
 */
export function parseExecutorServerMessage(value: string): ExecutorServerMessage {
  return serverMessage.parse(JSON.parse(value)) as ExecutorServerMessage
}
