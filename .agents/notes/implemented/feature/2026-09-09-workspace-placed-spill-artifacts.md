# Agent Note: Place spill artifacts inside the session workspace

Status: implemented

English | [中文](2026-09-09-workspace-placed-spill-artifacts.zh.md)

## Problem

Two producers hand the model a filesystem path: the subprocess output collector, which appends a truncated command's full stream to a spill file and reports it as `spillPath`, and `ctx.spillStore`, which persists an oversized tool result and returns a locator that the spill policy renders into the result text. Both wrote under a host-private directory in the OS temp area — the right default for a local deployment, where the model can `read` or `grep` either path.

Under the Server profile neither path is reachable. Session reads are fenced to the session workspace (`fs-sandbox` with `strictReads`), so `read` rejects the temp location, and the shell's own `/tmp` is a fresh per-call tmpfs inside the bubblewrap namespace rather than the host directory the artifact was written to. The model therefore received a truncation notice naming a recovery file it could never open, and its only honest options were to lose the output or re-run the command with its own redirection into the workspace. A related defect sat underneath: opening or writing a spill file happened inside a stream `data` listener with no containment, so an unwritable spill directory escaped as an uncaught host error instead of degrading the one stream.

## Decision

One shared convention and two opt-in placements, both defaulting to the existing private behavior so no profile other than the Server changes.

`@deepseek-ai/dsh-home-paths` owns the location, because it already owns the `.dsh` name and exists so product packages can share user-data path conventions without depending on one another: `workspaceSpillRoot(workspaceRoot)` resolves `<workspace>/.dsh/spill`, beside the project skills a workspace already carries at `<workspace>/.dsh/skills`, with `WORKSPACE_DSH_DIR_NAME` and `WORKSPACE_SPILL_DIR_NAME` naming the segments. Callers own creation, permissions, and retention.

The command-output side gains the directory on the seam that already owns spill mechanics. `SubprocessSpawnSpec.spillDir` names an absolute directory for one spawn's spill files, consistent with that seam's rule that every disposition arrives explicitly and the runtime keeps no config; `dsh-subprocess-local` prefers it over its private default, creates it on demand with owner-only permissions, and now contains every spill filesystem failure — creation, exclusive open, or write — by dropping the artifact and keeping the bounded in-memory tail. `dsh-bash-local` and its `dsh-pwsh-local` mirror add `spillPlacement: private | session-workspace` and derive the directory from the same per-call identity that confines the command: the resolved sandbox-policy root, else the command's own workdir. A `read-only` policy keeps the private directory, because that mode promises no workspace writes and this artifact is written by the harness rather than by the confined child.

The tool-result side gains the location as a caller-supplied hint on the storage namespace. `SpillOwner.workspaceRoot` carries the owning session's workspace, `dsh-spill-policy` forwards the session header cwd it already reads for the owner id, and `dsh-spill-local` adds `placement: private | session-workspace`. Under `session-workspace` a save whose owner carries no workspace REJECTS, which routes through the policy's documented best-effort path — log, keep the inline result — rather than writing to the private root and advertising a locator outside the session's boundary. The session-scoped naming, unpredictable file prefix, exclusive owner-only write, and 0700 directory are unchanged; only the root moves.

The Server composition sets both: `cloud-bash` runs with `spillPlacement: session-workspace` and the `spill-local` row with `placement: session-workspace`. Placement inside the workspace is also the isolation-correct answer, not merely the reachable one. The workspace is that session's own boundary, so an artifact there is scoped to its producer by construction; the shared private root instead relies on an unguessable name, and Server session ids derive deterministically from `(userId, projectId)`, so a `session-<sha256 prefix>` directory name is computable by another user. That is why the fence was not widened instead: allowing the private root through `strictReads` would have made every session's artifacts readable by any session that could compute the name.

## Testing

`packages/util/home-paths/tests/home-paths.spec.ts` pins the convention and its absolute resolution. `packages/subprocess/subprocess-local/tests/spawn.spec.ts` pins that a spec directory wins over the runtime's private one and is created on demand, and that an impossible directory (a regular file where the parent belongs) settles the run with its truncated tail and no `spillPath` instead of throwing. `packages/shell/bash-local/tests/executor.spec.ts` and the `dsh-pwsh-local` mirror pin all four branches: the private default, the policy root under `workspace-write`, the workdir fallback with no policy, and the private directory under `read-only` with no `.dsh` created in the workspace. `packages/spill/spill-local/tests/spill-local.spec.ts` pins the in-workspace layout and permissions, the rejection without an owner workspace, and that the default placement ignores the hint; `packages/spill/spill-policy/tests/spill-policy.spec.ts` pins that the forwarded owner carries the header cwd when present and omits it when absent.

## Alternatives considered

**Allow the private spill root through the strict-reads fence.** Rejected: the fence would then grant a shared, cross-session tree, and the directory name is a hash of a session id another user can compute from the deterministic Server identity. Name unpredictability is not an authorization boundary in a process that serves many users from one OS identity.

**Stop reporting `spillPath` and the store locator on the Server.** Rejected: it removes a real recovery capability — the full output of a truncated command and the full text of an oversized result — to hide a placement defect. Rendering an honest "redirect long output into your workspace" hint was the cheap variant of this, and it remains available to a deployment that does not want harness files in the workspace, but the reachable path is the better default for a profile whose whole filesystem story is the workspace.

**Give `dsh-subprocess-local` a spill-directory config.** Rejected: the service documents that it has none, precisely so deployment-varying choices stay with the caller's config, and a single static directory cannot be inside every user's workspace. The per-spawn spec field is the only shape that can express "this session's directory".

**Write the artifacts through `ctx.fs` so the fence mediates them.** Rejected: the fence judges model-controlled paths for a calling session, while a spill writer is host-side plumbing with no session and a path it derived itself. Routing it through the fence would add a policy check to a write that is not a model request, and the collector is synchronous stream plumbing that cannot await a filesystem seam.

**Add a retrieval tool that reads spill artifacts regardless of the fence.** Rejected: new model-facing surface, prompt tokens, and a second read path with its own authorization story, to solve what `read` and `grep` already do once the path is inside the boundary the session already has.

## Consequences

A Server session's truncated command output and oversized tool results are now recoverable with the tools it already has, and the paths it is handed are paths its own boundary can open. The cost is that harness artifacts become user-visible inside the project directory: `glob` searches hidden entries and lists them, the user's version control may report them as untracked, and nothing in the seam defines their retention — the pre-existing "spill files persist until external cleanup" gap now sits inside the workspace, where deleting the project workspace removes them. `session-workspace` is opt-in, so every other profile keeps the private temp behavior byte for byte, and a `read-only` Server session would still receive an unreachable private path — unreachable today only because the Server caps every session at `workspace-write`, which is stated where the branch lives rather than left implicit.
