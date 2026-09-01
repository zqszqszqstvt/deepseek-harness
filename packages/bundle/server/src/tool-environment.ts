/** Model-facing, approval-gated execution-environment switch. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { ServerBindingId } from './environments.ts'
import type {} from './environments.ts'

export const name = 'tool-server-environment'
export const inject = ['tools', 'serverEnvironments']

const TOOL_NAME = 'switch_execution_environment'

interface SwitchArguments {
  bindingId: string
}

/** Register a switch tool whose every invocation is decided by the user approval seam. */
export function apply(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (exec.name !== TOOL_NAME || decision.kind !== 'allow') return decision
    const bindingId = String((exec.arguments as Partial<SwitchArguments>).bindingId ?? '')
    return {
      kind: 'ask',
      reason: 'The Agent requested switching this Session to execution environment ' + JSON.stringify(bindingId) + '.',
    }
  })

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: 'Switch this Session to another listed cloud or local execution environment. '
      + 'The user must approve every switch. Files are not synchronized between environments.',
    parameters: {
      bindingId: {
        type: 'string',
        required: true,
        description: 'Exact binding id from the current execution-environments context.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          activeBindingId: { type: 'string', required: true },
          environmentEpoch: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Execution environment switched to ' + value.activeBindingId
          + ' (epoch ' + value.environmentEpoch + ').',
      }],
    },
    async execute(args: SwitchArguments, exec) {
      if (exec.agent === undefined) throw new Error(TOOL_NAME + ' requires an owning Agent Session')
      const bindingId = args.bindingId.trim()
      if (bindingId.length === 0 || bindingId.length > 512) {
        throw new Error('bindingId must be a non-empty string no longer than 512 characters')
      }
      const view = await ctx.serverEnvironments.switchForSession(
        String(exec.agent.session.id),
        ServerBindingId(bindingId),
      )
      return {
        activeBindingId: String(view.activeBindingId),
        environmentEpoch: view.environmentEpoch,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Switch execution environment',
      kind: 'other',
      rawInput: args.bindingId,
    }),
  }))
}
