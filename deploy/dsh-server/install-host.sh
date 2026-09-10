#!/usr/bin/env bash
# Bare-metal installer for the dsh server cloud runtime contract.
# Supports apt (Debian/Ubuntu) and dnf/yum (RHEL, Rocky, Alma, Fedora, Amazon Linux).
# Idempotent: re-running it only repairs what is missing. Requires root.
#
#   sudo ./install-host.sh [--data-dir DIR] [--dsh-home DIR] [--no-systemd]
#                          [--no-service-user] [--no-lock] [--no-node]
#                          [--node-version 24.19.0|lts22] [--no-pnpm] [--pnpm-version V]
#
# --no-service-user skips the service user, the data directories, the deployment
# patch, and the unit: use it when the Server is started by hand (for example
# `pnpm dsh server` from a checkout) under an existing login user, then copy
# cordis.patch.yml into that user's own $DSH_HOME.
# Host-side hardening defaults to the files this kit installed. --lock-all locks
# all of /usr/local (tolerating vendor trees that reject chmod, such as Aliyun
# aegis); --no-lock hardens nothing host-side. Agents cannot write under /usr
# either way, because the strict profile ro-binds it.
#
# It installs the same layout the Dockerfile produces, so verify.sh accepts both:
#   /usr/local/bin/python3, uv, node, npm, pnpm      shared, read-only
#   /etc/pip.conf, /etc/uv/uv.toml                   optional index config
#   /usr/local/share/dsh/skills                      DSH_BUNDLED_SKILL_DIR
#   /var/lib/dsh                                     DSH_HOME (invisible to agents)
#   <data-dir>                                       per-user workspaces
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR=/var/lib/dsh/server-data
DSH_HOME_DIR=/var/lib/dsh
SERVICE_USER=dsh
SERVICE_UID=10001
SKILL_ROOT=/usr/local/share/dsh/skills
WITH_SYSTEMD=1
WITH_LOCK=0   # 0 = kit files only (default), 1 = all of /usr/local, 2 = none
NODE_VERSION=lts22          # an exact version (24.19.0) or lts22 to resolve the newest 22.x
WITH_NODE=1
WITH_PNPM=1
PNPM_VERSION=11.7.0

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="${2:?}"; shift 2 ;;
    --dsh-home) DSH_HOME_DIR="${2:?}"; shift 2 ;;
    --no-systemd) WITH_SYSTEMD=0; shift ;;
    --no-service-user) SERVICE_USER=""; shift ;;
    --no-lock) WITH_LOCK=2; shift ;;
    --no-node) WITH_NODE=0; shift ;;
    --no-pnpm) WITH_PNPM=0; shift ;;
    --node-version) NODE_VERSION="${2:?}"; shift 2 ;;
    --pnpm-version) PNPM_VERSION="${2:?}"; shift 2 ;;
    --lock-all) WITH_LOCK=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
[ -f /etc/os-release ] || { echo "no /etc/os-release; cannot detect the package manager" >&2; exit 1; }
. /etc/os-release
echo "== target: ${PRETTY_NAME:-unknown} =="

# ── package manager ────────────────────────────────────────────────────────────
if command -v apt-get >/dev/null 2>&1; then
  PKG=apt
elif command -v dnf >/dev/null 2>&1; then
  PKG=dnf
elif command -v yum >/dev/null 2>&1; then
  PKG=yum
else
  echo "no apt-get, dnf, or yum on PATH" >&2; exit 1
fi
echo "== package manager: $PKG =="

# npm's and pnpm's CLIs are scripts with a `#!/usr/bin/env node` shebang, and
# sudo's secure_path usually omits /usr/local/bin, so a bare /usr/local/bin/npm
# dies with "env: 'node': No such file or directory". Always put the contract
# directory on PATH for them.
kit_npm() { env PATH="/usr/local/bin:$PATH" /usr/local/bin/npm "$@"; }
kit_pnpm() { env PATH="/usr/local/bin:$PATH" /usr/local/bin/pnpm "$@"; }

# Every path the contract names must exist when this script returns, so a step
# that died halfway (a failed download, a protected vendor tree) cannot leave a
# deployment that looks installed and silently is not.
contract_summary() {
  local missing=0 target
  echo "== contract summary =="
  local required="/usr/local/bin/python3 /usr/local/bin/uv /usr/local/libexec/dsh-netns-bwrap /usr/local/share/dsh/runtime-etc/hosts /usr/local/share/dsh/runtime-etc/nsswitch.conf /usr/local/share/dsh/runtime-etc/resolv.conf /etc/uv/uv.toml $SKILL_ROOT/runtime-env/SKILL.md"
  if [ "$WITH_NODE" -eq 1 ]; then
    required="$required /usr/local/bin/node /usr/local/bin/npm"
  fi
  for target in $required; do
    if [ -e "$target" ]; then
      printf "   ok      %s\n" "$target"
    else
      printf "   MISSING %s\n" "$target"
      missing=1
    fi
  done
  if [ "$WITH_NODE" -eq 1 ] && [ "$WITH_PNPM" -eq 1 ] && [ ! -x /usr/local/bin/pnpm ]; then
    echo "   note    /usr/local/bin/pnpm absent (npm is still usable)"
  fi
  if [ "$missing" -ne 0 ]; then
    echo "install-host.sh: the contract is INCOMPLETE — fix the MISSING lines above" >&2
    return 1
  fi
  return 0
}

pkg_install() {  # best-effort: a missing optional package must not abort
  case "$PKG" in
    apt) apt-get install -y --no-install-recommends "$@" >/dev/null ;;
    *)   "$PKG" install -y "$@" >/dev/null ;;
  esac
}

# Newest interpreter that can actually build a venv. uv requires 3.8+, and the
# strict profile only guarantees that /usr/bin and /usr/local/bin are visible.
pick_python() {
  local cand bin
  for cand in python3.13 python3.12 python3.11 python3.9 python3.8 python3; do
    bin="$(command -v "$cand" 2>/dev/null || true)"
    [ -n "$bin" ] || continue
    if "$bin" -c 'import sys, ensurepip, venv; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
      echo "$bin"; return 0
    fi
  done
  return 1
}

echo "== 1. system packages =="
# bubblewrap is mandatory: without it every shell call fails closed with
# SANDBOX_UNAVAILABLE. /lib64 must exist because sandbox-local ro-binds it
# unconditionally (packages/sandbox/sandbox-local/src/profiles.ts:19-45).
if [ "$PKG" = apt ]; then
  apt-get update -qq
  pkg_install bubblewrap ca-certificates curl git nftables passt xz-utils
else
  "$PKG" makecache -q >/dev/null 2>&1 || "$PKG" makecache >/dev/null 2>&1 || true
  pkg_install bubblewrap ca-certificates curl git nftables passt xz which
fi
command -v bwrap >/dev/null || { echo "   FAIL: bubblewrap did not install (on CentOS 7 it needs EPEL)" >&2; exit 1; }
command -v pasta >/dev/null || { echo "   FAIL: pasta is required (install the passt package, enabling EPEL/CRB when needed)" >&2; exit 1; }
command -v nft >/dev/null || { echo "   FAIL: nft is required (install the nftables package)" >&2; exit 1; }
[ -d /lib64 ] || install -d /lib64
echo "   bwrap $(bwrap --version 2>&1 | head -1)"
echo "   pasta $(pasta --version 2>&1 | head -1)"

install -d -m 0755 /usr/local/libexec /usr/local/share/dsh/runtime-etc
install -m 0755 "$HERE/dsh-netns-bwrap" /usr/local/libexec/dsh-netns-bwrap
install -m 0644 "$HERE/hosts" /usr/local/share/dsh/runtime-etc/hosts
install -m 0644 "$HERE/nsswitch.conf" /usr/local/share/dsh/runtime-etc/nsswitch.conf
install -m 0644 "$HERE/resolv.conf" /usr/local/share/dsh/runtime-etc/resolv.conf

echo "== 2. interpreter: the distribution's python3 =="
if ! pick_python >/dev/null 2>&1; then
  if [ "$PKG" = apt ]; then
    pkg_install python3 python3-venv python3-pip
  else
    # RHEL-family has no python3-venv: venv and ensurepip ship inside each
    # versioned interpreter package, and the default python3 may be too old
    # (3.6 on CentOS 7, 3.9 on RHEL 9), so prefer the newest available.
    pkg_install python3.12 python3.12-pip || pkg_install python3.11 python3.11-pip \
      || pkg_install python39 python39-pip || pkg_install python3 python3-pip || true
  fi
fi
PY_BIN="$(pick_python || true)"
if [ -z "$PY_BIN" ]; then
  echo "   FAIL: no python3 >= 3.8 with venv+ensurepip." >&2
  echo "         apt: install python3 python3-venv python3-pip" >&2
  echo "         dnf: install python3.12 python3.12-pip (or python3.11 / python39)" >&2
  exit 1
fi
# Publish the chosen interpreter at ONE deterministic path. Bare `python3` is not
# safe to name in the contract: what it resolves to follows the PATH of whoever
# started the Server (sudo's secure_path puts /bin ahead of /usr/local/bin), and
# the distribution's own python3 can be older than uv supports (3.6 on RHEL 8
# lineage). /usr/local/bin is ro-bound like the rest of /usr, so the symlink is
# visible to every session and cannot be modified from inside one.
ln -sfn "$PY_BIN" /usr/local/bin/python3
printf '   contract path /usr/local/bin/python3 -> %s\n' "$PY_BIN"
printf '   %s\n' "$(/usr/local/bin/python3 -VV 2>&1 | head -1)"
/usr/local/bin/python3 -c 'import ensurepip, venv; print("   venv+ensurepip ok")'

echo "== 3. uv at /usr/local/bin/uv =="
if [ ! -x /usr/local/bin/uv ]; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
fi
chmod 0755 /usr/local/bin/uv /usr/local/bin/uvx 2>/dev/null || true
/usr/local/bin/uv --version 2>/dev/null || echo "   note: uv did not report a version"

echo "== 3b. node at /usr/local/bin/node =="
# Same rule as Python: an agent can only run what lives under a bound prefix, so
# a node installed under $HOME (nvm) or /opt is invisible inside every session.
if [ "$WITH_NODE" -eq 0 ]; then
  echo "   SKIPPED (--no-node): agents cannot run node, npm, or pnpm in a session"
elif [ -x /usr/local/bin/node ]; then
  printf '   already present: %s\n' "$(/usr/local/bin/node -v)"
else
  case "$NODE_VERSION" in
    lts22|lts|'')
      NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json         | /usr/local/bin/python3 -c 'import json,sys
for row in json.load(sys.stdin):
    if row["version"].startswith("v22."):
        print(row["version"][1:]); break')" || true
      [ -n "${NODE_VERSION:-}" ] || { echo "   FAIL: could not resolve the newest 22.x; pass --node-version X.Y.Z" >&2; exit 1; }
      ;;
    *) NODE_VERSION="${NODE_VERSION#v}" ;;
  esac
  case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) echo "   FAIL: unsupported architecture $(uname -m); install node under /usr/local yourself" >&2; exit 1 ;;
  esac
  NODE_TARBALL="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  echo "   fetching $NODE_TARBALL"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL" -o "/tmp/$NODE_TARBALL"
  # --strip-components=1 lands bin/, lib/node_modules, include/, share/ directly in
  # /usr/local, which is where npm then expects its global prefix.
  tar -xJf "/tmp/$NODE_TARBALL" -C /usr/local --strip-components=1
  rm -f "/tmp/$NODE_TARBALL"
  printf '   node %s, npm %s\n' "$(/usr/local/bin/node -v 2>/dev/null || echo unknown)" \
    "$(kit_npm -v 2>/dev/null || echo unknown)"
fi
if [ "$WITH_NODE" -eq 1 ] && [ "$WITH_PNPM" -eq 1 ] && [ ! -x /usr/local/bin/pnpm ]; then
  # Installed BEFORE the read-only lock: a global install from inside a session
  # would fail EROFS, which is exactly what the contract tells the model. A
  # failure here must not abort the install — node and npm are already usable.
  if kit_npm install -g "pnpm@$PNPM_VERSION" >/dev/null 2>&1; then
    printf '   pnpm %s\n' "$(kit_pnpm -v 2>/dev/null || echo unknown)"
  else
    echo "   note: pnpm@$PNPM_VERSION did not install; agents can still use npm"
  fi
fi

echo "== 4. optional index config under /etc =="
# Both files are mirror-free by default: agents install from the public index.
# They still matter, because uv.toml pins link-mode=copy (hardlinks fail across
# filesystems) and python-downloads=never (the project HOME must not gain runtimes).
# Never put credentials in them: agents can cat /etc/pip.conf.
install -m 0644 "$HERE/pip.conf" /etc/pip.conf
install -d -m 0755 /etc/uv
install -m 0644 "$HERE/uv.toml" /etc/uv/uv.toml

echo "== 5. contract skill at $SKILL_ROOT =="
install -d -m 0755 "$SKILL_ROOT"
# A renamed kit skill must not survive beside its replacement, or a session sees
# two skills for the same contract.
rm -rf "$SKILL_ROOT/python-env"
cp -r "$HERE/skills/." "$SKILL_ROOT/"
chmod -R a-w "$SKILL_ROOT"

echo "== 6. harden the files this kit installed =="
# The read-only guarantee agents actually hit is the MOUNT, not the mode bits:
# the strict profile ro-binds /usr, so nothing under /usr/local is writable
# inside a session whatever the host permissions say
# (packages/sandbox/sandbox-local/src/profiles.ts:19-45). Locking host-side is
# defense in depth for the kit's own files only.
#
# Never lock /usr/local wholesale. Vendor trees there reject chmod even as root
# — Aliyun aegis (/usr/local/aegis) is protected by a kernel module — and a
# blanket chmod under `set -e` aborts the install halfway. Pass --lock-all only
# on a host you know has no such tree.
KIT_OWN_PATHS=(/usr/local/bin/uv /usr/local/bin/uvx /usr/local/share/dsh
               /usr/local/libexec/dsh-netns-bwrap
               /etc/pip.conf /etc/uv/uv.toml
               /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx
               /usr/local/bin/pnpm /usr/local/lib/node_modules)
# A container image installs the interpreter itself, so its real files are ours
# too. On a host install /usr/local/bin/python3 is a symlink into /usr, which the
# ro-bind already protects: locking it would chmod the distribution's file.
for cand in /usr/local/bin/python3 /usr/local/bin/python3.1[0-9] /usr/local/lib/python3.*; do
  [ -e "$cand" ] && [ ! -L "$cand" ] && KIT_OWN_PATHS+=("$cand")
done

lock_one() {
  local target="$1" failures=0
  chown -R root:root "$target" 2>/dev/null || failures=$((failures + 1))
  chmod -R a-w "$target" 2>/dev/null || failures=$((failures + 1))
  if [ "$failures" -eq 0 ]; then
    echo "   locked $target"
  else
    echo "   note: could not fully lock $target (left as installed; the ro-bind still protects it)"
  fi
}
for target in "${KIT_OWN_PATHS[@]}"; do
  [ -e "$target" ] || continue
  lock_one "$target"
done

if [ "$WITH_LOCK" -eq 1 ]; then
  echo "   --lock-all: locking the whole of /usr/local, tolerating protected trees"
  chown -R root:root /usr/local 2>/dev/null || echo "   note: some chown failures under /usr/local (vendor-protected files)"
  chmod -R a-w /usr/local 2>/dev/null || echo "   note: some chmod failures under /usr/local (vendor-protected files)"
elif [ "$WITH_LOCK" -eq 2 ]; then
  echo "   SKIPPED (--no-lock): nothing was hardened host-side. Agents still cannot"
  echo "   write under /usr (the bind is read-only), but any other host process can."
fi

echo "== 7. sandbox prerequisites =="
# Unprivileged user namespaces are what bubblewrap needs; no capability required.
maxns="$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo unknown)"
echo "   user.max_user_namespaces = $maxns"
if [ "$maxns" = "0" ]; then
  echo "   FAIL: set it nonzero, e.g. sysctl -w user.max_user_namespaces=15000" >&2
  exit 1
fi
if [ "$PKG" != apt ] && command -v getenforce >/dev/null 2>&1; then
  selinux="$(getenforce 2>/dev/null || echo unknown)"
  echo "   SELinux = $selinux"
  if [ "$selinux" = Enforcing ]; then
    echo "   note: if the bwrap probe in verify.sh fails while SELinux is Enforcing,"
    echo "         confirm with 'setenforce 0' and then keep a policy module rather"
    echo "         than leaving the host permissive"
  fi
elif [ "$PKG" = apt ]; then
  echo "   note: Ubuntu 24.04 needs kernel.apparmor_restrict_unprivileged_userns=0"
fi

if [ -z "$SERVICE_USER" ]; then
  echo "== 8-10. skipped (--no-service-user) =="
  echo "   copy the resident contract into the running user's DSH_HOME:"
  echo "     install -m 0600 $HERE/cordis.patch.yml \"\${DSH_HOME:-\$HOME/.dsh}/cordis.patch.yml\""
  echo "   and export these before starting the Server:"
  echo "     DSH_BUNDLED_SKILL_DIR=$SKILL_ROOT  UV_PYTHON_DOWNLOADS=never"
  echo
  contract_summary || exit 1

  echo "== next steps =="
  echo "  1. $HERE/verify.sh --bwrap-probe        # must be all ok"
  echo "  2. capacity: a quota on the data volume, and workspace-gc.sh nightly"
  exit 0
fi

echo "== 8. service user and directories =="
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --uid "$SERVICE_UID" --home-dir "$DSH_HOME_DIR" --create-home \
    --shell /sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --uid "$SERVICE_UID" --home-dir "$DSH_HOME_DIR" --create-home \
         --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DSH_HOME_DIR" "$DATA_DIR"

echo "== 9. deployment patch (resident persona) =="
# The base bundle mounts system-prompt.persona empty and calls it a deployment
# choice; $DSH_HOME/AGENTS.md would be silently ignored under strictReads.
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 \
  "$HERE/cordis.patch.yml" "$DSH_HOME_DIR/cordis.patch.yml"

if [ "$WITH_SYSTEMD" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
  echo "== 10. systemd unit =="
  DSH_BIN="$(command -v dsh || true)"
  if [ -z "$DSH_BIN" ] || [ ! -x "$DSH_BIN" ]; then
    echo "   FAIL: install the pinned dsh release on PATH, then rerun this installer" >&2
    exit 1
  fi
  sed -e "s|@DSH_HOME@|$DSH_HOME_DIR|g" \
      -e "s|@DATA_DIR@|$DATA_DIR|g" \
      -e "s|@SERVICE_USER@|$SERVICE_USER|g" \
      -e "s|@DSH_BIN@|$DSH_BIN|g" \
      "$HERE/dsh-server.service" > /etc/systemd/system/dsh-server.service
  systemctl daemon-reload
  echo "   wrote /etc/systemd/system/dsh-server.service (dsh at $DSH_BIN)"
  echo "   next: put the model credential in the unit's environment or a drop-in,"
  echo "         then: systemctl enable --now dsh-server"
else
  echo "== 10. systemd skipped =="
  echo "   run as the service user:"
  echo "     sudo -u $SERVICE_USER env DSH_HOME=$DSH_HOME_DIR \\"
  echo "       DSH_BUNDLED_SKILL_DIR=$SKILL_ROOT UV_PYTHON_DOWNLOADS=never \\"
  echo "       dsh server --host 127.0.0.1 --port 3080 --data-dir $DATA_DIR"
fi

echo
contract_summary || exit 1

echo "== next steps =="
echo "  1. $HERE/verify.sh --bwrap-probe        # must be all ok"
echo "  2. capacity: a quota on $DATA_DIR, and workspace-gc.sh nightly"
