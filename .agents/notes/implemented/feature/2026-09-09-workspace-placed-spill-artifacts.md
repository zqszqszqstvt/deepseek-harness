# Agent Note: Place spill artifacts inside the session workspace

Status: implemented

English | [中文](2026-09-09-workspace-placed-spill-artifacts.zh.md)

## Problem

Two producers hand the model a filesystem path: the subprocess output collector reports a truncated command's full stream as `spillPath`, and `ctx.spillStore` persists an oversized tool result and returns a locator that the spill policy renders into the result text. Their private OS-temp locations are appropriate for ordinary dsh profiles, but a Server Session cannot read them because `fs-sandbox` restricts reads to that Session's project workspace and the shell's `/tmp` is a separate per-call tmpfs inside the bubblewrap namespace.

Placing those files directly under a caller-supplied workspace path is not sufficient in the multi-user Server. The model can write inside its workspace and can pre-place `.dsh` or `spill` as a symlink or Windows junction. A host-side `mkdir` or `open` that follows that link can therefore write outside the authorized project even when the original path string appears contained. `SpillOwner.workspaceRoot` is also a placement hint shared by generic dsh packages, not an authorization source for a Server Session.

## Decision

Ordinary dsh profiles retain their private spill behavior. The generic subprocess and spill packages may accept explicit workspace placement from a trusted composition, but the Server does not enable those modes and does not treat their path hints as authority. Its overlay disables the generic `spill-local` provider and mounts `@deepseek-ai/dsh-server/spill-store` instead.

The Server spill provider resolves `SpillOwner.sessionId` through `serverEnvironments.projectForSession()` and derives the destination only from the returned `ProjectSessionState.cwd`. It creates `<workspace>/.dsh/spill/session-<hash>` one component at a time, rejects a symlink, junction, or non-directory at every reserved component, and verifies each component's canonical path before opening an unpredictable filename exclusively with owner-only permissions. An owner without a current Server project binding is rejected; `workspaceRoot` from the caller cannot redirect the write.

Cloud command collection keeps the generic collector's private destination. After a foreground command settles, `tool-server-shell` copies each reported private spill file into the validated Server directory and exposes only the published workspace path. A background adapter records private spill sources without exposing them while the process runs; a lossy running read says that recovery becomes available after completion. Job settlement awaits the closed collector and asynchronous publication, and the next `job_output` returns the final delta with published workspace paths. Publication failure is contained to that stream: the Server logs it, reports the full output as unavailable, and retains the bounded tail.

The workspace is the correct model-readable location because it is already the Server Session's filesystem authorization boundary. The shared private root is not added to `strictReads`: Server Session ids derive deterministically from `(userId, projectId)`, so another tenant can compute a session-directory name, and an unpredictable filename is not a cross-tenant authorization mechanism.

## Testing

`packages/bundle/server/tests/spill-store.spec.ts` pins authoritative project resolution, rejection of a workspace spill symlink or junction without touching its outside target, publication of a private collector file, and rejection of an owner with no Server binding. `packages/bundle/server/tests/background-spill.spec.ts` pins lossless reads, two-stream publication after settlement, private-path suppression, and publication-failure containment. `packages/bundle/server/tests/tool-shell.spec.ts` pins foreground and background cloud publication through the model-visible tool paths. `packages/bundle/server/tests/sandbox-policy.spec.ts` composes the real base and Server overlays and pins that the generic spill provider is disabled, the Server provider is mounted, and the cloud collector retains private placement. `packages/bundle/server/tests/spill-store-composition.spec.ts` boots real `tools`, Server spill, and spill-policy plugins through Loader and proves that an oversized tool result is published through the Server provider. Existing generic-package tests continue to pin their opt-in placement APIs and private defaults independently of the Server.

## Alternatives considered

**Enable generic workspace placement in the Server.** Rejected: the generic API receives a caller path and performs a host write, while a Server workspace is model-writable. Without Server-owned identity lookup and link checks, a pre-planted symlink or junction can redirect the write outside the project.

**Allow the private spill root through the strict-reads fence.** Rejected: the fence would grant access to a shared cross-session tree. Deterministic Server Session ids make its session-directory names computable, and filename unpredictability is not authorization.

**Stop reporting recovery paths in the Server.** Rejected: this discards the full output of a truncated command and the full text of an oversized result instead of making existing `read` and `grep` recovery work inside the established project boundary.

**Add a privileged spill-retrieval tool.** Rejected: it creates a second read path with separate authorization and model-facing surface when the existing filesystem tools already suffice after safe publication.

## Consequences

A Server Session can reopen every spill path it receives, while the destination is derived from Server-owned state and stable pre-planted symlink or junction escapes are rejected. Native and other ordinary dsh profiles remain independent: they keep private spill storage and do not depend on Server identity or workspace rules.

The Server pays for a second copy of truncated cloud output, and the collector's private source remains subject to its existing external cleanup policy. A lossy background read cannot provide its recovery path until the process settles and the closed spill file has been published. Published artifacts are visible under the project directory, can appear in hidden-file searches or version-control status, and persist until external cleanup or project deletion. A publication failure leaves only the bounded tail available to the model. As with the repository's filesystem sandbox, canonical validation followed by a later file open does not eliminate a privileged concurrent filesystem race; it blocks stable link redirection but does not claim race-free containment against another host actor mutating the path during the operation.
