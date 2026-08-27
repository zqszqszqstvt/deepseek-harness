# Agent Note: Server sandbox maximum

Status: implemented

English | [中文](2026-08-27-server-sandbox-maximum.zh.md)

## Problem

The shared sandbox escalation flow treats an `allowed-once` answer as authority to run one call under its requested wider mode, including `danger-full-access`. That behavior is useful for local interactive profiles, but a multi-user Server promises that each user remains inside an assigned workspace. Hiding escalation controls in the Server UI or tool schema cannot enforce that promise because persisted session events and forged tool arguments can still reach execution.

## Decision

`SandboxPolicyService` owns two deployment limits in addition to its default mode. `maximumMode` caps the resolved default, durable session override, and explicit call override; `escalationTargets` is the ordered set that model-facing tools may advertise and submit for one-shot approval. The defaults remain `danger-full-access` and `['workspace-write', 'danger-full-access']`, so existing CLI, Web, and custom profiles retain their prior behavior unless their composition opts into a lower ceiling.

The Server overlay sets `mode` and `maximumMode` to `workspace-write`, sets `escalationTargets` to an empty list, and exposes only the `workspace-write` permission preset. Bash, PowerShell, and filesystem mutation tools therefore omit escalation fields and retry hints in Server sessions. A forced `sandbox_permissions` argument fails before approval and before any executor or filesystem provider receives the call. The approval service and Server approval transport remain composed for non-sandbox approval types. Explicit TypeScript path mappings for the Server startup and persistence subpaths keep pnpm source launches independent of prebuilt `lib` artifacts.

## Enforcement

The policy resolver caps every input source rather than trusting the permission preset or session log. The shared escalation helper rejects targets absent from the deployment list before resolving an approval service, and every enforcing tool passes the same owner-provided list into that helper. These checks keep schema omission as model guidance while execution remains authoritative.

Config validation rejects a default or escalation target above `maximumMode` and rejects duplicate targets. Cordis profile layers still replace an entry's complete config, so the Server overlay restates `mode` and `workspaceRoot` alongside the new fields.

## Verification

Policy tests pin unchanged defaults, invalid configurations, and ceiling behavior for durable and explicit `danger-full-access` values. Shared escalation tests prove a disabled target never calls the approver. Bash, PowerShell, and filesystem tool tests prove schema omission, missing retry guidance, pre-execution rejection, and unchanged default escalation. A base-plus-Server overlay composition test pins the effective sandbox policy and permission table; Linux sandbox end-to-end coverage separately proves that strict workspace confinement rejects out-of-workspace creation at execution.

## Alternatives considered

**Treat user approval as authority to escape the Server workspace.** Rejected because the Server workspace is an isolation guarantee between users, not a per-call preference. An ordinary user approval cannot widen deployment authority.

**Remove or auto-reject the Server approval service.** Rejected because approval is a shared capability used by request types other than sandbox escalation. The restriction belongs to sandbox policy and its consumers.

**Hide `sandbox_permissions` only in schemas or the frontend.** Rejected because tool arguments, durable events, and alternate clients can bypass presentation. Execution must reject a wider mode independently.

**Change the shared default to `workspace-write`.** Rejected because that would silently remove intentional permission escalation from existing non-Server profiles. The lower ceiling is an explicit Server overlay choice.

## Consequences

Server users cannot read or write other host user content outside their session workspace through DSH-confined shell or filesystem operations, even after approving a request or carrying a stale wider session mode. Strict Linux shell confinement still exposes the read-only system paths required to start programs, while it leaves other user directories unmounted. Users receive a direct denial without misleading escalation guidance. Administrators retain the existing plugin and profile extension points, and non-Server compositions keep the prior escalation defaults. A deployment that deliberately edits the Server overlay or applies a later administrator-owned patch can select a different ceiling; end-user approval alone cannot do so.
