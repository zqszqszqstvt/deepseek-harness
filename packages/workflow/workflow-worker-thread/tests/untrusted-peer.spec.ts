import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import { WorkerRun } from '../src/host.ts'
import type { WorkflowPeer } from '../src/peer.ts'
import { HostToWorkerType, WorkerToHostType } from '../src/protocol.ts'

class UntrustedPeer extends EventEmitter implements WorkflowPeer {
  readonly trustedMessages = false
  readonly posted: unknown[] = []

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

describe('untrusted workflow peer host enforcement', () => {
  it('limits child starts, validates lifecycle identity, and replaces self-reported totals', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    let starts = 0
    const provider: SubagentProvider = {
      name: 'stub',
      capabilities: { outputSchema: true, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      async start() {
        starts += 1
        return {
          id: SessionId('real-child'),
          localAgent: undefined,
          result: new Promise(() => {}),
          dispose: () => Promise.resolve(),
        }
      },
    }
    ctx.subagents.registerProvider(provider)
    const peer = new UntrustedPeer()
    const agentStarts: unknown[] = []
    const agentEnds: unknown[] = []
    const run = new WorkerRun(
      ctx,
      ctx.subagents,
      WorkflowRunId('untrusted-run'),
      { name: 'untrusted', description: 'host validation' },
      { id: SessionId('parent'), options: {} } as unknown as Agent,
      {
        meta: { name: 'untrusted', description: 'host validation' },
        body: 'return null',
        limits: { maxConcurrentAgents: 1, maxTotalAgents: 1, maxItemsPerCall: 1, syncTimeoutMs: 100 },
      },
      'stub',
      100,
      {
        phase: () => {},
        log: () => {},
        agentStart: (info) => { agentStarts.push(info) },
        agentEnd: (info) => { agentEnds.push(info) },
      },
      undefined,
      () => peer,
      1,
    )

    peer.emit('message', { type: WorkerToHostType.Ready })
    expect(peer.posted).toContainEqual({ type: HostToWorkerType.Go })
    peer.emit('message', { type: WorkerToHostType.ChildStart, callId: 1, request: { prompt: 'one' } })
    peer.emit('message', { type: WorkerToHostType.ChildStart, callId: 1, request: { prompt: 'duplicate' } })
    peer.emit('message', { type: WorkerToHostType.ChildStart, callId: 2, request: { prompt: 'over cap' } })
    await vi.waitFor(() => {
      expect(peer.posted).toContainEqual({ type: HostToWorkerType.ChildStarted, callId: 1, childId: 'real-child' })
    })

    peer.emit('message', {
      type: WorkerToHostType.AgentStart,
      info: { seq: 1, label: 'fake', childId: SessionId('not-a-child') },
    })
    const validInfo = { seq: 1, label: 'real', childId: SessionId('real-child') }
    peer.emit('message', { type: WorkerToHostType.AgentStart, info: validInfo })
    peer.emit('message', { type: WorkerToHostType.AgentStart, info: validInfo })
    peer.emit('message', {
      type: WorkerToHostType.AgentEnd,
      info: { ...validInfo, label: 'forged', outcome: 'completed' },
    })
    peer.emit('message', {
      type: WorkerToHostType.AgentEnd,
      info: { ...validInfo, outcome: 'completed' },
    })
    peer.emit('message', {
      type: WorkerToHostType.Result,
      result: { value: 'ok', stopReason: 'completed', agentsStarted: 999 },
    })

    await expect(run.result).resolves.toEqual({ value: 'ok', stopReason: 'completed', agentsStarted: 1 })
    expect(starts).toBe(1)
    expect(agentStarts).toEqual([validInfo])
    expect(agentEnds).toEqual([{ ...validInfo, outcome: 'completed' }])
    expect(peer.posted).toContainEqual(expect.objectContaining({
      type: HostToWorkerType.ChildStartError,
      callId: 1,
    }))
    expect(peer.posted).toContainEqual(expect.objectContaining({
      type: HostToWorkerType.ChildStartError,
      callId: 2,
    }))
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('closes an untrusted peer lifecycle before accepting an early result', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'stub',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      async start() {
        return {
          id: SessionId('early-child'),
          localAgent: undefined,
          result: new Promise(() => {}),
          dispose: () => Promise.resolve(),
        }
      },
    })
    const peer = new UntrustedPeer()
    const outcomes: string[] = []
    const run = new WorkerRun(
      ctx,
      ctx.subagents,
      WorkflowRunId('early-run'),
      { name: 'early', description: 'early result' },
      { id: SessionId('parent'), options: {} } as unknown as Agent,
      {
        meta: { name: 'early', description: 'early result' },
        body: 'return null',
        limits: { maxConcurrentAgents: 1, maxTotalAgents: 1, maxItemsPerCall: 1, syncTimeoutMs: 100 },
      },
      'stub',
      100,
      { phase: () => {}, log: () => {}, agentStart: () => {}, agentEnd: (info) => { outcomes.push(info.outcome) } },
      undefined,
      () => peer,
      1,
    )
    peer.emit('message', { type: WorkerToHostType.ChildStart, callId: 1, request: { prompt: 'one' } })
    await vi.waitFor(() => {
      expect(peer.posted).toContainEqual({ type: HostToWorkerType.ChildStarted, callId: 1, childId: 'early-child' })
    })
    peer.emit('message', {
      type: WorkerToHostType.AgentStart,
      info: { seq: 1, label: 'early', childId: SessionId('early-child') },
    })
    peer.emit('message', {
      type: WorkerToHostType.Result,
      result: { value: null, stopReason: 'completed', agentsStarted: 1 },
    })
    await run.result
    expect(outcomes).toEqual(['cancelled'])
    await run.dispose()
    await ctx.fiber.dispose()
  })
})
