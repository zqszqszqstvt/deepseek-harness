# Agent Note: Server host boundary

Status: implemented

English | [中文](2026-08-27-server-host-boundary.zh.md)

## Problem

The multi-user Server is an HTTP adapter for an authenticating platform backend, but its command help did not state that deployment assumption. A directly reachable client could choose any URL `userId` and thereby select another tenant's deterministic workspace and session. Binding to `0.0.0.0` was shown without the trusted-network condition.

Server-owned request failures also returned exception or ApiProxy error messages verbatim. Filesystem and persistence failures can include absolute host paths, so a platform that relayed those responses exposed host layout to its tenant. Terminal ApiProxy mux errors had the same problem on SSE.

A copied Server data directory retained each session header's absolute workspace `cwd`. Starting the copy at a new absolute `--data-dir` requested the same deterministic session id with a different cwd, leaving every returning user in a permanent `session-conflict` even though the log and workspace belonged to that user.

## Decision

`dsh server` is explicitly an internal service with no authentication layer. Its help requires loopback or a trusted backend network. The backend authenticates the caller, derives the URL `userId` from that principal, and never accepts a caller-controlled `userId`. The all-interface example names the trusted-network requirement.

Locally validated request errors keep their specific safe messages. Exceptions and failed ApiProxy results return HTTP `500` with `server request failed`; terminal mux failures emit `event stream failed` with empty details. The Server logger receives the original exception or result, including host diagnostics. Ordinary session events remain the tenant's own agent transcript and are not rewritten by this adapter.

Before adopting a deterministic user session, the Server inspects the JSONL artifact. If its cwd differs from the current workspace, automatic relocation is allowed only when the old cwd ends in `users/<full SHA-256 user key>/workspace`. Any other same-id session is rejected. The JSONL backend rewrites the cold session header, moves its session directory within the configured persistence root, invalidates cold coordinator state, and preserves the id and event log. Header replacement precedes the directory move, so retry completes a process interruption between those two commits. Concurrent first requests for one user share the same initialization operation.

## Verification

Server HTTP tests prove thrown errors and failed ApiProxy results retain host paths in logs but return only the public message. SSE tests prove an upstream terminal message is logged and absent from the emitted frame. A real Server route test moves a prior-layout user session and rejects an unrelated same-id cwd. JSONL tests cover plaintext and default Zstandard relocation, event and identity preservation, idempotence, and live-session refusal; Win32 tests pin replacement flags. Project-reference TypeScript builds cover both changed packages.

## Alternatives considered

**Require operators to edit session logs when moving `dataDir`.** Rejected because the immutable cwd is an implementation detail and a copied self-contained Server data root should remain usable without per-user repair.

**Derive a new session id from `dataDir`.** Rejected because relocation would silently abandon the user's conversation history and create a new identity after every path change.

**Relocate every same-id session regardless of its old cwd.** Rejected because a collision with a non-Server session must not grant that session access to a tenant workspace. The full SHA directory proof restricts migration to artifacts created by the same Server user layout.

**Add authentication inside this bundle.** Rejected because credential verification and principal mapping belong to the integrating platform. The Server states and preserves that division rather than introducing a second, incompatible identity system.

## Consequences

Platform tenants do not receive Server infrastructure paths through Server-owned HTTP or terminal SSE failures, while operators retain full diagnostics. A Server deployment exposed beyond loopback is safe only behind a trusted authenticating backend that owns `userId`. Moving a complete `dataDir` preserves returning users' deterministic sessions and history. Deliberately changing a user's workspace to an unrelated layout, migrating a live session, or colliding with a non-Server session still fails and requires operator intervention.
