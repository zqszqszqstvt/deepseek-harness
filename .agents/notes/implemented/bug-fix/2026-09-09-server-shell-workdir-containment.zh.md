# Agent Note: 在 spawn 之前限制 Server shell 工具的云端工作目录

Status: implemented

[English](2026-09-09-server-shell-workdir-containment.md) | 中文

## 问题

Server 的环境中立 `shell` 工具自行解析模型给出的 `workdir`，并把结果直接交给路由后的执行器。云端分支会原样返回绝对路径，并把相对路径按会话 cwd 解析，全程没有包含性校验；本地分支同样原样返回绝对路径。平台的 bash 工具会用 `resolveConfinedCwd` 按解析出的逐调用策略限制同一个参数，而施加沙箱的 bash 执行器并不收窄 `spec.workdir`——它只包装 argv——因此在工具与 spawn 之间，没有任何一方为 Server Session 承担这项检查。

挂载 namespace 只是掩盖了后果，并没有消除它：Server 的 `strictFilesystem` bubblewrap profile 只绑定运行时路径与调用会话自身的工作区，因此外部目录要么在 namespace 中不存在（spawn 失败，并呈现为令人困惑的 `SANDBOX_UNAVAILABLE` 形态错误），要么只以系统目录的形式只读存在。这不符合本项目的包含性契约——该契约要求工作区外的请求在 spawn、读取、写入或搜索之前就失败。它在任何其他强制执行方式下还会失效放行：关闭 `strictFilesystem`、换用其他 runner，或未来某个绑定更多宿主内容的部署，同一次调用就会把工作目录落在会话工作区之外执行命令。

## 决策

`packages/bundle/server/src/tool-shell.ts` 现在先解析逐调用沙箱策略，再解析工作目录，并像 `dsh-tool-bash` 一样用共享的 `resolveConfinedCwd` 辅助函数限制云端分支。云端相对 `workdir` 的基准现在是已解析的策略根目录——与沙箱所绑定的同一份规范身份——并回退到会话 header 的 cwd、再回退到项目状态的 cwd；最终值会经过规范化与包含性校验，因此越权的绝对路径、`..` 遍历与符号链接逃逸都会在工具内以该辅助函数的 `outside the session workspace` 错误失败，绝不会到达 `ctx.shell.resolve()` 或 `run()`。当组合中不存在 `ctx.sandboxPolicy` 时，解析结果原样透传，这让工具对什么都不强制执行的部署保持诚实。

本地分支在 Server 中有意不做限制。它的 `workdir` 指向远端设备上的目录，而本进程无法规范化该设备的文件系统：按所报告的根目录做词法比较，会拒绝那些仅大小写不同、或经由重解析点才能到达该根目录的合法 Windows 路径，那是设备本身不会做出的错误拒绝。已连接的执行器拥有该边界，并且已经在 spawn 之前把每个目录按已授权的项目根目录解析，因此 Server 继续把相对路径映射到所报告的根目录，并把绝对路径转交给设备去接受或拒绝。

无 agent 的云端调用现在会按部署的回退根目录做限制，而不是按项目工作区。这是一致而非更宽松的结果：同一份已解析策略决定沙箱绑定什么，因此策略根目录为回退值的调用本来就会被限制在其中，只是现在它会在 spawn 之前以明确原因失败，而不是在 namespace 内部失败。

## 测试

`packages/bundle/server/tests/tool-shell.spec.ts` 在一个规范的临时工作区上，用打桩的路由器、shell 与策略服务启动真实工具。它固定了：相对与工作区内绝对的 `workdir` 会按策略根目录解析后到达 `ctx.shell.resolve()`；省略 `workdir` 时默认使用该根目录；`../outside`、`/etc`、`nested/../../outside` 以及一个真实存在的工作区外目录都会返回错误，且 `resolve()` 与 `run()` 都不会被调用；没有策略时该值保持未解析；以及在存在策略时，本地 Windows 选择仍会原样转发绝对 `workdir`。

## 考虑过的替代方案

**在 `dsh-bash-sandbox` 内部做限制。** 拒绝：执行器收到的是已解析的绝对 `spec.workdir`，无法区分调用方的明确选择与默认值，而平台 bash 工具已经在工具层承担这项检查。放进执行器要么对 `dsh-tool-bash` 形成双重强制，要么把一个 Consumer 的决定搬进 seam 文档明确定义为「携带策略、而非决定策略」的 Provider。

**按所报告的根目录对本地分支做词法限制。** 拒绝：Server 无法规范化远端设备的路径，而 Windows 的大小写与重解析点别名会让词法比较拒绝合法目录。设备侧的物理边界检查才是权威检查，并留在那里。

**把 namespace 当作强制执行手段并写进文档。** 拒绝：这会让保证依赖于某一个 runner 的挂载清单，与仓库对每个接受路径的能力所声明的包含性契约相矛盾，并把一次被拒绝的请求变成基础设施形态的失败，让模型读成沙箱故障。

## 后果

工作目录越出会话工作区的 Server `shell` 调用，现在会在 spawn 之前以共享辅助函数的消息失败，且在所有 runner 与 profile 配置下都如此；云端工作目录与限制边界成为同一份规范身份，而不是两个各自独立推导的字符串。该工具现在以值而非仅类型的方式引入 `@deepseek-ai/dsh-sandbox`，而这个组合包本来就已依赖它。本地执行保持既有行为与既有强制执行方；Server 不重复一项自己无法正确评估的设备侧检查，而这处不对称已记录在两个分支分开的工具源码处。
