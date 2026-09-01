# Agent Note: 按项目隔离的 Server Session

Status: implemented

[English](2026-08-31-project-scoped-server-sessions.md) | 中文

## Problem

多用户 Server 过去仅从 `userId` 派生一个 Session 和工作区。因此，同一用户的两个项目会共享 Agent 历史、工作目录和用户级回合队列。本地执行需要稳定的项目身份，因为同一逻辑项目在云端和不同设备环境中具有不同工作区路径。

## Decision

Server 从 `(userId, projectId)` 派生确定性 Session。项目路由使用 `/v1/users/<userId>/projects/<projectId>/...`；旧版用户路由访问保留的 `default` 项目，并继续使用原 Session ID 和工作区布局。

具名项目工作区使用 `users/<sha256(userId)>/projects/<sha256(projectId)>/workspace`。Session ID 对以 NUL 分隔的用户和项目组合取摘要，因此两个 URL 值都不会进入文件路径。持久 cwd 迁移只接受属于该 Session 的精确摘要布局。

回合串行化按 Session，而不是按用户建立键。同一项目的两个回合保持顺序，同一用户的不同项目可以在进程全局上限内并发运行。SSE 连接上限仍按用户计算，但每个客户端只订阅一个项目 Session ID。

## Alternatives considered

**每个用户保留一个 Session，并在内部切换目录。** 这种方式会混合不相关的项目历史，并让 cwd 变化重新解释先前文件观察。项目 Session 为每个项目保留稳定历史和云端工作区。

**由前端提供任意 Session ID。** 这种方式会让 Session 归属和恢复依赖不可信客户端状态。确定性派生使 Server 无需另一个身份注册表即可校验每条项目路由。

**直接移除旧用户路由。** 现有 Server 数据会在没有迁移的情况下不可达。保留 `default` 可以继续使用原 Session ID 和存储路径，新项目则使用显式路由。

## Verification

Server 路由测试覆盖稳定项目 ID 和路径、默认项目兼容、同一用户不同项目的独立回合、数据根目录迁移、审批路由和 SSE 隔离。包级 TypeScript 构建包含带品牌的路由身份类型。

## Consequences

管理项目的客户端使用项目路由并持久化稳定 `projectId`。旧客户端继续使用单一默认项目。每用户 SSE 上限汇总该用户的所有项目事件流，回合并发和工作区则按项目隔离。环境绑定可以附加到这个稳定 Session，而无需改变 Agent 身份。
