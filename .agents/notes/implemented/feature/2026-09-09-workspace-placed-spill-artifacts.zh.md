# Agent Note: 把 spill 产物放进会话工作区内

Status: implemented

[English](2026-09-09-workspace-placed-spill-artifacts.md) | 中文

## 问题

有两处会把文件系统路径交给模型：子进程输出 collector 会把被截断命令的完整流以 `spillPath` 报告，`ctx.spillStore` 则会持久化过大的工具结果并返回一个 locator，由 spill policy 渲染进结果文本。它们位于操作系统临时目录下的私有位置，适合作为普通 dsh profile 的行为；但 Server Session 无法读取这些位置，因为 `fs-sandbox` 把读取范围限制在该 Session 的项目工作区内，而 shell 的 `/tmp` 是 bubblewrap namespace 内每次调用独立的 tmpfs。

在多用户 Server 中，仅把这些文件直接放到调用方给出的 workspace 路径下并不安全。模型可以写自己的工作区，也就能预先把 `.dsh` 或 `spill` 放成 symlink 或 Windows junction。宿主侧的 `mkdir` 或 `open` 一旦跟随该链接，即使原始路径字符串看似仍在工作区内，也可能写到授权项目之外。`SpillOwner.workspaceRoot` 还是通用 dsh 包共享的落点提示，不是 Server Session 的授权来源。

## 决策

普通 dsh profile 保持其私有 spill 行为。通用 subprocess 与 spill 包可以接受可信 composition 显式指定的 workspace 落点，但 Server 不启用这些模式，也不把其中的路径提示当作权威依据。Server overlay 会禁用通用 `spill-local` provider，并改为挂载 `@deepseek-ai/dsh-server/spill-store`。

Server spill provider 通过 `serverEnvironments.projectForSession()` 解析 `SpillOwner.sessionId`，并且只根据返回的 `ProjectSessionState.cwd` 推导目标位置。它逐级创建 `<workspace>/.dsh/spill/session-<hash>`，拒绝每个保留路径组件上的 symlink、junction 或非目录对象，在打开以仅限所有者权限排他创建的不可预测文件名前检查每级组件的规范路径。没有当前 Server 项目绑定的 owner 会被拒绝；调用方的 `workspaceRoot` 无法改变写入目标。

云端命令收集继续使用通用 collector 的私有落点。前台命令结束后，`tool-server-shell` 会把 collector 报告的每个私有 spill 文件复制到经校验的 Server 目录，并且只暴露发布后的工作区路径。后台适配器会记录私有 spill 源，但在进程运行期间不暴露它们；发生丢失的运行中读取会说明恢复文件将在任务结束后可用。job 结算会等待 collector 关闭与异步发布，下一次 `job_output` 会返回最终增量和发布后的工作区路径。发布失败只会降级对应输出流：Server 记录日志、把完整输出报告为不可用，并保留有界的输出尾部。

工作区是正确的模型可读位置，因为它已经是 Server Session 的文件系统授权边界。共享私有根目录不会被加入 `strictReads`：Server Session id 由 `(userId, projectId)` 确定性推导，其他租户可以计算会话目录名，而不可预测的文件名不能充当跨租户授权机制。

## 测试

`packages/bundle/server/tests/spill-store.spec.ts` 固定了权威项目解析、拒绝工作区 spill symlink 或 junction 且不触碰其外部目标、发布私有 collector 文件，以及拒绝没有 Server 绑定的 owner。`packages/bundle/server/tests/background-spill.spec.ts` 固定了无损读取、结算后双流发布、私有路径隐藏与发布失败收敛。`packages/bundle/server/tests/tool-shell.spec.ts` 通过模型可见工具路径固定前台与后台 cloud 发布行为。`packages/bundle/server/tests/sandbox-policy.spec.ts` 会组合真实的 base 与 Server overlay，并固定通用 spill provider 被禁用、Server provider 已挂载且 cloud collector 保持私有落点。`packages/bundle/server/tests/spill-store-composition.spec.ts` 通过 Loader 启动真实的 `tools`、Server spill 与 spill-policy 插件，并证明过大的工具结果经由 Server provider 发布。既有通用包测试继续独立于 Server 固定其可选落点 API 与私有默认行为。

## 考虑过的替代方案

**在 Server 中启用通用 workspace 落点。** 拒绝：通用 API 接收调用方路径并执行宿主写入，而 Server 工作区可被模型写入。如果没有 Server 自有身份查询和链接检查，预先放置的 symlink 或 junction 可以把写入重定向到项目之外。

**让 strict-reads 围栏允许访问私有 spill 根目录。** 拒绝：围栏将由此允许访问一个跨会话共享的目录树。确定性的 Server Session id 使其会话目录名可以被计算，而文件名的不可预测性并不等于授权。

**停止在 Server 中报告恢复路径。** 拒绝：这会丢弃被截断命令的完整输出和过大结果的完整文本，而不是让既有 `read` 与 `grep` 在既定项目边界内完成恢复。

**新增一个有特权的 spill 读取工具。** 拒绝：这会引入一条需要单独授权的第二读取路径和新的模型可见能力；安全发布后，既有文件系统工具已经足够。

## 后果

Server Session 可以重新打开其收到的每个 spill 路径；目标位置由 Server 自有状态推导，并拒绝稳定存在的预置 symlink 或 junction 逃逸。原生及其他普通 dsh profile 保持独立：它们继续使用私有 spill 存储，不依赖 Server 身份或工作区规则。

Server 需要额外复制一份被截断的云端输出，collector 的私有源文件仍沿用既有外部清理策略。发生丢失的后台读取必须等到进程结算且关闭后的 spill 文件完成发布，才能提供恢复路径。发布后的产物在项目目录中可见，可能出现在隐藏文件搜索或版本控制状态中，并持续存在到外部清理或项目删除。发布失败时，模型只能使用有界的输出尾部。与仓库的文件系统 sandbox 一样，规范路径校验之后再打开文件无法消除具备权限的并发文件系统竞态；该机制阻止稳定的链接重定向，但不声称能够在另一个宿主 actor 于操作期间修改路径时提供无竞态的包含性。
