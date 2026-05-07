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
# apps/desktop is a workspace member but its sources never reach the
# runtime image — we only copy its package.json here so frozen-
# lockfile install can resolve every workspace entry the lockfile
# references.  Without this Bun bails with "lockfile had changes" on
# the desktop devDependencies (@tauri-apps/cli) it can't account for.
COPY apps/desktop/package.json ./apps/desktop/
RUN bun install --production --frozen-lockfile

FROM oven/bun:1 AS runtime
WORKDIR /repo
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
VOLUME ["/data"]
EXPOSE 9000

CMD ["bun", "run", "engine/src/index.ts"]
