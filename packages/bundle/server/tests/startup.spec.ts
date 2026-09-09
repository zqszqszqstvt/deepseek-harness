/** Server command-line help and deployment contract. */

import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ServerStartup from '../src/startup.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  ServerStartup.internals.platform = process.platform
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
      ServerStartup.internals.platform = 'win32'
      provideCmdline(ctx, { args: ['--help'], exit })

      await ctx.plugin(ServerStartup)

      expect(exit).toHaveBeenCalledWith(0)
      const help = output.join('')
      expect(help).toContain('Linux-only multi-user dsh API')
      expect(help).toContain('dsh server runs only on Linux')
      expect(help).toContain('rejected before the Server starts')
      expect(help).toContain('dsh server does not authenticate clients')
      expect(help).toContain('derive each URL userId from')
      expect(help).toContain('the authenticated principal')
      expect(help).toContain('--cors-origin <origin>')
      expect(help).toContain('dsh server --port 3080')
      expect(help).toContain('trusted test network only')
      expect(ctx.get('serverStartup')).toBeUndefined()
    } finally {
      internals.stdout = original
    }
  })

  it.each(['win32', 'darwin'] as const)('rejects %s before publishing startup values', async (platform) => {
    const ctx = new Context()
    contexts.push(ctx)
    const errors: string[] = []
    const original = internals.stderr
    internals.stderr = { write: (chunk: string) => { errors.push(chunk) } }
    try {
      const exit = vi.fn()
      ServerStartup.internals.platform = platform
      provideCmdline(ctx, { args: [], exit })

      await ctx.plugin(ServerStartup)

      expect(exit).toHaveBeenCalledWith(1)
      expect(errors.join('')).toContain(`supported only on Linux because ${platform} cannot enforce workspace-only shell reads`)
      expect(ctx.get('serverStartup')).toBeUndefined()
    } finally {
      internals.stderr = original
    }
  })

  it('publishes startup values on Linux', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const exit = vi.fn()
    ServerStartup.internals.platform = 'linux'
    provideCmdline(ctx, { args: [], exit })

    await ctx.plugin(ServerStartup)

    expect(exit).not.toHaveBeenCalled()
    expect(ctx.get('serverStartup')).toMatchObject({
      host: '127.0.0.1',
      maxConcurrentTurns: 8,
      maxSseConnections: 128,
      maxSseConnectionsPerUser: 4,
    })
  })

  it('publishes an explicit direct-client CORS origin', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const exit = vi.fn()
    ServerStartup.internals.platform = 'linux'
    provideCmdline(ctx, { args: ['--cors-origin', '*'], exit })

    await ctx.plugin(ServerStartup)

    expect(exit).not.toHaveBeenCalled()
    expect(ctx.get('serverStartup')).toMatchObject({ corsOrigin: '*' })
  })
})
