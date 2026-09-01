# @deepseek-ai/dsh-executor-protocol

English | [中文](README.zh.md)

Shared, runtime-validated WebSocket messages between the DSH Executor Broker and local executors. The protocol carries device registration, heartbeat, project workspace bindings, filesystem operations, foreground subprocess execution, output streaming, cancellation, and final results. Every execution request includes its user, device, Session, project, environment binding, and environment epoch; every output and final result repeats the environment binding and epoch for Broker validation.

The executor initiates the outbound WebSocket and sends `executor/register` first. The Broker acknowledges the negotiated protocol version, then owns heartbeat and execution request correlation. A disconnected request is never replayed automatically.

## Model Experience

None, as this package validates transport messages; execution providers and Agent context plugins own model-visible content.

#### KV Cache effect

None; this package does not assemble model requests.

## Known Limitations and Deferred Work

- **First-version capabilities only** — PTY, LSP, local MCP, background processes, and cross-environment file transfer are not represented.
