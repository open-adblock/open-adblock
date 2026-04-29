/**
 * WASM filter engine wrapper.
 *
 * Two init paths so the same module works in Deno tests and Cloudflare Workers:
 *
 * - `loadEngine(wasmBytes, blob)` — for tests. Compiles the WASM bytes into a
 *   module, then instantiates and constructs a `WasmEngine`.
 * - `loadEngineFromModule(wasmModule, blob)` — for CF Workers, which provide a
 *   pre-compiled `WebAssembly.Module` via bundler-level `import` of the .wasm.
 *
 * The wasm-bindgen glue `../wasm/engine.js` keeps a single module-level `wasm`
 * instance after first init, so only one `WebAssembly.Module` ever runs, even
 * when we host both `light` and `pro` filter blobs — each blob produces its
 * own `WasmEngine` instance bound to that single module.
 */

// @ts-ignore - ambient wasm-bindgen shim has no TS declarations we import
import initSyncDefault, { initSync, WasmEngine } from "../wasm/engine.js";

// Re-export enum so callers don't import it from the shim.
export const Verdict = {
  Pass: 0,
  Block: 1,
  Allow: 2,
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export interface FilterEngine {
  lookup(domain: string): Verdict;
}

let initialized = false;

/** Initialize WASM from raw bytes (Deno / test environment). */
export async function loadEngine(wasmBytes: Uint8Array, blob: Uint8Array): Promise<FilterEngine> {
  if (!initialized) {
    // Normalize buffer type to plain ArrayBuffer for strict TS checks.
    const buf = wasmBytes.slice().buffer as ArrayBuffer;
    const mod = await WebAssembly.compile(buf);
    initSync({ module: mod });
    initialized = true;
  }
  return wrap(new WasmEngine(blob));
}

/** Initialize WASM from a pre-compiled module (CF Workers environment). */
export function loadEngineFromModule(
  wasmModule: WebAssembly.Module,
  blob: Uint8Array,
): FilterEngine {
  if (!initialized) {
    initSync({ module: wasmModule });
    initialized = true;
  }
  return wrap(new WasmEngine(blob));
}

/** Reset initialization state. Intended for tests only. */
export function _resetForTest(): void {
  initialized = false;
}

function wrap(inner: WasmEngine): FilterEngine {
  return {
    lookup(domain: string): Verdict {
      return inner.lookup(domain) as Verdict;
    },
  };
}

// Mark unused import warning-free.
void initSyncDefault;
