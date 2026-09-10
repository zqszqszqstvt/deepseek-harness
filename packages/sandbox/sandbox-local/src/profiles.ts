/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-landlock-run'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** Runtime configuration paths permitted in the strict profile's synthetic `/etc`. */
const STRICT_ETC_BINDS = [
  '/etc/alternatives',
  '/etc/ca-certificates',
  '/etc/crypto-policies',
  '/etc/gai.conf',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/localtime',
  '/etc/mime.types',
  '/etc/os-release',
  '/etc/pki',
  '/etc/pip.conf',
  '/etc/protocols',
  '/etc/services',
  '/etc/ssl',
  '/etc/timezone',
  '/etc/uv',
] as const

/** Build optional read-only binds into the strict profile's synthetic `/etc`. */
function strictEtcArgs(): string[] {
  return STRICT_ETC_BINDS.flatMap(path => ['--ro-bind-try', path, path])
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @param strictFilesystem - when true, use an empty read-only root and expose
 *   only runtime paths plus the policy workspace (used by the server profile).
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy, strictFilesystem = false): string[] {
  const args = strictFilesystem
    ? [
      // Start from an empty mount root. Otherwise paths not covered by the
      // selected binds may remain backed by the host root in the namespace.
      '--tmpfs', '/',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/sbin', '/sbin',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64',
      '--dir', '/etc',
      ...strictEtcArgs(),
      // The deployment kit installs a resolver file whose synthetic address
      // pasta forwards to the host resolver without exposing host loopback.
      '--ro-bind-try', '/usr/local/share/dsh/runtime-etc/hosts', '/etc/hosts',
      '--ro-bind-try', '/usr/local/share/dsh/runtime-etc/nsswitch.conf', '/etc/nsswitch.conf',
      '--ro-bind-try', '/usr/local/share/dsh/runtime-etc/resolv.conf', '/etc/resolv.conf',
      '--dev', '/dev', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
      '--proc', '/proc', '--cap-drop', 'ALL', '--die-with-parent',
      '--ro-bind', policy.workspaceRoot, policy.workspaceRoot,
    ]
    : ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  if (strictFilesystem) {
    // The empty root is itself a writable tmpfs unless it is remounted. Without
    // this step an absent host path such as /home/... can be created inside the
    // namespace and the command appears successful even though the file vanishes
    // with the namespace. Child bind mounts retain their own read/write flags.
    args.push('--remount-ro', '/')
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
