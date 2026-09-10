# Agent Note: Isolate Server cloud command networks and environments

Status: implemented

English | [中文](2026-09-10-server-cloud-command-isolation.zh.md)

## Problem

The Server confines cloud command files to one project workspace, but a command shared the Server process's host network namespace. The Server listens without authentication on host loopback, so model-written code could call `/v1/users/<other-user>/...` directly and bypass the filesystem boundary. The command also inherited the scrubbed parent environment, including non-credential host paths, proxy settings, and loader variables, while strict filesystem mode exposed the host's complete `/etc` and `/run`. Credential-name scrubbing reduced accidental leakage but could not define a complete cloud environment or protect unknown sensitive names.

Cloud background jobs also had no lifetime after the initiating tool call returned. A forgotten install, watcher, or child process could remain managed until cancellation or Server shutdown.

## Decision

The Server cloud sandbox uses an operator-supplied `pasta` runner before bubblewrap. Pasta creates an unprivileged user and network namespace, does not map the host gateway, and exposes a synthetic DNS forwarder. Namespace loopback remains available for same-command tests but is distinct from host loopback. A trusted wrapper installs nftables output rules before entering bubblewrap. The rules allow DNS and public destinations while rejecting RFC1918, shared, link-local, cloud metadata, multicast, and reserved gateway ranges. The strict bubblewrap profile explicitly drops all capabilities before starting the model command, preventing it from changing those rules. Missing pasta, nftables, wrapper files, DNS files, or rule installation fails the command closed through configured runner-failure signatures.

Strict bwrap mode constructs `/etc` from a fixed allow-list instead of binding the host directory. Deployment-owned `hosts`, `nsswitch.conf`, and `resolv.conf` replace their host counterparts; host account databases, global Git/npm configuration, and `/run` are absent. PID, IPC, UTS, and cgroup namespaces are unshared. `/usr` remains the read-only shared runtime and only the active project workspace is writable.

`LocalSubprocessRuntime` makes ambient inheritance configurable. Its default remains the existing scrubbed parent environment for ordinary profiles. The Server cloud instance sets `inheritParentEnv: false` and a fixed executable PATH. Each cloud shell receives a complete project-scoped environment: `.home`, `.cache`, XDG directories, Python/uv/npm/pnpm caches, locale, `TMPDIR`, and `PYTHONNOUSERSITE`. Project initialization creates `.home` and `.cache`; explicit managed `DSH_*` facts still merge after this environment. The shell tool caps background jobs with `backgroundTimeoutMs`, defaulting to 30 minutes, and kills the process tree when the deadline expires.

The [deployment kit decision](../process/2026-09-09-server-agent-runtime-deployment-kit.md) continues to own shared runtime placement and operator delivery. This note owns the runtime changes required to make that deployment safe against host-network API access and ambient host state.

## Alternatives considered

**Rely on upstream identity enforcement.** The platform backend still owns authentication, but code inside the sandbox bypasses that backend and reaches the loopback listener directly. This remains unsafe even when every external request is authenticated correctly.

**Use bubblewrap `--unshare-net` with no adapter.** This blocks the Server API but also blocks Python and Node package downloads. The requested runtime needs controlled public egress, so a user-mode network adapter and destination policy are required.

**Proxy an allow-list of package registries.** This provides a narrower egress policy but adds an authenticated proxy, registry inventory, certificate distribution, and availability dependency. Public-only destination filtering is the current compromise; a registry proxy can replace it when package policy becomes a separate requirement.

**Keep the parent environment scrub heuristic.** A deny-list cannot cover arbitrary secret names, internal proxy configuration, language loader hooks, or future service variables. An empty base with explicit deployment entries has a closed reviewable result.

**Bind selected host `/etc` files including `hosts`, `gitconfig`, and `npmrc`.** Host-managed files can contain internal names, helper commands, or credentials. Deployment-owned network files and credential-free package configuration provide the required runtime behavior without importing that state.

## Consequences

Cloud commands retain public package access but cannot reach the Server listener through loopback or a pasta gateway, and DNS rebinding to a private or metadata address is rejected at connect time. Each command pays for a pasta namespace and nftables setup in addition to bubblewrap. Hosts must provide working unprivileged user namespaces, pasta, and nftables; AppArmor or SELinux policy may require an explicit deployment rule.

Cloud command behavior is deterministic across service managers because proxy variables and other ambient settings do not survive unless explicitly supplied. Project HOME and caches consume the same project storage as dependencies. The background deadline bounds forgotten jobs but can terminate a legitimate build; deployments may configure a value from one minute through 24 hours.

Unit tests pin strict profile arguments, environment replacement, project directory creation, command environment injection, and background termination. The deployment probe exercises the real pasta+nftables+bwrap chain on Linux and the live acceptance runbook proves that a shell cannot call another user's Server API. Windows development hosts cannot execute that kernel-level probe.
