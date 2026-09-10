---
name: python-env
description: Use when a task needs Python packages, a virtual environment, uv, conda or micromamba, or any install, build, or test command that may exceed the 60-second foreground shell timeout, in either the cloud sandbox or a local device execution environment.
---

# Python environments

Pick the branch for the active execution environment first. Both branches share two rules: state never crosses calls, so the environment and the directory go on the same command line; and interpreters are invoked by path, never through `activate`.

## Cloud branch (Linux + bubblewrap)

Visible read-only: `/usr` (including `/usr/local`), `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, `/run`. Writable: this session's workspace, plus a private `/tmp` that is destroyed when the call ends. Not present at all: `$HOME`, `/home`, `/opt`, `/var`, `/srv`, other users' workspaces. Network is available. Foreground calls are capped at 60 seconds (120 maximum); stdin is closed.

Shared layer, provided by the image and read-only:

| Path | What it is |
| --- | --- |
| `/usr/local/bin/python3` | shared interpreter (a symlink to the newest interpreter with `venv` and `ensurepip`) |
| `/usr/local/bin/uv`, `/usr/local/bin/uvx` | shared installer and resolver |
| `/etc/pip.conf`, `/etc/uv/uv.toml` | optional index config; absent means the public index |

Always use these absolute paths. Bare `python3` resolves through the PATH inherited from the Server process and may be an older distribution interpreter that `uv` refuses. Writing anywhere in the shared layer returns EROFS, because the strict profile ro-binds `/usr`: that is the isolation contract, and per-task packages belong in a workspace-local environment.

### Stage 0 — probe once, in a single call

```sh
/usr/local/bin/python3 -VV; /usr/local/bin/uv --version; command -v git curl
cat /etc/pip.conf 2>/dev/null | head -5
/usr/local/bin/python3 -c 'import urllib.request as u; print("net=", u.urlopen("https://pypi.org/simple/", timeout=8).status)' 2>&1 | tail -1
```

Do not probe `$HOME` (`touch $HOME/.wtest`, `df -h $HOME`): it is not mounted, so the call is wasted.

### Stage 1 — create the environment inside the workspace

```sh
UV_CACHE_DIR="$PWD/.cache/uv" /usr/local/bin/uv venv .venv --python /usr/local/bin/python3
```

Fallback when `uv` is unavailable:

```sh
/usr/local/bin/python3 -m venv .venv && .venv/bin/python -m pip install -q -U pip
```

### Stage 2 — install in the background

Submit with `run_in_background: true`. The command must be self-contained, because nothing carries over:

```sh
mkdir -p .cache && UV_CACHE_DIR="$PWD/.cache/uv" /usr/local/bin/uv pip install \
  --python .venv/bin/python pandas==2.2.3 > .cache/install.log 2>&1; echo "exit=$?" >> .cache/install.log
```

Collect with `job_output` (use `wait: true` only when genuinely blocked). A finished job notifies the session, so never poll with `sleep`.

pip equivalent, and the two fallbacks:

```sh
PIP_CACHE_DIR="$PWD/.cache/pip" .venv/bin/python -m pip install -q --no-input pandas==2.2.3 > .cache/install.log 2>&1
# no venv possible (missing ensurepip): install into a directory and inline PYTHONPATH on EVERY later command
PIP_CACHE_DIR="$PWD/.cache/pip" /usr/local/bin/python3 -m pip install -q --no-input --target .pylibs pandas==2.2.3
PYTHONPATH="$PWD/.pylibs" /usr/local/bin/python3 script.py
```

### Stage 3 — run and verify

```sh
.venv/bin/python -c "import pandas; print(pandas.__version__)"   # ① the target environment works
.venv/bin/python script.py                                        # ② the real script runs
/usr/local/bin/python3 -c "import pandas" 2>&1 | tail -1       # ③ the shared interpreter must NOT see it
```

Verification ③ is what proves the install stayed inside the workspace instead of touching the shared layer.

### Large output

A command whose stream exceeds 64 KB is truncated in the tool result, which names the complete log under `<workspace>/.dsh/spill/`; `read` and `grep` can open that path. When the exact bytes matter, redirect into the workspace yourself. Never stage data in `/tmp`.

## Local device branch (Electron executor)

No sandbox and `$HOME` is writable, so conda may already be on PATH. The limits are different: no background execution, foreground capped at 60 seconds (120 maximum) with a 120-second transport timeout, combined stdout+stderr above roughly 128 KB terminates the command, and no streaming stdin. POSIX runs `<shell> -lc` (profile files, not `~/.bashrc`); Windows runs `powershell -NoLogo -NoProfile -NonInteractive` (not `$PROFILE`) — so a conda hook never loads by itself.

```sh
# POSIX: source the hook in the SAME command, or call the interpreter by absolute path
source "$HOME/miniconda3/etc/profile.d/conda.sh" && conda activate py311 \
  && python -m pip install -q pandas > pip.log 2>&1
```

```powershell
# Windows: -NoProfile means absolute paths only
& C:\Users\User\miniconda3\envs\py311\python.exe -m pip install -q pandas 2>&1 |
  Out-File -Encoding utf8 pip.log
```

Because nothing can run in the background, split a long install into two foreground calls: `pip download -d .wheels <pkgs>` then `pip install --no-index --find-links .wheels <pkgs>`. Always pass `-q` and redirect to a file, or the ~128 KB output limit kills the command. If the work is heavier than that, ask the user to run it in their own terminal.
