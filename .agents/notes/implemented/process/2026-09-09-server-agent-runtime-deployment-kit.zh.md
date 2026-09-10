# Agent Note: 以部署套件的形式交付 Server 的 agent 运行时契约

Status: implemented

[English](2026-09-09-server-agent-runtime-deployment-kit.md) | 中文

## Problem

一个想让 agent 使用 Python 的多用户 Server 部署此前无路可走。被强制执行的事实散落在各个源文件里，从未以契约的形式被写下来：strict 限制只绑定 `/usr`、`/bin`、`/sbin`、`/lib`、`/lib64`、`/etc`、`/run` 与本次调用会话的工作区，所以共享工具链只有放在 `/usr/local` 下才可达，而放在 `/opt`、`/srv` 或服务用户 home 下的工具链在 namespace 里根本不存在；缓存不能指向 `$HOME`，因为 `$HOME` 不存在；前台调用封顶 60 秒；`stdin` 是关闭的，因此交互式安装程序会立刻读到 EOF；`/tmp` 是每次调用即焚的 tmpfs，任何经它传递的东西都活不到下一次调用。这些每一条都会让 agent 白费一次探测或失败一次安装，而模型除了反复撞上 `[sandbox: file access denied under workspace-write mode]` 之外没有别的学习途径。

在调研"契约该写在哪里"时暴露出一个更尖锐的问题：桌面 profile 用来做这件事的两个位置，在 Server 上是静默失效的。`agent-instructions` 通过 `ctx.get('fs')` 探测 `$DSH_HOME/AGENTS.md`，而 Server 会话把该 provider 围栏限定在工作区，于是探测返回 unavailable、该 scope 被跳过且不产生任何诊断。本地 skill provider 经同一道围栏读取 `$DSH_HOME/skills` 与 `$DSH_AGENTS_HOME/skills`，并把 `FS_SANDBOX_DENIED` 映射进它的"路径缺失"判定，所以放在那里的 skill 会得到零候选且没有错误。因此一位照着桌面工作流操作的运维会交付一份永远不会加载的契约，而且看不到任何解释。

## Decision

把契约作为部署套件交付在 [`deploy/dsh-server`](../../../../deploy/dsh-server/README.zh.md) 下，不改动任何 harness 代码。这个套件就是运维据以构建的产物：`Dockerfile` 与面向 apt 和 dnf/yum 宿主的 `install-host.sh` 把发行版解释器以 `python3` 的名义提供（当该名字缺失或版本对 uv 而言过旧时，发布为 `/usr/local/bin/python3`）、把 `uv` 装到 `/usr/local/bin/uv`、把包镜像源写到 `/etc/pip.conf` 与 `/etc/uv/uv.toml`、把 skill 拷到 `/usr/local/share/dsh/skills`、用 `chmod -R a-w /usr/local` 锁住共享层，并以 `DSH_HOME=/var/lib/dsh`、`--data-dir /var/lib/dsh/server-data` 创建服务用户；`cordis.patch.yml` 填写 base 组合刻意留空的 `system-prompt` persona 行；`skills/python-env/SKILL.md` 提供云端与本地执行器两套命令模板；`verify.sh` 负责宿主侧与命名空间内的验收；`workspace-gc.sh` 负责两类 harness 自有产物树。

两个投递点正是强制执行面所允许的那两个。常驻文案走 `system-prompt.persona`：它作为 order-0 段落渲染进每个用户的每个会话，并且在组合阶段由宿主侧读取，因此工作区围栏根本不适用于它。按需模板走 bundled skill 根：`skill-filesystem` 把 `bundledSkillDir` 标记为可信，并用宿主文件系统调用而非 `ctx.fs` 列举和读取它——这是 Server 会话唯一能看到的宿主 skill 目录，通过 `DSH_BUNDLED_SKILL_DIR` 即可到达，不需要任何配置行。套件明确写出桌面侧的两个陷阱而不是留给后人重新发现，Server README 与 Server 子系统文档现在都承载了它们，因为一个"静默什么也不做"的部署决定属于参考文档，而不只属于运行手册。

隔离被表达为一个挂载事实，而不是一套新机制：strict profile 对 `/usr` 做 ro-bind，因此共享层对每个会话只读，往系统 site-packages 里 `pip install`、往 base 里 `conda install` 会按设计得到 EROFS，谁都改不了别人 agent 会 import 的东西；而可写层是本次调用会话自己工作区里的 `.venv`，strict bubblewrap 每次只绑定一个会话。宿主侧加锁只是纵深防御，套件把它收窄到安装器自己写的那些文件，因为对整个 `/usr/local` 做 `chmod -R a-w` 并不可移植：厂商目录连 root 都拒绝，而由内核模块保护的 `/usr/local/aegis`（阿里云云盾）在一台真实的 Alibaba Cloud Linux 宿主上正好让这一步中断，直到安装器改为只锁自己的路径，并把 `--lock-all` 与 `--no-lock` 作为显式选项。这也正是"暴露共享工具链"与 workflow 隔离立场相容的原因：那篇 note 拒绝的是把共享 Conda 环境**未声明地**只读暴露给运行在会话边界之外的模型代码，而本套件声明了这次暴露、把它锁成只读，并让每个可写产物都留在产生它的会话之内。

## Testing

仓库里没有任何测试覆盖这个套件，这是刻意的：它断言的是宿主镜像的事实，而 harness 无法测试它并不运行的部署。`deploy/dsh-server/verify.sh` 就是它的验收工具——静态检查解释器、`venv` 与 `ensurepip` 可用性、`uv`、两个镜像源文件、其中不含凭据、`/usr/local` 的只读锁、skill frontmatter、persona 行及其不含花括号、被导出的宿主缓存路径、以及数据目录属主；外加 `--bwrap-probe`，它复刻 strict profile 参数并在真实命名空间内断言：共享工具可见、`/etc` 镜像源可读、工作区可写、`/usr/local` 与 `/etc` 拒绝写入、`$HOME`、`/opt`、`/srv`、`/var/lib` 不存在、网络可达。这个探针**故意**是 [`profiles.ts`](../../../../packages/sandbox/sandbox-local/src/profiles.ts) 的一份拷贝，且两个文件都写明了这一点，因为一个与挂载清单漂移的探针会去认证一个错误的环境。文档侧由常规门禁覆盖：套件 README 对与被编辑的两对文档走翻译配对，新增相对链接走 `verify-md-links`，被编辑的包与子系统散文走 `verify-md-wrap`。

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
