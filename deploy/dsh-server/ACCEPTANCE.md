# dsh server cloud runtime acceptance runbook

English-only runbook (an operator script, not a paired document). Chinese turn payloads are intentional: they are prompts to the model.

This runbook proves, on a live multi-user [`dsh server`](../../packages/bundle/server/README.md) deployment, that the [runtime contract](README.md) actually holds: agents can build Python and Node environments inside their own workspace, the shared layer stays read-only, one user cannot reach another user's files, oversized output is recoverable from a path the model can open, and an escaping `workdir` is refused before any process is spawned.

It is written to be driven by an AI operator. Every check has a mechanical pass condition: an exit code, a file test, or an exact string. Nothing requires judgement.

## Operator rules

1. Never use `sudo` in phases 1-8. The Server runs as the login user, and `sudo` changes `$HOME`, which changes which `cordis.patch.yml` and data directory the checks read.
2. Never edit `~/.dsh/*.yaml`, never print `~/.dsh/.credentials.yaml`, never kill a process this runbook did not start.
3. Generate every turn payload with `python3` into a file and post it with `--data-binary @file`. Never hand-type multi-line JSON on a command line: a terminal that wraps the line inserts a real newline into the JSON string, the Server's body parse fails, and the client only sees the generic `server request failed`.
4. `POST /turns` blocks until the turn settles. Always pass `--max-time`.
5. Judge each turn with `show-history.py` (exit 0 = pass, 1 = contract mismatch, 2 = transport/server fault) plus the host-side file tests, which are the ground truth. On exit 2, read the server log and stop; do not retry blindly.
6. Record evidence lines verbatim in the final report. Do not summarise a failure into a pass.

## Phase 0 — host precondition

```bash
cd ~/agent/deepseek-harness/deploy/dsh-server
./verify.sh --bwrap-probe
```

Pass: the last line is `verify.sh: all checks passed`. A `warn` about bare `python3` pointing into a conda directory is expected and is exactly why the contract names absolute paths. Any `FAIL` stops the run: fix the host first (see the [README](README.md) directory contract).

## Phase 1 — variables and payloads

```bash
PORT=3081
HOST=127.0.0.1
U1=acca; U2=accb; P=acc
UH=$(printf '%s' "$U1" | sha256sum | cut -d' ' -f1)
PH=$(printf '%s' "$P"  | sha256sum | cut -d' ' -f1)
WS_A="$HOME/.dsh/server-data/users/$UH/projects/$PH/workspace"
B1="$HOST:$PORT/v1/users/$U1/projects/$P"
B2="$HOST:$PORT/v1/users/$U2/projects/$P"
KIT=~/agent/deepseek-harness/deploy/dsh-server
mkdir -p /tmp/dsh-acceptance && cd /tmp/dsh-acceptance
echo "$WS_A"
```

If the Server was started with a non-default `--data-dir`, set `WS_A` to `<data-dir>/users/$UH/projects/$PH/workspace` instead.

Generate all seven payloads at once (valid JSON by construction):

```bash
WS_A="$WS_A" python3 - <<'PY'
import json, os
ws = os.environ['WS_A']
turns = {
 't1': '先列出你当前可用的 skills 名字。然后调用 runtime-env skill，在工作区里用 uv 建 .venv，'
       '并用后台任务安装 requests，缓存放在 $PWD/.cache/uv，日志写到 $PWD/.cache/install.log。'
       '完成后做三重验证：.venv/bin/python 能 import requests 并打印版本；'
       '用 .venv/bin/python 跑一个打印 requests.__version__ 的脚本；'
       '/usr/local/bin/python3 -c "import requests" 必须失败。每一步都把工具返回的原文贴出来，不要改写。',
 't2': '在工作区里用 node 建一个最小项目：写 package.json，然后用 npm 安装 is-number，'
       '缓存必须放在工作区内（npm_config_cache="$PWD/.cache/npm"），日志写到 $PWD/.cache/npm.log。'
       '不要使用 -g。装完用 /usr/local/bin/node -e "console.log(require(\'is-number\')(5))" 验证，'
       '并把工具返回的原文贴出来。',
 't3': '用 read 工具读这个文件的前 5 行，把工具返回的原文贴给我，不要重试、不要改用 shell：' + ws + '/.venv/pyvenv.cfg',
 't4': '用 shell 执行这一条命令：{ echo HEAD-MARKER-0001; for i in $(seq 1 20000); do echo "line-$i"; done; echo TAIL-MARKER-9999; } '
       '然后用 read 工具读取结果里 full output 指向的那个文件的前 5 行，把工具返回的原文贴出来。',
 't5': '用 shell 工具执行 pwd，workdir 参数必须传 /etc。不要改目录、不要重试、不要申请权限，把工具返回的原文贴给我。',
 't6': '用一次 shell 调用执行下面这些探测，并把工具返回的原文完整贴出来：'
       '/usr/local/bin/python3 -VV; /usr/local/bin/uv --version; /usr/local/bin/node -v; '
       'touch /usr/local/dsh-write-test 2>&1 | tail -1; echo "HOME=$HOME"; ls -d "$HOME" 2>&1 | tail -1; '
       'ls -d /opt 2>&1 | tail -1; touch ./ws-write-test && echo workspace-writable && rm -f ./ws-write-test',
 't7': '分两次独立的 shell 工具调用完成：第一次执行 echo probe-value > /tmp/dsh-probe && cat /tmp/dsh-probe；'
       '第二次执行 cat /tmp/dsh-probe 2>&1 | tail -1。两次的工具返回原文都贴出来。',
}
for name, message in turns.items():
    with open(f'/tmp/dsh-acceptance/{name}.json', 'w', encoding='utf-8') as handle:
        json.dump({'message': message}, handle, ensure_ascii=False)
print('wrote', ', '.join(sorted(turns)))
PY
python3 -c 'import json,glob;[json.load(open(f,encoding="utf-8")) for f in sorted(glob.glob("/tmp/dsh-acceptance/t*.json"))];print("all payloads are valid JSON")'
```

Confirm the running Server actually carries the contract:

```bash
pid=$(pgrep -f 'apps/cli/src/bin.ts server' | head -1); echo "pid=$pid"
tr '\0' '\n' < /proc/$pid/environ | grep -E '^(DSH_BUNDLED_SKILL_DIR|UV_PYTHON_DOWNLOADS)='
cd ~/agent/deepseek-harness && pnpm dsh server --dump-config 2>/dev/null | grep -c 'Runtime contract for cloud sessions'
```

Pass: the two environment lines are present and the count is `1`. If the count is `0`, `$DSH_HOME/cordis.patch.yml` is missing or the Server was started before it was installed — restart the Server, do not continue.

## Phase 2 — sessions and event stream

```bash
curl -s -X PUT "$B1/session" | head -c 300; echo
curl -s -X PUT "$B2/session" | head -c 300; echo
ls -ld "$WS_A"
: > /tmp/dsh-acceptance/events.log
curl -sN "$B1/events" >> /tmp/dsh-acceptance/events.log &
SSE_PID=$!; echo "sse pid $SSE_PID"
```

Pass: both PUTs return `{"ok":true,...}` with `type":"cloud"` and a `rootPath` under the data directory, and `$WS_A` exists. An HTML body means the port is wrong (a reverse proxy answered).

## Phase 3 — T1 Python: the environment is usable and stays per-user

```bash
curl -s --max-time 900 -X POST "$B1/turns" -H 'content-type: application/json' --data-binary @/tmp/dsh-acceptance/t1.json; echo
"$KIT/show-history.py" --user "$U1" --project "$P" --port "$PORT" --tail 40 \
  --grep runtime-env --preview 300
test -f "$WS_A/.venv/pyvenv.cfg" && echo "pass: .venv exists"
grep -E '^home = ' "$WS_A/.venv/pyvenv.cfg"
"$WS_A/.venv/bin/python" -c 'import requests, sys; print("pass:", requests.__version__, sys.executable)'
/usr/local/bin/python3 -c 'import requests' 2>&1 | tail -1
ls -la "$WS_A/.cache" 2>/dev/null | head
```

Pass, all of:
- `show-history.py` exits 0 (`runtime-env` appears, so the bundled skill root is live);
- `.venv/pyvenv.cfg` exists and its `home =` line points into `/usr`, **not** into a conda or `$HOME` path;
- the venv interpreter imports `requests` and its `sys.executable` is inside `$WS_A`;
- `/usr/local/bin/python3 -c 'import requests'` prints `ModuleNotFoundError` (the shared layer was not touched);
- `$WS_A/.cache` exists (caches were redirected into the workspace).

## Phase 4 — T2 Node: same contract, second runtime

```bash
curl -s --max-time 900 -X POST "$B1/turns" -H 'content-type: application/json' --data-binary @/tmp/dsh-acceptance/t2.json; echo
"$KIT/show-history.py" --user "$U1" --project "$P" --port "$PORT" --tail 30 --grep is-number
test -d "$WS_A/node_modules/is-number" && echo "pass: workspace node_modules"
test ! -e /usr/local/lib/node_modules/is-number && echo "pass: no global install"
( cd "$WS_A" && /usr/local/bin/node -e 'console.log("pass:", require("is-number")(5))' )
ls -d "$WS_A/.cache/npm" 2>/dev/null
```

Pass, all of: `node_modules/is-number` is inside the workspace; `/usr/local/lib/node_modules/is-number` does **not** exist (a `-g` install would have failed EROFS anyway); `node -e` prints `pass: true`; the npm cache directory is inside the workspace.

## Phase 5 — T3 isolation: the second user cannot read the first user's files

```bash
curl -s --max-time 300 -X POST "$B2/turns" -H 'content-type: application/json' --data-binary @/tmp/dsh-acceptance/t3.json; echo
"$KIT/show-history.py" --user "$U2" --project "$P" --port "$PORT" --tail 30 \
  --grep denied --absent 'home = /usr'
test -f "$WS_A/.venv/pyvenv.cfg" && echo "pass: first user's file untouched"
```

Pass: `show-history.py` exits 0 — some event contains `denied` (the fenced read) and **no** event contains the file's content (`home = /usr`). If the content appears, isolation is broken: stop and report immediately.

The `denied` needle matches the model-facing text `file access denied under workspace-write mode`. If the deployment renders a different message, use `--grep FS_SANDBOX_DENIED` as well and record which matched.

## Phase 6 — T4 oversized output: the spill path is one the model can open

```bash
curl -s --max-time 600 -X POST "$B1/turns" -H 'content-type: application/json' --data-binary @/tmp/dsh-acceptance/t4.json; echo
"$KIT/show-history.py" --user "$U1" --project "$P" --port "$PORT" --tail 40 \
  --grep '.dsh/spill/' --grep HEAD-MARKER-0001
ls -la "$WS_A/.dsh/spill/"
grep -l HEAD-MARKER-0001 "$WS_A"/.dsh/spill/* | head -3
```

Pass, all of: the history names a path under `.dsh/spill/`; the history contains `HEAD-MARKER-0001`, which the inline truncated tail cannot contain (only the tail of the stream is inlined, so the head marker proves the model reopened the file); the spill directory holds a file whose content starts with that marker.

## Phase 7 — T5 escaping workdir is refused before spawn

```bash
curl -s --max-time 300 -X POST "$B1/turns" -H 'content-type: application/json' --data-binary @/tmp/dsh-acceptance/t5.json; echo
"$KIT/show-history.py" --user "$U1" --project "$P" --port "$PORT" --tail 20 \
  --grep 'outside the session workspace' --absent SANDBOX_UNAVAILABLE
```

Pass: exit 0. The refusal text proves the tool confined the directory itself; `SANDBOX_UNAVAILABLE` would mean the request reached the namespace and failed there instead, which is the pre-fix behaviour.

## Phase 8 — T6 and T7: the facts the contract teaches

```bash
curl -s --max-time 300 -X POST "$B1/turns" -H 'content-type: application/json' --data-binary @/tmp/dsh-acceptance/t6.json; echo
"$KIT/show-history.py" --user "$U1" --project "$P" --port "$PORT" --tail 30 \
  --grep 'Read-only file system' --grep 'No such file or directory' --grep workspace-writable
test ! -e /usr/local/dsh-write-test && echo "pass: shared layer unwritten"
test ! -e "$WS_A/ws-write-test" && echo "pass: probe file cleaned up"

curl -s --max-time 300 -X POST "$B1/turns" -H 'content-type: application/json' --data-binary @/tmp/dsh-acceptance/t7.json; echo
"$KIT/show-history.py" --user "$U1" --project "$P" --port "$PORT" --tail 30 \
  --grep probe-value --grep 'No such file or directory'
```

Pass: the shared layer rejects writes (`Read-only file system`), `$HOME` and `/opt` do not exist inside the session (`No such file or directory`), the workspace is writable, and nothing was left behind on the host; `/tmp` holds `probe-value` in the call that wrote it and is empty in the next call, which is why the contract forbids using it to carry state.

## Failure triage

| Symptom | Most likely cause | First command |
| --- | --- | --- |
| `{"ok":false,"error":"server request failed"}` | malformed JSON body (a wrapped heredoc), or a host exception logged server-side | `python3 -m json.tool < payload.json`; then `tail -60 output.log` |
| HTML from nginx instead of JSON | `$B1` points at the proxy port, not the Server | `ss -ltnp \| grep -E ':3081\|:3080'` |
| `show-history.py` exits 2 | the Server is down or the session was never created | `curl -s $HOST:$PORT/healthz`; `curl -s -X PUT "$B1/session"` |
| History has only `permission/preset`, `sandbox/mode`, `approval/policy` | the turn never ran: no live agent, or the model call failed | `tail -60 output.log` |
| Model says it has no `runtime-env` skill | `DSH_BUNDLED_SKILL_DIR` missing from the Server process environment | `tr '\0' '\n' < /proc/$pid/environ \| grep DSH_BUNDLED` |
| Model ignores the contract (uses bare `python3`, `activate`, `/tmp`, `-g`) | the persona row is not in the composition | `pnpm dsh server --dump-config \| grep -c 'Runtime contract'` |
| `pip`/`npm` install times out at 60s in the foreground | the model did not use `run_in_background` | check the turn's tool calls in the digest, then re-prompt |
| `.venv` creation fails | `venv`/`ensurepip` missing for the chosen interpreter | `./verify.sh` section 2 |

## Cleanup

```bash
kill "$SSE_PID" 2>/dev/null
curl -s -X DELETE "$B1/session"; echo
curl -s -X DELETE "$B2/session"; echo
test ! -d "$WS_A" && echo "pass: first user's project data removed"
rm -rf /tmp/dsh-acceptance
```

`DELETE .../session` removes the Server-owned project directory, which is also the retention answer for a test project. Real user workspaces are not touched by this runbook, because it uses the dedicated `acca`/`accb` identities.

## Report template

Emit exactly this, filling every line with observed output:

```markdown
# dsh server runtime acceptance — <date> <host>

host self-check: <verify.sh last line>
persona in composition: <count>
server pid / env: <pid> <DSH_BUNDLED_SKILL_DIR value>

| # | Check | Result | Evidence |
| - | ----- | ------ | -------- |
| T1 | Python env usable, stays per-user | PASS/FAIL | <pyvenv.cfg home line; requests version; ModuleNotFoundError line> |
| T2 | Node env usable, no global install | PASS/FAIL | <node -e output; absence of /usr/local/lib/node_modules/is-number> |
| T3 | Cross-user read denied | PASS/FAIL | <the denied text; confirm no file content leaked> |
| T4 | Spill path readable by the model | PASS/FAIL | <spill path; HEAD-MARKER-0001 seen in history> |
| T5 | Escaping workdir refused pre-spawn | PASS/FAIL | <refusal text> |
| T6 | Shared layer read-only, $HOME and /opt absent | PASS/FAIL | <EROFS line; No such file lines; workspace-writable> |
| T7 | /tmp does not cross calls | PASS/FAIL | <first call output; second call output> |

cleanup: <DELETE results; workspace removed yes/no>
verdict: <ACCEPTED / NOT ACCEPTED — list every FAIL with its raw evidence>
```
