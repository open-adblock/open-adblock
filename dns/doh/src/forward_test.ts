// Phase 4.4 — upstream DoH forwarding.

import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import { forwardToUpstream } from "./forward.ts";

type StubCall = { url: string; method: string; body: Uint8Array; ct: string };

/** Install a fetch stub that returns a fixed body, records calls, and yields a restore function. */
function stubFetch(body: Uint8Array, status = 200): { calls: StubCall[]; restore: () => void } {
  const calls: StubCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    let url: string;
    let method = "GET";
    let reqBody = new Uint8Array();
    let ct = "";
    if (input instanceof Request) {
      url = input.url;
      method = input.method;
      ct = input.headers.get("content-type") ?? "";
      reqBody = new Uint8Array(await input.arrayBuffer());
    } else {
      url = typeof input === "string" ? input : input.toString();
      method = init?.method ?? "GET";
      const h = new Headers(init?.headers);
      ct = h.get("content-type") ?? "";
      if (init?.body) {
        if (init.body instanceof Uint8Array) {
          reqBody = new Uint8Array(init.body);
        } else if (init.body instanceof ArrayBuffer) {
          reqBody = new Uint8Array(init.body);
        }
      }
    }
    calls.push({ url, method, body: reqBody, ct });
    return new Response(body.slice().buffer, {
      status,
      headers: { "content-type": "application/dns-message" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

Deno.test("forwardToUpstream: POSTs query bytes to the upstream DoH URL", async () => {
  const fakeResp = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const stub = stubFetch(fakeResp);
  try {
    const query = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const body = await forwardToUpstream(query, "https://1.1.1.1/dns-query");
    assertEquals(body, fakeResp);
    assertEquals(stub.calls.length, 1);
    assertEquals(stub.calls[0].method, "POST");
    assertStringIncludes(stub.calls[0].url, "/dns-query");
    assertEquals(stub.calls[0].ct, "application/dns-message");
    assertEquals(stub.calls[0].body, query);
  } finally {
    stub.restore();
  }
});

Deno.test("forwardToUpstream: throws on non-2xx upstream response", async () => {
  const stub = stubFetch(new Uint8Array(), 502);
  try {
    let threw = false;
    try {
      await forwardToUpstream(new Uint8Array([1, 2]), "https://upstream/dns-query");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  } finally {
    stub.restore();
  }
});
