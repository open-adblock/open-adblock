// Phase 4.2 — RFC 8484 DoH wire format parsing.

import { assertEquals, assertExists, assertStrictEquals } from "std/assert/mod.ts";
import { decodeGetQuery, readQueryFromRequest, responseMinTtl, toDohResponse } from "./doh.ts";

const CT = "application/dns-message";

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeQuery(): Uint8Array {
  // Minimal 12-byte header + empty question section (valid enough for transport).
  const buf = new Uint8Array(12);
  new DataView(buf.buffer).setUint16(0, 0xdead);
  return buf;
}

Deno.test("decodeGetQuery: decodes base64url-encoded dns param", () => {
  const q = makeQuery();
  const encoded = base64urlEncode(q);
  const decoded = decodeGetQuery(encoded);
  assertExists(decoded);
  assertEquals(decoded, q);
});

Deno.test("decodeGetQuery: returns null for invalid base64", () => {
  assertStrictEquals(decodeGetQuery("!!!not-base64!!!"), null);
});

Deno.test("readQueryFromRequest: POST with application/dns-message", async () => {
  const q = makeQuery();
  const req = new Request("https://dns.example/dns-query", {
    method: "POST",
    headers: { "content-type": CT },
    body: q.slice().buffer,
  });
  const result = await readQueryFromRequest(req);
  assertExists(result);
  assertEquals(result, q);
});

Deno.test("readQueryFromRequest: GET with ?dns param", async () => {
  const q = makeQuery();
  const url = `https://dns.example/dns-query?dns=${base64urlEncode(q)}`;
  const req = new Request(url, { method: "GET" });
  const result = await readQueryFromRequest(req);
  assertExists(result);
  assertEquals(result, q);
});

Deno.test("readQueryFromRequest: POST with wrong content-type is rejected", async () => {
  const req = new Request("https://dns.example/dns-query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeQuery().slice().buffer,
  });
  const result = await readQueryFromRequest(req);
  assertStrictEquals(result, null);
});

Deno.test("readQueryFromRequest: GET without ?dns returns null", async () => {
  const req = new Request("https://dns.example/dns-query", { method: "GET" });
  assertStrictEquals(await readQueryFromRequest(req), null);
});

Deno.test("toDohResponse: sets content-type and cache-control", () => {
  const body = new Uint8Array([0xaa, 0xbb]);
  const resp = toDohResponse(body, 120);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get("content-type"), CT);
  assertEquals(resp.headers.get("cache-control"), "public, max-age=120");
});

Deno.test("responseMinTtl: finds the smallest TTL across answer records", () => {
  // Build a fake response with 2 answers: TTL 300 and 60.
  // We assemble by hand: header + 1 question (1 byte null label + QTYPE+QCLASS) + 2 RRs.
  const parts: number[] = [];
  // header
  parts.push(0, 1, 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0);
  // question: "" label (root) + QTYPE=A + QCLASS=IN
  parts.push(0, 0, 1, 0, 1);
  // answer 1: name=root(0), type=A(1), class=IN(1), TTL=300, RDLEN=4, rdata=4 bytes
  parts.push(
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    1,
    0x2c, // 300
    0,
    4,
    1,
    2,
    3,
    4,
  );
  // answer 2: TTL=60
  parts.push(
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    0x3c, // 60
    0,
    4,
    4,
    3,
    2,
    1,
  );
  const pkt = new Uint8Array(parts);
  assertEquals(responseMinTtl(pkt), 60);
});

Deno.test("responseMinTtl: returns a default when no answers or malformed", () => {
  const pkt = new Uint8Array([0, 1, 0x81, 0x80, 0, 0, 0, 0, 0, 0, 0, 0]);
  // No answers → return default (60s)
  assertEquals(responseMinTtl(pkt), 60);
});
