#!/usr/bin/env bash
# Bootstrap Rust + Deno + wasm-pack + binaryen in a clean CI environment
# (Cloudflare Workers Builds: Ubuntu, non-root, no apt) and run build-all.sh.
# Idempotent: skips installs when tools already exist so repeat deploys are
# fast once the build cache is warm.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BINARYEN_VERSION="version_119"

export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"

mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$CARGO_HOME/bin:$DENO_INSTALL/bin:$PATH"

if ! command -v rustup >/dev/null 2>&1; then
  echo "==> installing rustup + stable toolchain"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --profile minimal --default-toolchain stable \
             --target wasm32-unknown-unknown
fi
rustup target add wasm32-unknown-unknown >/dev/null

if ! command -v deno >/dev/null 2>&1; then
  echo "==> installing deno"
  curl -fsSL https://deno.land/install.sh | sh >/dev/null
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "==> installing wasm-pack"
  curl -fsSL https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
fi

if ! command -v wasm-opt >/dev/null 2>&1; then
  echo "==> installing binaryen $BINARYEN_VERSION"
  tmpdir="$(mktemp -d)"
  curl -fsSL -o "$tmpdir/binaryen.tgz" \
    "https://github.com/WebAssembly/binaryen/releases/download/$BINARYEN_VERSION/binaryen-$BINARYEN_VERSION-x86_64-linux.tar.gz"
  tar -xzf "$tmpdir/binaryen.tgz" -C "$tmpdir"
  cp "$tmpdir/binaryen-$BINARYEN_VERSION/bin/wasm-opt" "$HOME/.local/bin/"
  rm -rf "$tmpdir"
fi

exec ./scripts/build-all.sh
