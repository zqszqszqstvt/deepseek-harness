/** Server command-line help and deployment contract. */

import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ServerStartup from '../src/startup.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

describe('server startup help', () => {
  it('states the trusted-backend user identity contract', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const output: string[] = []
    const original = internals.stdout
    internals.stdout = { write: (chunk: string) => { output.push(chunk) } }
    try {
      const exit = vi.fn()
      provideCmdline(ctx, { args: ['--help'], exit })

      await ctx.plugin(ServerStartup)

      expect(exit).toHaveBeenCalledWith(0)
      const help = output.join('')
      expect(help).toContain('dsh server does not authenticate clients')
      expect(help).toContain('derive each URL userId from')
      expect(help).toContain('the authenticated principal')
      expect(help).toContain('trusted backend network only')
      expect(ctx.get('serverStartup')).toBeUndefined()
    } finally {
      internals.stdout = original
    }
  })
})
