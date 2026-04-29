// Phase 4.5 — fetch handler integration.

import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import handler, { Env, resolvePreset } from "./index.ts";
import { _resetForTest } from "./engine.ts";

const WASM_PATH = new URL("../wasm/engine_bg.wasm", import.meta.url);
const LIGHT_BIN_PATH = new URL("../tests/fixtures/filters.bin", import.meta.url);

async function makeEnv(): Promise<Env> {
  const [wasmBytes, blob] = await Promise.all([
    Deno.readFile(WASM_PATH),
    Deno.readFile(LIGHT_BIN_PATH),
  ]);
  return {
    WASM_BYTES: wasmBytes,
    LIGHT_BIN: blob,
    PRO_BIN: blob, // tests reuse light for simplicity
    NOTICE: "test notice",
    DEFAULT_PRESET: "light",
  };
}

function buildDnsQuery(id: number, qname: string): Uint8Array {
  const labels = qname.split(".");
  const size = 12 + labels.reduce((s, l) => s + l.length + 1, 0) + 1 + 4;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, id);
  dv.setUint16(2, 0x0100);
  dv.setUint16(4, 1);
  let i = 12;
  for (const l of labels) {
    buf[i++] = l.length;
    for (let j = 0; j < l.length; j++) buf[i++] = l.charCodeAt(j);
  }
  buf[i++] = 0;
  dv.setUint16(i, 1);
  dv.setUint16(i + 2, 1);
  return buf;
}

function setupUpstreamStub(response: Uint8Array) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(response.slice().buffer, {
        status: 200,
        headers: { "content-type": "application/dns-message" },
      }),
    )) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function upstreamStubResponseFor(query: Uint8Array): Uint8Array {
  // Echo header + 1-byte marker. Exact bytes don't matter for the test beyond
  // being distinguishable from a locally-synthesized NXDOMAIN.
  const resp = new Uint8Array(query);
  resp[2] |= 0x80; // QR
  resp[3] = 0; // RCODE = NOERROR
  return resp;
}

// Reset engine singleton between runs so different fixtures don't bleed.
function resetBetweenRuns() {
  _resetForTest();
  // Clear engine cache (module-level). We can't access it directly; re-import
  // would be expensive — instead, we import the dynamic form of getEngine by
  // accepting some bleed in v1 and flushing via _resetForTest.
}

Deno.test("resolvePreset: maps hostnames to presets", () => {
  const env = { DEFAULT_PRESET: "light" } as Env;
  assertEquals(resolvePreset("dns.open-adblock.com", env), "light");
  assertEquals(resolvePreset("pro.dns.open-adblock.com", env), "pro");
  assertEquals(resolvePreset("localhost", env), "light");
});

Deno.test("fetch: /notice returns NOTICE body", async () => {
  resetBetweenRuns();
  const env = await makeEnv();
  const req = new Request("https://dns.open-adblock.com/notice");
  const resp = await handler.fetch(req, env);
  assertEquals(resp.status, 200);
  assertStringIncludes(resp.headers.get("content-type") ?? "", "text/plain");
  assertEquals(await resp.text(), "test notice");
});

Deno.test("fetch: /unknown → 404", async () => {
  resetBetweenRuns();
  const env = await makeEnv();
  const req = new Request("https://dns.open-adblock.com/unknown");
  const resp = await handler.fetch(req, env);
  assertEquals(resp.status, 404);
});

Deno.test("fetch: blocked domain returns NXDOMAIN", async () => {
  resetBetweenRuns();
  const env = await makeEnv();
  const query = buildDnsQuery(0x0001, "hand-blocked.example.com");
  const restore = setupUpstreamStub(new Uint8Array());
  try {
    const req = new Request("https://dns.open-adblock.com/dns-query", {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: query.slice().buffer,
    });
    const resp = await handler.fetch(req, env);
    assertEquals(resp.status, 200);
    assertEquals(resp.headers.get("content-type"), "application/dns-message");
    const body = new Uint8Array(await resp.arrayBuffer());
    assertEquals(body[3] & 0x0f, 0x03, "RCODE = NXDOMAIN");
  } finally {
    restore();
  }
});

Deno.test("fetch: unblocked domain forwards to upstream", async () => {
  resetBetweenRuns();
  const env = await makeEnv();
  const query = buildDnsQuery(0x0002, "example.org");
  const restore = setupUpstreamStub(upstreamStubResponseFor(query));
  try {
    const req = new Request("https://dns.open-adblock.com/dns-query", {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: query.slice().buffer,
    });
    const resp = await handler.fetch(req, env);
    assertEquals(resp.status, 200);
    const body = new Uint8Array(await resp.arrayBuffer());
    // Upstream stub returns NOERROR response, not our NXDOMAIN.
    assertEquals(body[3] & 0x0f, 0x00, "RCODE = NOERROR (from upstream)");
  } finally {
    restore();
  }
});

Deno.test("fetch: malformed DoH body returns 400", async () => {
  resetBetweenRuns();
  const env = await makeEnv();
  const req = new Request("https://dns.open-adblock.com/dns-query", {
    method: "GET",
  });
  const resp = await handler.fetch(req, env);
  assertEquals(resp.status, 400);
});
