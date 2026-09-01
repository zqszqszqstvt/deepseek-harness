import type { Context } from '@deepseek-ai/cordis'
import {
  ServerBindingId,
  type ProjectEnvironmentsView,
  type ServerEnvironments,
} from '../src/environments.ts'
import type { ProjectSessionState } from '../src/project-session.ts'

/** Provide the cloud-only environment projection used by unrelated Server route tests. */
export function provideCloudEnvironment(ctx: Context): void {
  const projects = new Map<string, ProjectSessionState>()
  const project = (state: ProjectSessionState): ProjectEnvironmentsView => ({
    sessionId: state.sessionId,
    activeBindingId: ServerBindingId('cloud'),
    environmentEpoch: 0,
    environments: [{
      bindingId: ServerBindingId('cloud'),
      environmentId: 'cloud',
      type: 'cloud',
      status: 'online',
      rootPath: state.cwd,
      platform: process.platform,
      arch: process.arch,
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      capabilities: ['filesystem', 'subprocess', 'shell'],
    }],
  })
  ctx.provide('serverEnvironments', {
    project,
    bindProject: (state: ProjectSessionState) => { projects.set(String(state.sessionId), state) },
    projectForSession: (sessionId: string) => {
      const state = projects.get(sessionId)
      return state === undefined ? undefined : { state, view: project(state) }
    },
    switch: async (state: ProjectSessionState, bindingId: ReturnType<typeof ServerBindingId>) => {
      if (bindingId !== 'cloud') throw new Error(`test environment '${bindingId}' is unavailable`)
      return project(state)
    },
  } as unknown as ServerEnvironments)
}
