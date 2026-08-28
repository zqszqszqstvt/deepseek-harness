# Agent Note: Confined process working directories

Status: implemented

English | [中文](2026-08-28-confined-terminal-cwd.zh.md)

## Problem

The model can select a process working directory through `bash.workdir`, `pwsh.workdir`, or `terminal_open.cwd`. The terminal consumer replaced every confined caller value with the workspace root, making valid subdirectories ineffective, while the two one-shot shell tools resolved relative paths but passed outside absolute paths to their executors. File confinement could still prevent reads and writes after spawn, but the public working-directory parameters did not enforce the session-workspace scope and an outside inherited cwd could undermine mount-based isolation assumptions.

## Decision

The sandbox Service Definition owns `resolveConfinedCwd(requested, policy)`. Under `read-only` or `workspace-write`, it resolves relative paths against the canonical policy root and accepts only that root or a canonical descendant, rejecting outside absolute paths, parent traversal, other drives, and symlink escapes. Under `danger-full-access`, it preserves an explicit cwd and defaults an omitted value to the policy root.

The Bash and PowerShell tools first resolve the standing sandbox policy, finish any one-shot approval, and construct the final effective policy. They then apply the shared cwd guard before executor resolution and before background-job publication. A Server deployment whose `maximumMode` is `workspace-write` therefore rejects an outside workdir even if a stale or forged session event claims `danger-full-access`; a native deployment that approves `danger-full-access` retains its outside-directory capability. Non-sandbox tool compositions retain their existing session-relative and external absolute-path behavior.

The model-facing `tool-terminal` consumer forwards `cwd` unchanged because replaceable backends may use a non-host path namespace. The local `terminal-bash` backend applies the same shared guard immediately before process creation, retaining backend ownership of host-path enforcement without duplicating the algorithm.

## Verification

Sandbox tests cover the root, relative and absolute descendants, both confined modes, outside absolute paths, parent traversal, symlink escapes, and unchanged `danger-full-access` behavior. Bash and PowerShell consumer tests prove confined foreground and background rejections occur before executor `resolve`, `run`, or `start`; they also pin accepted descendants and approved unrestricted calls. The Server ceiling regression folds a `danger-full-access` session event through `maximumMode: workspace-write` and proves no executor dispatch occurs. Terminal provider tests and the real Loader composition cover the same helper through PTY allocation and a running shell.

## Alternatives considered

**Continue replacing every confined cwd with the workspace root.** Rejected because it makes a documented public parameter ineffective for valid inputs and prevents callers from opening an interactive process in the project subdirectory they selected.

**Validate cwd in `tool-terminal`.** Rejected because the tool can select non-local and replaceable backends whose directory namespace is not the host filesystem. The local backend owns both host process creation and the inherited-directory risk.

**Trust process confinement to revoke an outside inherited cwd.** Rejected because mount-based confinement cannot reliably remove a directory handle that the process already inherited. The backend must reject the cwd before allocation.

**Intercept `cd` in shell text.** Rejected as a security mechanism because shell functions, builtins, nested shells, and direct `chdir` calls can bypass command-text rewriting. Completely forbidding post-spawn directory changes requires syscall denial, which breaks common tools, or a container/microVM whose virtual root is the workspace. The current promise is limited to model-selected initial and per-call working-directory parameters; the process sandbox governs file visibility and effects after spawn.

## Consequences

Every local model-controlled process entry now uses one canonical working-directory rule. Confined calls can start in any existing workspace directory, while invalid paths fail before a process or background job is created. Approved unrestricted and non-sandbox native workflows retain external directory support. Commands may still change their own cwd after spawn, but doing so does not expand the file access the active sandbox backend permits.
