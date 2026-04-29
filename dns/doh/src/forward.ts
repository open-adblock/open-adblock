/**
 * Forward a DNS query to an upstream DNS-over-HTTPS resolver and return the
 * raw response bytes.
 *
 * v1 does not integrate the Cloudflare `Cache API` yet — `index.ts` wraps
 * this function with `caches.default.match`/`put` using the query as a cache
 * key. That keeps forward.ts portable across runtimes (Deno tests have no
 * Cache API).
 */

export const DEFAULT_UPSTREAM = "https://1.1.1.1/dns-query";

export async function forwardToUpstream(
  query: Uint8Array,
  upstreamUrl: string = DEFAULT_UPSTREAM,
): Promise<Uint8Array> {
  const body = query.slice().buffer as ArrayBuffer;
  const resp = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/dns-message",
      "accept": "application/dns-message",
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(`upstream ${upstreamUrl} returned ${resp.status}`);
  }
  const ab = await resp.arrayBuffer();
  return new Uint8Array(ab);
}
