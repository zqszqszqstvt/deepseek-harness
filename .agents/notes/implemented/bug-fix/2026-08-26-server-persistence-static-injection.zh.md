# Agent Note: 通过静态注入挂载服务器持久化

Status: implemented

[English](2026-08-26-server-persistence-static-injection.md) | 中文

## Problem

server bundle 需要从解析后的 `--data-dir` 值派生 JSONL 会话根目录。后置 YAML patch 修改 base 的 `session-persistence-jsonl` 配置项后，其配置表达式依赖配置项级别的 `serverStartup` 注入。源码部署可能保留该表达式却没有形成有效注入，导致插件树在 HTTP server 或模型配置可用之前加载失败。

## Decision

server bundle 禁用 base 的 `session-persistence-jsonl` 配置项，并插入 `@deepseek-ai/dsh-server/session-persistence`。这个函数插件静态注入 `serverStartup`，然后以 `serverStartup.sessionsDir` 挂载共享的 `JsonlSessionPersistence` 提供方。因此，server profile 从与数据根目录相同的已解析启动值派生会话存储，无需计算跨层 YAML 表达式。

该适配插件是包的公开导出，也是 `dsh-session-persistence-jsonl` 的直接消费方。其子提供方归适配插件 fiber 所有，因此卸载 server 适配插件也会卸载持久化提供方。

## Alternatives considered

**继续向 base 配置项 patch `inject` 和 `config`。** 不采用，因为 server 专用依赖仍分散在 base 所有的配置项和后置 patch 之间；只保留配置表达式的组合会在报告 server 就绪状态前失败。

**通过环境变量发布解析后的数据目录。** 不采用，因为进程级可变状态会重复命令行服务，并使同一进程内的重复 profile 启动依赖环境状态。

## Verification

server 包测试证明：提供 `serverStartup` 前持久化保持缺席，激活后使用已配置的会话目录，并在适配插件 fiber dispose（资源释放）时消失。包构建会生成适配插件导出；built CLI 冒烟测试无需模型凭据即可启动 `dsh server`，并从 `/healthz` 和 `/readyz` 收到成功响应。

## Consequences

server 启动不再依赖为 base 所有的持久化配置项增加注入。server bundle 负责一个小型适配插件和一个直接工作区依赖；其他 profile 继续使用未改变的 base 持久化配置。
