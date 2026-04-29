/**
 * Cloudflare Workers entry point.
 *
 * Routing by hostname:
 *   dns.open-adblock.com/dns-query      → light
 *   pro.dns.open-adblock.com/dns-query  → pro
 *   <any>/notice                        → GPLv3 NOTICE body
 *   anything else                       → 404
 *
 * Env bindings (set in `wrangler.toml`):
 *   env.WASM            — precompiled WebAssembly.Module (CompiledWasm rule)
 *   env.LIGHT_BIN       — Uint8Array (light filter blob, bundled)
 *   env.PRO_BIN         — Uint8Array (pro filter blob, bundled)
 *   env.NOTICE          — string (rendered NOTICE template)
 *   env.UPSTREAM        — optional; default https://1.1.1.1/dns-query
 *   env.DEFAULT_PRESET  — used when Host doesn't match (e.g. localhost dev)
 */

import { buildNxdomain } from "./blocklist.ts";
import { DEFAULT_TTL_SECONDS, readQueryFromRequest, responseMinTtl, toDohResponse } from "./doh.ts";
import { extractQname } from "./dns-parse.ts";
import { FilterEngine, loadEngine, loadEngineFromModule, Verdict } from "./engine.ts";
import { DEFAULT_UPSTREAM, forwardToUpstream } from "./forward.ts";
import { mobileConfigResponse } from "./profile.ts";

export type Preset = "light" | "pro";

export interface Env {
  WASM?: WebAssembly.Module;
  WASM_BYTES?: Uint8Array;
  LIGHT_BIN: Uint8Array;
  PRO_BIN: Uint8Array;
  NOTICE?: string;
  UPSTREAM?: string;
  DEFAULT_PRESET?: Preset;
}

const engineCache: Partial<Record<Preset, FilterEngine>> = {};

async function getEngine(preset: Preset, env: Env): Promise<FilterEngine> {
  const cached = engineCache[preset];
  if (cached) return cached;
  const blob = preset === "light" ? env.LIGHT_BIN : env.PRO_BIN;
  let engine: FilterEngine;
  if (env.WASM) {
    engine = loadEngineFromModule(env.WASM, blob);
  } else if (env.WASM_BYTES) {
    engine = await loadEngine(env.WASM_BYTES, blob);
  } else {
    throw new Error("no WASM module or bytes available in env");
  }
  engineCache[preset] = engine;
  return engine;
}

export function resolvePreset(hostname: string, env: Env): Preset {
  if (hostname === "dns.open-adblock.com") return "light";
  if (hostname === "pro.dns.open-adblock.com") return "pro";
  return env.DEFAULT_PRESET ?? "light";
}

export default {
  async fetch(req: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const preset = resolvePreset(url.hostname, env);

    if (url.pathname === "/notice" || url.pathname === "/about") {
      return new Response(env.NOTICE ?? "No NOTICE available.", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/light.mobileconfig") {
      return mobileConfigResponse("light");
    }
    if (url.pathname === "/pro.mobileconfig") {
      return mobileConfigResponse("pro");
    }

    if (url.pathname !== "/dns-query") {
      return new Response("Not Found", { status: 404 });
    }

    const query = await readQueryFromRequest(req);
    if (!query) {
      return new Response("Bad DoH request", { status: 400 });
    }

    const qname = extractQname(query);
    const engine = await getEngine(preset, env);
    const verdict: Verdict = qname ? engine.lookup(qname) : Verdict.Pass;

    let responseBody: Uint8Array;
    let ttl = DEFAULT_TTL_SECONDS;
    if (verdict === Verdict.Block) {
      responseBody = buildNxdomain(query);
    } else {
      const upstream = env.UPSTREAM ?? DEFAULT_UPSTREAM;
      try {
        responseBody = await forwardToUpstream(query, upstream);
        ttl = responseMinTtl(responseBody);
      } catch (_e) {
        responseBody = buildNxdomain(query);
      }
    }

    return toDohResponse(responseBody, ttl);
  },
};

// Deno lacks the `ExecutionContext` global type; shim it here for
// TS strict-mode when running tests.
// deno-lint-ignore no-empty-interface
export interface ExecutionContext {}
