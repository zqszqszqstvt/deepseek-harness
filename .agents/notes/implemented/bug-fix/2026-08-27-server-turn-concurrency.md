# Agent Note: Server turn concurrency

Status: implemented

English | [中文](2026-08-27-server-turn-concurrency.zh.md)

## Problem

The multi-user Server names `maxConcurrentTurns` as a bound on executing turns, but `ApiProxy.sessions.prompt()` resolves when a message is admitted to the Agent inbox. Releasing the global permit at that receipt limits only the short admission calls. Repeated same-user queue requests can therefore fill the durable inbox without waiting for prior work, while `/readyz.running` drops even though Agents continue executing.

## Decision

The Server owns whole-Agent activity intervals through the public `Agent.whenIdle()` observation. A queue-mode request waits for the preceding request for that user, acquires a global permit only when it can submit, admits one prompt, and holds the permit and HTTP response until the Agent reaches idle. Requests waiting behind the same user do not consume global permits and do not enter the Agent inbox.

A steer-mode request submitted while that user's Agent is running remains immediate and joins the current activity. It does not acquire another permit or wait for idle because it is not a second executing turn. Steering submitted while idle follows the queued path because it starts Agent activity. The Server statically requires the shared `agents` service; non-Server bundles and the enqueue-only ApiProxy contract remain unchanged.

`whenIdle()` observes the complete Agent activity rather than attributing a result to one prompt. Other steering, injected context, recovery, or externally admitted work may extend that interval. The Server returns only the existing prompt admission result and makes no claim about which output belongs to the initiating message.

## Verification

Server HTTP tests keep a second same-user queue prompt outside the Agent inbox until idle, keep a second user's prompt behind a global limit of one, and admit steering immediately into a running activity. The tests also wait for every response and activity boundary so teardown cannot mask leaked work.

## Alternatives considered

**Rename the option as an admission-call limit.** Rejected because it leaves the configured limit operationally ineffective and permits unbounded Agent inbox growth through the Server route.

**Wait for every same-user request, including steering.** Rejected because steering is defined to affect the current running activity; delaying it until idle changes it into a later turn.

**Add a per-prompt completion result.** Rejected because one prompt does not own a causal result boundary. The shared Agent API deliberately exposes whole-Agent idleness instead.

## Consequences

`maxConcurrentTurns` and `/readyz.running` describe active Server-owned Agent intervals. Queue-mode HTTP requests may remain open while waiting for a same-user predecessor, a global permit, and eventual idleness, so platform timeouts must exceed the longest accepted turn. The Server prevents queued requests from entering the Agent inbox early, but deployment-level request-rate and connection limits still own the number of pending HTTP requests.
