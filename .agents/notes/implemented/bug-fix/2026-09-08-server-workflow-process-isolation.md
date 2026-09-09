# Agent Note: Isolate Server workflow JavaScript in a process sandbox

Status: implemented

English | [中文](2026-09-08-server-workflow-process-isolation.zh.md)

## Problem

The Server profile exposes `tool-workflow` and `tool-ralph` to multiple users. Their model-written JavaScript ran in `node:vm` inside a worker thread. `node:vm` shapes the script API but is not a security boundary: known constructor paths recover the worker's Node `process`, which has the Server process's filesystem, environment, network, and OS identity. Shell bubblewrap did not cover this independent execution path, so an escaped workflow could read or modify another user's workspace, credentials, or a shared Conda installation.

## Decision

[`dsh-workflow-worker-thread`](../../../../packages/workflow/workflow-worker-thread/README.md) supports two execution peers behind the existing workflow engine and protocol. `worker-thread` remains the default for non-Server profiles. The Server profile selects Linux-only `sandboxed-process`, which launches the built `process-worker.cjs` entry in a fresh bubblewrap process for every run.

The sandbox starts from a private root, mounts only the Node executable, system library directories required to load it, the single process-worker artifact, `/dev`, and a fresh `/proc`, then remounts that assembled root read-only and overlays a private writable `/tmp`. It creates separate PID, network, IPC, UTS, and session namespaces and clears the child environment. It deliberately omits Server data, user workspaces, home directories, `/run`, `/etc`, host command directories, `/usr/local`, global Conda installations, and the source repository. Source launches fail closed until the process-worker artifact has been built.

The isolated process communicates with the host through newline-delimited JSON. Frames and stderr output are byte-bounded. Every process-to-host message is parsed, validated, and rebuilt as host-owned data. The host independently enforces the total child cap, rejects reused child call IDs, accepts lifecycle narration only for a real published child with matching identity, and replaces process-reported `agentsStarted` with its own count. Cancellation kills the detached process group so descendants do not survive the run.

## Testing

Platform-independent tests cover bubblewrap arguments, every process message variant, malformed traffic, JSONL chunking and limits, reused call IDs, host child caps, lifecycle identity, and untrusted result totals. The built-artifact smoke starts `process-worker.cjs` under plain Node. A Linux-only end-to-end test first probes the real sandbox, then verifies an ordinary `agent()` call and uses the known VM escape to test that another workspace, a credentials file, a Conda environment, a host secret, root writes, `/usr/local`, and outbound network remain unavailable while private `/tmp` stays writable. Existing worker-thread suites pin the unchanged default path.

## Alternatives considered

**Disable `tool-workflow` and `tool-ralph` in Server.** Rejected because it removes orchestration, parallel child-agent work, structured aggregation, progress events, and Ralph iteration even though the unsafe part can be confined independently.

**Keep the worker thread and add more `node:vm` restrictions.** Rejected because `node:vm` explicitly does not promise hostile-code isolation. API filtering cannot turn the same privileged process into a security boundary.

**Rely on Unix ownership or Conda permissions alone.** Rejected because the Server is one OS process serving many application users. All workflow threads inherit that process identity, so filesystem ownership cannot distinguish those users.

**Mount the host `/usr` tree read-only.** Rejected because read-only access would still disclose and allow execution of shared environments under locations such as `/usr/local/miniconda`. The sandbox binds library subtrees instead of general command or installation roots.

**Run each Server user in a complete container.** This remains a valid outer deployment boundary, but it is not required for this fix and has materially higher operational cost. The per-run process preserves the current Server topology and tool contract.

## Consequences

Server workflows keep their existing model-facing API and host-side child-agent behavior, including Ralph. A successful VM escape now gains only the confined process authority rather than Server authority. Each run pays process and namespace startup cost, requires Linux, usable bubblewrap, and built artifacts, and may be less portable when Node depends on libraries outside the mounted system library roots. The sandbox isolates shared files, credentials, environments, network, and process authority; it intentionally does not provide CPU or memory quotas, which remain a deployment-level cgroup concern. Non-Server profiles keep the faster worker-thread path and its documented trust requirement.
