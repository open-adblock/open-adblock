// Phase 4.3 — WASM engine wrapper.
//
// The fixture `doh/tests/fixtures/filters.bin` contains these test rules:
//   block:   hand-blocked.example.com
//   allow:   hand-allowed.example.com
//   suffix:  *.ads.example.com

import { assertEquals } from "std/assert/mod.ts";
import { loadEngine, Verdict } from "./engine.ts";

const WASM_PATH = new URL("../wasm/engine_bg.wasm", import.meta.url);
const BLOB_PATH = new URL("../tests/fixtures/filters.bin", import.meta.url);

async function setup() {
  const [wasmBytes, blob] = await Promise.all([
    Deno.readFile(WASM_PATH),
    Deno.readFile(BLOB_PATH),
  ]);
  return await loadEngine(wasmBytes, blob);
}

Deno.test("WASM engine: blocks exact-match domain", async () => {
  const e = await setup();
  assertEquals(e.lookup("hand-blocked.example.com"), Verdict.Block);
});

Deno.test("WASM engine: allows allowlisted domain", async () => {
  const e = await setup();
  assertEquals(e.lookup("hand-allowed.example.com"), Verdict.Allow);
});

Deno.test("WASM engine: blocks suffix match", async () => {
  const e = await setup();
  assertEquals(e.lookup("pixel.ads.example.com"), Verdict.Block);
  assertEquals(e.lookup("ads.example.com"), Verdict.Block);
  assertEquals(e.lookup("deep.sub.ads.example.com"), Verdict.Block);
});

Deno.test("WASM engine: passes unmatched domain", async () => {
  const e = await setup();
  assertEquals(e.lookup("example.org"), Verdict.Pass);
  assertEquals(e.lookup("google.com"), Verdict.Pass);
});

Deno.test("WASM engine: normalizes case", async () => {
  const e = await setup();
  assertEquals(e.lookup("HAND-BLOCKED.Example.com"), Verdict.Block);
});
