/** Approval-gated Agent environment switching. */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerBindingId, type ServerEnvironments } from '../src/environments.ts'
import * as ToolEnvironment from '../src/tool-environment.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function start(withApproval: boolean) {
  context = new Context()
  const switchForSession = vi.fn().mockResolvedValue({
    sessionId: 'session-1', activeBindingId: ServerBindingId('local:desktop-1'),
    environmentEpoch: 2, environments: [],
  })
  context.provide('serverEnvironments', { switchForSession } as unknown as ServerEnvironments)
  if (withApproval) {
    context.provide('approval', { request: vi.fn().mockResolvedValue('allowed-once') } as never)
  }
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(ToolEnvironment)
  const agent = { session: { id: 'session-1' } } as unknown as Agent
  return { switchForSession, agent }
}

describe('environment switch tool', () => {
  it('fails closed before switching when no approval seam is available', async () => {
    const harness = await start(false)
    const result = await context!.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('switch-1'),
      name: 'switch_execution_environment',
      arguments: { bindingId: 'local:desktop-1' },
      agent: harness.agent,
    })

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('requested switching this Session to execution environment'),
    })
    expect(harness.switchForSession).not.toHaveBeenCalled()
  })

  it('commits exactly one approved switch and returns the new epoch', async () => {
    const harness = await start(true)
    const result = await context!.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('switch-2'),
      name: 'switch_execution_environment',
      arguments: { bindingId: 'local:desktop-1' },
      agent: harness.agent,
    })

    expect(result).toMatchObject({
      isError: false,
      value: { activeBindingId: 'local:desktop-1', environmentEpoch: 2 },
    })
    expect(harness.switchForSession).toHaveBeenCalledWith('session-1', ServerBindingId('local:desktop-1'))
  })
})
