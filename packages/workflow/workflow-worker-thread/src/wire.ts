/**
 * Runtime validation and bounded newline framing for the process workflow
 * transport. The isolated process may run escaped model code, so host-side
 * TypeScript types carry no authority across this boundary.
 * @module @deepseek-ai/dsh-workflow-worker-thread/wire
 */

import { SessionId, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { WorkflowAgentInfo } from '@deepseek-ai/dsh-workflow'
import { WorkerToHostType } from './protocol.ts'
import type { WorkerToHostMessage } from './protocol.ts'
import type { ChildStartRequest } from './types.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function decodeAgentInfo(value: unknown): WorkflowAgentInfo | undefined {
  const input = record(value)
  if (input === undefined || !positiveInteger(input.seq) || typeof input.label !== 'string'
    || !optionalString(input.phase) || typeof input.childId !== 'string') return undefined
  return {
    seq: input.seq,
    label: input.label,
    ...input.phase !== undefined ? { phase: input.phase } : {},
    childId: SessionId(input.childId),
  }
}

function decodeChildRequest(value: unknown): ChildStartRequest | undefined {
  const input = record(value)
  if (input === undefined || typeof input.prompt !== 'string'
    || !optionalString(input.provider) || !optionalString(input.model)) return undefined
  let schema: ObjectJsonSchema | undefined
  if (input.schema !== undefined) {
    try {
      assertObjectJsonSchema(input.schema)
      schema = input.schema
    } catch {
      return undefined
    }
  }
  return {
    prompt: input.prompt,
    ...schema !== undefined ? { schema } : {},
    ...input.provider !== undefined ? { provider: input.provider } : {},
    ...input.model !== undefined ? { model: input.model } : {},
  }
}

/**
 * Validate and rebuild one process-to-host workflow message.
 * @param value - parsed JSON from the isolated process.
 * @returns the rebuilt protocol message, or `undefined` for invalid traffic.
 */
export function decodeWorkerToHostMessage(value: unknown): WorkerToHostMessage | undefined {
  const input = record(value)
  if (input === undefined || typeof input.type !== 'string') return undefined
  switch (input.type) {
    case 'ready':
      return { type: WorkerToHostType.Ready }
    case 'phase':
      return typeof input.title === 'string' ? { type: WorkerToHostType.Phase, title: input.title } : undefined
    case 'log':
      return typeof input.message === 'string' ? { type: WorkerToHostType.Log, message: input.message } : undefined
    case 'agent-start': {
      const info = decodeAgentInfo(input.info)
      return info === undefined ? undefined : { type: WorkerToHostType.AgentStart, info }
    }
    case 'agent-end': {
      const info = decodeAgentInfo(input.info)
      const outcome = record(input.info)?.outcome
      if (info === undefined || (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled')) return undefined
      return { type: WorkerToHostType.AgentEnd, info: { ...info, outcome } }
    }
    case 'child-start': {
      const request = decodeChildRequest(input.request)
      return !positiveInteger(input.callId) || request === undefined
        ? undefined
        : { type: WorkerToHostType.ChildStart, callId: input.callId, request }
    }
    case 'child-dispose':
      return positiveInteger(input.callId)
        ? { type: WorkerToHostType.ChildDispose, callId: input.callId }
        : undefined
    case 'result': {
      const result = record(input.result)
      if (result === undefined || !Number.isSafeInteger(result.agentsStarted) || (result.agentsStarted as number) < 0
        || (result.stopReason !== 'completed' && result.stopReason !== 'cancelled' && result.stopReason !== 'error')
        || !optionalString(result.error) || !Object.hasOwn(result, 'value')) return undefined
      const materialized = snapshotJsonValue(result.value)
      if (materialized === undefined) return undefined
      return {
        type: WorkerToHostType.Result,
        result: {
          value: materialized,
          stopReason: result.stopReason,
          ...result.error !== undefined ? { error: result.error } : {},
          agentsStarted: result.agentsStarted as number,
        },
      }
    }
    default:
      return undefined
  }
}

/** Incremental byte-bounded decoder for newline-delimited UTF-8 JSON frames. */
export class JsonLineDecoder {
  private pending = Buffer.alloc(0)

  constructor(private readonly maxFrameBytes: number) {}

  /**
   * Consume bytes and return every complete line in order.
   * @param chunk - the next stream chunk.
   * @returns complete UTF-8 lines without their newline delimiters.
   * @throws when one frame exceeds the configured byte ceiling.
   */
  push(chunk: Buffer): string[] {
    this.pending = Buffer.concat([this.pending, chunk])
    const lines: string[] = []
    for (;;) {
      const newline = this.pending.indexOf(0x0a)
      if (newline === -1) break
      if (newline > this.maxFrameBytes) throw new Error(`workflow process frame exceeds ${this.maxFrameBytes} bytes`)
      const end = newline > 0 && this.pending[newline - 1] === 0x0d ? newline - 1 : newline
      lines.push(this.pending.subarray(0, end).toString('utf8'))
      this.pending = this.pending.subarray(newline + 1)
    }
    if (this.pending.length > this.maxFrameBytes) throw new Error(`workflow process frame exceeds ${this.maxFrameBytes} bytes`)
    return lines
  }
}
