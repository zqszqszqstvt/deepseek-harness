# `@deepseek-ai/dsh-server`

English | [中文](README.zh.md)

The multi-user HTTP bundle for dsh. It creates one deterministic Session and workspace per URL `userId`, stores Server-owned state below `--data-dir`, and exposes health, readiness, turn, history, approval, question, cancellation, and multiplexed SSE event routes under `/v1/users/<userId>/...`. The default command port is `13080`.

## Deployment Contract

`dsh server` has no authentication layer. Keep it on loopback or a trusted backend network. The authenticating platform backend must derive every URL `userId` from its authenticated principal and must never copy a caller-controlled request parameter into that path. A direct public bind, including an unrestricted `--host 0.0.0.0`, violates this contract.

Each identity is mapped to `users/<sha256(userId)>/workspace`. The Server fixes the Agent sandbox at that workspace; interactive approval cannot grant access outside it. Host exceptions and failed ApiProxy results are logged with their details, while HTTP and terminal SSE clients receive stable generic errors that do not expose host paths.

Changing `--data-dir` preserves a cold Server Session when its recorded working directory has the exact Server-owned `users/<full-sha256>/workspace` shape. The JSONL backend rewrites the persisted working directory and relocates the artifact before ApiProxy adopts it. Live Sessions, unrelated same-ID artifacts, and occupied destinations fail closed.

## Model Experience

None, as the HTTP bundle transports user messages and interactive responses; the composed Agent and tools own all model-facing content.

#### KV Cache effect

None; the bundle adds no prompt, tool schema, or model-visible result.

## Known Limitations and Deferred Work

- **Authentication belongs to the platform backend** - the Server does not validate credentials, tenants, or authorization policy.
- **One process owns one data root** - moving a live Session or merging two occupied Server data roots is rejected and requires an offline operator decision.
- **SSE is process-local** - connection limits and bounded client queues protect one process, but a multi-replica deployment must provide its own routing and event fan-out policy.
