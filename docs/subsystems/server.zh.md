# 多用户 Server

[English](server.md) | 中文

[`@deepseek-ai/dsh-server`](../../packages/bundle/server/README.zh.md) 组合包为 `(userId, projectId)` 持有确定性的项目 Session、持久执行环境选择，以及驱动每个项目云端 Agent 的 HTTP 路由。Server 将模型历史和编排保留在云端，同时把文件系统、子进程与 shell 操作路由到活动的云端或 Electron 工作区。

## 执行环境

每个项目都会挂载 Server 自有的云端工作区，以及已连接本地执行器报告的工作区。任一时刻只有一个 binding 和 `environmentEpoch` 处于活动状态。环境切换要求执行租约空闲；Agent 发起的切换使用审批，本地失败不会选择其他 Provider。[Server README](../../packages/bundle/server/README.zh.md#execution-environments) 负责说明部署行为和限制。

## 本地执行器传输

`ctx.executorBroker` 接受出站 WebSocket 连接、关联有界操作、校验响应的 binding 与 epoch 标识，并在连接关闭时移除设备可用状态。[`@deepseek-ai/dsh-executor-protocol`](../../packages/executor/executor-protocol/README.zh.md) README 负责说明 wire message 和能力限制。

## 信任边界

Server 只把 `userId` 用作路由和隔离键，不将其视为身份认证。可信平台后端必须提供该值。Electron 授权本地根目录并强制执行物理路径边界；Server 不同步文件，也不会在本地错误后回退到云端执行。云端 shell 调用的工作目录会在 spawn 之前被限制在会话工作区内，而 Server Session 交予路径的产物——被截断的命令输出与过大的工具结果——会 spill 到同一个工作区内部，因此模型收到的路径就是其自身读取边界可以重新打开的路径。

指令与 skill 的投递遵循同一条边界，而桌面 profile 依赖的两个宿主位置在该边界下是静默失效的。`$DSH_HOME/AGENTS.md` 经 `ctx.fs` 探测，因此 Server 会话将其观察为 unavailable 并跳过，且不产生任何诊断；`$DSH_HOME/skills` 与 `$DSH_AGENTS_HOME/skills` 被当作不存在，因为本地 skill provider 把被拒的读取映射成路径缺失。bundled skill 根是 Server 会话唯一会读到的宿主 skill 目录，因为它的 provider 用宿主文件系统调用列举并读取该根，并将其标记为可信。常驻的部署文案属于 `system-prompt` 的 persona 行，base 组合把它挂为空并明写这是部署的选择。[部署套件](../../deploy/dsh-server/README.zh.md)负责只读共享运行时、最小 `/etc`、私有网络 namespace、固定项目环境、宿主准备与在线验收流程。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
