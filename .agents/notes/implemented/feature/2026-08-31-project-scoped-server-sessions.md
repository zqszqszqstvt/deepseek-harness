# Agent Note: Project-scoped Server Sessions

Status: implemented

English | [中文](2026-08-31-project-scoped-server-sessions.zh.md)

## Problem

The multi-user Server derived one Session and workspace from `userId`. A user working on two projects therefore shared one Agent history, one working directory, and one per-user turn queue. Local execution requires a stable project identity because the same logical project has different workspace paths in cloud and device environments.

## Decision

The Server derives one deterministic Session from `(userId, projectId)`. Project routes use `/v1/users/<userId>/projects/<projectId>/...`; legacy user routes address the reserved `default` project and retain the prior Session id and workspace layout.

Named project workspaces use `users/<sha256(userId)>/projects/<sha256(projectId)>/workspace`. Session ids hash a NUL-framed user and project pair, so neither URL value enters a filesystem path. Persisted cwd relocation accepts only the exact hashed layout belonging to that Session.

Turn serialization is keyed by Session rather than user. Two turns for one project remain ordered, while separate projects owned by one user may run concurrently under the process-wide limit. SSE connection limits remain user-scoped, but every client subscribes to one project Session id.

## Alternatives considered

**Keep one Session per user and switch directories inside it.** This combines unrelated project history and permits cwd changes to reinterpret prior file observations. Project Sessions preserve one stable history and cloud workspace per project.

**Let the frontend provide arbitrary Session ids.** This makes Session ownership and recovery depend on untrusted client state. Deterministic derivation lets the Server verify every project route without another identity registry.

**Break existing user routes.** Existing Server data would become unreachable without a migration. Reserving `default` preserves the previous Session id and storage path while new projects use the explicit route.

## Verification

Server route tests cover stable project ids and paths, default-project compatibility, independent same-user project turns, data-root relocation, approval routing, and SSE isolation. The package TypeScript build includes the branded route identities.

## Consequences

Clients that manage projects use the project route and persist a stable `projectId`. Legacy clients continue in one default project. Per-user SSE limits aggregate all project event streams, while turn concurrency and workspaces are project-scoped. Environment bindings can attach to this stable Session without changing Agent identity.
