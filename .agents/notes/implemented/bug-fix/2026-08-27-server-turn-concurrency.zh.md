# Agent Note: Server 回合并发

Status: implemented

[English](2026-08-27-server-turn-concurrency.md) | 中文

## Problem

多用户 Server 把 `maxConcurrentTurns` 称为执行中回合的上限，但 `ApiProxy.sessions.prompt()` 会在消息进入 Agent inbox（收件箱）时完成。此时释放全局许可只限制短暂的入队调用。同一用户重复提交 queue 请求可以在不等待先前工作的情况下填满持久 inbox，而 `/readyz.running` 会在 Agent 仍执行时下降。

## Decision

Server 通过公开的 `Agent.whenIdle()` 观察点拥有整个 Agent 活动区间。queue 模式请求先等待该用户的前一个请求，只在能够提交时获取全局许可，放入一个 prompt，并持有许可和 HTTP 响应直到 Agent 进入 idle。等待同一用户前序活动的请求不占用全局许可，也不会进入 Agent inbox。

在该用户 Agent 正运行时提交的 steer 模式请求仍会立即进入当前活动。它不会获取另一份许可或等待 idle，因为它不是第二个执行中回合。在 idle 时提交的 steering 会遵循排队路径，因为它会启动 Agent 活动。Server 静态依赖共享 `agents` 服务；非 Server bundle 和只负责入队的 ApiProxy 协议保持不变。

`whenIdle()` 观察完整的 Agent 活动，而不会把结果归因给某个 prompt。其他 steering、注入上下文、恢复流程或外部提交的工作都可能延长该区间。Server 只返回既有的 prompt 接纳结果，不声称哪个输出属于发起消息。

## Verification

Server HTTP 测试确保同一用户的第二个 queue prompt 在 idle 前不会进入 Agent inbox，确保第二个用户的 prompt 会在全局上限为一时等待，并确保 steering 会立即进入运行中的活动。测试也会等待每个响应和活动边界，避免 teardown 掩盖泄漏的工作。

## Alternatives considered

**把选项改名为入队调用上限。** 否决，因为这会让配置限制在运行层面失效，并允许通过 Server 路由无限扩张 Agent inbox。

**等待同一用户的所有请求，包括 steering。** 否决，因为 steering 的定义是影响当前运行活动；把它推迟到 idle 会将其变成后续回合。

**增加逐 prompt 完成结果。** 否决，因为一个 prompt 并不拥有因果结果边界。共享 Agent API 有意只公开完整 Agent 的 idle 状态。

## Consequences

`maxConcurrentTurns` 和 `/readyz.running` 描述 Server 所拥有的活跃 Agent 区间。queue 模式 HTTP 请求可能在等待同一用户前序活动、全局许可和最终 idle 时保持打开，因此平台超时必须长于最长的已接纳回合。Server 会阻止排队请求提前进入 Agent inbox，但部署级请求速率和连接限制仍负责控制等待中的 HTTP 请求数量。
