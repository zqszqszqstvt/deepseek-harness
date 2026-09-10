#!/usr/bin/env bash
# Bare-metal installer for the dsh server cloud runtime contract (Debian/Ubuntu).
# Idempotent: re-running it only repairs what is missing. Requires root.
#
#   sudo ./install-host.sh [--data-dir DIR] [--dsh-home DIR] [--no-systemd]
#                          [--no-service-user]
#
# --no-service-user skips the service user, the data directories, the deployment
# patch, and the unit: use it when the Server is started by hand (for example
# `pnpm dsh server` from a checkout) under an existing login user, then copy
# cordis.patch.yml into that user's own $DSH_HOME.
#
# It installs the same layout the Dockerfile produces, so verify.sh accepts both:
#   python3 (distribution), /usr/local/bin/uv        shared, read-only
#   /etc/pip.conf, /etc/uv/uv.toml                   package mirrors
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

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="${2:?}"; shift 2 ;;
    --dsh-home) DSH_HOME_DIR="${2:?}"; shift 2 ;;
    --no-systemd) WITH_SYSTEMD=0; shift ;;
    --no-service-user) SERVICE_USER=""; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
[ -f /etc/os-release ] || { echo "no /etc/os-release; this installer targets Debian/Ubuntu" >&2; exit 1; }
. /etc/os-release
echo "== target: ${PRETTY_NAME:-unknown} =="

echo "== 1. system packages =="
# bubblewrap is mandatory: without it every shell call fails closed with
# SANDBOX_UNAVAILABLE. /lib64 must exist because sandbox-local ro-binds it
# unconditionally (packages/sandbox/sandbox-local/src/profiles.ts:19-45).
apt-get update -qq
apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git xz-utils
[ -d /lib64 ] || install -d /lib64

echo "== 2. interpreter: the distribution's python3 =="
# /usr/bin is ro-bound by the strict profile, so the distribution interpreter is
# already visible to every agent. What is NOT optional is venv+ensurepip: Debian
# and Ubuntu split them out, and without them `python3 -m venv .venv` fails.
apt-get install -y --no-install-recommends python3 python3-venv python3-pip
command -v python3 >/dev/null || { echo "   FAIL: python3 still missing" >&2; exit 1; }
python3 -c 'import ensurepip, venv; print("   venv+ensurepip ok")' || {
  echo "   FAIL: python3 lacks venv/ensurepip; install python3-venv for this release" >&2; exit 1; }
printf '   %s at %s
' "$(python3 -VV 2>&1 | head -1)" "$(command -v python3)"

echo "== 3. uv at /usr/local/bin/uv =="
if [ ! -x /usr/local/bin/uv ]; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
fi
chmod 0755 /usr/local/bin/uv /usr/local/bin/uvx 2>/dev/null || true
/usr/local/bin/uv --version

echo "== 4. package mirrors under /etc =="
# Replace these two files with your internal mirror BEFORE running this, or edit
# them afterwards. Never put credentials in them: agents can cat /etc/pip.conf.
install -m 0644 "$HERE/pip.conf" /etc/pip.conf
install -d -m 0755 /etc/uv
install -m 0644 "$HERE/uv.toml" /etc/uv/uv.toml

echo "== 5. contract skill at $SKILL_ROOT =="
install -d -m 0755 "$SKILL_ROOT"
cp -r "$HERE/skills/." "$SKILL_ROOT/"
chmod -R a-w "$SKILL_ROOT"

echo "== 6. lock the shared layer read-only =="
# Per-user installs belong in a workspace .venv; writing here must fail with EROFS.
chown -R root:root /usr/local
chmod -R a-w /usr/local

if [ -z "$SERVICE_USER" ]; then
  echo "== 7-9. skipped (--no-service-user) =="
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

echo "== 7. service user and directories =="
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --uid "$SERVICE_UID" --home-dir "$DSH_HOME_DIR" --create-home \
    --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DSH_HOME_DIR" "$DATA_DIR"

echo "== 8. deployment patch (resident persona) =="
# The base bundle mounts system-prompt.persona empty and calls it a deployment
# choice; $DSH_HOME/AGENTS.md would be silently ignored under strictReads.
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 \
  "$HERE/cordis.patch.yml" "$DSH_HOME_DIR/cordis.patch.yml"

if [ "$WITH_SYSTEMD" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
  echo "== 9. systemd unit =="
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
  echo "== 9. systemd skipped =="
  echo "   run as the service user:"
  echo "     sudo -u $SERVICE_USER env DSH_HOME=$DSH_HOME_DIR \\"
  echo "       DSH_BUNDLED_SKILL_DIR=$SKILL_ROOT UV_PYTHON_DOWNLOADS=never \\"
  echo "       dsh server --host 127.0.0.1 --port 3080 --data-dir $DATA_DIR"
fi

echo
echo "== next steps =="
echo "  1. edit /etc/pip.conf and /etc/uv/uv.toml to your internal mirror"
echo "  2. $HERE/verify.sh --bwrap-probe        # must be all ok"
echo "  3. capacity: XFS project quota on $DATA_DIR, and workspace-gc.sh nightly"
