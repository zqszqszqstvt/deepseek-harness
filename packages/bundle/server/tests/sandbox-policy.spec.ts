/** Server bundle sandbox policy after the real base and overlay patch composition. */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const basePatch = fileURLToPath(new URL('../../base/cordis.patch.yml', import.meta.url))
const serverPatch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

function effectiveEntry(id: string): { config?: Record<string, unknown> } {
  const warnings: string[] = []
  const entries = composeEntries([
    loadOverlayPatches('server-test', basePatch),
    loadOverlayPatches('server-test', serverPatch),
  ], warning => warnings.push(warning))
  expect(warnings).toEqual([])
  const entry = entries.find(candidate => candidate.id === id)
  if (entry === undefined) throw new Error(`missing composed entry ${id}`)
  return entry
}

function effectiveEntries() {
  const warnings: string[] = []
  const entries = composeEntries([
    loadOverlayPatches('server-test', basePatch),
    loadOverlayPatches('server-test', serverPatch),
  ], warning => warnings.push(warning))
  expect(warnings).toEqual([])
  return entries
}

describe('server sandbox deployment policy', () => {
  it('caps every resolved mode at workspace-write and advertises no escalation target', () => {
    expect(effectiveEntry('sandbox-policy').config).toMatchObject({
      mode: 'workspace-write',
      maximumMode: 'workspace-write',
      escalationTargets: [],
    })
  })

  it('exposes only the workspace-write permission preset', () => {
    expect(effectiveEntry('permission').config).toEqual({
      defaultPreset: 'workspace-write',
      presets: {
        'workspace-write': {
          sandbox: 'workspace-write',
          approval: 'ask',
          name: 'workspace-write',
          description: 'Write only inside the session workspace and permitted temporary directories.',
        },
      },
    })
  })

  it('restricts glob and grep search roots to the session workspace', () => {
    expect(effectiveEntry('tool-fs-search').config).toEqual({
      sampleOverCapGlobResults: false,
      strictReads: true,
    })
  })

  it('replaces root execution providers with one isolated cloud realm and Server routers', () => {
    const entries = effectiveEntries()
    for (const id of ['subprocess', 'bash-sandbox', 'pwsh-sandbox', 'fs-sandbox', 'tool-bash', 'tool-pwsh']) {
      expect(entries.find(entry => entry.id === id)).toMatchObject({ disabled: true })
    }
    expect(entries.find(entry => entry.id === 'server-cloud-execution')).toMatchObject({
      name: 'cordis:group',
      group: true,
      isolate: { fs: true, subprocess: true, shell: true },
      config: expect.arrayContaining([
        expect.objectContaining({ id: 'cloud-subprocess', name: '@deepseek-ai/dsh-subprocess-local' }),
        expect.objectContaining({ id: 'cloud-fs', name: '@deepseek-ai/dsh-fs-sandbox' }),
        expect.objectContaining({ id: 'cloud-execution-bridge', name: '@deepseek-ai/dsh-server/cloud-execution' }),
      ]),
    })
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'server-runtime-router', name: '@deepseek-ai/dsh-server/runtime-router' }),
      expect.objectContaining({ id: 'server-fs-router', name: '@deepseek-ai/dsh-server/fs-router' }),
      expect.objectContaining({ id: 'server-subprocess-router', name: '@deepseek-ai/dsh-server/subprocess-router' }),
      expect.objectContaining({ id: 'server-shell-router', name: '@deepseek-ai/dsh-server/shell-router' }),
      expect.objectContaining({ id: 'tool-server-shell', name: '@deepseek-ai/dsh-server/tool-shell' }),
    ]))
  })
})
