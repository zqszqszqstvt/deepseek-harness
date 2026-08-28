# Agent Note: Confined terminal working directory

Status: implemented

English | [中文](2026-08-28-confined-terminal-cwd.zh.md)

## Problem

`terminal_open` exposes `cwd` as the initial working directory, but the model-facing consumer replaced every caller value with the workspace root under `read-only` and `workspace-write`. A valid workspace subdirectory therefore had the same result as an omitted value. Removing that replacement without another check would restore the parameter while allowing a local confined process to inherit a host directory outside the mount policy.

## Decision

The model-facing `tool-terminal` consumer forwards `cwd` unchanged to the selected terminal backend and does not depend on sandbox policy. This keeps replaceable backends responsible for their own path domain rather than applying host filesystem rules to every backend type.

The local `terminal-bash` backend resolves the session policy immediately before process creation. Under `read-only` or `workspace-write`, an omitted cwd selects the canonical workspace root, a relative cwd resolves against that root, and an explicit cwd is accepted only when its canonical path is the root or a descendant. The check rejects outside absolute paths, parent-traversal escapes, and symlink escapes before terminal allocation. Under `danger-full-access`, an explicit cwd remains unchanged and an omitted value keeps the policy root default.

## Verification

Provider tests cover relative and absolute workspace subdirectories, the omitted default, both confined modes, outside paths, canonical symlink escapes, and unchanged `danger-full-access` behavior. The model-facing consumer test pins unchanged forwarding to a replaceable backend. The real Loader composition opens a shell in a workspace subdirectory and observes that directory from the running PTY.

## Alternatives considered

**Continue replacing every confined cwd with the workspace root.** Rejected because it makes a documented public parameter ineffective for valid inputs and prevents callers from opening an interactive process in the project subdirectory they selected.

**Validate cwd in `tool-terminal`.** Rejected because the tool can select non-local and replaceable backends whose directory namespace is not the host filesystem. The local backend owns both host process creation and the inherited-directory risk.

**Trust process confinement to revoke an outside inherited cwd.** Rejected because mount-based confinement cannot reliably remove a directory handle that the process already inherited. The backend must reject the cwd before allocation.

## Consequences

Confined local terminals can start in any existing workspace directory without weakening workspace isolation. Invalid confined cwd values fail directly instead of silently changing directories. Backend implementations other than `terminal-bash` retain the exact cwd request and remain responsible for any path policy in their own execution environment.
