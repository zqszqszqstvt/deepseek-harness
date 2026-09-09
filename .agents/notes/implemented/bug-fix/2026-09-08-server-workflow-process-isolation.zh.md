# Agent Note: 在进程沙箱中隔离 Server workflow JavaScript

Status: implemented

[English](2026-09-08-server-workflow-process-isolation.md) | 中文

## 问题

Server profile 会向多个用户提供 `tool-workflow` 和 `tool-ralph`。它们由模型编写的 JavaScript 原本在 worker thread 内的 `node:vm` 中运行。`node:vm` 可以塑造脚本 API，但不是安全边界：已知的 constructor 路径可以重新取得 worker 的 Node `process`，而该进程拥有 Server 进程的文件系统、环境、网络和操作系统身份。Shell 的 bubblewrap 没有覆盖这条独立执行路径，因此逃逸的 workflow 可以读取或修改其他用户的工作区、凭据或共享 Conda 安装。

## 决策

[`dsh-workflow-worker-thread`](../../../../packages/workflow/workflow-worker-thread/README.zh.md) 在现有工作流引擎和协议背后支持两种执行 peer。`worker-thread` 仍是非 Server profile 的默认值。Server profile 选择仅 Linux 可用的 `sandboxed-process`，为每次运行在新的 bubblewrap 进程中启动已构建的 `process-worker.cjs` 入口。

沙箱从私有根目录启动，只挂载 Node 可执行文件、加载它所需的系统库目录、单个 process-worker 产物、`/dev` 和新的 `/proc`，随后把组装后的根目录重新挂载为只读，并覆盖一个私有可写 `/tmp`。它创建独立的 PID、网络、IPC、UTS 和会话 namespace，并清空子进程环境。它有意不挂载 Server 数据、用户工作区、home 目录、`/run`、`/etc`、宿主命令目录、`/usr/local`、全局 Conda 安装和源代码仓库。在 process-worker 产物构建完成前，源代码启动会失败关闭。

隔离进程通过以换行分隔的 JSON 与宿主通信。帧和 stderr 输出都有字节上限。每条进程到宿主的消息都会被解析、校验并重新构造为宿主持有的数据。宿主会独立限制 child 总数、拒绝重复使用的 child call ID、只为实际发布且身份匹配的 child 接受生命周期叙述，并用自己的计数替换进程报告的 `agentsStarted`。取消会终止独立进程组，使后代进程无法在运行结束后继续存活。

## 测试

平台无关测试覆盖 bubblewrap 参数、每种进程消息、格式错误的流量、JSONL 分块与上限、重复 call ID、宿主 child 上限、生命周期身份和不可信结果总数。构建产物 smoke 测试会在普通 Node 下启动 `process-worker.cjs`。仅 Linux 运行的端到端测试会先探测真实沙箱，再验证普通 `agent()` 调用，并使用已知 VM 逃逸来确认其他工作区、凭据文件、Conda 环境、宿主 secret、根目录写入、`/usr/local` 和出站网络仍不可用，而私有 `/tmp` 保持可写。现有 worker-thread 套件会固定不变的默认路径。

## 考虑过的替代方案

**在 Server 中禁用 `tool-workflow` 和 `tool-ralph`。** 拒绝，因为这会删除编排、并行子 agent 工作、结构化聚合、进度事件和 Ralph 迭代，而不安全的部分可以独立限制。

**保留 worker thread 并增加更多 `node:vm` 限制。** 拒绝，因为 `node:vm` 明确不承诺恶意代码隔离。API 过滤无法把同一个高权限进程变成安全边界。

**只依赖 Unix 所有权或 Conda 权限。** 拒绝，因为 Server 是一个服务多个应用用户的操作系统进程。所有 workflow thread 都继承该进程身份，文件系统所有权无法区分这些用户。

**以只读方式挂载宿主 `/usr` 树。** 拒绝，因为只读访问仍会泄露并允许执行位于 `/usr/local/miniconda` 等位置的共享环境。沙箱只绑定库子树，而不绑定通用命令或安装根目录。

**在完整容器中运行每个 Server 用户。** 这仍是有效的外层部署边界，但并非本次修复的必要条件，而且运维成本明显更高。每次运行使用独立进程可以保留当前 Server 拓扑和工具约定。

## 后果

Server workflow 保留现有面向模型的 API 和宿主侧子 agent 行为，包括 Ralph。成功的 VM 逃逸现在只能取得受限进程权限，而不是 Server 权限。每次运行都要承担进程和 namespace 启动成本，并要求 Linux、可用的 bubblewrap 和已构建产物；当 Node 依赖所挂载系统库根目录之外的库时，可移植性可能降低。沙箱会隔离共享文件、凭据、环境、网络和进程权限；它有意不提供 CPU 或内存配额，这仍属于部署级 cgroup 的职责。非 Server profile 保留更快的 worker-thread 路径及其已记录的信任要求。
