# Trace.Direct tax engine service. AGPL-3.0-only; see LICENSE and NOTICE.md.
# Base images pinned by digest (node 24 bookworm-slim, 28 Oct 2026).
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

FROM ${NODE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY engine engine
COPY scripts scripts
# Fetch the pinned commit, verify every file, build with the engine's own tooling.
RUN bash scripts/build-engine.sh /src/build/engine
# Production-only copy of the built engine (its dist + runtime dependencies).
RUN cd /src/build/engine \
 && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --filter @dtax/tax-engine deploy --prod --ignore-scripts /out/tax-engine

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    DTAX_ENGINE_DIR=/app/build/engine
WORKDIR /app
COPY --from=build /out/tax-engine /app/build/engine/packages/tax-engine
COPY --from=build /src/build/engine-build.json /app/build/engine-build.json
COPY LICENSE NOTICE.md README.md package.json ./
COPY engine/engine.lock.json engine/engine.lock.json
COPY src src
# The deployed dist must be byte-identical to the one the verified build produced.
RUN node -e 'const c=require("crypto"),f=require("fs");const b=JSON.parse(f.readFileSync("build/engine-build.json"));const h=c.createHash("sha256").update(f.readFileSync("build/engine/packages/tax-engine/dist/index.js")).digest("hex");if(h!==b.distIndexSha256){console.error("dist mismatch");process.exit(1)}console.log("dist verified",h)'
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
