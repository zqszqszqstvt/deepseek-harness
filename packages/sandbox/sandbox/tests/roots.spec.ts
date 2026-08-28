/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalPath, resolveConfinedCwd, writableRoots } from '@deepseek-ai/dsh-sandbox'

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('resolveConfinedCwd', () => {
  it.each(['read-only', 'workspace-write'] as const)('accepts the root and relative or absolute descendants under %s', (mode) => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-confined-cwd-'))
    const nested = join(workspace, 'nested')
    mkdirSync(nested)
    try {
      const policy = { mode, workspaceRoot: workspace }
      expect(resolveConfinedCwd(undefined, policy)).toBe(realpathSync.native(workspace))
      expect(resolveConfinedCwd('.', policy)).toBe(realpathSync.native(workspace))
      expect(resolveConfinedCwd('nested', policy)).toBe(realpathSync.native(nested))
      expect(resolveConfinedCwd(nested, policy)).toBe(realpathSync.native(nested))
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each(['read-only', 'workspace-write'] as const)('rejects absolute, parent, and symlink escapes under %s', (mode) => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-confined-cwd-'))
    const workspace = join(base, 'workspace')
    const outside = join(base, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    symlinkSync(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const policy = { mode, workspaceRoot: workspace }
    try {
      expect(() => resolveConfinedCwd(outside, policy)).toThrow('outside the session workspace')
      expect(() => resolveConfinedCwd('../outside', policy)).toThrow('outside the session workspace')
      expect(() => resolveConfinedCwd('escape', policy)).toThrow('outside the session workspace')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('preserves an explicit danger-full-access cwd and defaults to the policy root', () => {
    const policy = { mode: 'danger-full-access' as const, workspaceRoot: '/session-workspace' }
    expect(resolveConfinedCwd('../outside', policy)).toBe('../outside')
    expect(resolveConfinedCwd(undefined, policy)).toBe('/session-workspace')
  })
})

describe('writableRoots', () => {
  it('read-only grants nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(roots).toContain(realpathSync.native(ws))
    expect(roots).toContain(canonicalPath('/tmp'))
    expect(roots).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(roots).size).toBe(roots.length)
  })
})
