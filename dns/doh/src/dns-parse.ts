/**
 * Extract the QNAME from the first question of a raw DNS wire-format packet.
 * Returns the dot-separated, lowercased name (without trailing dot), or `null`
 * if the packet is malformed.
 *
 * We intentionally do not handle compression pointers in the question section:
 * they are illegal there per RFC 1035 and rejecting them avoids a class of
 * parsing bugs.
 */
export function extractQname(packet: Uint8Array): string | null {
  if (packet.length < 13) return null;
  let i = 12;
  const labels: string[] = [];
  while (i < packet.length) {
    const len = packet[i];
    if (len === 0) {
      // Need QTYPE + QCLASS after
      if (packet.length < i + 5) return null;
      return labels.join(".").toLowerCase();
    }
    if ((len & 0xc0) !== 0) return null; // no compression in question section
    if (len > 63) return null;
    i += 1;
    if (i + len > packet.length) return null;
    let label = "";
    for (let j = 0; j < len; j++) label += String.fromCharCode(packet[i + j]);
    labels.push(label);
    i += len;
  }
  return null;
}
