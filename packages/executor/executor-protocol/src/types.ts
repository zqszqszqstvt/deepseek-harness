/** Wire types shared by the DSH executor broker and local executors. */

declare const EXECUTOR_BRAND: unique symbol

/** String identifier branded within this transport-only package. */
type ExecutorBranded<Name extends string> = string & { readonly [EXECUTOR_BRAND]: Name }

/** Current executor wire protocol version. */
export const EXECUTOR_PROTOCOL_VERSION = 1 as const

/** Correlation id for one execution request. */
export type ExecutorRequestId = ExecutorBranded<'ExecutorRequestId'>

/**
 * Brand one validated execution request id.
 * @param value - request id already validated at the transport boundary.
 * @returns branded execution request id.
 */
export function ExecutorRequestId(value: string): ExecutorRequestId {
  return value as ExecutorRequestId
}

/** Stable id generated and retained by one executor device. */
export type ExecutorDeviceId = ExecutorBranded<'ExecutorDeviceId'>

/**
 * Brand one validated executor device id.
 * @param value - device id already validated at the transport boundary.
 * @returns branded executor device id.
 */
export function ExecutorDeviceId(value: string): ExecutorDeviceId {
  return value as ExecutorDeviceId
}

/** One project root explicitly authorized in the local application. */
export interface ExecutorWorkspaceRegistration {
  readonly projectId: string
  readonly rootPath: string
}

/** First frame sent by a local executor after WebSocket negotiation. */
export interface ExecutorRegisterMessage {
  readonly type: 'executor/register'
  readonly protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION
  readonly userId: string
  readonly deviceId: ExecutorDeviceId
  readonly deviceName: string
  readonly platform: string
  readonly arch: string
  readonly shell: string
  readonly capabilities: readonly string[]
  readonly workspaces: readonly ExecutorWorkspaceRegistration[]
}

/** Executor response to one Broker heartbeat. */
export interface ExecutorPongMessage {
  readonly type: 'executor/pong'
  readonly nonce: string
}

/** Stream chunk emitted by a running subprocess operation. */
export interface ExecutorEnvironmentIdentity {
  readonly environmentId: string
  readonly bindingId: string
  readonly environmentEpoch: number
}

/** Stream chunk emitted by a running subprocess operation. */
export interface ExecutorOutputMessage extends ExecutorEnvironmentIdentity {
  readonly type: 'execution/output'
  readonly requestId: ExecutorRequestId
  readonly sequence: number
  readonly stream: 'stdout' | 'stderr'
  readonly data: string
}

/** Structured executor failure safe to transport to the Broker. */
export interface ExecutorFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

/** Final response for one execution request. */
export interface ExecutorResultMessage extends ExecutorEnvironmentIdentity {
  readonly type: 'execution/result'
  readonly requestId: ExecutorRequestId
  readonly result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: ExecutorFailure }
}

/** Every frame accepted from a connected local executor. */
export type ExecutorClientMessage =
  | ExecutorRegisterMessage
  | ExecutorPongMessage
  | ExecutorOutputMessage
  | ExecutorResultMessage

/** Resolve a path inside the bound project root. */
export interface FsResolveOperation {
  readonly kind: 'fs.resolve'
  readonly path: string
  readonly cwd?: string
}

/** Inspect a previously resolved filesystem target. */
export interface FsStatOperation {
  readonly kind: 'fs.stat'
  readonly targetKey: string
}

/** Inspect a path without following its final link. */
export interface FsLstatOperation {
  readonly kind: 'fs.lstat'
  readonly path: string
  readonly cwd?: string
}

/** Read one resolved target as UTF-8 text. */
export interface FsReadTextOperation {
  readonly kind: 'fs.readText'
  readonly targetKey: string
}

/** Read one resolved target as bounded raw bytes. */
export interface FsReadBytesOperation {
  readonly kind: 'fs.readBytes'
  readonly targetKey: string
  readonly maxBytes: number
}

/** List direct children of one resolved directory. */
export interface FsListDirOperation {
  readonly kind: 'fs.listDir'
  readonly targetKey: string
}

/** Create or atomically replace one UTF-8 file. */
export interface FsWriteTextOperation {
  readonly kind: 'fs.writeText'
  readonly targetKey: string
  readonly content: string
  readonly expected?:
    | { readonly kind: 'createIfAbsent' }
    | { readonly kind: 'replaceIfVersion'; readonly version: string }
}

/** Apply one literal text edit atomically. */
export interface FsEditTextOperation {
  readonly kind: 'fs.editText'
  readonly targetKey: string
  readonly oldString: string
  readonly newString: string
  readonly replaceAll: boolean
  readonly expectedVersion?: string
}

/** Create one directory target, optionally including missing parents. */
export interface FsMakeDirOperation {
  readonly kind: 'fs.mkdir'
  readonly targetKey: string
  readonly recursive: boolean
}

/** Remove one file or directory target. */
export interface FsRemoveOperation {
  readonly kind: 'fs.remove'
  readonly targetKey: string
  readonly recursive: boolean
}

/** Move one target inside the same authorized project workspace. */
export interface FsMoveOperation {
  readonly kind: 'fs.move'
  readonly sourceKey: string
  readonly destinationKey: string
  readonly overwrite: boolean
}

/** Run one foreground process and stream stdout and stderr. */
export interface SubprocessRunOperation {
  readonly kind: 'subprocess.run'
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | null>>
  readonly stdin?: string
  readonly graceMs: number
  readonly outputLimitBytes: number
}

/** First-version operation set supported by a local executor. */
export type ExecutorOperation =
  | FsResolveOperation
  | FsStatOperation
  | FsLstatOperation
  | FsReadTextOperation
  | FsReadBytesOperation
  | FsListDirOperation
  | FsWriteTextOperation
  | FsEditTextOperation
  | FsMakeDirOperation
  | FsRemoveOperation
  | FsMoveOperation
  | SubprocessRunOperation

/** Broker request with complete Session and environment ownership. */
export interface ExecutorExecutionRequest extends ExecutorEnvironmentIdentity {
  readonly type: 'execution/request'
  readonly requestId: ExecutorRequestId
  readonly userId: string
  readonly deviceId: ExecutorDeviceId
  readonly sessionId: string
  readonly projectId: string
  readonly timeoutMs: number
  readonly operation: ExecutorOperation
}

/** Successful registration acknowledgement. */
export interface BrokerRegisteredMessage {
  readonly type: 'broker/registered'
  readonly protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION
  readonly heartbeatIntervalMs: number
}

/** Broker heartbeat requiring an exact nonce response. */
export interface BrokerPingMessage {
  readonly type: 'broker/ping'
  readonly nonce: string
}

/** Cancellation request for one in-flight execution. */
export interface BrokerCancelMessage {
  readonly type: 'execution/cancel'
  readonly requestId: ExecutorRequestId
  readonly reason: string
}

/** Graceful Broker shutdown or connection replacement notice. */
export interface BrokerCloseMessage {
  readonly type: 'broker/close'
  readonly reason: 'server-shutdown' | 'connection-replaced'
}

/** Every frame sent by the Broker to a local executor. */
export type ExecutorServerMessage =
  | BrokerRegisteredMessage
  | BrokerPingMessage
  | ExecutorExecutionRequest
  | BrokerCancelMessage
  | BrokerCloseMessage
