# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the `dns-udp` server. One image ships both preset
# blobs (light + pro); the runtime process picks one via the PRESET env var.
#
# Build context must be the monorepo root:
#   docker build -f dns/udp/Dockerfile .
# or (from fly.toml):
#   [build]
#     dockerfile = "dns/udp/Dockerfile"

FROM rust:1-bookworm AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_TERM_COLOR=never

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git unzip \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | sh -s -- --no-modify-path
ENV PATH="/root/.deno/bin:${PATH}"

WORKDIR /build

COPY dns/Cargo.toml dns/Cargo.lock dns/deno.json dns/deno.lock dns/
COPY dns/engine/ dns/engine/
COPY dns/udp/ dns/udp/
COPY dns/scripts/fetch-upstream.ts dns/scripts/fetch-upstream.ts
COPY filters/dns/ filters/dns/

WORKDIR /build/dns

RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/build/dns/target,sharing=locked \
    mkdir -p ../filters/dns/fetched ../filters/dns/dist \
 && deno run --allow-read --allow-write --allow-net \
      scripts/fetch-upstream.ts ../filters/dns/light.urls ../filters/dns/pro.urls \
 && cargo run --quiet --release -p engine --bin engine-compile -- \
      --urls ../filters/dns/light.urls \
      --custom ../filters/dns/custom \
      --fetched ../filters/dns/fetched \
      -o ../filters/dns/dist/light.bin \
 && cargo run --quiet --release -p engine --bin engine-compile -- \
      --urls ../filters/dns/pro.urls \
      --custom ../filters/dns/custom \
      --fetched ../filters/dns/fetched \
      -o ../filters/dns/dist/pro.bin \
 && cargo build --release -p dns-udp --bin dns-udp \
 && cp target/release/dns-udp /usr/local/bin/dns-udp

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /usr/local/bin/dns-udp        /usr/local/bin/dns-udp
COPY --from=builder /build/filters/dns/dist/light.bin /app/filters/light.bin
COPY --from=builder /build/filters/dns/dist/pro.bin   /app/filters/pro.bin
COPY dns/udp/fly/config.light.toml                    /app/config.light.toml
COPY dns/udp/fly/config.pro.toml                      /app/config.pro.toml

ENV PRESET=light \
    RUST_LOG=info

EXPOSE 53/udp

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/bin/sh", "-c", "exec /usr/local/bin/dns-udp /app/config.${PRESET}.toml"]
