# Agent Note: Server SSE fanout

Status: implemented

English | [中文](2026-08-27-server-sse-fanout.zh.md)

## Problem

Each multi-user Server `/events` response opened its own all-session `ApiProxy.events.mux()` stream. ApiProxy therefore allocated a `FrameQueue` and installed the complete global event listener set for every connected user, while the Server discarded frames for other sessions only after those frames entered each queue. With one SSE response per active user, every global event was copied to every connection before filtering, so aggregate CPU and transient memory grew with the global event rate multiplied by the connection count and could approach quadratic growth as active users increased. Each response queue was also unbounded, allowing a slow or stalled client to retain unlimited encoded events.

## Decision

The Server owns one lazily started, process-wide ApiProxy mux reader and dispatches each session-scoped frame to only the SSE clients registered for that session. The ApiProxy mux contract and its Web, CLI, SDK, and plugin consumers remain unchanged. Server-generated `session/subscribed` frames use the target session's current sequence, while the shared reader ignores ApiProxy's all-session subscription frames.

The distributor retains only the latest `session/queue` and `session/jobs` snapshots plus still-pending approval and question requests for each session. A reconnect receives that transient baseline after its synthetic subscription frame; durable events and projections continue to recover through the existing history and projection paths. Resolved interaction frames remove their matching cached requests, and session disposal removes all cached state and subscribers for that session.

Every SSE response has a byte-counted pending-frame limit. Exceeding it closes that response instead of silently dropping an event, allowing the client to reconnect and re-establish history and transient state. The Server also rejects connections above process-wide and per-user limits. CLI options `--max-sse-connections`, `--max-sse-connections-per-user`, and `--sse-buffer-bytes` default to `128`, `2`, and `1048576`; `/readyz` reports the current connection count, global limit, and shared mux state. Server disposal aborts and awaits the shared reader before completing.

## Verification

Server HTTP tests open concurrent Alice and Bob responses, prove ApiProxy receives one mux call, and prove each response receives only its own session frames. They cover unresolved interaction replay and post-resolution removal, process-wide and per-user connection rejection, readiness counters, queue overflow, and Context disposal reaching a closed shared reader and responses.

## Alternatives considered

**Ask every platform backend to open one shared connection and filter itself.** Rejected as the only enforcement because the Server's natural per-user endpoint would remain unsafe for independent consumers and a single mistaken integration would restore the amplification.

**Add a session filter to each ApiProxy mux call.** Rejected because each connection would still install and invoke a global listener set; filtering before queue insertion reduces retained frames but does not remove event-rate multiplication by the number of connections.

**Change ApiProxy to expose a new session-specific stream.** Rejected because the defect is confined to the Server adapter and changing the shared host protocol would expand the compatibility and testing surface for Web, CLI, SDK, and plugins.

**Drop frames from slow clients while keeping their responses open.** Rejected because a live SSE response would then appear healthy while exposing an internally inconsistent event sequence with no signal that history recovery is required.

## Consequences

Global ApiProxy events are projected and encoded once by the Server regardless of SSE connection count, then delivered only to interested session clients. Memory retained for each client is bounded, and deployments can cap connection cardinality. The shared reader remains active after its first subscriber until Server shutdown so transient state stays current for later reconnects; its session cache is bounded by current queue/job snapshots and outstanding interactions rather than event history. A client that cannot keep up loses its connection and must reconnect, and a session whose complete transient baseline exceeds its configured buffer receives `503` until the deployment raises the limit or the transient state shrinks.
