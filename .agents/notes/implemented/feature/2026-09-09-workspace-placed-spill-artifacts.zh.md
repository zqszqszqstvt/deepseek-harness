# Agent Note: 把 spill 产物放进会话工作区内

Status: implemented

[English](2026-09-09-workspace-placed-spill-artifacts.md) | 中文

## 问题

有两处会把文件系统路径交给模型：子进程输出收集器会把被截断命令的完整流追加到一个 spill 文件并以 `spillPath` 报告，`ctx.spillStore` 则会持久化过大的工具结果并返回一个定位符，由 spill 策略渲染进结果文本。两者都写在操作系统临时区域下的宿主私有目录里——这对本地部署是正确的默认值，因为模型对这两个路径都能 `read` 或 `grep`。

在 Server profile 下这两个路径都不可达。会话读取被围栏限制在会话工作区内（启用 `strictReads` 的 `fs-sandbox`），因此 `read` 会拒绝该临时位置；而 shell 自身的 `/tmp` 是 bubblewrap namespace 内每次调用全新的 tmpfs，并不是产物实际写入的宿主目录。于是模型收到的截断提示会指向一个它永远打不开的恢复文件，而它唯一诚实的选择只有丢弃输出，或者重新执行命令并自己把输出重定向进工作区。其下还藏着一个相关缺陷：打开或写入 spill 文件发生在流的 `data` 监听器内且没有任何收敛，因此不可写的 spill 目录会逃逸为未被捕获的宿主错误，而不是只降级这一条流。

## 决策

一个共享约定加两处可选落点，两者都默认保持既有的私有行为，因此除 Server 之外没有任何 profile 发生变化。

位置由 `@deepseek-ai/dsh-home-paths` 拥有，因为它已经拥有 `.dsh` 这个名称，且它存在的意义就是让产品包共享用户数据路径约定而无需彼此依赖：`workspaceSpillRoot(workspaceRoot)` 解析出 `<workspace>/.dsh/spill`，与工作区已经在 `<workspace>/.dsh/skills` 承载的项目 skill 并列，并由 `WORKSPACE_DSH_DIR_NAME` 与 `WORKSPACE_SPILL_DIR_NAME` 命名各路径段。创建、权限与保留由调用方负责。

命令输出这一侧把目录加在已经拥有 spill 机制的那个 seam 上。`SubprocessSpawnSpec.spillDir` 为一次 spawn 的 spill 文件指定绝对目录，这与该 seam「每项处置都显式到达、运行时不保留配置」的规则一致；`dsh-subprocess-local` 让它优先于自身的私有默认值，按需以仅限所有者的权限创建该目录，并且现在会收敛所有 spill 文件系统失败——创建、排他打开或写入——做法是丢弃产物并保留有界的内存尾部输出。`dsh-bash-local` 及其 `dsh-pwsh-local` 对应实现新增 `spillPlacement: private | session-workspace`，并按限制该命令所用的同一份逐调用身份推导目录：已解析的沙箱策略根目录，否则是该命令自身的工作目录。`read-only` 策略仍使用私有目录，因为该模式承诺不写入工作区，而这个产物由 harness 写入，而不是由受限子进程写入。

工具结果这一侧把位置作为调用方提供的提示加在存储命名空间上。`SpillOwner.workspaceRoot` 携带所属会话的工作区，`dsh-spill-policy` 转发它本来就会为 owner id 读取的会话 header cwd，`dsh-spill-local` 新增 `placement: private | session-workspace`。在 `session-workspace` 下，owner 未携带工作区的保存会被**拒绝**，从而走策略已记录的尽力而为路径——记录日志、保留内联结果——而不是写入私有根目录并给出一个位于会话边界之外的定位符。会话级命名、不可预测的文件名前缀、排他的仅限所有者写入以及 0700 目录权限都保持不变；只有根目录发生移动。

Server 组合把两者都设置好：`cloud-bash` 以 `spillPlacement: session-workspace` 运行，`spill-local` 行配置 `placement: session-workspace`。放进工作区同时也是隔离上正确的答案，而不仅仅是可达的答案。工作区就是该会话自身的边界，因此放在那里的产物在构造上就归属于它的产生者；而共享的私有根目录依赖的是不可猜测的名称，可是 Server 的会话 id 由 `(userId, projectId)` 确定性派生，所以 `session-<sha256 前缀>` 这样的目录名可以被另一个用户算出来。这也正是没有改为放宽围栏的原因：让私有根目录通过 `strictReads`，会使每个会话的产物对任何能算出该名称的会话都可读。

## 测试

`packages/util/home-paths/tests/home-paths.spec.ts` 固定该约定及其绝对路径解析。`packages/subprocess/subprocess-local/tests/spawn.spec.ts` 固定 spec 给出的目录优先于运行时私有目录并按需创建，以及一个不可能的目录（本应是父目录的位置上放着普通文件）会让本次运行以截断尾部结算且没有 `spillPath`，而不是抛出异常。`packages/shell/bash-local/tests/executor.spec.ts` 与 `dsh-pwsh-local` 的对应测试固定全部四个分支：私有默认值、`workspace-write` 下的策略根目录、无策略时回退到工作目录，以及 `read-only` 下使用私有目录且工作区内不创建 `.dsh`。`packages/spill/spill-local/tests/spill-local.spec.ts` 固定工作区内的布局与权限、owner 缺少工作区时的拒绝，以及默认落点会忽略该提示；`packages/spill/spill-policy/tests/spill-policy.spec.ts` 固定转发的 owner 在 header 带有 cwd 时携带它、缺少时不携带。

## 考虑过的替代方案

**让私有 spill 根目录通过 strict-reads 围栏。** 拒绝：那样围栏就会放行一棵跨会话共享的目录树，而目录名是某个会话 id 的哈希，另一个用户可以从确定性的 Server 身份算出它。在一个以单一操作系统身份服务多个用户的进程里，名称不可预测并不是授权边界。

**在 Server 上停止报告 `spillPath` 与存储定位符。** 拒绝：这会为了掩盖落点缺陷而移除一项真实的恢复能力——被截断命令的完整输出与过大结果的完整文本。渲染一条诚实的「把长输出重定向进你的工作区」提示是它的廉价变体，对不希望工作区里出现 harness 文件的部署仍然可用；但对一个整个文件系统叙事都围绕工作区的 profile 而言，可达的路径是更好的默认值。

**给 `dsh-subprocess-local` 增加 spill 目录配置。** 拒绝：该服务明确记录自己没有配置，正是为了让随部署变化的选择留在调用方的配置里，而且单一静态目录不可能同时在每个用户的工作区之内。逐 spawn 的 spec 字段是唯一能表达「这个会话的目录」的形态。

**通过 `ctx.fs` 写入产物，让围栏来裁决。** 拒绝：围栏裁决的是某个调用会话中由模型控制的路径，而 spill 写入方是宿主侧管道，既没有会话，路径也是它自己推导的。把它接入围栏会给一次并非模型请求的写入增加策略检查，况且收集器是同步的流管道，无法等待一个文件系统 seam。

**新增一个不受围栏限制的取回工具来读取 spill 产物。** 拒绝：为解决「路径一旦落在会话已有边界内，`read` 与 `grep` 本来就能做到」的问题，引入新的模型可见面、提示词 token，以及第二条带有自身授权叙事的读取路径。

## 后果

Server 会话被截断的命令输出与过大的工具结果现在可以用它已有的工具恢复，而它拿到的路径就是其自身边界可以打开的路径。代价是 harness 产物会出现在项目目录内、对用户可见：`glob` 会搜索隐藏条目并列出它们，用户的版本控制可能把它们报告为未跟踪文件，而该 seam 也没有定义它们的保留期——既有的「spill 文件持续存在直到外部清理」缺口现在位于工作区内，删除项目工作区即删除它们。`session-workspace` 是可选启用的，因此其他每个 profile 都逐字节保持私有临时目录行为；而 `read-only` 的 Server 会话仍会收到不可达的私有路径——今天之所以不可达，只是因为 Server 把每个会话都封顶在 `workspace-write`，这一点已写在该分支所在的位置，而不是留作隐含假设。
