FROM node:24-bookworm-slim AS viewer-build
WORKDIR /workspace/viewer
COPY viewer/package*.json ./
RUN npm ci
COPY viewer/ ./
RUN npm run build

FROM denoland/deno:2.5.6
RUN apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends wget dcmtk ca-certificates && \
  rm -rf /var/lib/apt/lists/*
EXPOSE 8000
WORKDIR /app
USER deno
COPY --chown=deno server/deno.lock server/src/deps.ts ./
RUN deno cache --reload --lock=deno.lock ./deps.ts
COPY --chown=deno server/ ./
COPY --from=viewer-build --chown=deno /workspace/viewer/dist ./public/viewer
CMD ["run", "--allow-all", "src/index.ts"]
