//! Upstream resolver. Forwards raw DNS packet bytes to an upstream UDP server
//! and relays the response as-is. Preserves all EDNS0/DNSSEC bits because we
//! never re-serialize the response.

use anyhow::{Context, Result};
use std::net::SocketAddr;
use tokio::net::UdpSocket;
use tokio::time::{timeout, Duration};

const FORWARD_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_DNS_UDP: usize = 4096; // EDNS0 extended maximum

/// Forwards raw DNS packets to an upstream UDP server.
///
/// v1 binds a fresh ephemeral socket per forward to avoid response interleave
/// across concurrent queries. v2 will keep a pool and demux by transaction ID.
pub struct Resolver {
    upstream: SocketAddr,
}

impl Resolver {
    pub async fn new(upstream: SocketAddr) -> Result<Self> {
        Ok(Self { upstream })
    }

    pub fn upstream_addr(&self) -> SocketAddr {
        self.upstream
    }

    pub async fn forward(&self, query: &[u8]) -> Result<Vec<u8>> {
        let bind = match self.upstream {
            SocketAddr::V4(_) => "0.0.0.0:0",
            SocketAddr::V6(_) => "[::]:0",
        };
        let sock = UdpSocket::bind(bind).await?;
        sock.connect(self.upstream).await?;
        sock.send(query).await?;
        let mut buf = vec![0u8; MAX_DNS_UDP];
        let n = timeout(FORWARD_TIMEOUT, sock.recv(&mut buf))
            .await
            .context("upstream timed out")??;
        buf.truncate(n);
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UdpSocket;

    /// Spawn a mock upstream that echoes request bytes (XOR-ed on byte 2 to
    /// simulate QR flip) until dropped. Returns its bound address.
    async fn spawn_echo_upstream() -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = sock.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            while let Ok((n, peer)) = sock.recv_from(&mut buf).await {
                let mut resp = buf[..n].to_vec();
                if resp.len() >= 3 {
                    resp[2] |= 0x80; // set QR bit
                }
                let _ = sock.send_to(&resp, peer).await;
            }
        });
        (addr, handle)
    }

    #[tokio::test]
    async fn forward_round_trips_bytes_through_mock_upstream() {
        let (addr, _h) = spawn_echo_upstream().await;
        let resolver = Resolver::new(addr).await.unwrap();
        let query = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x03www\x07example\x03com\x00\x00\x01\x00\x01";
        let resp = resolver.forward(query).await.unwrap();
        // Transaction ID preserved
        assert_eq!(&resp[0..2], &[0x12, 0x34]);
        // QR bit flipped by mock
        assert_eq!(resp[2] & 0x80, 0x80);
        // Question section unchanged
        assert_eq!(&resp[12..], &query[12..]);
    }

    #[tokio::test]
    async fn forward_preserves_edns0_opt_record_bytes() {
        // Same query but with an OPT pseudo-record in ARCOUNT (minimal EDNS0).
        let (addr, _h) = spawn_echo_upstream().await;
        let resolver = Resolver::new(addr).await.unwrap();
        let mut query: Vec<u8> = Vec::new();
        query.extend_from_slice(&[0xab, 0xcd]);
        query.extend_from_slice(&[0x01, 0x00]); // flags
        query.extend_from_slice(&[0x00, 0x01]); // QDCOUNT
        query.extend_from_slice(&[0x00, 0x00]); // ANCOUNT
        query.extend_from_slice(&[0x00, 0x00]); // NSCOUNT
        query.extend_from_slice(&[0x00, 0x01]); // ARCOUNT = 1 (OPT)
        query.extend_from_slice(b"\x07example\x03com\x00");
        query.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // QTYPE A, QCLASS IN
                                                            // OPT record: root name(0), TYPE=41 (OPT), CLASS=UDP payload 4096,
                                                            // TTL=0, RDLENGTH=0
        query.extend_from_slice(&[
            0x00, // root name
            0x00, 0x29, // TYPE=41
            0x10, 0x00, // UDP payload 4096
            0x00, 0x00, 0x00, 0x00, // TTL
            0x00, 0x00, // RDLENGTH
        ]);

        let resp = resolver.forward(&query).await.unwrap();
        assert_eq!(resp.len(), query.len(), "OPT record bytes preserved");
        assert_eq!(&resp[12..], &query[12..]);
    }
}
