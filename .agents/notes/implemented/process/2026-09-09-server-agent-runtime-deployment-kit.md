# Agent Note: Ship the Server agent-runtime contract as a deployment kit

Status: implemented

English | [中文](2026-09-09-server-agent-runtime-deployment-kit.zh.md)

## Problem

A multi-user Server deployment that wants agents to use Python and Node needs one reproducible way to place the shared runtime, per-project writable dependencies, package policy, model instructions, service state, and host checks. Without that artifact, each operator has to rediscover which paths strict confinement exposes, why shared installs must be read-only, which instruction locations Server sessions can load, and how to distinguish a broken host from an ordinary package failure.

Investigating where to state the contract surfaced a sharper problem: the two locations a desktop profile uses for exactly this are silently inert on the Server. `agent-instructions` probes `$DSH_HOME/AGENTS.md` through `ctx.get('fs')`, which a Server session fences to the workspace, so the probe returns unavailable and the scope is skipped without a diagnostic. The local skill provider reads `$DSH_HOME/skills` and `$DSH_AGENTS_HOME/skills` through the same fence and maps `FS_SANDBOX_DENIED` onto its absent-path predicate, so a skill placed there yields zero candidates and no error. An operator following the documented desktop workflow would therefore ship a contract that never loads, and see nothing to explain why.

## Decision

Ship the operational contract as a deployment kit under [`deploy/dsh-server`](../../../../deploy/dsh-server/README.md). The host installer supports apt and dnf/yum, publishes Python, uv, Node.js, and package managers under `/usr/local`, installs credential-free package policy, synthetic runtime `/etc` files, the pasta+nftables+bwrap runner, the bundled skill, the resident Cordis persona, a dedicated service user, and a hardened systemd unit. `verify.sh` checks host files and executes the real namespace chain; `ACCEPTANCE.md` exercises an online Server; `workspace-gc.sh` prunes only harness-owned caches and spills. The [cloud command isolation decision](../bug-fix/2026-09-10-server-cloud-command-isolation.md) owns the runtime hardening that supports this kit.

The two delivery points are the ones the enforcement actually permits. Resident text goes to `system-prompt.persona`, which renders as the order-0 section for every session of every user and is read host-side during composition, so the workspace fence never applies to it. On-demand templates go to the bundled skill root, because `skill-filesystem` marks `bundledSkillDir` trusted and lists and reads it with host filesystem calls instead of `ctx.fs` — the only host skill directory a Server session can see, reachable through `DSH_BUNDLED_SKILL_DIR` with no configuration row. The kit states the desktop traps explicitly rather than leaving them to be rediscovered, and both the Server README and the Server subsystem document now carry them, since a deployment decision that silently does nothing belongs in the reference documentation and not only in a runbook.

The strict profile ro-binds `/usr`, so the shared layer is read-only for every session and a system or global package install fails with EROFS. The writable dependency layer, project HOME, and caches live in the calling project's workspace, which strict bubblewrap binds one project at a time. Host-side locking remains defense in depth and covers kit-owned files by default because vendor directories under `/usr/local`, including Aliyun aegis, can reject recursive mode changes even from root. `--lock-all` and `--no-lock` keep the broader choices explicit. A runtime under the service home or `/opt` remains absent from cloud commands, which is why the kit publishes one deterministic path under `/usr/local`.

## Testing

Repository unit tests pin the harness-owned profile, environment, project initialization, and background-lifetime behavior. `deploy/dsh-server/verify.sh` owns Linux host acceptance: it checks required files, modes, package policy, configuration composition, and data ownership, then reproduces the strict profile through pasta, nftables, and bwrap. The namespace probe checks the shared runtimes, project HOME, minimal `/etc`, absent host paths, public package access, and rejected private, metadata, and loopback destinations. `ACCEPTANCE.md` proves the same rules through model-facing tools on a live Server, including a cross-user API attempt.

## Alternatives considered

Landing the contract in `$DSH_HOME/AGENTS.md` plus a workspace skill was the obvious desktop-shaped answer and is the one this note exists to rule out: neither loads on the Server, and both fail silently.

Contributing runtime facts through `ctx.shellEnv` (`DSH_PYTHON`, `DSH_VENV`, `DSH_ENV_MODE`) would remove the probing stage entirely and stays the right answer if the probe cost ever matters; it was deferred because the persona and skill already name the exact absolute paths, so the remaining saving is one or two tool calls per session against a new bundle row, config surface, tests, and three-end documentation.

Editing the `shell` tool description in `tool-shell.ts`, as the minimal CLI preset does for its own environment, was rejected because the Server description is hardcoded: the change would cost code, a bundle release, and synchronized documentation in three repositories to deliver text a deployment can already write into its own persona row and edit without redeploying the harness.

Seeding each new workspace from `ensureProject` would make per-project files first-class and remains the right home for a `.gitignore` that hides `.dsh/`; it was deferred because the bundled skill root already reaches every session without per-workspace state, and seeding adds a template-versioning and migration question that no current requirement forces.

Adding an `extraReadonlyBinds` option to the sandbox so a toolchain could live under `/opt` was rejected: the strict profile is deliberately an empty root plus a fixed allow-list, and a configurable bind list would make the visible surface a per-deployment variable that the isolation argument then has to track. Placing the toolchain where the existing allow-list already reaches costs nothing and keeps the mount list a constant.

## Consequences

Operators get one buildable directory with explicit absolute paths, so the failure mode shifts from "the agent keeps hitting denied paths" to "the image does not match the contract", which `verify.sh` reports before any session runs. Deployments that had already placed instructions in `$DSH_HOME` now have a documented explanation and a migration target.

The kit couples the repository to a deployment shape it does not run: the `Dockerfile` pins a base image, a Node major, and a `uv` copy stage, and the probe duplicates the strict mount arguments. Both are stated in the files, and the probe is the part that must be edited together with `profiles.ts`.

Capacity remains a deployment job. `workspace-gc.sh` prunes only `.cache` and `.dsh/spill`, never a `.venv` or a user file, so per-user environment growth is controllable only through a filesystem quota on the data volume; the Server still enforces no quota and no retention of its own. The three-way meaning of `/tmp` also survives: the kit removes the harness's own dependence on it and tells the model not to use it, but a model-authored `/tmp` hand-off between two calls still fails.
