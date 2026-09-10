# dsh server 云端运行环境准备

[English](README.md) | 中文

本目录是让 Python 在多用户 [`dsh server`](../../packages/bundle/server/README.zh.md) 部署里既可用又互相隔离的部署套件。它**不需要修改 harness 代码**：镜像提供只读共享工具链，部署层 patch 提供常驻契约，bundled skill 提供按需命令模板。隔离论证只有一句——共享层对所有人只读，唯一可写的地方是本次调用会话自己的工作区，而 strict bubblewrap 每次调用只绑定这一个工作区。两条安装路径产生完全相同的布局：在既有 Linux 宿主（apt、dnf 或 yum）上用 [`install-host.sh`](install-host.sh)，或在容器化部署时用 [`Dockerfile`](Dockerfile)。本套件不要求使用容器。

## 目录契约

agent 需要触达的每个路径都必须位于 strict profile 会绑定的前缀之下：`/usr`、`/bin`、`/sbin`、`/lib`、`/lib64`、`/etc`、`/run`，加上该会话的工作区（[`profiles.ts:19-45`](../../packages/sandbox/sandbox-local/src/profiles.ts)）。

| 绝对路径 | 存放内容 | 沙箱内 | 属主与权限 |
| --- | --- | --- | --- |
| `/usr/local/bin/python3` | 共享解释器：软链到已安装的、带 `venv` 与 `ensurepip` 且版本满足 `uv` 要求的最新解释器 | 只读 | 发行版软件包；真正的保证来自绑定挂载，而不是权限位 |
| `/usr/local/bin/uv`、`/usr/local/bin/uvx` | 共享安装器/解析器 | 只读 | `root:root 0755` |
| `/usr/local/bin/node`、`npm`、`npx`、`pnpm` | 共享 Node.js LTS 及其包管理器 | 只读 | `root:root`，在加锁之前安装 |
| `/etc/pip.conf`、`/etc/uv/uv.toml` | 可选的源配置；缺失即使用公网源 | 只读 | `root:root 0644`，不含凭据 |
| `/usr/local/share/dsh/skills/runtime-env/SKILL.md` | 面向模型的命令模板 | 不需要：宿主侧读取 | `root:root`、`a-w` |
| `/var/lib/dsh`（`DSH_HOME`） | `cordis.patch.yml`、profile、凭据 | 不可见 | `dsh:dsh 0700` |
| `/var/lib/dsh/server-data`（`--data-dir`） | 所有用户的工作区 | 仅本次调用会话自己的子树 | `dsh:dsh 0700` |
| `<workspace>/.venv`、`<workspace>/.cache`、`<workspace>/.pylibs` | 该用户可写的环境 | 可读写 | 服务 uid |
| `<workspace>/.dsh/spill` | harness 写入的截断调用完整输出 | 可读写 | 服务 uid |
| `/opt`、`/srv`、`$HOME`、`/var/tmp` | 绝不要在这里安装 agent 工具 | **不存在** | — |

每用户工作区路径：保留的 default 项目是 `<data-dir>/users/<sha256(userId)>/workspace`，具名项目是 `<data-dir>/users/<sha256(userId)>/projects/<sha256(projectId)>/workspace`。

## 为什么是这些目录

布局由三个机制决定，每个机制都有一种"看起来像 bug、其实是契约"的失败形态。

- **要么可见，要么不存在。** strict profile 从空根开始（`--tmpfs /` 再 `--remount-ro /`），所以放在 `/opt/conda` 或服务用户 home 下的工具链不只是被禁止——它根本不存在，引用它的命令会以 ENOENT 失败。这就是解释器与 `uv` 必须进 `/usr/local`、镜像源必须进 `/etc` 的原因。
- **共享只读，用户可写。** 让共享层敢于暴露的是挂载而不是权限位：strict profile 对 `/usr` 做 ro-bind，所以在会话内每个用户往系统 site-packages 里 `pip install`、往 base 里 `conda install` 都会得到 EROFS，谁都改不了别人 agent 会 import 的东西。宿主侧的加锁属于纵深防御，而且必须收窄，因为对整个 `/usr/local` 做 `chmod -R a-w` 会在那些连 root 都拒绝的厂商目录上中断——`/usr/local/aegis` 下的阿里云云盾就是一例——所以 `install-host.sh` 只锁它自己装的文件，并把 `--lock-all` 与 `--no-lock` 作为显式选项。每个会话的包住在自己工作区的 `.venv` 里，而 strict bubblewrap 每次调用只绑定一个工作区，所以用户 A 既读不到也写不到用户 B 的环境。Node.js 以同样的条件、同样的理由加入共享层：住在 `$HOME`（nvm 的默认位置）或 `/opt` 下的运行时在每个会话里都不可见，所以安装器把 node、npm、npx、pnpm 放进 `/usr/local`。这样 `npm install -g` 的目标就是 `/usr/local`，在会话内得到 EROFS；而每个包管理器的缓存默认值（`~/.npm`、`~/.local/share/pnpm`、`~/.cache/pip`、`~/.cache/uv`）都指向一个并不存在的 `$HOME`，这正是契约要求在同一条命令里把每个缓存重定向进工作区的原因。
- **宿主侧根目录是投递指令的唯一途径。** Server 会话把进程内读取围栏限定在工作区（`fs-sandbox` + `strictReads`），这会静默废掉 CLI 或桌面部署惯用的两个位置：`$DSH_HOME/AGENTS.md` 经 `ctx.fs` 探测后返回 unavailable，被直接跳过且没有任何诊断；`$DSH_HOME/skills` 与 `$DSH_AGENTS_HOME/skills` 被当作不存在，因为 skill provider 把 `FS_SANDBOX_DENIED` 映射成路径缺失。bundled skill 根是例外——它用宿主文件系统调用加载并被标记为可信——这正是 `DSH_BUNDLED_SKILL_DIR` 暴露的东西。常驻文案改走 `system-prompt.persona`，base 组合刻意把这一行留给部署填写。

## 在 Linux 宿主上安装

当 `dsh server` 已经跑在虚拟机或裸机上时走这条路径——它更短，因为 bubblewrap 此时不需要任何额外的容器特权。脚本是幂等的，会自动识别包管理器（Debian/Ubuntu 用 apt，RHEL、Rocky、Alma、Fedora、Amazon Linux 用 dnf 或 yum），安装与镜像相同的目录布局，写出 systemd unit，并在无法提供解释器时以明确错误停下。Node.js LTS 会被取到 `/usr/local` 并在旁边装上 pnpm；`--node-version 24.19.0`、`--no-node`、`--no-pnpm`、`--pnpm-version` 可以改变这一行为。

```bash
sudo ./install-host.sh --data-dir /var/lib/dsh/server-data
sudo systemctl edit dsh-server      # Environment=DEEPSEEK_API_KEY=... (or a drop-in)
sudo systemctl enable --now dsh-server
./verify.sh --bwrap-probe
```

宿主必须开启非特权 user namespace：`user.max_user_namespaces` 不为 0，Ubuntu 24.04 还需要 `kernel.apparmor_restrict_unprivileged_userns=0`。unit 正是因此不添加任何 capability——如果宿主的 bubblewrap 是 setuid 二进制，则改为从 unit 里去掉 `NoNewPrivileges`。在 SELinux 为 `Enforcing` 的宿主上，探针失败通常是策略而不是套件的问题：先用 `setenforce 0` 确认，然后保留一个策略模块而不是把宿主长期停在 permissive。只有当宿主把可写工具放在 `/usr/local` 下时才传 `--no-lock`，并接受“agent 能修改其他 agent 会 import 的东西”这个后果。

当 Server 是手工启动而不是由 systemd 托管时——例如在仓库检出目录里跑 `pnpm dsh server`——跳过服务用户，把契约拷进运行用户自己的 `$DSH_HOME`：

```bash
sudo ./install-host.sh --no-systemd --no-service-user
install -m 0600 cordis.patch.yml "${DSH_HOME:-$HOME/.dsh}/cordis.patch.yml"
export DSH_BUNDLED_SKILL_DIR=/usr/local/share/dsh/skills UV_PYTHON_DOWNLOADS=never
pnpm dsh server --host 127.0.0.1 --port 3080
```

此时数据目录默认为 `<DSH_HOME>/server-data`，所以每个用户的工作区是 `<DSH_HOME>/server-data/users/<sha256(userId)>/workspace`。

## 构建镜像

```bash
cd deploy/dsh-server
docker build -t dsh-server:py312 .
# Offline build: replace the uv COPY stage with a local static binary, and point
# pip.conf / uv.toml at your internal mirror before building.
```

## 运行容器

容器路径是可选的；如果 Server 已经跑在宿主上，直接跳到下面的“在 Linux 宿主上安装”一节。bubblewrap 需要在容器内创建 mount namespace。Ubuntu 24.04 宿主还要设置 `kernel.apparmor_restrict_unprivileged_userns=0`。

```bash
docker run -d --name dsh-server \
  --cap-add SYS_ADMIN --security-opt seccomp=unconfined \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  -v dsh-data:/var/lib/dsh/server-data \
  -p 127.0.0.1:3080:3080 \
  dsh-server:py312
```

命名卷首次使用时会继承镜像目录的属主，因此 `/var/lib/dsh/server-data` 保持由服务 uid 拥有；改为绑定挂载宿主目录时必须先 `chown -R 10001:10001`。`DEEPSEEK_API_KEY` 永远不会出现在 agent shell 里：变量名匹配 `KEY|PASSWORD|SECRET|TOKEN` 的会被从子进程环境中丢弃。对外发布的端口要留在 loopback 或可信后端网络——Server 自身没有认证层。

## 准备部署层 patch

镜像已经把 [`cordis.patch.yml`](cordis.patch.yml) 拷到 `/var/lib/dsh/cordis.patch.yml`，`install-host.sh` 也会连同 systemd unit 一起安装它。手工裸机部署时，把它拷到服务用户的 `$DSH_HOME`：

```bash
install -d -m 0700 /var/lib/dsh
install -m 0600 -o dsh -g dsh cordis.patch.yml /var/lib/dsh/cordis.patch.yml
systemctl edit dsh-server   # or the unit's Environment= lines
#   DSH_HOME=/var/lib/dsh
#   DSH_BUNDLED_SKILL_DIR=/usr/local/share/dsh/skills
#   UV_PYTHON_DOWNLOADS=never
```

patch 行会替换目标行的**整段** config，而 persona 是严格模板：文案里出现字面量 `{{` 会在提示词装配时抛错。

## 配额与保留期

Server 对工作区内容既不设磁盘配额也不做保留期清理。部署层用两件事覆盖：

```bash
# 1. Retention for the two harness-owned artifact trees (.cache, .dsh/spill).
#    Dry run by default; never deletes .venv, .pylibs, or user files.
./workspace-gc.sh --data-dir /var/lib/dsh/server-data --older-than-days 14
./workspace-gc.sh --data-dir /var/lib/dsh/server-data --older-than-days 14 --apply

# 2. Capacity: a filesystem quota on the data volume, because per-user .venv and
#    .cache growth is user work, not garbage. XFS project quotas map cleanly onto
#    users/<sha256(userId)>; ext4 needs a per-user mount or a single volume cap.
xfs_quota -x -c 'limit -p bhard=20g <project-id>' /var/lib/dsh/server-data

# cron: prune nightly, report weekly
0 3 * * * /opt/dsh-deploy/workspace-gc.sh --data-dir /var/lib/dsh/server-data --apply >> /var/log/dsh-gc.log 2>&1
```

## 验收

```bash
./verify.sh                                  # host-side: paths, modes, traps, patch
./verify.sh --bwrap-probe                    # also assert what an agent sees in the namespace
./verify.sh --bwrap-probe /var/lib/dsh/server-data/users/<sha>/workspace
```

然后对一个活跃会话发一轮端到端回合：让 agent 列出自己的 skills、建 `.venv`、后台装一个包、再做三重验证。期望结果由 `verify.sh` 第 7 节打印。命名空间内的断言复刻 [`profiles.ts`](../../packages/sandbox/sandbox-local/src/profiles.ts)；那个文件改了，这个探针也要跟着改。

## 已知空档

- 没有产品级配额、GC 或保留期：两者今天都是部署职责，而 `.venv` 的增长只能靠文件系统配额控制。
- 没有 workspace seeding：新项目工作区是空目录，Server 也不暴露文件系统 HTTP 路由，所以项目级文件只能来自 bundled skill 根、persona，或宿主侧脚本。
- `read-only` 会话仍会把产物写到宿主私有临时目录，因为该模式承诺不写工作区。Server 把会话封顶在 `workspace-write`，所以今天走不到这条路径。
- `/tmp` 仍有三种语义（shell 里是每次调用即焚的 tmpfs、写围栏里是宿主 `/tmp`、读围栏里被拒）。本套件不消除它，而是用 persona 与 skill 告诉模型不要依赖它。
- 本地（Electron）执行环境没有后台任务、输出合计上限约 128KB、传输硬超时 120 秒。skill 的本地分支通过拆分安装步骤在这些限制内工作；本套件不含协议改动。

## 相关文档

- [`@deepseek-ai/dsh-server` README](../../packages/bundle/server/README.zh.md) — 部署契约、HTTP 路由、模型体验
- [多用户 Server 子系统](../../docs/subsystems/server.zh.md) — 信任边界与 Cordis API
- [`sandbox-local` profiles](../../packages/sandbox/sandbox-local/src/profiles.ts) — 权威的挂载清单
