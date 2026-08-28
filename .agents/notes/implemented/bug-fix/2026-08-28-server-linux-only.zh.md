# Agent Note: Linux-only 多用户 Server

Status: implemented

[English](2026-08-28-server-linux-only.md) | 中文

## Problem

多用户 Server 为每个租户分配工作区，并保证 shell 和文件系统操作无法读取其他租户的文件。严格文件系统工具读取和沙箱权限上限会约束 DSH 工具路径，但 Bash 或 PowerShell 可以绕过这些文件系统工具检查，直接通过宿主内核读取。Linux bubblewrap 限制会从 shell 的挂载视图中移除其他用户目录。macOS Seatbelt 和 Windows ACL runner 主要约束写入，无法提供同等的仅工作区可读保证。

## Decision

`dsh server` 只支持 Linux。启动命令会在发布 `serverStartup` 前拒绝其他所有 Node 平台；HTTP 监听器、Server Session 持久化和 Server runtime 都会注入该值，因此拒绝后无法激活。由于 Commander 处理 `--help` 时不执行启动 action，命令帮助仍可在所有平台查看。

该限制属于 Server 启动提供方。共享沙箱包、Bash、PowerShell、Web、Headless 和自定义 profile 保留现有平台行为。Server 沙箱最高模式仍是防止通过审批扩大权限的独立防线，详见 [Server 沙箱最高模式](2026-08-27-server-sandbox-maximum.zh.md)。

## Verification

启动测试会确定性选择 Linux、Windows 和 macOS。Linux 会发布启动值。Windows 和 macOS 会请求退出码 1，在诊断中包含工作区读取原因，并保持 `serverStartup` 缺席。现有帮助测试会在不受支持的测试平台上运行，并证明帮助退出时不会发布启动值。

## Alternatives considered

**依赖严格文件系统工具读取。** 否决，因为 shell 命令不使用文件系统工具服务，而是可以直接打开宿主路径。

**将 Seatbelt 和 Windows ACL 写入限制视为足够的隔离。** 否决，因为 Server 保证租户读取隔离，而不只是防止写入。

**在 macOS 和 Windows 上禁用 shell 工具。** 否决，因为 Server 继承了围绕 shell 执行构建的工流和 agent 行为。平台专用的精简 Server 将形成另一项产品约定，需要独立设计和验证。

**改变共享的非 Server 平台行为。** 否决，因为本地 Web、Headless 和自定义 profile 不提供 Server 的多租户隔离保证。

## Consequences

Server 运维人员必须在可用严格 shell 沙箱的 Linux 上部署。macOS 和 Windows 用户会直接收到启动失败，而不是获得一个租户读取隔离不完整的可访问 Server。帮助保持跨平台可用，非 Server profile 不会失去任何平台功能。
