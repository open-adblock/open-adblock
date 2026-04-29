/**
 * Build a DNS response for a blocked query. Currently NXDOMAIN only — mirrors
 * the v1 scope of the UDP server's `blocklist.rs`.
 */

export function buildNxdomain(query: Uint8Array): Uint8Array {
  if (query.length < 12) return new Uint8Array();
  const resp = new Uint8Array(query);
  // QR=1, clear TC
  resp[2] = (resp[2] | 0x80) & ~0x02;
  // RA=1, RCODE=3
  resp[3] = (resp[3] & 0xf0) | 0x03 | 0x80;
  // Zero answer / authority / additional counts
  resp[6] = 0;
  resp[7] = 0;
  resp[8] = 0;
  resp[9] = 0;
  resp[10] = 0;
  resp[11] = 0;
  // Truncate past the question section.
  const end = questionSectionEnd(resp);
  if (end !== null) return resp.slice(0, end);
  return resp;
}

function questionSectionEnd(packet: Uint8Array): number | null {
  let i = 12;
  while (i < packet.length) {
    const len = packet[i];
    if (len === 0) return i + 1 + 4; // null label + QTYPE + QCLASS
    if ((len & 0xc0) !== 0) return null;
    i += 1 + len;
    if (i > packet.length) return null;
  }
  return null;
}
