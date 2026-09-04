# Agent Note: Platform Session Registry

Status: implemented

English | [中文](2026-09-02-platform-session-registry.zh.md)

## Problem

The multi-user Server derives a Session from URL identity, while an authenticated product needs tenant ownership, user-visible titles, discovery, and archival state. Persistence headers contain the derived Session id and working directory but not the platform identity or presentation metadata required to authorize and list those Sessions.

## Decision

The authenticated platform backend owns the user-visible Session registry. It allocates an opaque project route key, verifies tenant and user ownership before every call, derives the Server `userId` from the verified principal, and uses the idempotent `PUT /v1/users/<userId>/projects/<projectId>/session` route to initialize or resume the corresponding Server Session.

`GET /v1/capabilities` reports the Server API version, executor protocol version, Session identity mode, and supported integration features without creating a Session. The Server does not expose its persistence-wide `list()` as a user route: that unfiltered storage operation lacks platform ownership, title, and archival metadata.

Conversation events, approvals, questions, and execution-environment selection remain authoritative in the Server. The platform registry stores references and presentation lifecycle only; it does not duplicate the event log.

Permanent deletion is Server-authoritative. The Server waits for any in-flight initialization, rejects deletion during an active turn, releases the exact Host-owned `AgentHandle`, verifies that the live Session left the store, and then removes persistence, environment state, and the project directory. The platform backend deletes its registry row only after that operation succeeds. The Host retains one handle per Session created or resumed through its API gateway and records one teardown promise while releasing it; concurrent releases await that operation without unloading sibling Sessions owned by the same plugin fiber.

## Alternatives considered

**Expose persistence `list()` through HTTP.** Persistence listing is unfiltered and its headers cannot recover the original route identities from hashed paths, so the platform could neither authorize nor present the results correctly.

**Store a second conversation log in the platform database.** Dual event ownership would require transactional replication across independent services and could disagree after streaming failures or retries.

**Let the client choose `userId` and project route keys.** The Server deliberately has no authentication layer, so trusting those values would let one client address another principal's runtime state.

**Dispose the live Agent's plugin fiber.** API-created Agents share the API gateway's owner fiber. Disposing that fiber would unload every sibling Session attached to it, while a bare registry lookup cannot recover the per-Agent teardown capability.

## Consequences

Session discovery remains available when the Server is temporarily unavailable, while history, execution, and permanent deletion still require the Server. Provisioning and deletion are idempotent cross-service operations rather than distributed transactions. A failed Server deletion preserves the platform registry row for retry, and deletion refuses a live Session not owned through the API gateway instead of guessing at its lifecycle owner. Deployments must keep the Server on a trusted backend network and must terminate authenticated client HTTP, SSE, and executor WebSocket traffic at the platform backend.
