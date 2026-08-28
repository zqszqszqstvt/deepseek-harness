# Agent Note: 受限进程工作目录

Status: implemented

[English](2026-08-28-confined-terminal-cwd.md) | 中文

## Problem

模型可以通过 `bash.workdir`、`pwsh.workdir` 或 `terminal_open.cwd` 选择进程工作目录。终端消费方会把每个受限调用方值替换成工作区根目录，导致合法子目录失效；两个一次性 shell 工具虽然会解析相对路径，却会把工作区外的绝对路径传给执行器。文件沙箱仍可能阻止 spawn 后的读写，但公开的工作目录参数没有强制会话工作区范围，而且继承工作区外 cwd 可能破坏基于挂载的隔离假设。

## Decision

沙箱 Service Definition 持有 `resolveConfinedCwd(requested, policy)`。在 `read-only` 或 `workspace-write` 下，它会基于规范化策略根目录解析相对路径，只接受该根目录或其规范化后代，并拒绝工作区外绝对路径、父目录遍历、其他盘符与符号链接逃逸。在 `danger-full-access` 下，它会保留显式 cwd，省略值则默认使用策略根目录。

Bash 与 PowerShell 工具会先解析常驻沙箱策略、完成可能存在的单次审批，再构造最终有效策略。随后，它们会在执行器解析和发布后台任务之前应用共享 cwd 守卫。因此，`maximumMode` 为 `workspace-write` 的 Server 部署即使遇到声称 `danger-full-access` 的陈旧或伪造会话事件，也会拒绝工作区外 workdir；允许审批 `danger-full-access` 的原生部署仍保留工作区外目录能力。无沙箱工具组合保留原有的会话相对路径与外部绝对路径行为。

面向模型的 `tool-terminal` 消费方会原样转发 `cwd`，因为可替换后端可能使用非宿主路径命名空间。本地 `terminal-bash` 后端会在创建进程前立即应用同一个共享守卫，从而保留宿主路径强制执行的后端归属，同时不再复制算法。

## Verification

沙箱测试覆盖工作区根目录、相对与绝对后代、两种受限模式、工作区外绝对路径、父目录遍历、符号链接逃逸，以及不变的 `danger-full-access` 行为。Bash 与 PowerShell 消费方测试证明受限前台和后台拒绝都发生在执行器 `resolve`、`run` 或 `start` 之前；同时固定合法后代与获批 unrestricted 调用。Server 上限回归会让 `danger-full-access` 会话事件经过 `maximumMode: workspace-write` 折叠，并证明执行器从未收到分发。终端提供方测试与真实 Loader 组合则覆盖同一函数经过 PTY 分配并进入运行中 shell 的路径。

## Alternatives considered

**继续把每个受限 cwd 替换为工作区根目录。** 否决，因为这会让已公开参数对合法输入失效，并阻止调用方在其选定的项目子目录中打开交互式进程。

**在 `tool-terminal` 中校验 cwd。** 否决，因为该工具可以选择非本地的可替换后端，而这些后端的目录命名空间并不是宿主文件系统。本地后端同时拥有宿主进程创建和继承目录风险，应由它执行检查。

**依赖进程限制撤销继承的工作区外 cwd。** 否决，因为基于挂载的限制无法可靠移除进程已经继承的目录句柄。后端必须在分配前拒绝该 cwd。

**拦截 shell 文本中的 `cd`。** 否决将其作为安全机制，因为 shell 函数、builtin、嵌套 shell 与直接 `chdir` 调用都能绕过命令文本重写。完全禁止 spawn 后切换目录需要拒绝系统调用，而这会破坏常见工具；或者需要使用以工作区作为虚拟根目录的容器／microVM。当前承诺仅覆盖模型选择的初始与逐调用工作目录参数；spawn 后的文件可见性和文件效果由进程沙箱负责。

## Consequences

每个本地模型可控进程入口现在都使用同一条规范工作目录规则。受限调用可以从任意既有工作区目录启动，非法路径则会在创建进程或后台任务前失败。获批 unrestricted 与无沙箱的原生工作流仍支持外部目录。命令在 spawn 后仍可自行改变 cwd，但这不会扩大当前沙箱后端允许的文件访问。
