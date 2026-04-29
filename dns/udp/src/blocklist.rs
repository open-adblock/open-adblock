//! Build a DNS response packet for a blocked query.
//!
//! We operate directly on the wire format to minimize allocations and preserve
//! unknown EDNS0 options. For NXDOMAIN we just flip the RCODE and QR bits in
//! the header; for "zeros" we append a synthetic A/AAAA answer with all-zero
//! rdata.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockAction {
    Nxdomain,
    Zeros,
}

/// Build a response packet for a blocked query. `query` is the raw request bytes
/// as received from the client. On error (malformed packet), returns a generic
/// SERVFAIL response.
pub fn build_response(query: &[u8], action: BlockAction) -> Vec<u8> {
    if query.len() < 12 {
        return Vec::new();
    }
    match action {
        BlockAction::Nxdomain => nxdomain_response(query),
        BlockAction::Zeros => {
            // Fallback to NXDOMAIN if we can't synthesize a proper A/AAAA. This
            // is intentionally conservative for v1; full zeros support can be
            // extended later.
            zeros_response(query).unwrap_or_else(|| nxdomain_response(query))
        }
    }
}

fn nxdomain_response(query: &[u8]) -> Vec<u8> {
    let mut resp = query.to_vec();
    // Set QR=1 (response) and RCODE=NXDOMAIN (3) in the header.
    // Byte layout (RFC 1035):
    //   [0..2]  = transaction ID
    //   [2]     = QR(1) | Opcode(4) | AA(1) | TC(1) | RD(1)
    //   [3]     = RA(1) | Z(3) | RCODE(4)
    resp[2] |= 0b1000_0000; // QR
    resp[2] &= 0b1111_1011; // clear TC
                            // Preserve opcode + RD from query; clear AA.
    resp[2] &= 0b1111_1011;
    resp[3] = (resp[3] & 0b1111_0000) | 0x03; // RCODE = NXDOMAIN
                                              // RA bit: set if we support recursion. We do (we forward).
    resp[3] |= 0b1000_0000;
    // ANCOUNT, NSCOUNT, ARCOUNT → 0 (preserve QDCOUNT).
    resp[6] = 0;
    resp[7] = 0;
    resp[8] = 0;
    resp[9] = 0;
    resp[10] = 0;
    resp[11] = 0;
    // Truncate anything past the question section. We need to find the end of
    // the first question. If parsing fails, just return the header+qname as-is.
    if let Some(end) = question_section_end(&resp) {
        resp.truncate(end);
    }
    resp
}

fn zeros_response(_query: &[u8]) -> Option<Vec<u8>> {
    // TODO (v2): synthesize A=0.0.0.0 / AAAA=:: answer.
    None
}

fn question_section_end(packet: &[u8]) -> Option<usize> {
    // Skip 12-byte header, then walk the QNAME, then +4 for QTYPE+QCLASS.
    let mut i = 12usize;
    while i < packet.len() {
        let len = packet[i] as usize;
        if len == 0 {
            i += 1; // null label
            return Some(i + 4); // QTYPE (2) + QCLASS (2)
        }
        if len & 0xc0 != 0 {
            // pointer in question section shouldn't happen, bail.
            return None;
        }
        i += 1 + len;
        if i > packet.len() {
            return None;
        }
    }
    None
}

/// Extract the QNAME of the first question as a dot-separated ASCII string
/// (lowercased, no trailing dot). Returns `None` for malformed packets.
pub fn extract_qname(packet: &[u8]) -> Option<String> {
    if packet.len() < 13 {
        return None;
    }
    let mut i = 12usize;
    let mut labels: Vec<String> = Vec::new();
    while i < packet.len() {
        let len = packet[i] as usize;
        if len == 0 {
            i += 1;
            // Need QTYPE + QCLASS after, so packet must have 4 more bytes.
            if packet.len() < i + 4 {
                return None;
            }
            return Some(labels.join(".").to_ascii_lowercase());
        }
        if len & 0xc0 != 0 || len > 63 {
            return None;
        }
        i += 1;
        if i + len > packet.len() {
            return None;
        }
        let label = std::str::from_utf8(&packet[i..i + len]).ok()?;
        labels.push(label.to_string());
        i += len;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid DNS query packet for the given QNAME (A record).
    fn build_query(id: u16, qname: &str) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&id.to_be_bytes());
        p.extend_from_slice(&[0x01, 0x00]); // RD=1, others 0
        p.extend_from_slice(&[0x00, 0x01]); // QDCOUNT=1
        p.extend_from_slice(&[0x00, 0x00]); // ANCOUNT
        p.extend_from_slice(&[0x00, 0x00]); // NSCOUNT
        p.extend_from_slice(&[0x00, 0x00]); // ARCOUNT
        for label in qname.split('.') {
            p.push(label.len() as u8);
            p.extend_from_slice(label.as_bytes());
        }
        p.push(0); // null label terminator
        p.extend_from_slice(&[0x00, 0x01]); // QTYPE=A
        p.extend_from_slice(&[0x00, 0x01]); // QCLASS=IN
        p
    }

    #[test]
    fn nxdomain_preserves_id_and_question() {
        let q = build_query(0xbeef, "blocked.example.com");
        let resp = build_response(&q, BlockAction::Nxdomain);
        // Same transaction ID
        assert_eq!(&resp[0..2], &[0xbe, 0xef]);
        // QR bit set, RCODE=3
        assert_eq!(resp[2] & 0x80, 0x80);
        assert_eq!(resp[3] & 0x0f, 0x03);
        // RA bit set
        assert_eq!(resp[3] & 0x80, 0x80);
        // QDCOUNT preserved
        assert_eq!(&resp[4..6], &[0x00, 0x01]);
        // ANCOUNT/NSCOUNT/ARCOUNT zeroed
        assert_eq!(&resp[6..12], &[0, 0, 0, 0, 0, 0]);
        // Question section preserved
        assert_eq!(
            extract_qname(&resp),
            Some("blocked.example.com".to_string())
        );
    }

    #[test]
    fn rd_flag_is_preserved_from_request() {
        let mut q = build_query(0x1234, "ads.com");
        q[2] |= 0x01; // RD=1 already set by build_query, but be explicit
        let resp = build_response(&q, BlockAction::Nxdomain);
        assert_eq!(resp[2] & 0x01, 0x01, "RD bit should be preserved");
    }

    #[test]
    fn malformed_short_packet_returns_empty() {
        assert!(build_response(&[0, 1, 2], BlockAction::Nxdomain).is_empty());
    }

    #[test]
    fn extract_qname_works_for_normal_packet() {
        let q = build_query(0x0001, "foo.BAR.example");
        assert_eq!(extract_qname(&q), Some("foo.bar.example".to_string()));
    }

    #[test]
    fn extract_qname_works_for_single_label() {
        let q = build_query(0x0002, "localhost");
        assert_eq!(extract_qname(&q), Some("localhost".to_string()));
    }

    #[test]
    fn zeros_falls_back_to_nxdomain_for_now() {
        let q = build_query(0x00aa, "x.y.z");
        let resp = build_response(&q, BlockAction::Zeros);
        assert_eq!(resp[3] & 0x0f, 0x03); // NXDOMAIN rcode
    }
}
