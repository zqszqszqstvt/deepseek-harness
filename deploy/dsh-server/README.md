# dsh server cloud runtime preparation

English | [中文](README.zh.md)

This directory is the deployment kit that makes Python usable inside a multi-user [`dsh server`](../../packages/bundle/server/README.md) deployment while keeping every user isolated. It requires **no harness code change**: the image supplies a read-only shared toolchain, the deployment patch supplies the resident contract, and the bundled skill supplies the on-demand command templates. The isolation argument is one sentence — the shared layer is read-only for everyone, and the only writable place is the calling session's own workspace, which strict bubblewrap binds per call. Two installation paths produce exactly the same layout: [`install-host.sh`](install-host.sh) on an existing Linux host (apt, dnf, or yum), or the [`Dockerfile`](Dockerfile) when the deployment is containerized. Nothing here requires a container.

## Directory contract

Every path an agent must reach has to live under a prefix the strict profile binds: `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, `/run`, plus that session's workspace ([`profiles.ts:19-45`](../../packages/sandbox/sandbox-local/src/profiles.ts)).

| Absolute path | What lives there | Inside the sandbox | Owner and mode |
| --- | --- | --- | --- |
| `python3` — `/usr/bin/python3` on a host, `/usr/local/bin/python3` in the image | shared interpreter | read-only | distribution package; the bind, not the mode bits, is what enforces it |
| `/usr/local/bin/uv`, `/usr/local/bin/uvx` | shared installer/resolver | read-only | `root:root 0755` |
| `/etc/pip.conf`, `/etc/uv/uv.toml` | optional index config; absent means the public index | read-only | `root:root 0644`, no credentials |
| `/usr/local/share/dsh/skills/python-env/SKILL.md` | model-facing command templates | not needed: read host-side | `root:root`, `a-w` |
| `/var/lib/dsh` (`DSH_HOME`) | `cordis.patch.yml`, profile, credentials | invisible | `dsh:dsh 0700` |
| `/var/lib/dsh/server-data` (`--data-dir`) | every user's workspace | only the calling session's own subtree | `dsh:dsh 0700` |
| `<workspace>/.venv`, `<workspace>/.cache`, `<workspace>/.pylibs` | the user's writable environment | read-write | service uid |
| `<workspace>/.dsh/spill` | harness-written full output of truncated calls | read-write | service uid |
| `/opt`, `/srv`, `$HOME`, `/var/tmp` | never install agent tooling here | **absent** | — |

Per-user workspaces are `<data-dir>/users/<sha256(userId)>/workspace` for the reserved default project and `<data-dir>/users/<sha256(userId)>/projects/<sha256(projectId)>/workspace` for a named project.

## Why these directories

Three mechanisms decide the layout, and each one has a failure mode that looks like a bug but is the contract.

- **Visible or nonexistent.** The strict profile starts from an empty root (`--tmpfs /` then `--remount-ro /`), so a toolchain under `/opt/conda` or in the service user's home is not merely forbidden — it does not exist, and a command referencing it fails with ENOENT. This is why the interpreter and `uv` go to `/usr/local` and the mirrors go to `/etc`.
- **Read-only shared, writable per user.** What makes the shared layer safe to expose is the mount rather than the mode bits: the strict profile ro-binds `/usr`, so inside a session `pip install` into system site-packages or `conda install` into base fails with EROFS for every user, and nobody can change what another user's agent imports. Host-side locking is defense in depth and must stay narrow, because a blanket `chmod -R a-w /usr/local` aborts on vendor trees that reject it even as root — Aliyun aegis under `/usr/local/aegis` is one — so `install-host.sh` locks only the files it installed, with `--lock-all` and `--no-lock` as the explicit alternatives. Each session's packages live in its own workspace `.venv`, and strict bubblewrap binds exactly one workspace per call, so user A cannot read or write user B's environment.
- **Host-side roots are the only way to ship instructions.** A Server session fences in-process reads to its workspace (`fs-sandbox` with `strictReads`), which silently disables the two locations a CLI or desktop deployment would use: `$DSH_HOME/AGENTS.md` is probed through `ctx.fs`, returns unavailable, and is skipped without a diagnostic; `$DSH_HOME/skills` and `$DSH_AGENTS_HOME/skills` are treated as absent because the skill provider maps `FS_SANDBOX_DENIED` to a missing path. The bundled skill root is the exception — it is loaded with host filesystem calls and marked trusted — which is what `DSH_BUNDLED_SKILL_DIR` exposes. Resident text goes to `system-prompt.persona` instead, a row the base bundle deliberately leaves empty for the deployment.

## Install on a Linux host

Use this path when `dsh server` already runs on a VM or bare host — it is the shorter one, because bubblewrap then needs no extra container privileges. The script is idempotent, detects the package manager (apt on Debian/Ubuntu, dnf or yum on RHEL, Rocky, Alma, Fedora, Amazon Linux), installs the same directories the image contains, writes the systemd unit, and stops with a clear error when the interpreter cannot be provided.

```bash
sudo ./install-host.sh --data-dir /var/lib/dsh/server-data
sudo systemctl edit dsh-server      # Environment=DEEPSEEK_API_KEY=... (or a drop-in)
sudo systemctl enable --now dsh-server
./verify.sh --bwrap-probe
```

Unprivileged user namespaces must be enabled on the host: `user.max_user_namespaces` nonzero, and on Ubuntu 24.04 also `kernel.apparmor_restrict_unprivileged_userns=0`. The unit adds no capability for this reason — if the host's bubblewrap is a setuid binary, drop `NoNewPrivileges` from the unit instead. On an SELinux host in `Enforcing` mode a failing probe is usually policy, not the kit: confirm with `setenforce 0`, then keep a policy module rather than leaving the host permissive. Pass `--no-lock` only on hosts that keep writable tooling under `/usr/local`, and accept that agents can then modify what other agents import.

When the Server is started by hand instead of by systemd — for example `pnpm dsh server` from a repository checkout — skip the service user and copy the contract into the running user's own `$DSH_HOME`:

```bash
sudo ./install-host.sh --no-systemd --no-service-user
install -m 0600 cordis.patch.yml "${DSH_HOME:-$HOME/.dsh}/cordis.patch.yml"
export DSH_BUNDLED_SKILL_DIR=/usr/local/share/dsh/skills UV_PYTHON_DOWNLOADS=never
pnpm dsh server --host 127.0.0.1 --port 3080
```

The data directory then defaults to `<DSH_HOME>/server-data`, so each user's workspace is `<DSH_HOME>/server-data/users/<sha256(userId)>/workspace`.

## Build the image

```bash
cd deploy/dsh-server
docker build -t dsh-server:py312 .
# Offline build: replace the uv COPY stage with a local static binary, and point
# pip.conf / uv.toml at your internal mirror before building.
```

## Run the container

The container path is optional; skip to the “Install on a Linux host” section when the Server already runs on a host. bubblewrap needs to create a mount namespace inside the container. On Ubuntu 24.04 hosts also set `kernel.apparmor_restrict_unprivileged_userns=0`.

```bash
docker run -d --name dsh-server \
  --cap-add SYS_ADMIN --security-opt seccomp=unconfined \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  -v dsh-data:/var/lib/dsh/server-data \
  -p 127.0.0.1:3080:3080 \
  dsh-server:py312
```

A named volume takes the image directory's ownership on first use, so `/var/lib/dsh/server-data` stays owned by the service uid. Bind-mounting a host directory instead requires `chown -R 10001:10001` on it first. `DEEPSEEK_API_KEY` never reaches an agent shell: variable names matching `KEY|PASSWORD|SECRET|TOKEN` are dropped from the child environment. Keep the published port on loopback or a trusted backend network — the Server has no authentication layer of its own.

## Prepare the deployment patch

The image already copies [`cordis.patch.yml`](cordis.patch.yml) to `/var/lib/dsh/cordis.patch.yml`, and `install-host.sh` installs it together with the systemd unit. For a manual host install, copy it to the service user's `$DSH_HOME`:

```bash
install -d -m 0700 /var/lib/dsh
install -m 0600 -o dsh -g dsh cordis.patch.yml /var/lib/dsh/cordis.patch.yml
systemctl edit dsh-server   # or the unit's Environment= lines
#   DSH_HOME=/var/lib/dsh
#   DSH_BUNDLED_SKILL_DIR=/usr/local/share/dsh/skills
#   UV_PYTHON_DOWNLOADS=never
```

A patch row replaces the target row's whole config, and the persona is a strict template: a literal `{{` in the text throws during prompt assembly.

## Quota and retention

The Server enforces no disk quota and no retention for workspace content. Two deployment-level controls cover it:

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

## Verify

```bash
./verify.sh                                  # host-side: paths, modes, traps, patch
./verify.sh --bwrap-probe                    # also assert what an agent sees in the namespace
./verify.sh --bwrap-probe /var/lib/dsh/server-data/users/<sha>/workspace
```

Then one end-to-end turn against a live session: ask the agent to list its skills, build `.venv`, install a package in the background, and run the three-step verification. The expected results are printed by `verify.sh` section 7. The in-namespace assertions replicate [`profiles.ts`](../../packages/sandbox/sandbox-local/src/profiles.ts); if that file changes, the probe must change with it.

## Known gaps

- No product-level quota, GC, or retention: both are deployment jobs today, and `.venv` growth is only controllable through a filesystem quota.
- No workspace seeding: a new project workspace is an empty directory, and the Server exposes no filesystem HTTP route, so per-project files must come from the bundled skill root, the persona, or a host-side script.
- A `read-only` session would still spill to the host-private temp directory, because that mode promises no workspace writes. The Server caps sessions at `workspace-write`, so this is unreachable today.
- `/tmp` still has three different meanings (per-call tmpfs in shell, host `/tmp` in the write fence, denied by the read fence). The kit does not remove that; the persona and skill tell the model not to rely on it.
- The local (Electron) execution environment has no background jobs, a ~128 KB combined output limit, and a 120-second transport timeout. The skill's local branch works inside those limits by splitting installs; no protocol change is included here.

## Related

- [`@deepseek-ai/dsh-server` README](../../packages/bundle/server/README.md) — deployment contract, HTTP routes, model experience
- [Multi-user Server subsystem](../../docs/subsystems/server.md) — trust boundary and Cordis API
- [`sandbox-local` profiles](../../packages/sandbox/sandbox-local/src/profiles.ts) — the authoritative mount list
