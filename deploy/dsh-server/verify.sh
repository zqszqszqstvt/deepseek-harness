#!/usr/bin/env bash
# Host-side acceptance checks for a dsh server cloud image.
#
#   ./verify.sh                     static checks against the running host/image
#   ./verify.sh --bwrap-probe [WS]  also run the strict namespace and assert what
#                                   an agent actually sees (default WS: a temp dir)
#
# The in-namespace truth is owned by packages/sandbox/sandbox-local/src/
# profiles.ts:19-45; --bwrap-probe replicates those arguments on purpose, so if
# that file changes, this probe must change with it.
set -uo pipefail

FAILURES=0
PROBE=0
WS_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bwrap-probe) PROBE=1; WS_ARG="${2:-}"; [ $# -ge 2 ] && shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  warn  %s\n' "$1"; }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

PYTHON=python3
UV=/usr/local/bin/uv
SKILL_ROOT="${DSH_BUNDLED_SKILL_DIR:-/usr/local/share/dsh/skills}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DATA_DIR="${DSH_DATA_DIR:-$DSH_HOME_DIR/server-data}"

echo "== 1. sandbox runtime =="
check "bubblewrap installed" 'command -v bwrap'
check "/lib64 exists (bwrap ro-binds it unconditionally)" 'test -d /lib64'
maxns="$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo unknown)"
if [ "$maxns" = "0" ]; then
  bad "user.max_user_namespaces=0 — bubblewrap cannot create a namespace"
elif [ "$maxns" = "unknown" ]; then
  warn "user.max_user_namespaces not readable"
else
  ok "user.max_user_namespaces=$maxns"
fi
if [ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  aa="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)"
  if [ "$aa" != "0" ]; then
    bad "kernel.apparmor_restrict_unprivileged_userns=$aa (Ubuntu 24.04: set it to 0)"
  else
    ok "apparmor allows unprivileged user namespaces"
  fi
fi
if command -v getenforce >/dev/null 2>&1; then
  selinux="$(getenforce 2>/dev/null || echo unknown)"
  printf '  info  SELinux=%s\n' "$selinux"
  if [ "$selinux" = Enforcing ]; then
    warn "SELinux Enforcing: if --bwrap-probe fails, confirm with 'setenforce 0' and then fix policy rather than staying permissive"
  fi
fi

echo "== 2. shared read-only layer =="
check "$PYTHON on PATH" "command -v $PYTHON"
check "$PYTHON reports a version" "$PYTHON -V"
printf '  info  %s -> %s
' "$PYTHON" "$(command -v "$PYTHON" 2>/dev/null)"
check "$PYTHON has venv + ensurepip (Debian splits these out)" \
  "$PYTHON -c 'import ensurepip, venv'"
check "$UV executable" "$UV --version"
check "/usr/local/bin/uvx present" 'test -x /usr/local/bin/uvx'
if [ -f /etc/pip.conf ]; then ok "/etc/pip.conf present"; else warn "/etc/pip.conf absent — pip uses the public index"; fi
if [ -f /etc/uv/uv.toml ]; then ok "/etc/uv/uv.toml present"; else warn "/etc/uv/uv.toml absent — uv uses the public index and its own defaults"; fi
if grep -Eq '://[^/[:space:]]+:[^@[:space:]]+@' /etc/pip.conf /etc/uv/uv.toml 2>/dev/null; then
  bad "index URL contains credentials (agents can cat /etc/pip.conf)"
else
  ok "index config carries no credentials"
fi
# The authoritative read-only guarantee is the mount, asserted by --bwrap-probe.
# Host-side, only check that what the kit installed is not group/world writable:
# a blanket chmod of /usr/local is neither portable (vendor trees such as Aliyun
# aegis reject it even as root) nor necessary.
writable="$(find /usr/local/bin/uv /usr/local/bin/uvx /usr/local/share/dsh   /etc/pip.conf /etc/uv/uv.toml -perm /022 -print -quit 2>/dev/null)"
if [ -n "$writable" ]; then
  bad "group/world writable shared file: $writable"
else
  ok "kit-owned shared files are not group/world writable"
fi

echo "== 3. contract skill (bundled root) =="
check "$SKILL_ROOT/python-env/SKILL.md exists" "test -f '$SKILL_ROOT/python-env/SKILL.md'"
check "skill has frontmatter name" "grep -q '^name: python-env' '$SKILL_ROOT/python-env/SKILL.md'"
check "skill has frontmatter description" "grep -q '^description: ' '$SKILL_ROOT/python-env/SKILL.md'"
if [ -n "${DSH_BUNDLED_SKILL_DIR:-}" ]; then
  ok "DSH_BUNDLED_SKILL_DIR=$DSH_BUNDLED_SKILL_DIR"
else
  warn "DSH_BUNDLED_SKILL_DIR unset — the skill root will not be discovered"
fi
# These two are the silent traps: both are read through ctx.fs, which Server
# sessions fence to the workspace, so anything placed there is ignored with no error.
for trap_dir in "$DSH_HOME_DIR/skills" "${DSH_AGENTS_HOME:-$HOME/.agents}/skills"; do
  if [ -d "$trap_dir" ] && [ -n "$(ls -A "$trap_dir" 2>/dev/null)" ]; then
    warn "$trap_dir is NOT readable by Server sessions (strictReads); move it to $SKILL_ROOT"
  fi
done
if [ -f "$DSH_HOME_DIR/AGENTS.md" ]; then
  warn "$DSH_HOME_DIR/AGENTS.md is NOT loaded by Server sessions; use system-prompt.persona"
fi

echo "== 4. deployment patch (resident persona) =="
PATCH="$DSH_HOME_DIR/cordis.patch.yml"
check "$PATCH exists" "test -f '$PATCH'"
check "patch overrides system-prompt" "grep -q 'id: system-prompt' '$PATCH'"
check "patch sets a persona" "grep -q 'persona:' '$PATCH'"
if grep -q '{{' "$PATCH" 2>/dev/null; then
  bad "persona contains '{{' — strict interpolation throws at assembly"
else
  ok "persona contains no template braces"
fi

echo "== 5. service environment =="
for var in PIP_CACHE_DIR UV_CACHE_DIR CONDA_PKGS_DIRS MAMBA_ROOT_PREFIX; do
  if [ -n "${!var:-}" ]; then
    bad "$var=${!var} is forwarded into the sandbox, where that host path does not exist"
  fi
done
[ "$FAILURES" -eq 0 ] && ok "no host cache paths exported into the sandbox"
check "data directory exists ($DATA_DIR)" "test -d '$DATA_DIR'"
if [ -d "$DATA_DIR" ]; then
  printf '  info  %s owner=%s mode=%s\n' "$DATA_DIR" \
    "$(stat -c '%U' "$DATA_DIR" 2>/dev/null)" "$(stat -c '%a' "$DATA_DIR" 2>/dev/null)"
fi

if [ "$PROBE" -eq 1 ]; then
  echo "== 6. strict namespace probe =="
  WS="${WS_ARG:-$(mktemp -d)}"
  [ -n "$WS_ARG" ] || trap 'rm -rf "$WS"' EXIT
  # Mirrors bwrapProfileArgs(policy, strictFilesystem = true) for workspace-write.
  bwrap \
    --tmpfs / \
    --ro-bind /usr /usr \
    --ro-bind /bin /bin \
    --ro-bind /sbin /sbin \
    --ro-bind /lib /lib \
    --ro-bind /lib64 /lib64 \
    --ro-bind /etc /etc \
    --ro-bind /run /run \
    --dev /dev --unshare-pid --proc /proc --die-with-parent \
    --ro-bind "$WS" "$WS" \
    --tmpfs /tmp \
    --bind "$WS" "$WS" \
    --remount-ro / \
    --setenv PROBE_WS "$WS" \
    -- bash -c '
      fail=0
      p_ok()  { printf "  ok    %s\n" "$1"; }
      p_bad() { printf "  FAIL  %s\n" "$1"; fail=1; }
      t() { if eval "$2" >/dev/null 2>&1; then p_ok "$1"; else p_bad "$1"; fi; }
      t "shared interpreter visible"        "command -v python3"
      t "shared installer visible"          "command -v /usr/local/bin/uv"
      t "/etc/pip.conf readable"            "cat /etc/pip.conf"
      t "workspace writable"                "touch \"$PROBE_WS/.probe\" && rm -f \"$PROBE_WS/.probe\""
      t "/tmp writable (per-call tmpfs)"    "touch /tmp/.probe && rm -f /tmp/.probe"
      t "/usr/local rejects writes"         "! touch /usr/local/.probe"
      t "/etc rejects writes"               "! touch /etc/.probe"
      t "\$HOME is absent"                  "[ -z \"${HOME:-}\" ] || [ ! -d \"$HOME\" ]"
      t "/opt is absent"                    "[ ! -e /opt ]"
      t "/srv is absent"                    "[ ! -e /srv ]"
      t "/var is absent"                    "[ ! -e /var/lib ]"
      t "network reachable"                 "python3 -c \"import urllib.request as u; u.urlopen(\\\"https://pypi.org/simple/\\\", timeout=8)\""
      exit $fail
    ' || FAILURES=$((FAILURES + 1))
fi

echo
echo "== 7. end-to-end against a live server (run these yourself) =="
cat <<'EOF'
  U=alice; P=demo
  curl -s -X PUT  localhost:3080/v1/users/$U/projects/$P/session
  curl -s -N      localhost:3080/v1/users/$U/projects/$P/events &
  curl -s -X POST localhost:3080/v1/users/$U/projects/$P/turns \
    -H 'content-type: application/json' \
    -d '{"message":"列出你可用的 skills，然后用 python-env skill 在工作区建 .venv 并安装 requests，最后做三重验证。"}'
  # Expect: python-env listed; .venv created under the workspace; the shared
  # interpreter still raises ModuleNotFoundError; no path outside the workspace.
EOF

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "verify.sh: all checks passed"
else
  echo "verify.sh: $FAILURES check(s) failed"
fi
exit "$([ "$FAILURES" -eq 0 ] && echo 0 || echo 1)"
