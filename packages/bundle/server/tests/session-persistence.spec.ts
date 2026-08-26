/** Server session persistence activation through its real Cordis plugin exports. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'
import * as ServerSessionPersistence from '../src/session-persistence.ts'
import type { ServerStartupValues } from '../src/startup.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('server session persistence', () => {
  it('waits for server startup and mounts JSONL below its sessions directory', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)

    const fiber = ctx.plugin(ServerSessionPersistence)
    expect(ctx.get('sessionPersistence')).toBeUndefined()

    const sessionsDir = join(mkdtempSync(join(tmpdir(), 'dsh-server-persistence-')), 'sessions')
    const startup: ServerStartupValues = {
      sessionsDir,
      maxConcurrentTurns: 8,
    }
    ctx.provide('serverStartup', startup)
    await fiber

    expect(ctx.get('sessionPersistence')).toBeInstanceOf(JsonlSessionPersistence)
    expect((ctx.get('sessionPersistence') as JsonlSessionPersistence).config.root).toBe(sessionsDir)

    await fiber.dispose()
    expect(ctx.get('sessionPersistence')).toBeUndefined()
  })
})
