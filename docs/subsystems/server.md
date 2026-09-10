# Multi-user Server

English | [中文](server.zh.md)

The [`@deepseek-ai/dsh-server`](../../packages/bundle/server/README.md) bundle owns deterministic project Sessions for `(userId, projectId)`, durable execution-environment selection, and the HTTP routes that drive one cloud Agent per project. The Server keeps model history and orchestration in the cloud while routing filesystem, subprocess, and shell operations to the active cloud or Electron workspace.

## Execution environments

Every project mounts its Server-owned cloud workspace and the workspaces reported by connected local executors. One binding and `environmentEpoch` are active at a time. Environment switches require an idle execution lease; Agent-initiated switches use approval, and local failures never select another Provider. The [Server README](../../packages/bundle/server/README.md#execution-environments) owns deployment behavior and limitations.

## Local executor transport

`ctx.executorBroker` accepts outbound WebSocket connections, correlates bounded operations, validates response binding and epoch identity, and removes device availability when a connection closes. The [`@deepseek-ai/dsh-executor-protocol`](../../packages/executor/executor-protocol/README.md) README owns the wire messages and capability limits.

## Trust boundary

The Server treats `userId` as a routing and isolation key, not authentication. A trusted platform backend must supply it. Electron authorizes local roots and enforces their physical path boundary; the Server neither synchronizes files nor falls back to cloud execution after a local error. A cloud shell call's working directory is confined to the session workspace before spawn, and the artifacts a Server Session is handed paths to — truncated command output and oversized tool results — are spilled inside that same workspace, so a path the model receives is a path its own read boundary can reopen.

Instruction and skill delivery obeys the same boundary, and the two host locations a desktop profile relies on are silently inert under it. `$DSH_HOME/AGENTS.md` is probed through `ctx.fs`, so a Server session observes it as unavailable and skips it without a diagnostic, and `$DSH_HOME/skills` and `$DSH_AGENTS_HOME/skills` are treated as absent because the local skill provider maps a denied read to a missing path. The bundled skill root is the one host skill directory a Server session does read, because its provider lists and reads that root with host filesystem calls and marks it trusted. Resident deployment text belongs to the `system-prompt` persona row, which the base bundle mounts empty and calls a deployment choice. Agent runtime preparation — the read-only shared toolchain under `/usr/local`, package mirrors under `/etc`, quota, and the acceptance probe — is owned by the [deployment kit](../../deploy/dsh-server/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcloudexecution--cloudexecution"></a>

### `ctx.cloudExecution` — `CloudExecution`

Stable bridge from root routers to the isolated cloud Providers.

Source: [`packages/bundle/server/src/cloud-execution.ts`](../../packages/bundle/server/src/cloud-execution.ts)

<a id="ctxexecutorbroker--executorbroker"></a>

### `ctx.executorBroker` — `ExecutorBroker`

Executor connection registry and request dispatcher.

```ts cordis-catalog
/**
 * Execute one request on its exact registered device.
 * @param request - complete Session and environment ownership plus operation.
 * @param options - cancellation and output observer.
 * @returns executor's final structured result.
 */
execute( request: ExecutorBrokerRequest, options: ExecutorBrokerExecuteOptions = {}, ): Promise<ExecutorResultMessage['result']>
```

Source: [`packages/bundle/server/src/executor-broker.ts`](../../packages/bundle/server/src/executor-broker.ts)

<a id="ctxserverenvironments--serverenvironments"></a>

### `ctx.serverEnvironments` — `ServerEnvironments`

Server-owned environment registry. Active binding state is durable; local device facts exist only while the executor connection owns its registration.

```ts cordis-catalog
/**
 * Publish one connected executor until the returned disposer runs.
 * @param registration - validated device facts and project workspaces.
 * @returns disposer that removes only this exact registration.
 */
registerExecutor(registration: LocalExecutorRegistration): () => void

/**
 * Associate one deterministic Server Session with its validated project identity.
 * Repeated route access is idempotent; a conflicting identity fails closed.
 * @param state - validated project Session state derived from the Server route.
 */
bindProject(state: ProjectSessionState): void

/**
 * Resolve the current environment view from a live Agent Session id.
 * @param sessionId - deterministic Server Session id.
 * @returns current project state and environment view, or undefined outside Server-owned Sessions.
 */
projectForSession(sessionId: string): { readonly state: ProjectSessionState readonly view: ProjectEnvironmentsView } | undefined

/**
 * Commit an approved switch for a live Agent Session.
 * @param sessionId - deterministic Server Session id.
 * @param bindingId - requested available binding.
 * @returns committed environment projection.
 */
async switchForSession(sessionId: string, bindingId: ServerBindingId): Promise<ProjectEnvironmentsView>

/**
 * Hold the exact active binding and epoch for one tool operation.
 * @param sessionId - owning Server Session.
 * @param bindingId - binding selected before the operation starts.
 * @param environmentEpoch - epoch selected before the operation starts.
 * @returns idempotent release callback.
 */
leaseExecution( sessionId: string, bindingId: ServerBindingId, environmentEpoch: number, ): () => void

/**
 * Project the durable selection and currently connected environments.
 * @param state - project Session identity and cloud workspace.
 * @returns current environment view; an unavailable selected local binding remains visible as offline.
 */
project(state: ProjectSessionState): ProjectEnvironmentsView

/**
 * Commit a user-approved environment switch after verifying availability.
 * @param state - project Session whose active binding changes.
 * @param bindingId - requested binding from the current project view.
 * @returns the committed environment view.
 */
async switch(state: ProjectSessionState, bindingId: ServerBindingId): Promise<ProjectEnvironmentsView>

/**
 * Permanently remove one project's durable selection and live binding.
 * Active execution leases reject deletion so a tool cannot outlive its
 * environment identity.
 * @param state - project Session being deleted.
 */
async deleteProject(state: ProjectSessionState): Promise<void>
```

Source: [`packages/bundle/server/src/environments.ts`](../../packages/bundle/server/src/environments.ts)

<a id="ctxserverruntimerouter--serverruntimerouter"></a>

### `ctx.serverRuntimeRouter` — `ServerRuntimeRouter`

Session-aware dispatcher shared by FS, subprocess, and Shell routers.

```ts cordis-catalog
/**
 * Resolve the initiating Agent to its exact current environment.
 * @returns current project, binding, epoch, and environment facts.
 */
current(): ServerRuntimeSelection

/**
 * Acquire an environment-switch exclusion lease for one operation.
 * @param selection - environment snapshot captured before the operation.
 * @returns idempotent lease release callback.
 */
lease(selection: ServerRuntimeSelection): () => void

/**
 * Run one finite cloud or local operation under an environment-switch exclusion lease.
 * @param selection - environment snapshot captured before the operation.
 * @param operation - finite operation to execute while the lease is held.
 * @returns operation result after releasing the lease.
 */
async run<T>( selection: ServerRuntimeSelection, operation: () => Promise<T>, ): Promise<T>

/**
 * Dispatch one structured operation to the selected local device.
 * @param selection - local environment snapshot captured before dispatch.
 * @param operation - validated filesystem or subprocess operation.
 * @param timeoutMs - maximum Broker request lifetime in milliseconds.
 * @param options - optional cancellation signal and output observer.
 * @returns structured successful executor value.
 */
async executeLocal( selection: ServerRuntimeSelection, operation: ExecutorOperation, timeoutMs: number, options: ExecutorBrokerExecuteOptions = {}, ): Promise<unknown>
```

Source: [`packages/bundle/server/src/runtime-router.ts`](../../packages/bundle/server/src/runtime-router.ts)

<a id="ctxserverstartup--serverstartupvalues"></a>

### `ctx.serverStartup` — `ServerStartupValues`

Parsed Server command-line values shared by the HTTP and persistence plugins.

Source: [`packages/bundle/server/src/startup.ts`](../../packages/bundle/server/src/startup.ts)
<!-- END GENERATED cordis-surface -->
