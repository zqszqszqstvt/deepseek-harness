# Agent Note: Confine the Server shell tool's cloud working directory before spawn

Status: implemented

English | [中文](2026-09-09-server-shell-workdir-containment.zh.md)

## Problem

The Server's environment-neutral `shell` tool resolved a model-supplied `workdir` itself and passed the result straight to the routed executor. On the cloud branch an absolute path was returned verbatim and a relative one was resolved against the session cwd, with no containment check; on the local branch an absolute path was likewise returned verbatim. The platform bash tool confines the same argument through `resolveConfinedCwd` against the resolved per-call policy, and the sandboxing bash executor does not narrow `spec.workdir` — it wraps argv only — so nothing between the tool and the spawn owned that check for Server Sessions.

The mount namespace hid the consequence rather than removing it: the Server's `strictFilesystem` bubblewrap profile binds only the runtime paths and the calling session's workspace, so an outside directory either does not exist in the namespace (the spawn fails with a confusing `SANDBOX_UNAVAILABLE`-shaped error) or exists read-only as a system directory. That is not the project's containment contract, which requires an out-of-workspace request to fail before spawn, read, write, or search. It also fails open under any other enforcement: with `strictFilesystem` off, under a different runner, or in a future deployment that binds more of the host, the same call would run a command with its working directory outside the session workspace.

## Decision

`packages/bundle/server/src/tool-shell.ts` resolves the per-call sandbox policy BEFORE the working directory and confines the cloud branch with the shared `resolveConfinedCwd` helper, exactly as `dsh-tool-bash` does. The cloud base for a relative `workdir` is now the resolved policy root — the same canonical identity the sandbox binds — falling back to the session header cwd and then the project state cwd, and the final value is canonicalized and containment-checked, so an escaping absolute path, a `..` traversal, and a symlinked escape all fail in the tool with the helper's `outside the session workspace` error and never reach `ctx.shell.resolve()` or `run()`. Without a `ctx.sandboxPolicy` in the composition the resolved value passes through unchanged, which keeps the tool honest for a deployment that enforces nothing.

The local branch deliberately stays unconfined in the Server. Its `workdir` names a directory on a remote device whose filesystem this process cannot canonicalize: a lexical check against the reported root would reject legitimate Windows paths that differ only in casing or that reach the root through a reparse point, which is a false denial the device would not have made. The connected executor owns that boundary and already resolves every directory against the authorized project root before spawning, so the Server keeps mapping a relative path onto the reported root and forwards an absolute one for the device to accept or reject.

An agentless cloud call now confines against the deployment's fallback root instead of the project workspace. That is consistent rather than restrictive: the same resolved policy decides what the sandbox binds, so a call whose policy root is the fallback would have been confined to it anyway, and it now fails with a named reason before spawn instead of failing inside the namespace.

## Testing

`packages/bundle/server/tests/tool-shell.spec.ts` boots the real tool over a stubbed router, shell, and policy service on a canonical temporary workspace. It pins that a relative and an inside absolute `workdir` reach `ctx.shell.resolve()` resolved under the policy root, that an omitted `workdir` defaults to that root, that `../outside`, `/etc`, `nested/../../outside`, and a real directory outside the workspace all return an error while neither `resolve()` nor `run()` is called, that no policy leaves the value unresolved, and that a local Windows selection still forwards an absolute `workdir` verbatim when a policy is present.

## Alternatives considered

**Confine inside `dsh-bash-sandbox`.** Rejected: the executor receives an already-resolved absolute `spec.workdir` and cannot distinguish a caller's deliberate choice from a defaulted one, and the platform bash tool already owns this check at the tool layer. Putting it in the executor would either double-enforce for `dsh-tool-bash` or move a Consumer decision into a Provider that the seam documents as policy-carrying, not policy-deciding.

**Confine the local branch lexically against the reported root.** Rejected: the Server cannot canonicalize a remote device's paths, and Windows casing and reparse-point aliases make a lexical comparison reject legitimate directories. The device's physical boundary check is the authoritative one and stays there.

**Leave the namespace as the enforcement and document it.** Rejected: it makes the guarantee depend on one runner's mount list, contradicts the containment contract the repository states for every path-taking capability, and turns a rejected request into an infrastructure-shaped failure the model reads as a sandbox outage.

## Consequences

A Server `shell` call whose `workdir` escapes the session workspace now fails before spawn with the shared helper's message, on every runner and profile setting, and the cloud working directory and the confinement boundary are one canonical identity rather than two independently derived strings. The tool imports `@deepseek-ai/dsh-sandbox` for a value rather than types only, which the bundle already depended on. Local executions keep their existing behavior and their existing enforcer; the Server does not duplicate a device-side check it cannot evaluate correctly, and that asymmetry is documented in the tool source where the two branches diverge.
