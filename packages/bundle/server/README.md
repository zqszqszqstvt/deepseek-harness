# `@deepseek-ai/dsh-server`

English | [中文](README.zh.md)

The Linux-only multi-user HTTP bundle for dsh. It creates one deterministic Session and workspace per URL `(userId, projectId)`, stores Server-owned state below `--data-dir`, and exposes health, readiness, turn, history, approval, question, cancellation, and multiplexed SSE event routes under `/v1/users/<userId>/projects/<projectId>/...`. The legacy `/v1/users/<userId>/...` routes address the reserved `default` project. The default command port is `3080`.

## Deployment Contract

`dsh server` runs only on Linux, where strict bubblewrap confinement provides workspace-only reads. macOS and Windows are rejected before startup values are published, so the HTTP listener and Server Session persistence cannot activate. This restriction belongs to the Server profile; other dsh profiles retain their existing platform support. If bubblewrap is unavailable or unusable, shell execution fails closed with `SANDBOX_UNAVAILABLE`.

`dsh server` has no authentication layer. Keep it on loopback or a trusted backend network. The authenticating platform backend must derive every URL `userId` from its authenticated principal and must never copy a caller-controlled request parameter into that path. A direct public bind, including an unrestricted `--host 0.0.0.0`, violates this contract.

Browser CORS is disabled by default. A direct Electron test client can use `--cors-origin '*'` on a trusted test network, or name one exact HTTP origin; production backend-only deployments leave this option unset. This switch permits browser transport only and does not add authentication.

The default project retains `users/<sha256(userId)>/workspace`; every named project maps to `users/<sha256(userId)>/projects/<sha256(projectId)>/workspace`. The Server fixes each Agent sandbox at its project workspace; interactive approval cannot grant access outside it. Filesystem reads and `glob`/`grep` searches reject targets outside the workspace, including canonical symlink escapes. Host exceptions and failed ApiProxy results are logged with their details, while HTTP and terminal SSE clients receive stable generic errors that do not expose host paths. Turn admission serializes one project Session while allowing the same user's other projects to use the global concurrency pool independently.

Changing `--data-dir` preserves a cold Server Session when its recorded working directory has the exact Server-owned default or named-project layout. The JSONL backend rewrites the persisted working directory and relocates the artifact before ApiProxy adopts it. Live Sessions, unrelated same-ID artifacts, and occupied destinations fail closed.

## Execution Environments

Each project Session keeps its Agent, model history, and orchestration in the Server while mounting the cloud workspace and any connected Electron workspaces as separate execution environments. Exactly one binding is active. Filesystem, subprocess, and shell calls carry the Session binding and environment epoch; a stale call fails, and a local failure or disconnect never falls back to cloud execution.

The Electron executor opens an outbound WebSocket, registers its device and project roots, and enforces each authorized local root. An Agent uses `switch_execution_environment` to request a binding change through the approval service. A user-initiated HTTP switch is already an explicit user decision. Switching never copies or synchronizes files, and an active execution lease must settle first.

## Model Experience

### Environment snapshot

#### What the model sees

Every admitted model step receives a replayable user-message snapshot listing the cloud and local environments, active binding, `environmentEpoch`, platform, shell, workspace root, and connection state. The snapshot states that files are not synchronized and that Agent-initiated switching requires approval.

#### Token effect

The snapshot adds one bounded user message whose size grows with the number of mounted environments.

#### KV Cache effect

The snapshot is appended near the request suffix and changes when bindings, epochs, or device state change.

### Environment tools

#### What the model sees

The bundle exposes `switch_execution_environment` and an environment-neutral `shell` tool. The `shell` description tells the model to use the active environment's reported dialect; cloud commands may use background jobs, while local commands are foreground-only.

#### Token effect

The two stable tool definitions replace the platform-fixed Bash and PowerShell definitions in this bundle.

#### KV Cache effect

The stable `shell` and switch definitions join the tool prefix and remain reusable while environment state changes.

## Known Limitations and Deferred Work

- **Authentication belongs to the platform backend** - the Server does not validate credentials, tenants, or authorization policy.
- **Linux with usable bubblewrap is required** - macOS Seatbelt and Windows ACL execution do not provide the workspace-only shell-read isolation required by the multi-user Server; a Linux host without usable bubblewrap rejects shell execution.
- **One process owns one data root** - moving a live Session or merging two occupied Server data roots is rejected and requires an offline operator decision.
- **SSE is process-local** - connection limits and bounded client queues protect one process, but a multi-replica deployment must provide its own routing and event fan-out policy.
- **Local execution is non-interactive** - the executor supports bounded filesystem operations and foreground subprocesses, but streaming stdin, PTY, long-running background jobs, LSP, and local MCP remain unavailable.
