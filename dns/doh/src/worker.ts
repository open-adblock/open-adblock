/**
 * Cloudflare Workers entry. Wraps the bundler-provided imports into the `Env`
 * shape consumed by `./index.ts`, which is kept runtime-agnostic for testing.
 */

// Bundler-provided imports (wrangler.toml rules):
//   CompiledWasm → `WebAssembly.Module`
//   Data         → `Uint8Array`
//   Text         → `string`
// @ts-ignore bundler-provided
import wasmModule from "../wasm/engine_bg.wasm";
// @ts-ignore bundler-provided
import lightBin from "../wasm/light.bin";
// @ts-ignore bundler-provided
import proBin from "../wasm/pro.bin";
// @ts-ignore bundler-provided
import notice from "../wasm/NOTICE.txt";

import handler, { Env, Preset } from "./index.ts";

interface WorkerVars {
  UPSTREAM?: string;
  DEFAULT_PRESET?: Preset;
}

export default {
  fetch(req: Request, env: WorkerVars, ctx: ExecutionContext): Promise<Response> {
    const bundled: Env = {
      WASM: wasmModule as WebAssembly.Module,
      LIGHT_BIN: lightBin as Uint8Array,
      PRO_BIN: proBin as Uint8Array,
      NOTICE: notice as string,
      UPSTREAM: env.UPSTREAM,
      DEFAULT_PRESET: env.DEFAULT_PRESET,
    };
    return handler.fetch(req, bundled, ctx);
  },
};
