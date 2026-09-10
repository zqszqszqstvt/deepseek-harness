# Agent Note: 隔离 Server 云端命令的网络与环境

Status: implemented

[English](2026-09-10-server-cloud-command-isolation.md) | 中文

## Problem

Server 会把云端命令的文件访问限制在单一项目工作区，但命令与 Server 进程共享宿主网络 namespace。Server 在宿主 loopback 上监听且自身不做认证，因此模型代码可以直接调用 `/v1/users/<other-user>/...`，绕过文件系统边界。命令还会继承经过清除的父进程环境，其中仍可能包含非凭据形态的宿主路径、代理设置和 loader 变量；strict 文件系统模式则暴露宿主完整 `/etc` 与 `/run`。凭据名称清除只能降低意外泄漏，无法定义一份封闭的云端环境，也无法保护未知命名的敏感变量。

云端后台任务在发起它的工具调用返回后也没有生命周期上限。被遗忘的安装、watcher 或子进程可能一直受管，直到显式取消或 Server 关闭。

## Decision

Server 云端沙箱在 bubblewrap 之前使用运维提供的 `pasta` runner。Pasta 创建非特权 user 与 network namespace，不映射宿主网关，并提供合成 DNS 转发地址。namespace loopback 仍可供同一命令内的测试使用，但与宿主 loopback 不同。可信包装器先安装 nftables output 规则，再进入 bubblewrap。规则允许 DNS 与公网目标，拒绝 RFC1918、共享、链路本地、云元数据、组播与保留网关网段。strict bubblewrap profile 会在启动模型命令前显式丢弃全部 capability，阻止其修改这些规则。缺少 pasta、nftables、包装器、DNS 文件或规则安装失败时，命令都会通过配置的 runner 失败签名 fail closed。

strict bwrap 模式通过固定 allow-list 构造 `/etc`，不再绑定宿主目录。部署自有 `hosts`、`nsswitch.conf` 和 `resolv.conf` 取代宿主版本；宿主账号库、全局 Git/npm 配置与 `/run` 均不存在。PID、IPC、UTS 与 cgroup namespace 彼此隔离。`/usr` 继续承载只读共享运行时，只有活动项目工作区可写。

`LocalSubprocessRuntime` 允许配置是否继承环境。普通 profile 的默认值仍是既有的已清除父进程环境。Server 云端实例设置 `inheritParentEnv: false` 和固定可执行文件 PATH。每条云端 shell 得到一份完整的项目级环境：`.home`、`.cache`、XDG 目录、Python/uv/npm/pnpm 缓存、locale、`TMPDIR` 与 `PYTHONNOUSERSITE`。项目初始化会创建 `.home` 和 `.cache`；显式受管 `DSH_*` 信息仍在该环境之后合并。shell 工具通过 `backgroundTimeoutMs` 限制后台任务，默认 30 分钟；超时后终止进程树。

[部署套件决策](../process/2026-09-09-server-agent-runtime-deployment-kit.zh.md)继续负责共享运行时位置与运维交付。本 note 负责让该部署抵御宿主网络 API 访问与环境状态泄漏所必需的运行时改动。

## Alternatives considered

**依赖上游身份强制。** 平台后端仍负责认证，但沙箱内代码会绕过该后端，直接访问 loopback listener。即使每个外部请求都正确完成认证，这条路径仍不安全。

**使用 bubblewrap `--unshare-net` 且不提供适配器。** 这会阻断 Server API，也会阻断 Python 与 Node 包下载。所需运行时必须保留受控公网出口，因此需要用户态网络适配器与目标地址策略。

**仅代理包仓库 allow-list。** 这能提供更窄的出口策略，但会新增认证代理、仓库清单、证书分发和可用性依赖。当前折中方案是只允许公网目标；包策略成为独立需求后，可以替换为仓库代理。

**保留父进程环境清除启发式规则。** deny-list 无法覆盖任意 secret 名称、内部代理配置、语言 loader hook 或未来服务变量。空基底加显式部署条目会产生封闭且可审核的结果。

**绑定包括 `hosts`、`gitconfig` 和 `npmrc` 在内的宿主 `/etc` 文件。** 宿主管理文件可能包含内部名称、helper 命令或凭据。部署自有网络文件与不含凭据的包配置能够提供所需运行时行为，而无需引入这些状态。

## Consequences

云端命令保留公网包访问能力，但无法通过 loopback 或 pasta 网关访问 Server listener；DNS rebinding 得到私网或元数据地址时，也会在连接阶段被拒绝。每条命令除了 bubblewrap 外，还要承担 pasta namespace 与 nftables 初始化成本。宿主必须提供可用的非特权 user namespace、pasta 和 nftables；AppArmor 或 SELinux 可能需要显式部署策略。

云端命令不会因服务管理器而获得不同环境，因为代理变量与其他环境状态只有显式提供时才会存活。项目 HOME 与缓存会和依赖一起占用项目存储。后台截止时间可以限制遗忘任务，但也可能终止合法构建；部署可在 1 分钟至 24 小时之间配置。

单元测试固定 strict profile 参数、环境替换、项目目录创建、命令环境注入与后台终止行为。部署探针在 Linux 上运行真实 pasta+nftables+bwrap 链，在线验收手册证明 shell 无法调用其他用户的 Server API。Windows 开发主机无法执行该内核级探针。
