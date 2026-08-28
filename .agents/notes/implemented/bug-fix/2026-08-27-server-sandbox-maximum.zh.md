# Agent Note: Server 沙箱最高模式

Status: implemented

[English](2026-08-27-server-sandbox-maximum.md) | 中文

## Problem

共享沙箱升级流程会把 `allowed-once` 答复视为使用请求的更宽模式执行一次调用的权限，其中包括 `danger-full-access`。这种行为适合本地交互式 profile，但多用户 Server 承诺每个用户只能停留在分配的工作区内。仅在 Server UI 或工具 schema 中隐藏升级控件无法落实该承诺，因为持久化会话事件和伪造的工具参数仍可到达执行路径。

## Decision

`SandboxPolicyService` 除默认模式外还持有两项部署限制。`maximumMode` 封顶解析后的默认值、持久会话覆盖和显式调用覆盖；`escalationTargets` 是面向模型的工具可以公开并提交一次性审批的有序集合。默认值仍为 `danger-full-access` 与 `['workspace-write', 'danger-full-access']`，因此既有 CLI、Web 和自定义 profile 会保留原有行为，除非其组合明确选择更低上限。

Server overlay 将 `mode` 和 `maximumMode` 设为 `workspace-write`，将 `escalationTargets` 设为空列表，并且只公开 `workspace-write` 权限预设。因此 Bash、PowerShell 和文件系统变更工具会在 Server 会话中省略升级字段与重试提示。强行传入 `sandbox_permissions` 会在审批之前失败，执行器或文件系统提供方也不会收到调用。审批服务和 Server 审批传输继续为非沙箱审批类型保持组合。Server startup 与 persistence 子路径的显式 TypeScript 路径映射让 pnpm 源码启动不依赖预构建的 `lib` 产物。

搜索限制是共享 `tool-fs-search` 插件上的部署选择。其 `strictReads` 配置默认为 `false`，从而保留原生 Web、Headless 与 `danger-full-access` 在工作目录外搜索的能力。只有 Server overlay 启用它，使 `glob` 与 `grep` 拒绝规范路径离开会话工作区的显式目标，并向模型公开该边界。

## Enforcement

策略解析器会封顶每一种输入来源，而不信任权限预设或会话日志。共享升级 helper 会在解析审批服务之前拒绝不在部署列表中的目标，每项负责强制执行的工具都把归属方提供的同一列表传入该 helper。这些检查让 schema 省略只承担模型引导，而执行路径仍是权威。

搜索守卫会通过最深的既有祖先解析会话工作目录和请求目标，再执行包含关系比较，因此 `..`、绝对路径和符号链接目录都无法绕过 Server 搜索隔离。守卫仅在部署启用 `strictReads` 时运行，不从共享沙箱默认值推断。

配置验证会拒绝高于 `maximumMode` 的默认值或升级目标，并拒绝重复目标。Cordis profile 层仍会整体替换条目 config，因此 Server overlay 会在新增字段旁重新声明 `mode` 与 `workspaceRoot`。

## Verification

策略测试固定不变的默认值、非法配置，以及持久和显式 `danger-full-access` 值的封顶行为。共享升级测试证明禁用目标绝不会调用审批方。Bash、PowerShell 和文件系统工具测试证明 schema 省略、没有重试引导、执行前拒绝，以及默认升级行为保持不变。base 与 Server overlay 的组合测试固定最终沙箱策略和权限表；Linux 沙箱端到端覆盖另行证明严格工作区限制会在执行时拒绝在工作区外创建内容。

搜索工具测试证明原生默认调用仍会为工作区外的 `glob` 与 `grep` 目标启动进程，而严格调用会在 spawn 前拒绝这两个工具、允许工作区内目标，并拒绝规范化后的符号链接逃逸。Server 组合测试固定 `strictReads: true`，同时确保不会丢失搜索插件必填的采样选择。

## Alternatives considered

**把用户审批视为逃离 Server 工作区的权限。** 否决，因为 Server 工作区是用户之间的隔离保证，而不是逐调用偏好。普通用户审批不能拓宽部署权限。

**删除 Server 审批服务或自动拒绝所有审批。** 否决，因为审批是其他请求类型也会使用的共享能力。限制应归属于沙箱策略及其消费者。

**只在 schema 或前端隐藏 `sandbox_permissions`。** 否决，因为工具参数、持久事件和其他客户端可以绕过展示层。执行路径必须独立拒绝更宽模式。

**把共享默认值改成 `workspace-write`。** 否决，因为这会默默移除既有非 Server profile 有意提供的权限升级。更低上限是 Server overlay 的明确选择。

## Consequences

Server 启动还会拒绝非 Linux 宿主，因为当平台执行器不提供仅工作区 shell 读取时，沙箱最高模式无法创建这项隔离。[仅限 Linux 的多用户 Server](2026-08-28-server-linux-only.zh.md) 决策负责该平台限制。

Server 用户无法通过 DSH 限制的 shell 或文件系统操作读取、搜索或写入会话工作区之外的其他主机用户内容，即使用户批准请求或会话携带陈旧的更宽模式也不例外。Linux 严格 shell 限制仍会公开启动程序所需的只读系统路径，但不会挂载其他用户目录。用户会直接收到拒绝，而不会看到误导性的升级引导。管理员继续拥有既有插件和 profile 扩展点，非 Server 组合保留原有升级与搜索默认值。明确编辑 Server overlay 或应用更晚管理员 patch 的部署可以选择不同上限；仅靠最终用户审批无法做到这一点。
