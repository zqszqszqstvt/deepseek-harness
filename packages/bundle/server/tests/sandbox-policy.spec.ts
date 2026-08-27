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
  return entry as { config?: Record<string, unknown> }
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
})
