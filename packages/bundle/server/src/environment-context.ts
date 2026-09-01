/** Durable model context describing the cloud and local execution worlds. */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectEnvironmentsView, ServerEnvironmentView } from './environments.ts'
import type {} from './environments.ts'

export const name = 'server-environment-context'
export const inject = ['agents', 'serverEnvironments']

function environmentName(environment: ServerEnvironmentView): string {
  return environment.type === 'cloud'
    ? 'cloud'
    : 'local device ' + JSON.stringify(environment.deviceName ?? environment.deviceId ?? 'unknown')
}

function renderEnvironment(environment: ServerEnvironmentView, activeBindingId: string): string {
  const active = environment.bindingId === activeBindingId ? 'ACTIVE' : 'available'
  const root = environment.rootPath === undefined ? 'unavailable' : JSON.stringify(environment.rootPath)
  return '- ' + environment.bindingId + ': ' + environmentName(environment) + '; ' + active
    + '; status=' + environment.status + '; platform=' + environment.platform
    + '; arch=' + environment.arch + '; shell=' + environment.shell + '; root=' + root
    + '; capabilities=' + (environment.capabilities.length === 0 ? 'none' : environment.capabilities.join(','))
}

/**
 * Render one complete, replayable execution-environment snapshot for the model.
 * @param view - current project environments and active binding.
 * @returns model-visible environment context.
 */
export function renderContext(view: ProjectEnvironmentsView): string {
  const active = view.environments.find(environment => environment.bindingId === view.activeBindingId)
  const activeDescription = active === undefined
    ? 'binding ' + view.activeBindingId + ' is unavailable'
    : environmentName(active) + ' (' + active.platform + ', ' + active.shell
      + ', root ' + JSON.stringify(active.rootPath ?? 'unavailable') + ')'
  return [
    'Execution environments for this Session (epoch ' + view.environmentEpoch + '):',
    ...view.environments.map(environment => renderEnvironment(environment, view.activeBindingId)),
    'Current execution environment: ' + activeDescription + '.',
    'Filesystem and command tools operate only in the current execution environment.',
    'Cloud and local files are different and are never synchronized implicitly.',
    'Use switch_execution_environment with an exact binding id when another environment is required.',
    'That switch always requires the user to approve it before it takes effect.',
  ].join('\n')
}

/** Append a replayable environment snapshot to every admitted model step. */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const project = ctx.serverEnvironments.projectForSession(String(agent.session.id))
    if (project === undefined) return decision
    const text = renderContext(project.view)
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'plugin',
            plugin: name,
            form: 'snapshot',
            sections: [{ name: 'execution-environments', text }],
          },
        }),
      ],
    }
  }, { prepend: true })
}
