import { assertEquals } from "std/assert/mod.ts";
import { buildNxdomain } from "./blocklist.ts";

function buildQuery(id: number, qname: string): Uint8Array {
  const labels = qname.split(".");
  const size = 12 + labels.reduce((s, l) => s + l.length + 1, 0) + 1 + 4;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, id);
  dv.setUint16(2, 0x0100); // RD=1
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

Deno.test("buildNxdomain: sets QR and RCODE=3, preserves question", () => {
  const q = buildQuery(0xabcd, "blocked.example.com");
  const r = buildNxdomain(q);
  assertEquals(r[0], 0xab);
  assertEquals(r[1], 0xcd);
  assertEquals(r[2] & 0x80, 0x80, "QR set");
  assertEquals(r[3] & 0x0f, 0x03, "RCODE = NXDOMAIN");
  // answer/authority/additional counts zero
  for (let i = 6; i < 12; i++) assertEquals(r[i], 0);
});

Deno.test("buildNxdomain: empty for malformed short packet", () => {
  assertEquals(buildNxdomain(new Uint8Array([1, 2, 3])), new Uint8Array());
});
