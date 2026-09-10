/** Server-owned spill placement and link containment. */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { parseProjectRoute, projectSessionState } from '../src/project-session.ts'
import ServerSpillStore, { publishServerSpillFile } from '../src/spill-store.ts'

const roots: string[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-server-spill-'))
  roots.push(root)
  const route = parseProjectRoute('/v1/users/alice/projects/alpha/session')
  if (route === undefined) throw new Error('test project route is invalid')
  const state = projectSessionState(root, route.identity)
  await mkdir(state.cwd, { recursive: true })
  return state
}

async function store(state: Awaited<ReturnType<typeof project>>): Promise<ServerSpillStore> {
  context = new Context()
  context.provide('serverEnvironments', {
    projectForSession: (sessionId: string) => sessionId === String(state.sessionId)
      ? { state, view: {} }
      : undefined,
  } as never)
  await context.plugin(ServerSpillStore)
  return context.spillStore
}

function request(sessionId: ReturnType<typeof SessionId>, workspaceRoot?: string) {
  return {
    owner: { sessionId, ...(workspaceRoot === undefined ? {} : { workspaceRoot }) },
    source: { toolName: 'probe', callId: CallId('call-1'), label: 'result' },
    suggestedName: 'probe.txt',
    content: 'the full body',
  }
}

describe('ServerSpillStore', () => {
  it('uses the Server project binding instead of the caller workspace hint', async () => {
    const state = await project()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-server-spill-hint-'))
    roots.push(outside)
    const spill = await store(state)

    const ref = await spill.saveText(request(state.sessionId, outside))

    expect(ref.locator.startsWith(join(state.cwd, '.dsh', 'spill'))).toBe(true)
    expect(await readFile(ref.locator, 'utf8')).toBe('the full body')
    expect(ref.bytes).toBe(Buffer.byteLength('the full body', 'utf8'))
    expect(await readdir(outside)).toEqual([])
    if (process.platform !== 'win32') {
      expect((await stat(dirname(ref.locator))).mode & 0o777).toBe(0o700)
      expect((await stat(ref.locator)).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects a workspace spill link that redirects the host write outside', async () => {
    const state = await project()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-server-spill-outside-'))
    roots.push(outside)
    const dsh = join(state.cwd, '.dsh')
    const link = join(dsh, 'spill')
    await mkdir(dsh)
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const spill = await store(state)

    try {
      await expect(spill.saveText(request(state.sessionId))).rejects.toThrow(/must not be a symbolic link/)
      expect(await readdir(outside)).toEqual([])
    } finally {
      if (existsSync(link)) await unlink(link)
    }
  })

  it('publishes a private shell collector file into the project workspace', async () => {
    const state = await project()
    const source = join(dirname(state.cwd), 'private-output.log')
    await writeFile(source, 'complete shell output')

    const published = await publishServerSpillFile(source, state, 'shell-stdout')

    expect(published.startsWith(join(state.cwd, '.dsh', 'spill'))).toBe(true)
    expect(await readFile(published, 'utf8')).toBe('complete shell output')
  })

  it('rejects a non-directory in the reserved workspace path', async () => {
    const state = await project()
    await writeFile(join(state.cwd, '.dsh'), 'occupied')
    const spill = await store(state)

    await expect(spill.saveText(request(state.sessionId))).rejects.toThrow(/is not a directory/)
  })

  it('rejects a project workspace that is not a directory', async () => {
    const state = await project()
    await rm(state.cwd, { recursive: true })
    await writeFile(state.cwd, 'not a directory')
    const spill = await store(state)

    await expect(spill.saveText(request(state.sessionId))).rejects.toThrow(/workspace is not a directory/)
  })

  it('removes no unrelated file when the private collector source is missing', async () => {
    const state = await project()
    const source = join(dirname(state.cwd), 'missing-private-output.log')

    await expect(publishServerSpillFile(source, state, 'shell-stdout')).rejects.toThrow()
    const sessionRoot = join(state.cwd, '.dsh', 'spill')
    const sessionEntries = await readdir(sessionRoot)
    expect(sessionEntries).toHaveLength(1)
    expect(await readdir(join(sessionRoot, sessionEntries[0]!))).toEqual([])
  })

  it('rejects an owner that has no Server project binding', async () => {
    const state = await project()
    const spill = await store(state)

    await expect(spill.saveText(request(SessionId('foreign')))).rejects.toThrow(/not a Server Session/)
  })
})
