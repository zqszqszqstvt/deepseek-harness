# `@deepseek-ai/dsh-server`

English | [中文](README.zh.md)

The Linux-only multi-user HTTP bundle for dsh. It creates one deterministic Session and workspace per URL `(userId, projectId)`, stores Server-owned state below `--data-dir`, and exposes idempotent Session initialization, turn, history, approval, question, cancellation, execution-environment, and multiplexed SSE event routes under `/v1/users/<userId>/projects/<projectId>/...`. `GET /v1/capabilities` reports the HTTP and executor protocol versions without creating a Session. The legacy `/v1/users/<userId>/...` routes address the reserved `default` project. The default command port is `3080`.

## Deployment Contract

`dsh server` runs only on Linux, where strict bubblewrap confinement provides workspace-only reads. macOS and Windows are rejected before startup values are published, so the HTTP listener and Server Session persistence cannot activate. This restriction belongs to the Server profile; other dsh profiles retain their existing platform support. If bubblewrap is unavailable or unusable, shell execution fails closed with `SANDBOX_UNAVAILABLE`.

The Server profile also runs model-written `workflow` and Ralph JavaScript in a separate bubblewrap process. A VM escape can access Node only inside a private read-only root with a private writable `/tmp`, cleared environment, and no network. The process does not mount the Server data root, user workspaces, home directories, host commands, `/usr/local`, global Conda environments, credentials, or the source repository. Child-agent RPC remains on the Server and is schema-validated, identity-checked, and independently capped by the host. Ordinary non-Server profiles retain the lower-overhead worker-thread mode.

`dsh server` has no authentication layer. Keep it on loopback or a trusted backend network. The authenticating platform backend must derive every URL `userId` from its authenticated principal and must never copy a caller-controlled request parameter into that path. A direct public bind, including an unrestricted `--host 0.0.0.0`, violates this contract.

The platform backend owns user-visible Session discovery, titles, tenant ownership, and archival state. It uses `PUT /v1/users/<userId>/projects/<projectId>/session` to initialize or resume one registered Session. Server persistence intentionally does not expose a user Session-list route because its headers do not contain platform ownership or presentation metadata.

Browser CORS is disabled by default. A direct Electron test client can use `--cors-origin '*'` on a trusted test network, or name one exact HTTP origin; production backend-only deployments leave this option unset. This switch permits browser transport only and does not add authentication.

The default project retains `users/<sha256(userId)>/workspace`; every named project maps to `users/<sha256(userId)>/projects/<sha256(projectId)>/workspace`. The Server fixes each Agent sandbox at its project workspace; interactive approval cannot grant access outside it. Filesystem reads and `glob`/`grep` searches reject targets outside the workspace, including canonical symlink escapes. Host exceptions and failed ApiProxy results are logged with their details, while HTTP and terminal SSE clients receive stable generic errors that do not expose host paths. Turn admission serializes one project Session while allowing the same user's other projects to use the global concurrency pool independently. A cloud `shell` call's `workdir` is resolved against the same per-call policy root the sandbox binds and containment-checked before any spawn, so an escaping absolute or relative directory fails in the tool rather than inside the namespace; a local `workdir` stays the connected executor's physical boundary to enforce, because the Server cannot canonicalize a remote device's paths. Spill artifacts — a truncated command's full output and an oversized tool result — are written under `.dsh/spill` inside the owning project workspace, so every path the Server hands the model is one that session's own read boundary can reopen.

Changing `--data-dir` preserves a cold Server Session when its recorded working directory has the exact Server-owned default or named-project layout. The JSONL backend rewrites the persisted working directory and relocates the artifact before ApiProxy adopts it. Live Sessions, unrelated same-ID artifacts, and occupied destinations fail closed.

Agent runtimes are a deployment contract rather than a harness feature. Strict confinement binds only `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, `/run`, and the calling session's workspace, so a shared Python or Conda toolchain is reachable only under `/usr/local` and its package mirrors only under `/etc`; a toolchain under `/opt`, `/srv`, or the service home does not exist inside the namespace and fails with ENOENT. Locking that shared layer read-only is what makes exposing it safe: every user can execute it, nobody can change what another user's agent imports, and per-user packages stay inside that user's workspace `.venv`. Two host locations a desktop profile would use are silently inert here, because in-process reads are fenced to the workspace: `$DSH_HOME/AGENTS.md` probes as unavailable and is skipped without a diagnostic, and `$DSH_HOME/skills` and `$DSH_AGENTS_HOME/skills` are treated as absent because the local skill provider maps a denied read to a missing path. The supported delivery points are the bundled skill root (`DSH_BUNDLED_SKILL_DIR`, which the provider loads with host filesystem calls and marks trusted) and the deployment persona (the `system-prompt` row the base bundle mounts empty for exactly this). [`deploy/dsh-server`](../../../deploy/dsh-server/README.md) owns the complete kit: image paths, the deployment patch, quota and retention, and the acceptance probe.

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
- **Each workflow pays separate-process startup cost** - Server workflow isolation protects shared files and authority but does not impose CPU or memory quotas; operators may add deployment-level cgroups when resource accounting is required.
- **One process owns one data root** - moving a live Session or merging two occupied Server data roots is rejected and requires an offline operator decision.
- **SSE is process-local** - connection limits and bounded client queues protect one process, but a multi-replica deployment must provide its own routing and event fan-out policy.
- **Local execution is non-interactive** - the executor supports bounded filesystem operations and foreground subprocesses, but streaming stdin, PTY, long-running background jobs, LSP, and local MCP remain unavailable.
