import { describe, expect, it } from 'vitest'
import { WorkerToHostType } from '../src/protocol.ts'
import { decodeWorkerToHostMessage, JsonLineDecoder } from '../src/wire.ts'

describe('process workflow wire validation', () => {
  it.each([
    [{ type: WorkerToHostType.Ready }, { type: WorkerToHostType.Ready }],
    [{ type: WorkerToHostType.Phase, title: 'Scan' }, { type: WorkerToHostType.Phase, title: 'Scan' }],
    [{ type: WorkerToHostType.Log, message: 'working' }, { type: WorkerToHostType.Log, message: 'working' }],
    [
      { type: WorkerToHostType.AgentStart, info: { seq: 1, label: 'one', phase: 'Scan', childId: 'child-1' } },
      { type: WorkerToHostType.AgentStart, info: { seq: 1, label: 'one', phase: 'Scan', childId: 'child-1' } },
    ],
    [
      { type: WorkerToHostType.AgentEnd, info: { seq: 2, label: 'two', childId: 'child-2', outcome: 'failed' } },
      { type: WorkerToHostType.AgentEnd, info: { seq: 2, label: 'two', childId: 'child-2', outcome: 'failed' } },
    ],
    [
      { type: WorkerToHostType.ChildStart, callId: 3, request: { prompt: 'answer', provider: 'spawn', model: 'm' } },
      { type: WorkerToHostType.ChildStart, callId: 3, request: { prompt: 'answer', provider: 'spawn', model: 'm' } },
    ],
    [
      {
        type: WorkerToHostType.ChildStart,
        callId: 4,
        request: { prompt: 'structured', schema: { type: 'object', properties: { answer: { type: 'number' } } } },
      },
      {
        type: WorkerToHostType.ChildStart,
        callId: 4,
        request: { prompt: 'structured', schema: { type: 'object', properties: { answer: { type: 'number' } } } },
      },
    ],
    [{ type: WorkerToHostType.ChildDispose, callId: 5 }, { type: WorkerToHostType.ChildDispose, callId: 5 }],
    [
      { type: WorkerToHostType.Result, result: { value: { answer: 42 }, stopReason: 'completed', agentsStarted: 1 } },
      { type: WorkerToHostType.Result, result: { value: { answer: 42 }, stopReason: 'completed', agentsStarted: 1 } },
    ],
    [
      { type: WorkerToHostType.Result, result: { value: null, stopReason: 'error', error: 'failed', agentsStarted: 0 } },
      { type: WorkerToHostType.Result, result: { value: null, stopReason: 'error', error: 'failed', agentsStarted: 0 } },
    ],
  ])('rebuilds a valid %s message', (input, expected) => {
    expect(decodeWorkerToHostMessage(input)).toEqual(expected)
  })

  it.each([
    undefined,
    null,
    [],
    'message',
    {},
    { type: 'unknown' },
    { type: WorkerToHostType.Phase, title: 1 },
    { type: WorkerToHostType.Log },
    { type: WorkerToHostType.AgentStart, info: { seq: 0, label: 'x', childId: 'c' } },
    { type: WorkerToHostType.AgentStart, info: { seq: 1, label: 2, childId: 'c' } },
    { type: WorkerToHostType.AgentStart, info: { seq: 1, label: 'x', phase: 2, childId: 'c' } },
    { type: WorkerToHostType.AgentEnd, info: { seq: 1, label: 'x', childId: 'c', outcome: 'other' } },
    { type: WorkerToHostType.ChildStart, callId: -1, request: { prompt: 'x' } },
    { type: WorkerToHostType.ChildStart, callId: 1, request: { prompt: 2 } },
    { type: WorkerToHostType.ChildStart, callId: 1, request: { prompt: 'x', provider: 2 } },
    { type: WorkerToHostType.ChildStart, callId: 1, request: { prompt: 'x', model: 2 } },
    { type: WorkerToHostType.ChildStart, callId: 1, request: { prompt: 'x', schema: { type: 'string' } } },
    { type: WorkerToHostType.ChildDispose, callId: 1.5 },
    { type: WorkerToHostType.Result, result: null },
    { type: WorkerToHostType.Result, result: { value: null, stopReason: 'other', agentsStarted: 0 } },
    { type: WorkerToHostType.Result, result: { value: null, stopReason: 'completed', agentsStarted: -1 } },
    { type: WorkerToHostType.Result, result: { value: null, stopReason: 'completed', agentsStarted: 0, error: 1 } },
    { type: WorkerToHostType.Result, result: { stopReason: 'completed', agentsStarted: 0 } },
    { type: WorkerToHostType.Result, result: { value: Number.NaN, stopReason: 'completed', agentsStarted: 0 } },
  ])('rejects invalid process traffic %#', (input) => {
    expect(decodeWorkerToHostMessage(input)).toBeUndefined()
  })
})

describe('JsonLineDecoder', () => {
  it('reassembles split frames and returns multiple LF or CRLF frames in order', () => {
    const decoder = new JsonLineDecoder(32)
    expect(decoder.push(Buffer.from('{"a":'))).toEqual([])
    expect(decoder.push(Buffer.from('1}\n{"b":2}\r\npartial'))).toEqual(['{"a":1}', '{"b":2}'])
    expect(decoder.push(Buffer.from('-done\n'))).toEqual(['partial-done'])
  })

  it('accepts a frame exactly at the byte limit', () => {
    const decoder = new JsonLineDecoder(4)
    expect(decoder.push(Buffer.from('1234\n'))).toEqual(['1234'])
  })

  it('rejects an unterminated or terminated frame over the byte limit', () => {
    expect(() => new JsonLineDecoder(4).push(Buffer.from('12345'))).toThrow('exceeds 4 bytes')
    expect(() => new JsonLineDecoder(4).push(Buffer.from('12345\n'))).toThrow('exceeds 4 bytes')
  })
})
