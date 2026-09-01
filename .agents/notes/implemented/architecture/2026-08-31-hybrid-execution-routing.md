# Agent Note: Hybrid Execution Routing

Status: implemented

English | [中文](2026-08-31-hybrid-execution-routing.zh.md)

## Problem

One Server Session must use its cloud workspace and a user's Electron workspace without moving the Agent, history, or orchestration off the Server. The environments may use different operating systems, shell dialects, paths, and files. Hiding that difference from the model risks executing a valid command or file operation in the wrong environment.

## Decision

Each project Session mounts cloud and local workspace bindings but selects exactly one active binding and environment epoch. Every admitted model step records a complete environment snapshot as a plugin user message. Agent-initiated changes use `switch_execution_environment` and the approval pipeline; direct HTTP changes represent an explicit user action. Files never synchronize implicitly.

Cloud filesystem, subprocess, and shell providers run in one isolated Cordis group. A bridge captures those providers, while root services route existing capability consumers by the initiating Agent Session. Local requests carry user, project, Session, device, binding, and epoch identity through the Executor Broker. Streamed output and final results repeat the binding and epoch, and the Broker rejects mismatched response frames. A lease blocks environment changes until each foreground operation or cloud background process reaches quiescence. Targets and shell specs created under an older epoch fail instead of being reinterpreted.

The Server treats `userId` as a routing key and does not authenticate clients. Direct Electron testing enables browser transport through an explicit CORS origin; backend-only deployments leave CORS disabled and derive `userId` from their authenticated principal.

The Server exposes one model-facing `shell` tool whose dialect follows the active environment snapshot. The bundle disables its host-platform `bash` and `pwsh` consumers, preserving their cloud provider behavior behind the router without exposing a misleading tool name when a local platform differs.

Remote errors, disconnects, stale epochs, unsupported streaming stdin, and unsupported PTY allocation fail in the selected environment. None of these failures can invoke a cloud provider as a fallback.

## Alternatives considered

**Fix the environment when the Session is created.** This prevents one conversation from deliberately moving between cloud and local work while preserving its plan and history.

**Route only subprocess calls.** A cloud Bash provider would still construct `bash -c` for a Windows local executor, and filesystem targets would retain cloud identities. Routing the complete filesystem, subprocess, and shell provider set keeps one execution world.

**Fall back to cloud when a local request fails.** This can apply a command to different files without the Agent or user noticing. Explicit failure preserves environment ownership and lets the user decide whether to switch.

**Expose both Bash and PowerShell tools.** One schema would remain invalid for the active environment and invite dialect mistakes. A neutral tool plus the environment snapshot gives the model one current execution contract.

## Verification

Server tests cover project binding conflicts, switch exclusion leases, approval-gated Agent switching, complete environment snapshots, full local Broker identity, mismatched response epochs, no-fallback remote errors, Windows local workdir resolution, local background rejection, explicit CORS preflight, and the composed isolated-provider topology. The Server package TypeScript build covers all router and tool entries.

## Consequences

Cloud execution keeps its existing providers and background jobs. Local execution supports bounded filesystem operations and foreground subprocesses; streaming stdin, PTY, long-running background jobs, LSP, and local MCP require later protocol additions. Environment snapshots add a changing request suffix, while stable tool schemas preserve the reusable prefix. A disconnected selected local binding remains selected and offline until the user chooses another environment.
