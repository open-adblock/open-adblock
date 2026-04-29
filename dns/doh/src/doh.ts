/**
 * RFC 8484 — DNS over HTTPS wire format helpers.
 *
 * `readQueryFromRequest`     → extract the raw DNS query bytes from a `Request`
 * `toDohResponse`            → wrap a raw DNS response in an HTTP `Response`
 * `decodeGetQuery`           → decode a base64url `?dns=` value
 * `responseMinTtl`           → compute cache max-age from answer record TTLs
 */

export const DNS_MESSAGE_CT = "application/dns-message";
export const DEFAULT_TTL_SECONDS = 60;

export function decodeGetQuery(b64url: string): Uint8Array | null {
  try {
    // base64url → base64
    let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function readQueryFromRequest(req: Request): Promise<Uint8Array | null> {
  if (req.method === "POST") {
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.startsWith(DNS_MESSAGE_CT)) return null;
    const ab = await req.arrayBuffer();
    return new Uint8Array(ab);
  }
  if (req.method === "GET") {
    const url = new URL(req.url);
    const dns = url.searchParams.get("dns");
    if (!dns) return null;
    return decodeGetQuery(dns);
  }
  return null;
}

export function toDohResponse(body: Uint8Array, ttlSeconds: number): Response {
  // Copy into a fresh ArrayBuffer to normalize the buffer type across runtimes.
  const ab = body.slice().buffer;
  return new Response(ab, {
    status: 200,
    headers: {
      "content-type": DNS_MESSAGE_CT,
      "cache-control": `public, max-age=${ttlSeconds}`,
    },
  });
}

/**
 * Walk the answer section and return the minimum TTL. Returns `DEFAULT_TTL_SECONDS`
 * if the packet has no answers, is malformed, or uses compression pointers we
 * can't follow in this minimal parser.
 */
export function responseMinTtl(response: Uint8Array): number {
  if (response.length < 12) return DEFAULT_TTL_SECONDS;
  const dv = new DataView(response.buffer, response.byteOffset, response.byteLength);
  const qdcount = dv.getUint16(4);
  const ancount = dv.getUint16(6);
  if (ancount === 0) return DEFAULT_TTL_SECONDS;

  let i = 12;
  // Skip QDCOUNT questions
  for (let q = 0; q < qdcount; q++) {
    i = skipName(response, i);
    if (i < 0) return DEFAULT_TTL_SECONDS;
    i += 4; // QTYPE + QCLASS
  }
  let minTtl = Infinity;
  for (let a = 0; a < ancount; a++) {
    i = skipName(response, i);
    if (i < 0 || i + 10 > response.length) return DEFAULT_TTL_SECONDS;
    // TYPE(2) CLASS(2) TTL(4) RDLEN(2) RDATA(rdlen)
    const ttl = dv.getUint32(i + 4);
    const rdlen = dv.getUint16(i + 8);
    if (ttl < minTtl) minTtl = ttl;
    i += 10 + rdlen;
  }
  if (!isFinite(minTtl) || minTtl <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(minTtl, 3600);
}

/**
 * Skip a DNS name (handling 0-terminated labels and 2-byte compression pointers).
 * Returns the index after the name, or -1 on malformed input.
 */
function skipName(packet: Uint8Array, start: number): number {
  let i = start;
  while (i < packet.length) {
    const len = packet[i];
    if (len === 0) return i + 1;
    if ((len & 0xc0) === 0xc0) {
      if (i + 1 >= packet.length) return -1;
      return i + 2; // pointer (2 bytes total)
    }
    if (len > 63) return -1;
    i += 1 + len;
  }
  return -1;
}
