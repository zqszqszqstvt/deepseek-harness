/** Runtime validation for both executor protocol directions. */

import { describe, expect, it } from 'vitest'
import {
  EXECUTOR_PROTOCOL_VERSION,
  parseExecutorClientMessage,
  parseExecutorServerMessage,
} from '../src/index.ts'

describe('executor protocol', () => {
  it('parses a complete registration and brands its device id', () => {
    expect(parseExecutorClientMessage(JSON.stringify({
      type: 'executor/register',
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      userId: 'alice',
      deviceId: 'desktop-1',
      deviceName: 'Alice PC',
      platform: 'win32',
      arch: 'x64',
      shell: 'powershell',
      capabilities: ['filesystem', 'subprocess'],
      workspaces: [{ projectId: 'alpha', rootPath: 'D:\\projects\\alpha' }],
    }))).toMatchObject({ type: 'executor/register', deviceId: 'desktop-1' })
  })

  it('rejects incompatible versions and malformed execution results', () => {
    expect(() => parseExecutorClientMessage(JSON.stringify({
      type: 'executor/register',
      protocolVersion: EXECUTOR_PROTOCOL_VERSION + 1,
      userId: 'alice',
      deviceId: 'desktop-1',
      deviceName: 'Alice PC',
      platform: 'win32',
      arch: 'x64',
      shell: 'powershell',
      capabilities: [],
      workspaces: [],
    }))).toThrow()
    expect(() => parseExecutorClientMessage(JSON.stringify({
      type: 'execution/result',
      requestId: 'request-1',
      result: { ok: false, error: { code: '', message: 'failed', retryable: false } },
    }))).toThrow()
  })

  it('requires environment ownership on output and final result frames', () => {
    const identity = {
      environmentId: 'local:desktop-1',
      bindingId: 'local:desktop-1',
      environmentEpoch: 3,
    }
    expect(parseExecutorClientMessage(JSON.stringify({
      type: 'execution/output',
      requestId: 'request-1',
      ...identity,
      sequence: 0,
      stream: 'stdout',
      data: 'ready',
    }))).toMatchObject(identity)
    expect(parseExecutorClientMessage(JSON.stringify({
      type: 'execution/result',
      requestId: 'request-1',
      ...identity,
      result: { ok: true, value: { exitCode: 0 } },
    }))).toMatchObject(identity)
  })

  it('parses an environment-owned subprocess request from the Broker', () => {
    expect(parseExecutorServerMessage(JSON.stringify({
      type: 'execution/request',
      requestId: 'request-1',
      userId: 'alice',
      deviceId: 'desktop-1',
      sessionId: 'session-1',
      projectId: 'alpha',
      environmentId: 'local:desktop-1',
      bindingId: 'local:desktop-1',
      environmentEpoch: 3,
      timeoutMs: 30_000,
      operation: {
        kind: 'subprocess.run',
        argv: ['git', 'status', '--short'],
        cwd: 'D:\\projects\\alpha',
        graceMs: 1_000,
        outputLimitBytes: 1_048_576,
      },
    }))).toMatchObject({
      type: 'execution/request',
      environmentEpoch: 3,
      operation: { kind: 'subprocess.run' },
    })
  })

  it('parses workspace mutation operations', () => {
    const base = {
      type: 'execution/request',
      requestId: 'request-1',
      userId: 'alice',
      deviceId: 'desktop-1',
      sessionId: 'session-1',
      projectId: 'alpha',
      environmentId: 'local:desktop-1',
      bindingId: 'local:desktop-1',
      environmentEpoch: 3,
      timeoutMs: 30_000,
    }
    expect(parseExecutorServerMessage(JSON.stringify({
      ...base,
      operation: { kind: 'fs.mkdir', targetKey: 'signed-target', recursive: true },
    }))).toMatchObject({ operation: { kind: 'fs.mkdir' } })
    expect(parseExecutorServerMessage(JSON.stringify({
      ...base,
      operation: {
        kind: 'fs.move',
        sourceKey: 'signed-source',
        destinationKey: 'signed-destination',
        overwrite: false,
      },
    }))).toMatchObject({ operation: { kind: 'fs.move' } })
    expect(parseExecutorServerMessage(JSON.stringify({
      ...base,
      operation: { kind: 'fs.remove', targetKey: 'signed-target', recursive: false },
    }))).toMatchObject({ operation: { kind: 'fs.remove' } })
  })
})
