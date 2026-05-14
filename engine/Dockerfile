# Koven engine — governance / admin / profile service.
# Two-stage build keeps the runtime image small (just the bun binary +
# our source) and lets us cache the install layer.

FROM oven/bun:1 AS deps
WORKDIR /repo
# Bun's workspace install needs root package.json + every workspace
# package.json present (with their real contents — Bun matches them
# against bun.lock, so a stub here trips frozen-lockfile mode under
# --production even with --no-frozen-lockfile).  Copying the real
# manifests means the lockfile resolves cleanly; the client deps that
# get pulled into node_modules/ are ignored at runtime since we only
# COPY shared/ and engine/ into the runtime image below.
COPY package.json bun.lock ./
COPY shared/package.json ./shared/
COPY engine/package.json ./engine/
COPY client/package.json ./client/
# apps/desktop and apps/mobile are workspace members but their sources
# never reach the runtime image — we only copy their package.json files
# here so frozen-lockfile install can resolve every workspace entry the
# lockfile references.  Without these Bun bails with "Workspace not
# found" for any entry in the root workspaces array it can't locate.
COPY apps/desktop/package.json ./apps/desktop/
COPY apps/mobile/package.json ./apps/mobile/
RUN bun install --production --frozen-lockfile

FROM oven/bun:1 AS runtime
WORKDIR /repo

# Runtime deps for the stdio MCP sandbox.  Three things needed:
#   - bubblewrap   → filesystem isolation for user-attached MCP
#                    subprocesses (per-bot bind-mounted /home/sandbox,
#                    read-only /usr, /lib, /etc, no view of /data or
#                    /synapse-data).  See engine/src/mcp/sandbox.ts.
#   - util-linux   → `prlimit` for memory / CPU / nproc / nofile caps
#                    on each spawned subprocess.
#   - npm + nodejs → `npx` for stdio MCP servers shipped as npm packages
#                    (the most common form — Perplexity, Brave Search,
#                    GitHub, etc.).  bun's runtime doesn't include npx.
#   - uv (via curl)→ `uvx` for stdio MCP servers shipped as PyPI
#                    packages.  Installed via the official installer
#                    script into /usr/local/bin so it's on PATH for
#                    the sandboxed invocation.
# Combined size: ~150 MB on the engine image.  One-time cost; npm /
# uv caches live in per-bot scratch dirs under /var/lib/koven-mcp,
# not in the image layer.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        bubblewrap \
        util-linux \
        nodejs \
        npm \
        ca-certificates \
        curl && \
    curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Per-bot MCP scratch root.  Engine creates per-bot subdirs here on
# first stdio attachment.  Mounted into bwrap sandboxes as the
# subprocess HOME so npm/uv caches survive across spawns (warm-start
# after initial cold-download).  chown nobody:nogroup so the
# sandboxed subprocess (running as nobody) can write.
RUN mkdir -p /var/lib/koven-mcp && chown nobody:nogroup /var/lib/koven-mcp

# Copy the installed dependencies + workspace source.  Bun hoists
# everything into the root node_modules (per-workspace node_modules
# only exist if a workspace has private/scoped packages, which we
# don't), so we copy that one tree and let Bun's resolver follow it.
COPY --from=deps /repo/node_modules ./node_modules
COPY shared ./shared
COPY engine ./engine
COPY package.json bun.lock ./

# Engine reads its config from env vars.  See engine/src/config.ts for
# the full list — defaults are dev-friendly, production overrides come
# from docker-compose's environment block.
ENV ENGINE_PORT=9000

# Persistent state lives at /data so the host can mount a volume.
VOLUME ["/data", "/var/lib/koven-mcp"]
EXPOSE 9000

CMD ["bun", "run", "engine/src/index.ts"]
