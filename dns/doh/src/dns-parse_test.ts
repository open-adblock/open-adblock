// Phase 4.1 — QNAME extraction from a DNS wire-format query.

import { assertEquals, assertStrictEquals } from "std/assert/mod.ts";
import { extractQname } from "./dns-parse.ts";

/** Build a minimal A/IN query for `qname` with transaction id 0x0001. */
function buildQuery(qname: string): Uint8Array {
  const labels = qname.split(".");
  // header (12) + sum(len+1) for each label + null (1) + qtype/qclass (4)
  const size = 12 + labels.reduce((s, l) => s + l.length + 1, 0) + 1 + 4;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0x0001); // ID
  dv.setUint16(2, 0x0100); // flags: RD=1
  dv.setUint16(4, 1); // QDCOUNT
  let i = 12;
  for (const l of labels) {
    buf[i++] = l.length;
    for (let j = 0; j < l.length; j++) buf[i++] = l.charCodeAt(j);
  }
  buf[i++] = 0; // null label
  dv.setUint16(i, 1); // QTYPE A
  dv.setUint16(i + 2, 1); // QCLASS IN
  return buf;
}

Deno.test("extractQname: simple three-label name", () => {
  const q = buildQuery("foo.example.com");
  assertEquals(extractQname(q), "foo.example.com");
});

Deno.test("extractQname: lowercases uppercase labels", () => {
  const q = buildQuery("FOO.Example.COM");
  assertEquals(extractQname(q), "foo.example.com");
});

Deno.test("extractQname: single label", () => {
  const q = buildQuery("localhost");
  assertEquals(extractQname(q), "localhost");
});

Deno.test("extractQname: returns null for packets shorter than header", () => {
  assertStrictEquals(extractQname(new Uint8Array([0, 1, 2])), null);
});

Deno.test("extractQname: returns null for malformed label length", () => {
  // Valid header, then a label length of 100 with only 5 bytes of data.
  const buf = new Uint8Array(12 + 1 + 5);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0x0001);
  dv.setUint16(2, 0x0100);
  dv.setUint16(4, 1);
  buf[12] = 100; // oversized label length
  for (let i = 13; i < buf.length; i++) buf[i] = 0x41;
  assertStrictEquals(extractQname(buf), null);
});

Deno.test("extractQname: rejects DNS compression pointer in question section", () => {
  const buf = new Uint8Array(20);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0x0001);
  dv.setUint16(2, 0x0100);
  dv.setUint16(4, 1);
  buf[12] = 0xc0; // pointer flag
  buf[13] = 0x0c;
  assertStrictEquals(extractQname(buf), null);
});
