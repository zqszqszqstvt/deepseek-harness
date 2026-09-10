# @deepseek-ai/dsh-spill-local

English | [中文](README.zh.md)

The **local-filesystem** implementation of the [`@deepseek-ai/dsh-spill`](../spill) storage seam. Registers as `ctx.spillStore` and persists a tool's oversized text to a private, session-scoped file; its locator is the file path and its retrieval hint tells the model to use `read` or `grep` on that path.

## Storage layout

Files land at `<root>/session-<hash>/​<random>-<safeName>`:

- **`root`** — the config `root` (resolved to absolute), or a lazily-created private (0700) per-process directory under the OS temp dir when omitted. A predictable, world-readable root would let other local users read spilled tool output or plant symlinks. Under `placement: session-workspace` the root is instead `<workspace>/.dsh/spill` inside the OWNING session's workspace (`SaveTextSpill.owner.workspaceRoot`), the one location a session whose reads are confined to that workspace can reopen; every other part of the layout is unchanged.
- **`session-<hash>`** — a short `sha256(sessionId)` prefix, so a session's spill files group together and a future cleanup can drop them per session.
- **`<random>-<safeName>`** — an unpredictable hex prefix (defeats symlink planting in a shared root) plus the caller's `suggestedName` sanitized to one safe path segment (traversal-proof; mirrors the JSONL persistence backend's `encodeSegment`). The write is exclusive + owner-only (`open(path, 'wx', 0o600)`): it fails on any pre-existing path, symlink or not, so a planted target cannot redirect it.

## Config

| Key | Default | Meaning |
|---|---|---|
| `root` | private 0700 temp dir | Root directory for spill files. Set to keep them under a known location. Consulted only by the `private` placement. |
| `placement` | `private` | `private` keeps the root above; `session-workspace` places artifacts under `<workspace>/.dsh/spill` in the owning session's workspace, and rejects a save whose owner carries no workspace so the policy keeps the inline result instead of advertising an unreachable locator. |

`saveText` rejects on a real storage failure (permissions, ENOSPC); the spill policy treats a rejection as best-effort and keeps the inline result. See the seam README for the vocabulary, the [tool output spill Agent Note](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) for the design, and the [workspace-placed spill artifacts Agent Note](../../../.agents/notes/implemented/feature/2026-09-09-workspace-placed-spill-artifacts.md) for the `session-workspace` placement.

## Model Experience

Indirectly, through spill consumers that render the local path and `read`/`grep` retrieval guidance.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Local spill files persist until external cleanup** — the backend has no session-lifecycle deletion or age-based retention policy, because persisted, resumed, and forked sessions may still reference a path.
- **Locators require a co-located filesystem consumer** — a remote or virtual deployment needs another `SpillStore` backend whose locator and retrieval hint are meaningful there.
- **In-workspace artifacts are user-visible** — `session-workspace` writes inside the project directory, so `glob` (which searches hidden entries) lists them and the user's own version control may report them as untracked. The `.dsh/spill` name marks them as harness-owned, and removing the workspace removes them.
