# Agent Note: 以部署套件的形式交付 Server 的 agent 运行时契约

Status: implemented

[English](2026-09-09-server-agent-runtime-deployment-kit.md) | 中文

## Problem

想让 agent 使用 Python 和 Node 的多用户 Server 部署，需要一种可复现方式来安放共享运行时、逐项目可写依赖、包策略、模型指令、服务状态与宿主检查。如果没有这份产物，每位运维都得重新发现 strict 限制会暴露哪些路径、共享安装为什么必须只读、Server 会话可以从哪里加载指令，以及如何区分宿主故障与普通包安装失败。

在调研"契约该写在哪里"时暴露出一个更尖锐的问题：桌面 profile 用来做这件事的两个位置，在 Server 上是静默失效的。`agent-instructions` 通过 `ctx.get('fs')` 探测 `$DSH_HOME/AGENTS.md`，而 Server 会话把该 provider 围栏限定在工作区，于是探测返回 unavailable、该 scope 被跳过且不产生任何诊断。本地 skill provider 经同一道围栏读取 `$DSH_HOME/skills` 与 `$DSH_AGENTS_HOME/skills`，并把 `FS_SANDBOX_DENIED` 映射进它的"路径缺失"判定，所以放在那里的 skill 会得到零候选且没有错误。因此一位照着桌面工作流操作的运维会交付一份永远不会加载的契约，而且看不到任何解释。

## Decision

把运维契约作为部署套件交付在 [`deploy/dsh-server`](../../../../deploy/dsh-server/README.zh.md) 下。宿主安装器支持 apt 和 dnf/yum，把 Python、uv、Node.js 与包管理器发布到 `/usr/local`，并安装不含凭据的包策略、合成运行时 `/etc` 文件、pasta+nftables+bwrap runner、bundled skill、常驻 Cordis persona、专用服务用户和加固 systemd unit。`verify.sh` 检查宿主文件并执行真实 namespace 链；`ACCEPTANCE.md` 验收在线 Server；`workspace-gc.sh` 只清理 harness 自有缓存与 spill。[云端命令隔离决策](../bug-fix/2026-09-10-server-cloud-command-isolation.zh.md)负责支撑本套件的运行时加固。

两个投递点正是强制执行面所允许的那两个。常驻文案走 `system-prompt.persona`：它作为 order-0 段落渲染进每个用户的每个会话，并且在组合阶段由宿主侧读取，因此工作区围栏根本不适用于它。按需模板走 bundled skill 根：`skill-filesystem` 把 `bundledSkillDir` 标记为可信，并用宿主文件系统调用而非 `ctx.fs` 列举和读取它——这是 Server 会话唯一能看到的宿主 skill 目录，通过 `DSH_BUNDLED_SKILL_DIR` 即可到达，不需要任何配置行。套件明确写出桌面侧的两个陷阱而不是留给后人重新发现，Server README 与 Server 子系统文档现在都承载了它们，因为一个"静默什么也不做"的部署决定属于参考文档，而不只属于运行手册。

strict profile 对 `/usr` 做 ro-bind，因此共享层对每个会话只读，系统或全局包安装会得到 EROFS。可写依赖层、项目 HOME 与缓存位于本次调用项目的工作区，而 strict bubblewrap 每次只绑定一个项目。宿主侧加锁仍是纵深防御，默认只覆盖套件自有文件，因为 `/usr/local` 下的厂商目录（包括阿里云云盾）可能连 root 的递归权限修改也会拒绝。`--lock-all` 与 `--no-lock` 保留更宽选择。服务 home 或 `/opt` 下的运行时仍不会出现在云端命令中，因此套件只在 `/usr/local` 发布一组确定性路径。

## Testing

仓库单元测试固定由 harness 持有的 profile、环境、项目初始化与后台生命周期行为。`deploy/dsh-server/verify.sh` 负责 Linux 宿主验收：检查必需文件、权限、包策略、配置组合与数据属主，然后通过 pasta、nftables 和 bwrap 复现 strict profile。namespace 探针检查共享运行时、项目 HOME、最小 `/etc`、缺失的宿主路径、公网包访问，以及被拒绝的私网、元数据和 loopback 目标。`ACCEPTANCE.md` 通过在线 Server 的模型工具证明相同规则，其中包含一次跨用户 API 尝试。

## Alternatives considered

把契约放进 `$DSH_HOME/AGENTS.md` 加一个工作区 skill，是形状最像桌面做法的显然答案，也正是本 note 要排除的那个：两者在 Server 上都不会加载，而且都是静默失败。

通过 `ctx.shellEnv` 贡献运行时事实（`DSH_PYTHON`、`DSH_VENV`、`DSH_ENV_MODE`）可以彻底去掉探测阶段，如果探测成本哪天变得重要，它仍是正确答案；本次暂缓是因为 persona 与 skill 已经写出了确切的绝对路径，剩下的收益只是每会话一到两次工具调用，而代价是一个新的组合行、配置面、测试与三端文档。

像 minimal CLI preset 那样去改 `tool-shell.ts` 里的 `shell` 工具描述被否决了，因为 Server 的描述是硬编码的：这条改动要付出代码、一次 bundle 发版、以及三个仓库的同步文档，才能交付一段部署本来就能写进自己 persona 行、且无需重新部署 harness 就能修改的文案。

从 `ensureProject` 给每个新工作区做 seeding 会让项目级文件成为一等公民，并且仍然是隐藏 `.dsh/` 的 `.gitignore` 的正确归宿；本次暂缓是因为 bundled skill 根已经能在不引入逐工作区状态的前提下触达每个会话，而 seeding 会带来一个当前没有需求强迫回答的模板版本化与迁移问题。

给沙箱增加 `extraReadonlyBinds` 选项、以便工具链可以住在 `/opt` 下被否决了：strict profile 刻意是"空根 + 固定允许清单"，而一份可配置的绑定清单会把可见面变成逐部署可变的量，隔离论证随后就得追踪它。把工具链放在现有允许清单已经覆盖的位置不花任何代价，并让挂载清单保持为常量。

## Consequences

运维得到一个可直接构建、路径全部写明的目录，于是失败模式从"agent 不停撞上被拒路径"变成"镜像与契约不符"，而后者会在任何会话运行之前由 `verify.sh` 报出来。已经把指令放进 `$DSH_HOME` 的部署现在有了成文的解释和迁移目标。

套件把仓库耦合到一种它自己并不运行的部署形态上：`Dockerfile` 钉住了基础镜像、一个 Node 大版本和一个 `uv` 拷贝阶段，而探针复制了 strict 挂载参数。两者都写在文件里，其中探针是必须与 `profiles.ts` 一起修改的那部分。

容量仍然是部署职责。`workspace-gc.sh` 只清理 `.cache` 与 `.dsh/spill`，绝不动 `.venv` 或用户文件，因此逐用户环境的增长只能靠数据卷上的文件系统配额控制；Server 自身仍然既不设配额也不做保留期清理。`/tmp` 的三义性也依然存在：套件消除了 harness 自己对它的依赖并告诉模型不要用它，但模型自己在两次调用之间用 `/tmp` 传递数据仍然会失败。
