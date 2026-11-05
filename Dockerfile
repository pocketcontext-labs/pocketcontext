# syntax=docker/dockerfile:1
# ONCE contract: HTTP port 80, GET /up, one persistent /storage volume.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS reader
WORKDIR /ui
COPY ui/package.json ui/pnpm-lock.yaml ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@10.33.2 && pnpm install --frozen-lockfile
COPY ui/ ./
RUN pnpm typecheck && pnpm test && pnpm build

FROM golang:1.27.3-trixie@sha256:d9fa6e7ba43678ee1e5d1617007db9a134612032a74e2d86b44a9f582f1564cc AS build
ENV GOTOOLCHAIN=local CGO_ENABLED=1
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    go mod download && go mod verify
COPY . .
COPY --from=reader /ui/dist ./ui/dist
ARG REVISION
RUN test -n "$REVISION" && \
    go build -trimpath -tags "$(cat build-tags.txt)" \
    -ldflags "-s -w -X github.com/pocketcontext-labs/pocketcontext/internal/bundle.Version=hosted-$REVISION" \
    -o /out/pocketcontext ./cmd/pocketcontext

FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates tini python3 python3-boto3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/pocketcontext /usr/local/bin/pocketcontext
COPY --chmod=0755 docker/entrypoint.py /usr/local/bin/pocketcontext-container
# ONCE owns the volume and does not offer a volume UID setting. The public port is 80.
# No Docker socket or host paths are mounted into this application.
ENV POCKETCONTEXT_DB=/storage/project/pocketcontext.db \
    XDG_CACHE_HOME=/storage/private/cache \
    XDG_CONFIG_HOME=/storage/private/config \
    XDG_STATE_HOME=/storage/private/state
ARG REVISION
ENV POCKETCONTEXT_REVISION=$REVISION
LABEL org.opencontainers.image.title="PocketContext" \
      org.opencontainers.image.source="https://github.com/pocketcontext-labs/pocketcontext" \
      org.opencontainers.image.revision=$REVISION
VOLUME /storage
EXPOSE 80
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pocketcontext-container"]
CMD ["serve"]
