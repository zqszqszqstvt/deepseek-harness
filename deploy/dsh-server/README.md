# dsh server cloud runtime preparation

English | [中文](README.zh.md)

This directory prepares a multi-user `dsh server` host with one read-only Python/Node runtime and one writable dependency layer per project workspace. The supported production path is a dedicated Linux VM with systemd. The deployment adds a private network namespace to every model-written shell command, exposes only a minimal `/etc`, replaces the inherited service environment with a fixed command environment, and kills cloud background jobs after 30 minutes. The intentionally deferred items are upstream identity enforcement, CPU/memory/process/disk limits, and physical deduplication of identical per-project dependencies.

## Resulting layout

| Path | Purpose | Visible to a cloud shell |
| --- | --- | --- |
| `/usr/local/bin/python3`, `uv`, `uvx` | shared Python runtime | read-only |
| `/usr/local/bin/node`, `npm`, `npx`, `pnpm` | shared Node.js runtime | read-only |
| `/etc/pip.conf`, `/etc/uv/uv.toml` | credential-free package index policy | read-only |
| `/usr/local/share/dsh/runtime-etc` | synthetic hosts, NSS, and pasta DNS files | mounted into the minimal `/etc` |
| `/usr/local/libexec/dsh-netns-bwrap` | nftables policy followed by bwrap | host-side launcher |
| `/usr/local/share/dsh/skills/runtime-env` | runtime command templates | loaded as a trusted bundled skill |
| `/var/lib/dsh` | Server config and credentials | absent |
| `/var/lib/dsh/server-data` | all hashed project directories | only the active project's workspace is mounted |
| `<workspace>/.home` | project-level `HOME` | writable |
| `<workspace>/.cache` | uv, pip, npm, and pnpm caches | writable |
| `<workspace>/.venv`, `node_modules` | project dependencies | writable |
| `/tmp` | one-call temporary data | writable and destroyed after the call |

The strict root contains `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, a synthetic `/etc`, `/dev`, `/proc`, `/tmp`, and the active workspace. `/run`, `/home`, `/opt`, `/var`, `/srv`, host account files, and host-wide Git/npm configuration are absent. The subprocess provider does not inherit the Server environment. A cloud shell receives a fixed `PATH=/usr/local/bin:/usr/bin:/bin`, a project HOME, project cache variables, locale, `TMPDIR`, and managed `DSH_*` facts only.

Each shell runs inside a new pasta network namespace, so its loopback is not the host's loopback and remains usable for same-command tests. nftables permits the synthetic DNS address and public destinations while rejecting RFC1918, shared, link-local, cloud metadata, multicast, and reserved gateway ranges. `--no-map-gw` also prevents pasta from mapping the host through its namespace gateway, and the strict bwrap profile drops every capability before starting the model command so it cannot remove the rules. This closes the path from one user's shell to the Server's unauthenticated loopback API while preserving public package downloads.

## Cloud host prerequisites

Use a dedicated VM, not a shared interactive host. Supported package managers are apt, dnf, and yum. Use a current x86-64 or arm64 distribution with systemd; Ubuntu 22.04/24.04, Debian 12, RHEL/Rocky/Alma 9, Fedora, and current Amazon Linux are the intended families. The host needs:

- root or sudo for installation;
- a working `dsh` executable installed from the release you intend to run;
- outbound HTTPS to the model endpoint, `nodejs.org`, `astral.sh`, and the configured Python/npm registries during installation;
- DNS and ordinary public egress for sandboxed package installation;
- a persistent filesystem for `/var/lib/dsh/server-data`;
- no public listener on port 3080: keep the Server on `127.0.0.1` and let the trusted backend call it.

Record these before installation:

```bash
uname -a
cat /etc/os-release
command -v dsh && dsh --version
df -h /var/lib/dsh 2>/dev/null || df -h /
systemctl --version | head -1
```

If `dsh` is not installed, install your pinned release first. The host installer prepares the runtime but does not choose or upgrade the Server release. Re-run it after installing `dsh` so the generated unit records the real executable path.

## Enable unprivileged namespaces

Both pasta and bubblewrap rely on unprivileged user namespaces. Check the host:

```bash
sysctl user.max_user_namespaces
unshare --user --map-root-user true
```

If the limit is zero on a dedicated VM, persist a nonzero value and reload it:

```bash
sudo install -d -m 0755 /etc/sysctl.d
printf '%s\n' 'user.max_user_namespaces=15000' | sudo tee /etc/sysctl.d/90-dsh-userns.conf
sudo sysctl --system
```

Ubuntu 24.04 may additionally set `kernel.apparmor_restrict_unprivileged_userns=1`. Prefer a reviewed AppArmor policy that grants user namespaces to the exact dsh, pasta, and bubblewrap execution path. On a dedicated VM, setting that sysctl to `0` is the compatibility fallback; it weakens the host-wide AppArmor restriction and is not appropriate for a shared host.

On SELinux systems, keep Enforcing enabled. If the namespace probe fails, inspect `ausearch -m AVC -ts recent`, build a narrow reviewed policy module for the denied pasta/bwrap operations, and rerun the probe. `setenforce 0` is only a short diagnostic comparison, never the deployed state.

## Install the host runtime

Run from the checked-out deployment directory:

```bash
cd /path/to/deepseek-harness/deploy/dsh-server
sudo ./install-host.sh \
  --dsh-home /var/lib/dsh \
  --data-dir /var/lib/dsh/server-data
```

The script installs `bubblewrap`, `passt` (which supplies `pasta`), `nftables`, Python, uv, Node.js, the synthetic `/etc` files, bundled skill, deployment patch, service user, and systemd unit. It is idempotent and fails when a required executable or file is absent. RHEL-family minimal images may need their normal EPEL/CRB repository enabled before the distribution can provide `passt` or `bubblewrap`; do that through the host's package policy, then rerun the same installer.

Useful options are `--node-version 24.19.0`, `--no-node`, `--no-pnpm`, `--pnpm-version V`, `--no-systemd`, and `--no-service-user`. The default hardens only files owned by this kit. `--lock-all` also attempts all of `/usr/local`; do not use it on hosts with vendor agents under that tree. `--no-lock` removes host-side defense in depth but does not change the sandbox's read-only mount.

Confirm the installed substrate:

```bash
command -v bwrap pasta nft
/usr/local/bin/python3 -VV
/usr/local/bin/uv --version
/usr/local/bin/node -v
sudo systemctl cat dsh-server
```

## Configure the service credential

Keep credentials out of the unit and repository. One systemd drop-in can read a root-owned environment file:

```bash
sudo install -d -m 0755 /etc/systemd/system/dsh-server.service.d
sudo install -m 0600 -o root -g root /dev/null /etc/dsh-server.env
sudoedit /etc/dsh-server.env
```

The file contains systemd environment assignments without `export`, for example `DEEPSEEK_API_KEY=...`. Then create `/etc/systemd/system/dsh-server.service.d/10-credentials.conf`:

```ini
[Service]
EnvironmentFile=/etc/dsh-server.env
```

The command sandbox does not inherit this environment. Credential-shaped names are scrubbed as an additional safeguard, but environment isolation, not the naming heuristic, is the primary control.

## Start and verify

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-server
sudo systemctl status dsh-server --no-pager
curl -fsS http://127.0.0.1:3080/healthz
```

Run the deployment checks as the service user so HOME, `DSH_HOME`, data permissions, configuration loading, and unprivileged namespaces match production:

```bash
cd /path/to/deepseek-harness/deploy/dsh-server
sudo -u dsh -H env \
  DSH_HOME=/var/lib/dsh \
  DSH_DATA_DIR=/var/lib/dsh/server-data \
  ./verify.sh --bwrap-probe
```

The final line must be `verify.sh: all checks passed`. The probe must show public package-index access while rejecting the private network, cloud metadata, and Server loopback; it must also show a different network namespace, a writable project HOME, an absent `/run`, and a minimal `/etc`. A `pasta:`, `dsh-netns-bwrap:`, or `bwrap:` failure means execution fails closed; do not enable traffic until it is fixed.

After the substrate passes, run [`ACCEPTANCE.md`](ACCEPTANCE.md) against the live service. It creates dedicated test users and proves Python/Node installation, cross-user file denial, environment scrubbing, minimal filesystem visibility, background timeout policy, and inability to reach `127.0.0.1:3080`, private addresses, or metadata from a model shell.

## Package mirrors

Edit [`pip.conf`](pip.conf) and [`uv.toml`](uv.toml) before installation when a public mirror is required, then rerun `install-host.sh`. Never put credentials in these files because every sandbox can read them. Use a network-side authenticated proxy or a credential-free internal mirror endpoint when private packages are required. Apply the same rule to npm: do not mount a token-bearing host `/etc/npmrc`; provide project-scoped credentials through a separately reviewed mechanism.

## Upgrade

Stage the new repository/release and keep a copy of the current deployment files:

```bash
sudo cp -a /etc/systemd/system/dsh-server.service /etc/systemd/system/dsh-server.service.pre-upgrade
sudo cp -a /var/lib/dsh/cordis.patch.yml /var/lib/dsh/cordis.patch.yml.pre-upgrade
sudo cp -a /usr/local/libexec/dsh-netns-bwrap /usr/local/libexec/dsh-netns-bwrap.pre-upgrade
```

Install the pinned new `dsh` release, rerun `install-host.sh` from that release, restart, and repeat both verification layers:

```bash
sudo ./install-host.sh --dsh-home /var/lib/dsh --data-dir /var/lib/dsh/server-data
sudo systemctl daemon-reload
sudo systemctl restart dsh-server
sudo -u dsh -H env DSH_HOME=/var/lib/dsh DSH_DATA_DIR=/var/lib/dsh/server-data ./verify.sh --bwrap-probe
```

Do not delete or migrate the data directory during a runtime-only upgrade. Stop traffic before any separate data-format migration and use that release's migration instructions.

## Rollback

Reinstall the previous pinned `dsh` release, run the previous release's `install-host.sh`, restore the saved unit/patch only if the installer did not reproduce them, then reload and restart systemd. Run the previous `verify.sh --bwrap-probe` before reopening traffic. A rollback is incomplete if only the CLI changes: the runner, synthetic `/etc`, Cordis patch, and service unit must agree with the same release.

## Operations

The deferred capacity controls still belong to the deployment. [`workspace-gc.sh`](workspace-gc.sh) dry-runs by default and prunes only `.cache` and `.dsh/spill`; it never deletes `.venv`, `node_modules`, `.pylibs`, or user files. Use filesystem quotas on the data volume when capacity enforcement becomes urgent.

Use `journalctl -u dsh-server -n 200 --no-pager` for service errors. Repeated runner signatures indicate namespace or nftables setup failure, not a package-install failure. A public index failure together with successful DNS usually means the VM egress policy blocks the translated pasta traffic.

## Container status

[`Dockerfile`](Dockerfile) remains a reproducible layout and image-build reference, but this repository does not provide a production-supported nested-container invocation. Pasta, nftables, unprivileged user namespaces, and bubblewrap must all work inside the container without exposing the host through broad capabilities. Do not treat `--cap-add SYS_ADMIN` plus `seccomp=unconfined` as an acceptable production substitute. Use the VM/systemd path unless your container platform has a reviewed namespace profile and passes the complete namespace probe and live acceptance runbook.

## Related

- [`@deepseek-ai/dsh-server` README](../../packages/bundle/server/README.md)
- [`sandbox-local` README](../../packages/sandbox/sandbox-local/README.md)
- [`subprocess-local` README](../../packages/subprocess/subprocess-local/README.md)
- [Server subsystem](../../docs/subsystems/server.md)
