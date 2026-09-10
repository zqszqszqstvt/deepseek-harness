# dsh server 云端运行环境准备

[English](README.md) | 中文

本目录用于在多用户 `dsh server` 主机上准备一套只读共享 Python/Node 运行时，并为每个项目工作区提供独立可写依赖层。生产环境推荐使用独立 Linux 云主机加 systemd。部署会让每条模型 shell 命令进入独立网络 namespace，只暴露最小 `/etc`，用固定命令环境取代 Server 进程继承环境，并在 30 分钟后终止云端后台任务。本次有意暂缓上游身份强制、CPU/内存/进程/磁盘限制，以及相同项目依赖的物理去重。

## 最终目录布局

| 路径 | 用途 | 云端 shell 内可见性 |
| --- | --- | --- |
| `/usr/local/bin/python3`、`uv`、`uvx` | 共享 Python 运行时 | 只读 |
| `/usr/local/bin/node`、`npm`、`npx`、`pnpm` | 共享 Node.js 运行时 | 只读 |
| `/etc/pip.conf`、`/etc/uv/uv.toml` | 不含凭据的包源策略 | 只读 |
| `/usr/local/share/dsh/runtime-etc` | 合成的 hosts、NSS 与 pasta DNS 文件 | 挂入最小 `/etc` |
| `/usr/local/libexec/dsh-netns-bwrap` | 先装载 nftables 策略，再启动 bwrap | 宿主侧启动器 |
| `/usr/local/share/dsh/skills/runtime-env` | 运行时命令模板 | 作为可信 bundled skill 读取 |
| `/var/lib/dsh` | Server 配置与凭据 | 不存在 |
| `/var/lib/dsh/server-data` | 所有哈希化项目目录 | 只挂载当前项目工作区 |
| `<workspace>/.home` | 项目级 `HOME` | 可写 |
| `<workspace>/.cache` | uv、pip、npm、pnpm 缓存 | 可写 |
| `<workspace>/.venv`、`node_modules` | 项目依赖 | 可写 |
| `/tmp` | 单次调用临时数据 | 可写，调用结束即销毁 |

strict 根目录只包含 `/usr`、`/bin`、`/sbin`、`/lib`、`/lib64`、合成 `/etc`、`/dev`、`/proc`、`/tmp` 和当前工作区。`/run`、`/home`、`/opt`、`/var`、`/srv`、宿主账号文件以及宿主全局 Git/npm 配置均不存在。子进程 provider 不继承 Server 环境；云端 shell 只得到固定的 `PATH=/usr/local/bin:/usr/bin:/bin`、项目 HOME、项目缓存变量、locale、`TMPDIR` 和受管理的 `DSH_*` 信息。

每条 shell 命令都运行在新的 pasta 网络 namespace 中，因此其中的 loopback 并非宿主 loopback，仍可供同一命令内的测试使用。nftables 允许合成 DNS 地址和公网目标，拒绝 RFC1918、共享、链路本地、云元数据、组播及保留网关网段；`--no-map-gw` 同时禁止 pasta 通过 namespace 网关映射宿主，strict bwrap profile 还会在启动模型命令前丢弃全部 capability，使其无法删除这些规则。这会关闭用户 shell 访问 Server 无认证回环 API 的路径，同时保留公网包下载能力。

## 云主机前置要求

使用独立 VM，不要与交互式业务共用宿主。支持 apt、dnf 和 yum；建议使用带 systemd 的当前 x86-64 或 arm64 发行版，目标系列为 Ubuntu 22.04/24.04、Debian 12、RHEL/Rocky/Alma 9、Fedora 和当前 Amazon Linux。主机需要：

- root 或 sudo 安装权限；
- 已按你的发布流程安装、可正常执行的 `dsh`；
- 安装期间允许出站 HTTPS 访问模型端点、`nodejs.org`、`astral.sh` 和配置的 Python/npm 仓库；
- 沙箱安装依赖时可使用 DNS 和普通公网出口；
- `/var/lib/dsh/server-data` 使用持久化文件系统；
- 3080 不对公网监听：Server 保持在 `127.0.0.1`，只允许可信后端调用。

安装前记录环境：

```bash
uname -a
cat /etc/os-release
command -v dsh && dsh --version
df -h /var/lib/dsh 2>/dev/null || df -h /
systemctl --version | head -1
```

如果没有安装 `dsh`，先安装你要运行的固定版本。宿主安装器只准备运行时，不替你选择或升级 Server 版本。安装 `dsh` 后应再次运行安装器，让生成的 unit 记录真实可执行文件路径。

## 启用非特权 namespace

pasta 与 bubblewrap 都依赖非特权 user namespace。先检查：

```bash
sysctl user.max_user_namespaces
unshare --user --map-root-user true
```

若独立 VM 上该值为零，持久化一个非零值并重新加载：

```bash
sudo install -d -m 0755 /etc/sysctl.d
printf '%s\n' 'user.max_user_namespaces=15000' | sudo tee /etc/sysctl.d/90-dsh-userns.conf
sudo sysctl --system
```

Ubuntu 24.04 还可能设置 `kernel.apparmor_restrict_unprivileged_userns=1`。优先编写并审核只允许确切 dsh、pasta、bubblewrap 执行路径创建 user namespace 的 AppArmor 策略。在独立 VM 上，把该 sysctl 设为 `0` 是兼容性后备方案，但它会削弱整台主机的 AppArmor 限制，不适合共享宿主。

在 SELinux 系统上保持 Enforcing。namespace 探针失败时查看 `ausearch -m AVC -ts recent`，针对被拒的 pasta/bwrap 操作制作并审核最小 policy module，再重新执行探针。`setenforce 0` 只能用于短时对比诊断，不能成为部署状态。

## 安装宿主运行时

在当前版本的部署目录运行：

```bash
cd /path/to/deepseek-harness/deploy/dsh-server
sudo ./install-host.sh \
  --dsh-home /var/lib/dsh \
  --data-dir /var/lib/dsh/server-data
```

脚本会安装 `bubblewrap`、提供 `pasta` 的 `passt`、`nftables`、Python、uv、Node.js、合成 `/etc` 文件、bundled skill、部署 patch、服务用户和 systemd unit。脚本可幂等重跑，任何必需程序或文件缺失都会失败。RHEL 系最小镜像可能要先按主机软件源规范启用 EPEL/CRB，发行版才能提供 `passt` 或 `bubblewrap`；启用后原样重跑安装器。

常用选项包括 `--node-version 24.19.0`、`--no-node`、`--no-pnpm`、`--pnpm-version V`、`--no-systemd`、`--no-service-user`。默认只加固本套件拥有的文件。`--lock-all` 还会尝试处理整个 `/usr/local`，有厂商 agent 的宿主不要使用；`--no-lock` 会移除宿主侧纵深防御，但不会改变沙箱中的只读挂载。

确认基础组件：

```bash
command -v bwrap pasta nft
/usr/local/bin/python3 -VV
/usr/local/bin/uv --version
/usr/local/bin/node -v
sudo systemctl cat dsh-server
```

## 配置服务凭据

不要把凭据写进 unit 或仓库。可以让 systemd drop-in 读取 root-only 环境文件：

```bash
sudo install -d -m 0755 /etc/systemd/system/dsh-server.service.d
sudo install -m 0600 -o root -g root /dev/null /etc/dsh-server.env
sudoedit /etc/dsh-server.env
```

文件中写 systemd 环境赋值，不写 `export`，例如 `DEEPSEEK_API_KEY=...`。然后创建 `/etc/systemd/system/dsh-server.service.d/10-credentials.conf`：

```ini
[Service]
EnvironmentFile=/etc/dsh-server.env
```

命令沙箱不会继承这份环境。凭据形态名称还会额外经过清除，但主要控制是环境隔离，不是变量名启发式规则。

## 启动与验证

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-server
sudo systemctl status dsh-server --no-pager
curl -fsS http://127.0.0.1:3080/healthz
```

以服务用户运行部署检查，使 HOME、`DSH_HOME`、数据目录权限、配置加载和非特权 namespace 与生产一致：

```bash
cd /path/to/deepseek-harness/deploy/dsh-server
sudo -u dsh -H env \
  DSH_HOME=/var/lib/dsh \
  DSH_DATA_DIR=/var/lib/dsh/server-data \
  ./verify.sh --bwrap-probe
```

最后一行必须是 `verify.sh: all checks passed`。探针必须显示公网包源可达，同时拒绝私网、云元数据和 Server loopback；还必须显示不同的网络 namespace、可写项目 HOME、不存在的 `/run` 以及最小 `/etc`。出现 `pasta:`、`dsh-netns-bwrap:` 或 `bwrap:` 失败意味着执行会 fail closed；修复前不要接入流量。

基础探针通过后，对在线服务执行 [`ACCEPTANCE.md`](ACCEPTANCE.md)。它会创建专用测试用户，验证 Python/Node 安装、跨用户文件拒绝、环境清除、最小文件系统可见性、后台超时策略，以及模型 shell 无法访问 `127.0.0.1:3080`、私网地址或云元数据。

## 包镜像源

需要公共镜像时，在安装前编辑 [`pip.conf`](pip.conf) 与 [`uv.toml`](uv.toml)，然后重跑 `install-host.sh`。这些文件对所有沙箱可读，绝不能包含凭据。私有包应使用网络侧认证代理或无需凭据的内网镜像端点。npm 遵循相同规则：不要挂载带 token 的宿主 `/etc/npmrc`；项目凭据需要另行设计并审核。

## 升级

准备新版本并保存当前部署文件：

```bash
sudo cp -a /etc/systemd/system/dsh-server.service /etc/systemd/system/dsh-server.service.pre-upgrade
sudo cp -a /var/lib/dsh/cordis.patch.yml /var/lib/dsh/cordis.patch.yml.pre-upgrade
sudo cp -a /usr/local/libexec/dsh-netns-bwrap /usr/local/libexec/dsh-netns-bwrap.pre-upgrade
```

安装固定的新 `dsh` 版本，从该版本重跑安装器，重启并重复两层验证：

```bash
sudo ./install-host.sh --dsh-home /var/lib/dsh --data-dir /var/lib/dsh/server-data
sudo systemctl daemon-reload
sudo systemctl restart dsh-server
sudo -u dsh -H env DSH_HOME=/var/lib/dsh DSH_DATA_DIR=/var/lib/dsh/server-data ./verify.sh --bwrap-probe
```

仅升级运行时时不要删除或迁移数据目录。独立的数据格式迁移应先停止流量，并遵循对应版本的迁移说明。

## 回滚

重新安装上一固定版本的 `dsh`，运行上一版本的 `install-host.sh`；只有安装器未复现原配置时才恢复备份 unit/patch，然后 reload 并重启 systemd。恢复流量前运行上一版本的 `verify.sh --bwrap-probe`。只切换 CLI 不算完整回滚：runner、合成 `/etc`、Cordis patch 与 service unit 必须来自同一版本。

## 日常运维

本次暂缓的容量控制仍由部署负责。[`workspace-gc.sh`](workspace-gc.sh) 默认只做 dry-run，只清理 `.cache` 与 `.dsh/spill`，绝不删除 `.venv`、`node_modules`、`.pylibs` 或用户文件。容量限制变得紧急时，应在数据卷上使用文件系统配额。

服务错误使用 `journalctl -u dsh-server -n 200 --no-pager` 查看。重复出现 runner 签名表示 namespace 或 nftables 初始化失败，不是包安装失败。DNS 成功但公网源失败，通常表示 VM 出口策略阻断了 pasta 转换后的流量。

## 容器状态

[`Dockerfile`](Dockerfile) 仍作为可复现目录布局和镜像构建参考，但仓库没有提供生产支持的嵌套容器启动方式。容器内必须同时正确运行 pasta、nftables、非特权 user namespace 与 bubblewrap，而且不能通过宽泛 capability 暴露宿主。不要把 `--cap-add SYS_ADMIN` 加 `seccomp=unconfined` 当成可接受的生产替代方案。除非你的容器平台已有审核过的 namespace 配置，并通过完整 namespace 探针和在线验收手册，否则使用 VM/systemd 路径。

## 相关文档

- [`@deepseek-ai/dsh-server` README](../../packages/bundle/server/README.zh.md)
- [`sandbox-local` README](../../packages/sandbox/sandbox-local/README.zh.md)
- [`subprocess-local` README](../../packages/subprocess/subprocess-local/README.zh.md)
- [Server 子系统](../../docs/subsystems/server.zh.md)
