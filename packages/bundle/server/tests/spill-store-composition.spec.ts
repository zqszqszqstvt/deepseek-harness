/** Real Loader composition for the Server spill provider and generic spill policy. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { CallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecution } from '@deepseek-ai/dsh-tools'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import { parseProjectRoute, projectSessionState } from '../src/project-session.ts'
import ServerSpillStore from '../src/spill-store.ts'

let root: string | undefined
let context: Awaited<ReturnType<typeof boot>> | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function textOf(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('Server spill real composition', () => {
  it('publishes an oversized tool result through the Server-authorized provider', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-server-spill-composition-'))
    const route = parseProjectRoute('/v1/users/alice/projects/alpha/session')
    if (route === undefined) throw new Error('test project route is invalid')
    const state = projectSessionState(root, route.identity)
    await mkdir(state.cwd, { recursive: true })
    await writeFile(join(root, 'cordis.yml'), [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-server/spill-store'",
      "- name: '@deepseek-ai/dsh-spill-policy'",
      '  config:',
      '    maxInlineBytes: 1024',
      '',
    ].join('\n'))

    context = await boot(
      'server-spill-composition',
      join(root, 'cordis.yml'),
      undefined,
      (ctx) => {
        ctx.provide('serverEnvironments', {
          projectForSession: (sessionId: string) => sessionId === String(state.sessionId)
            ? { state, view: {} }
            : undefined,
        } as never)
        const modules = new Map<string, unknown>([
          ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
          ['@deepseek-ai/dsh-tools', ToolRuntime],
          ['@deepseek-ai/dsh-server/spill-store', ServerSpillStore],
          ['@deepseek-ai/dsh-spill-policy', SpillPolicy],
        ])
        ctx.loader.internal = {
          version: 'v2',
          async import(specifier: string) {
            if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
            return modules.get(specifier)
          },
        } as unknown as NonNullable<typeof ctx.loader.internal>
      },
    )
    const unloaded = [...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const body = 'complete result '.repeat(200)
    context.tools.register(defineContentToolFixture({
      name: 'large-result',
      description: 'Return a large result',
      parameters: {},
      async execute(): Promise<ContentBlock[]> {
        return [{ type: 'text', text: body }]
      },
    }))
    const agent = { session: { header: { id: state.sessionId, cwd: join(root, 'malicious-hint') } } }
    const execution = {
      signal: new AbortController().signal,
      callId: CallId('large-result-call'),
      name: 'large-result',
      arguments: {},
      agent,
    } as unknown as ToolExecution

    const result = await context.tools.execute(execution)
    const text = textOf(result.content)
    const locator = /Full formatted result stored at: (.+?)\. Use read/.exec(text)?.[1]

    expect(result.isError).toBe(false)
    expect(locator?.startsWith(join(state.cwd, '.dsh', 'spill'))).toBe(true)
    expect(await readFile(String(locator), 'utf8')).toBe(body)
  })
})
