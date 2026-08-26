# Agent Note: Mount server persistence through static injection

Status: implemented

English | [中文](2026-08-26-server-persistence-static-injection.zh.md)

## Problem

The server bundle needs the JSONL session root derived from the parsed `--data-dir` value. Applying a later YAML patch to the base `session-persistence-jsonl` row made its config expression depend on an entry-level `serverStartup` injection. A source deployment could retain the expression without the effective injection and fail while the plugin tree loaded, before the HTTP server or model configuration became available.

## Decision

The server bundle disables the base `session-persistence-jsonl` row and inserts `@deepseek-ai/dsh-server/session-persistence`. This function plugin statically injects `serverStartup`, then mounts the shared `JsonlSessionPersistence` provider with `serverStartup.sessionsDir`. The server profile therefore derives session storage from the same parsed startup value as its data root without evaluating a cross-layer YAML expression.

The adapter is an exported package entry and a direct consumer of `dsh-session-persistence-jsonl`. Its child provider belongs to the adapter fiber, so unloading the server adapter also unloads persistence.

## Alternatives considered

**Continue patching `inject` and `config` onto the base row.** Rejected because the server-specific dependency remains split across a base-owned row and a later patch; a composition that retains only the config expression fails before it can report server readiness.

**Publish the parsed data directory through an environment variable.** Rejected because process-global mutable state would duplicate the command-line service and make repeated in-process profile boots depend on ambient state.

## Verification

The server package test proves that persistence remains absent until `serverStartup` is provided, uses the configured sessions directory after activation, and disappears when the adapter fiber is disposed. The package build emits the adapter export, and a built-CLI smoke test starts `dsh server` and receives successful `/healthz` and `/readyz` responses without model credentials.

## Consequences

Server startup no longer depends on adding an injection to a base-owned persistence row. The server bundle owns one small adapter plugin and one direct workspace dependency; other profiles continue using the base persistence configuration unchanged.
