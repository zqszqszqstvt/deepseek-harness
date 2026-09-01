# Agent Note: 混合执行路由

Status: implemented

[English](2026-08-31-hybrid-execution-routing.md) | 中文

## 问题

同一个 Server Session 必须能够使用云端工作区和用户的 Electron 工作区，同时 Agent、历史和编排仍留在 Server。两个环境可能使用不同的操作系统、shell 方言、路径和文件。若对模型隐藏这些差异，一个本身有效的命令或文件操作可能会在错误环境中执行。

## 决策

每个项目 Session 同时挂载云端和本地工作区 binding，但只选择一个活动 binding 和环境 epoch。每个获准进入的模型 step 都会将完整环境快照记录为 plugin user message。Agent 发起的变更通过 `switch_execution_environment` 和审批管线处理；直接 HTTP 变更代表用户明确操作。文件绝不会隐式同步。

云端文件系统、子进程和 shell provider 运行在同一个隔离 Cordis group 中。bridge 捕获这些 provider，根服务则根据发起调用的 Agent Session 路由现有 capability consumer。本地请求通过 Executor Broker 携带用户、项目、Session、设备、binding 和 epoch 标识。流式输出和最终结果会重复 binding 与 epoch，Broker 会拒绝标识不匹配的响应帧。执行租约会阻止环境切换，直至每个前台操作或云端后台进程完全停止。在旧 epoch 下创建的 target 和 shell spec 会失败，不会在新环境中重新解释。

Server 将 `userId` 作为路由键，不对客户端进行身份验证。直接使用 Electron 测试时，通过显式 CORS origin 启用浏览器传输；仅由后端调用的部署保持 CORS 关闭，并由后端根据已验证主体派生 `userId`。

Server 只向模型提供一个 `shell` 工具，其方言由活动环境快照决定。该组合包禁用依据 Server 主机平台选择的 `bash` 和 `pwsh` consumer，同时在 Router 后保留其云端 provider 行为，避免本地平台不同时暴露误导性的工具名称。

远端错误、断线、过期 epoch、不支持的流式 stdin 和 PTY 分配都会在所选环境中直接失败。这些失败均不得调用云端 provider 作为回退。

## 考虑过的替代方案

**在创建 Session 时固定环境。** 这会阻止同一段对话在保留计划和历史的同时主动往返于云端与本地环境。

**只路由子进程调用。** 云端 Bash provider 仍会为 Windows 本地执行器构造 `bash -c`，文件系统 target 也会保留云端标识。统一路由文件系统、子进程和 shell provider 才能维持一个完整执行环境。

**本地请求失败时回退云端。** 这可能在 Agent 和用户都没有察觉时把命令应用到另一套文件。明确失败能保留环境归属，并让用户决定是否切换。

**同时暴露 Bash 和 PowerShell 工具。** 其中一个 schema 会与活动环境不符，并诱发方言错误。环境中立工具配合环境快照只向模型提供一个当前执行约定。

## 验证

Server 测试覆盖项目 binding 冲突、切换排他租约、Agent 切换审批、完整环境快照、完整本地 Broker 标识、响应 epoch 不匹配、远端错误不回退、Windows 本地工作目录解析、本地后台拒绝、显式 CORS 预检和隔离 provider 组合拓扑。Server package TypeScript 构建覆盖所有 Router 和工具入口。

## 后果

云端执行保留现有 provider 和后台任务。本地执行支持有界文件系统操作与前台子进程；流式 stdin、PTY、长期后台任务、LSP 和本地 MCP 需要后续扩展协议。环境快照会增加变化的请求后缀，稳定工具 schema 则保留可复用前缀。已选中的本地 binding 断线后仍保持选中和离线状态，直到用户选择其他环境。
