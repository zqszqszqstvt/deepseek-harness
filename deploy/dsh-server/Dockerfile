# syntax=docker/dockerfile:1
#
# dsh server cloud image: Python 3.12 + uv + the model-facing runtime contract.
#
# Directory contract. Strict bubblewrap starts from an empty root and ro-binds
# ONLY /usr /bin /sbin /lib /lib64 /etc /run, plus the calling session's own
# workspace (packages/sandbox/sandbox-local/src/profiles.ts:19-45). Everything an
# agent must use therefore has to live under one of those prefixes:
#
#   /usr/local/bin/python3        shared interpreter (read-only)
#   /usr/local/bin/uv, /usr/local/bin/uvx   shared installer (read-only)
#   /etc/pip.conf                 pip index (read-only, visible to every agent)
#   /etc/uv/uv.toml               uv index (read-only, visible to every agent)
#   /usr/local/share/dsh/skills   bundled skill root, read host-side by the harness
#   /var/lib/dsh                  DSH_HOME: server config + credentials. NOT visible
#                                 inside the sandbox, which is the point.
#   /var/lib/dsh/server-data      --data-dir. Only the calling session's own
#                                 workspace subtree is bound into its namespace.
#
# Never install agent-visible tooling under /opt, /srv, /var/tmp, or any $HOME:
# those paths do not exist inside the namespace.

FROM python:3.12-slim-bookworm

# ① Runtime dependencies. bubblewrap is mandatory: without it every shell call
#    fails closed with SANDBOX_UNAVAILABLE.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git xz-utils \
 && rm -rf /var/lib/apt/lists/*

# ② sandbox-local passes `--ro-bind /lib64 /lib64` unconditionally, and bwrap
#    refuses a missing source path. Create it when the base image lacks it.
RUN [ -d /lib64 ] || install -d /lib64

# ③ Node.js and the dsh CLI (the server itself). The contract names one path in
#    both install routes, so the runtime is published under /usr/local/bin
#    whatever the package manager chose.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @deepseek-ai/dsh pnpm@11.7.0 \
 && for tool in node npm npx pnpm; do \
      real="$(command -v "$tool")"; \
      [ "$real" = "/usr/local/bin/$tool" ] || ln -sfn "$real" "/usr/local/bin/$tool"; \
    done \
 && /usr/local/bin/node -v && /usr/local/bin/npm -v && /usr/local/bin/pnpm -v

# ④ uv: one static binary into /usr/local/bin, the only agent-visible prefix.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN chmod 0755 /usr/local/bin/uv /usr/local/bin/uvx

# ⑤ Package indexes under /etc: read-only inside the sandbox, so every user's
#    agent gets the mirror without being told about it. Never put a token-bearing
#    URL here — agents can `cat /etc/pip.conf`.
COPY pip.conf /etc/pip.conf
COPY uv.toml /etc/uv/uv.toml
RUN chmod 0644 /etc/pip.conf /etc/uv/uv.toml

# ⑥ The runtime-contract skill. This is the ONLY host skill root a Server session
#    can read: `bundledSkillDir` is loaded host-side (trustedHost), while
#    $DSH_HOME/skills and $DSH_AGENTS_HOME/skills go through ctx.fs and are
#    silently skipped under strictReads.
COPY skills /usr/local/share/dsh/skills

# ⑦ Lock the shared layer read-only. A user writing to /usr/local or /etc must
#    get EROFS; per-user installs belong in that user's workspace .venv.
RUN chown -R root:root /usr/local /usr/local/share/dsh \
 && chmod -R a-w /usr/local

# ⑧ Service user and data directories. /var/lib/dsh is outside every namespace.
RUN useradd --system --uid 10001 --home-dir /var/lib/dsh --create-home \
      --shell /usr/sbin/nologin dsh \
 && install -d -o dsh -g dsh -m 0700 /var/lib/dsh /var/lib/dsh/server-data

# ⑨ Deployment-layer patch: the resident runtime contract (system-prompt.persona).
COPY cordis.patch.yml /var/lib/dsh/cordis.patch.yml
RUN chown dsh:dsh /var/lib/dsh/cordis.patch.yml && chmod 0600 /var/lib/dsh/cordis.patch.yml

ENV DSH_HOME=/var/lib/dsh
# skill-filesystem defaults bundledSkillDir to $DSH_BUNDLED_SKILL_DIR.
ENV DSH_BUNDLED_SKILL_DIR=/usr/local/share/dsh/skills
# There is no $HOME inside the sandbox, so uv must never try to fetch an
# interpreter: the baked /usr/local/bin/python3 is the only one.
ENV UV_PYTHON_DOWNLOADS=never
# Do NOT set PIP_CACHE_DIR / UV_CACHE_DIR / CONDA_PKGS_DIRS here. The server
# environment is forwarded into the sandbox, and a host cache path does not exist
# there. Each command points its cache into the workspace ($PWD/.cache/...).

USER dsh
WORKDIR /var/lib/dsh
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fsS http://127.0.0.1:3080/healthz || exit 1
CMD ["dsh", "server", "--host", "127.0.0.1", "--port", "3080", \
     "--data-dir", "/var/lib/dsh/server-data"]
