#!/usr/bin/env bash
# Build everything: fetch upstreams → compile filters.bin → build WASM →
# stamp NOTICE → copy into doh/wasm/ ready for wrangler deploy.
#
# Idempotent: safe to re-run. Fetch uses ETag caching.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Rust toolchain (Homebrew rustup-init path)
export PATH="/opt/homebrew/opt/rustup/bin:$PATH:$HOME/.cargo/bin"

FILTERS_ROOT="${FILTERS_ROOT:-$(cd "$ROOT/.." && pwd)/filters}"

if [ ! -d "$FILTERS_ROOT/dns" ]; then
  echo "filters/dns not found at $FILTERS_ROOT/dns" >&2
  echo "Run from the monorepo checkout or set FILTERS_ROOT." >&2
  exit 1
fi

DNS_FILTERS="$FILTERS_ROOT/dns"

echo "==> 1. fetch upstream lists"
mkdir -p "$DNS_FILTERS/fetched"
deno run --allow-read --allow-write --allow-net \
  scripts/fetch-upstream.ts "$DNS_FILTERS/light.urls" "$DNS_FILTERS/pro.urls"

echo "==> 2. compile filter blobs"
mkdir -p "$DNS_FILTERS/dist"
cargo run --quiet --release -p engine --bin engine-compile -- \
  --urls "$DNS_FILTERS/light.urls" \
  --custom "$DNS_FILTERS/custom" \
  --fetched "$DNS_FILTERS/fetched" \
  -o "$DNS_FILTERS/dist/light.bin"

cargo run --quiet --release -p engine --bin engine-compile -- \
  --urls "$DNS_FILTERS/pro.urls" \
  --custom "$DNS_FILTERS/custom" \
  --fetched "$DNS_FILTERS/fetched" \
  -o "$DNS_FILTERS/dist/pro.bin"

echo "==> 3. build WASM module"
( cd engine/wasm && wasm-pack build --target web --release )
wasm-opt -Oz \
  --enable-bulk-memory --enable-sign-ext \
  --enable-mutable-globals --enable-nontrapping-float-to-int \
  --enable-reference-types \
  engine/wasm/pkg/engine_wasm_bg.wasm \
  -o engine/wasm/pkg/engine_wasm_bg.wasm.tmp
mv engine/wasm/pkg/engine_wasm_bg.wasm.tmp engine/wasm/pkg/engine_wasm_bg.wasm

echo "==> 4. stage artifacts under doh/wasm/"
mkdir -p doh/wasm
cp engine/wasm/pkg/engine_wasm.js      doh/wasm/engine.js
cp engine/wasm/pkg/engine_wasm.d.ts    doh/wasm/engine_wasm.d.ts
cp engine/wasm/pkg/engine_wasm_bg.wasm doh/wasm/engine_bg.wasm
cp "$DNS_FILTERS/dist/light.bin"       doh/wasm/light.bin
cp "$DNS_FILTERS/dist/pro.bin"         doh/wasm/pro.bin

echo "==> 5. render NOTICE files"
deno run --allow-read \
  scripts/generate-notice.ts light "$DNS_FILTERS/light.urls" > "$DNS_FILTERS/dist/NOTICE.light.txt"
deno run --allow-read \
  scripts/generate-notice.ts pro "$DNS_FILTERS/pro.urls" > "$DNS_FILTERS/dist/NOTICE.pro.txt"
cat "$DNS_FILTERS/dist/NOTICE.light.txt" "$DNS_FILTERS/dist/NOTICE.pro.txt" > doh/wasm/NOTICE.txt

echo "==> done"
ls -la doh/wasm/
