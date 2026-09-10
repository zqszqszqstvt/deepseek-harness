# `@deepseek-ai/dsh-server`

[English](README.md) | 中文

dsh 的 Linux-only 多用户 HTTP 组合包。它为 URL 中的每个 `(userId, projectId)` 创建确定性 Session 和工作区，将 Server 自有状态存放在 `--data-dir` 下，并在 `/v1/users/<userId>/projects/<projectId>/...` 下提供幂等 Session 初始化、回合、历史、审批、问题回答、取消、执行环境和复用 SSE 事件路由。`GET /v1/capabilities` 在不创建 Session 的情况下报告 HTTP 与执行器协议版本。旧版 `/v1/users/<userId>/...` 路由访问保留的 `default` 项目。命令的默认端口是 `3080`。

## 部署契约

`dsh server` 只能在 Linux 上运行，因为严格 bubblewrap 限制只在该平台上提供仅工作区可读保证。macOS 和 Windows 会在启动值发布前被拒绝，因此 HTTP 监听器和 Server Session 持久化都无法激活。该限制只属于 Server profile；其他 dsh profile 保留现有平台支持。如果 bubblewrap 不可用或无法正常工作，shell 执行会以 `SANDBOX_UNAVAILABLE` fail closed。

Server profile 还会在独立 bubblewrap 进程中运行模型编写的 `workflow` 和 Ralph JavaScript。VM 逃逸只能在具有私有只读根目录、私有可写 `/tmp`、空环境且无网络的进程内访问 Node。该进程不会挂载 Server 数据根目录、用户工作区、home 目录、宿主命令、`/usr/local`、全局 Conda 环境、凭据或源代码仓库。子 agent RPC 仍留在 Server 上，由宿主校验 schema 和身份，并独立限制总数。普通非 Server profile 继续使用开销更低的 worker-thread 模式。

`dsh server` 不提供身份验证层。它只能监听回环地址或可信后端网络。完成身份验证的平台后端必须从已验证主体派生每个 URL `userId`，绝不能把调用者可控的请求参数直接写入该路径。直接暴露在公网，包括不受限制地使用 `--host 0.0.0.0`，都违反此契约。

平台后端负责用户可见的 Session 发现、标题、租户归属和归档状态，并通过 `PUT /v1/users/<userId>/projects/<projectId>/session` 初始化或恢复已登记的 Session。Server 持久层的 header 不含平台归属或展示元数据，因此有意不提供用户 Session 列表路由。

浏览器 CORS 默认关闭。直接使用 Electron 测试客户端时，可以在可信测试网络中传入 `--cors-origin '*'`，也可以指定一个确切的 HTTP origin；仅由生产后端调用的部署不设置该选项。该开关只允许浏览器传输，不提供身份验证。

默认项目继续映射到 `users/<sha256(userId)>/workspace`；每个具名项目映射到 `users/<sha256(userId)>/projects/<sha256(projectId)>/workspace`。Server 将每个 Agent 沙箱固定在对应项目工作区；交互式授权不能授予工作区外的访问权。文件系统读取与 `glob`/`grep` 搜索会拒绝工作区外目标，包括规范化后的符号链接逃逸。主机异常和 ApiProxy 失败的详情仅记入日志，HTTP 和终止 SSE 客户端只会收到稳定的通用错误，不会暴露主机路径。回合准入会串行化同一项目 Session，同时允许同一用户的其他项目独立使用全局并发池。云端 `shell` 调用的 `workdir` 会按沙箱所绑定的同一份逐调用策略根目录解析，并在任何 spawn 之前完成包含性校验，因此越权的绝对或相对目录会在工具内失败，而不是在 namespace 内部失败；本地 `workdir` 仍由已连接的执行器强制执行其物理边界，因为 Server 无法规范化远端设备上的路径。spill 产物——被截断命令的完整输出与过大的工具结果——写入所属项目工作区内的 `.dsh/spill` 之下，因此 Server 交给模型的每个路径都是该会话自身读取边界可以重新打开的。Server 专用 spill provider 会通过权威项目绑定解析 owner，而不信任调用方给出的路径提示；它拒绝保留目录链中的 symlink 或 junction，并且只在命令结束后把云端命令输出从通用 collector 的私有文件发布进工作区。前台结果会立即返回该路径；发生丢失的后台读取则会在结算后的 `job_output` 中报告它。普通 dsh profile 继续使用自己的私有 spill 行为。

更改 `--data-dir` 时，若冷 Server Session 记录的工作目录严格符合 Server 自有的默认或具名项目布局，则保留该 Session。JSONL 后端会先重写持久化的工作目录并迁移制品，然后再由 ApiProxy 接管。活跃 Session、不相关的同 ID 制品和已占用的目标目录都会失败关闭。

<a id="execution-environments"></a>

agent 运行时属于部署契约。strict 限制只暴露只读运行时目录、最小合成 `/etc` 和本次调用项目的工作区，同时省略 `/run`、`/home`、`/opt`、`/var`、`/srv`、宿主账号及宿主 Git/npm 配置。共享 Python 与 Node 位于 `/usr/local`；逐项目包留在 `.venv` 和 `node_modules`。项目创建时还会建立可写 `.home` 与 `.cache`。云端子进程拒绝继承 Server 环境，shell 只提供固定 PATH、项目 HOME、项目缓存、locale 和受管 `DSH_*` 信息。部署 runner 让每条 shell 进入 pasta 网络 namespace；其 nftables 策略允许公网出口，但阻断宿主 loopback、私有/共享/链路本地网段、云元数据和组播，namespace 或策略创建失败时命令会 fail closed。云端后台任务拥有可配置生命周期，默认 30 分钟。`$DSH_HOME/AGENTS.md`、`$DSH_HOME/skills` 与 `$DSH_AGENTS_HOME/skills` 仍在工作区读取围栏之外；受支持的指令投递点是可信 bundled skill 根与部署 persona。[`deploy/dsh-server`](../../../deploy/dsh-server/README.zh.md) 负责宿主准备、安全前置条件、patch 和验收手册。

## 执行环境

每个项目 Session 都将 Agent、模型历史和编排保留在 Server 中，同时把云端工作区和所有已连接的 Electron 工作区挂载为相互独立的执行环境。任一时刻只有一个 binding 处于活动状态。文件系统、子进程和 shell 调用都携带 Session binding 与环境 epoch；过期调用会失败，本地失败或断线绝不会回退到云端执行。

Electron 执行器主动建立出站 WebSocket，注册设备和项目根目录，并限制所有本地访问只能发生在相应授权根目录内。Agent 通过 `switch_execution_environment` 请求切换 binding，并交由审批服务处理；用户主动发起的 HTTP 切换本身就是明确决定。切换不会复制或同步文件，而且必须先等待活动执行租约结束。

## 模型体验

### 环境快照

#### 模型看到的内容

每个获准进入的模型 step 都会收到一条可重放的 user message 快照，其中列出云端和本地环境、活动 binding、`environmentEpoch`、平台、shell、工作区根目录和连接状态。快照明确说明文件不会同步，Agent 发起的切换必须经过审批。

#### Token 影响

该快照增加一条有界 user message，其大小随已挂载环境数量增长。

#### KV Cache 影响

该快照追加在请求后缀附近，并随 binding、epoch 或设备状态变化。

### 环境工具

#### 模型看到的内容

该组合包提供 `switch_execution_environment` 和环境中立的 `shell` 工具。`shell` 描述要求模型使用活动环境报告的命令方言；云端命令可以使用有生命周期上限的后台任务，本地命令仅支持前台执行。

#### Token 影响

在该组合包中，这两个稳定工具定义取代平台固定的 Bash 和 PowerShell 定义。

#### KV Cache 影响

稳定的 `shell` 和切换定义加入工具前缀，并可在环境状态变化时继续复用。

## 已知限制与暂缓事项

- **身份验证属于平台后端** - Server 不验证凭据、租户或授权策略。
- **必须使用可用 bubblewrap 的 Linux** - macOS Seatbelt 和 Windows ACL 执行无法提供多用户 Server 所需的仅工作区 shell 读取隔离；没有可用 bubblewrap 的 Linux 宿主会拒绝 shell 执行。
- **每个 workflow 都会承担独立进程启动成本** - Server workflow 隔离保护共享文件和权限，但不限制 CPU 或内存配额；需要资源计量时，运维方可以增加部署级 cgroup。
- **一个进程持有一个数据根目录** - 移动活跃 Session 或合并两个已占用的 Server 数据根目录会被拒绝，需要运维人员离线决策。
- **SSE 仅在进程内生效** - 连接上限和有界客户端队列只保护单个进程；多副本部署必须自行提供路由和事件扇出策略。
- **本地执行不支持交互模式** - 执行器支持有界文件系统操作和前台子进程，但尚不支持流式 stdin、PTY、长期后台任务、LSP 和本地 MCP。
