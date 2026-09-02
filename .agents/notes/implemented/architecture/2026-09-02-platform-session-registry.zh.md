# Agent Note: 平台 Session 注册表

Status: implemented

[English](2026-09-02-platform-session-registry.md) | 中文

## Problem

多用户 Server 从 URL 身份派生 Session，而已认证产品还需要租户归属、用户可见标题、会话发现和归档状态。持久层 header 包含派生的 Session ID 和工作目录，但不含授权及列出这些 Session 所需的平台身份与展示元数据。

## Decision

已认证的平台后端负责用户可见的 Session 注册表。后端分配不透明的项目路由键，在每次调用前验证租户和用户归属，从已验证主体派生 Server `userId`，并使用幂等 `PUT /v1/users/<userId>/projects/<projectId>/session` 路由初始化或恢复对应的 Server Session。

`GET /v1/capabilities` 在不创建 Session 的情况下报告 Server API 版本、执行器协议版本、Session 身份模式和支持的集成能力。Server 不把持久层全量 `list()` 暴露为用户路由；该无过滤存储操作缺少平台归属、标题和归档元数据。

对话事件、审批、问题和执行环境选择仍以 Server 为准。平台注册表只保存引用和展示生命周期，不复制事件日志。

## Alternatives considered

**通过 HTTP 暴露持久层 `list()`。** 持久层列表没有过滤能力，header 也无法从哈希路径还原原始路由身份，因此平台不能正确授权或展示结果。

**在平台数据库中保存第二份对话日志。** 双重事件所有权需要跨独立服务进行事务复制，并可能在流式失败或重试后产生分歧。

**允许客户端选择 `userId` 和项目路由键。** Server 有意不提供身份验证层，信任这些值会让客户端寻址其他主体的运行状态。

## Consequences

Server 暂时不可用时仍可发现 Session，而历史和执行操作仍依赖 Server。创建流程是幂等的跨服务操作，不是分布式事务。部署必须把 Server 保持在可信后端网络，并由平台后端终止经过认证的客户端 HTTP、SSE 和执行器 WebSocket 流量。
