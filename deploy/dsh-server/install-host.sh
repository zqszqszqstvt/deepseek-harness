#!/usr/bin/env bash
# Bare-metal installer for the dsh server cloud runtime contract.
# Supports apt (Debian/Ubuntu) and dnf/yum (RHEL, Rocky, Alma, Fedora, Amazon Linux).
# Idempotent: re-running it only repairs what is missing. Requires root.
#
#   sudo ./install-host.sh [--data-dir DIR] [--dsh-home DIR] [--no-systemd]
#                          [--no-service-user] [--no-lock]
#
# --no-service-user skips the service user, the data directories, the deployment
# patch, and the unit: use it when the Server is started by hand (for example
# `pnpm dsh server` from a checkout) under an existing login user, then copy
# cordis.patch.yml into that user's own $DSH_HOME.
# --no-lock skips the read-only lock on /usr/local, for hosts that keep writable
# tooling there (a tarball Node, a global pnpm). Without the lock the shared
# layer must be protected some other way, or a user's agent can modify what
# another user's agent imports.
#
# It installs the same layout the Dockerfile produces, so verify.sh accepts both:
#   python3 (distribution), /usr/local/bin/uv        shared, read-only
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
WITH_LOCK=1

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="${2:?}"; shift 2 ;;
    --dsh-home) DSH_HOME_DIR="${2:?}"; shift 2 ;;
    --no-systemd) WITH_SYSTEMD=0; shift ;;
    --no-service-user) SERVICE_USER=""; shift ;;
    --no-lock) WITH_LOCK=0; shift ;;
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
  pkg_install bubblewrap ca-certificates curl git xz-utils
else
  "$PKG" makecache -q >/dev/null 2>&1 || "$PKG" makecache >/dev/null 2>&1 || true
  pkg_install bubblewrap ca-certificates curl git xz which
fi
command -v bwrap >/dev/null || { echo "   FAIL: bubblewrap did not install (on CentOS 7 it needs EPEL)" >&2; exit 1; }
[ -d /lib64 ] || install -d /lib64
echo "   bwrap $(bwrap --version 2>&1 | head -1)"

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
# The contract names plain `python3`. On RHEL-family that name may be missing or
# point at an interpreter too old for uv, so publish the chosen one under
# /usr/local/bin, which precedes /usr/bin on PATH and is ro-bound like it.
if [ "$(command -v python3 2>/dev/null || echo none)" != "$PY_BIN" ]; then
  ln -sfn "$PY_BIN" /usr/local/bin/python3
  echo "   linked /usr/local/bin/python3 -> $PY_BIN"
fi
printf '   %s at %s\n' "$(/usr/local/bin/python3 -VV 2>&1 | head -1 || "$PY_BIN" -VV 2>&1 | head -1)" \
  "$(command -v python3)"
/usr/local/bin/python3 -c 'import ensurepip, venv; print("   venv+ensurepip ok")' 2>/dev/null \
  || "$PY_BIN" -c 'import ensurepip, venv; print("   venv+ensurepip ok")'

echo "== 3. uv at /usr/local/bin/uv =="
if [ ! -x /usr/local/bin/uv ]; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
fi
chmod 0755 /usr/local/bin/uv /usr/local/bin/uvx 2>/dev/null || true
/usr/local/bin/uv --version

echo "== 4. optional index config under /etc =="
# Both files are mirror-free by default: agents install from the public index.
# They still matter, because uv.toml pins link-mode=copy (hardlinks fail across
# filesystems) and python-downloads=never (there is no $HOME in the sandbox).
# Never put credentials in them: agents can cat /etc/pip.conf.
install -m 0644 "$HERE/pip.conf" /etc/pip.conf
install -d -m 0755 /etc/uv
install -m 0644 "$HERE/uv.toml" /etc/uv/uv.toml

echo "== 5. contract skill at $SKILL_ROOT =="
install -d -m 0755 "$SKILL_ROOT"
cp -r "$HERE/skills/." "$SKILL_ROOT/"
chmod -R a-w "$SKILL_ROOT"

echo "== 6. lock the shared layer read-only =="
if [ "$WITH_LOCK" -eq 1 ]; then
  # Per-user installs belong in a workspace .venv; writing here must fail EROFS.
  chown -R root:root /usr/local
  chmod -R a-w /usr/local
  echo "   /usr/local is now read-only (pass --no-lock to skip)"
else
  echo "   SKIPPED (--no-lock): agents can modify the shared layer, so isolation"
  echo "   now depends on whatever else protects /usr/local"
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
  DSH_BIN="$(command -v dsh || echo /usr/local/bin/dsh)"
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
echo "== next steps =="
echo "  1. $HERE/verify.sh --bwrap-probe        # must be all ok"
echo "  2. capacity: a quota on $DATA_DIR, and workspace-gc.sh nightly"
