//! Phase 2.4 — end-to-end UDP DNS test.
//!
//! Compiles a small in-memory filters.bin, starts a mock upstream on a random
//! ephemeral port, launches the real `Server` on another ephemeral port, and
//! fires DNS queries at it using raw UDP. Verifies:
//!
//! - Blocked domains receive NXDOMAIN
//! - Unblocked domains receive the mock upstream's response unmodified
//! - Allowlisted domains are forwarded (allow > block)

use dns_udp::{
    config::{BlockResponse, Config},
    server::Server,
};
use engine::{format::encode, matcher::RuleSetBuilder, Engine};
use std::net::SocketAddr;
use std::time::Duration;
use tempfile::TempDir;
use tokio::net::UdpSocket;
use tokio::time::timeout;

const UPSTREAM_SENTINEL_BYTE: u8 = 0x42; // stamped by mock so we can tell responses apart

fn build_engine() -> Engine {
    let mut allow = RuleSetBuilder::new();
    allow.add_exact("safe.example.com");
    let mut block = RuleSetBuilder::new();
    block.add_exact("blocked.example.com");
    block.add_exact("safe.example.com"); // will lose to allow
    block.add_suffix("adserver.net");
    let blob = encode(&allow.build().unwrap(), &block.build().unwrap()).unwrap();
    Engine::load(&blob).unwrap()
}

/// Build a minimal DNS query for the given name (A record, IN class).
fn build_query(id: u16, qname: &str) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&id.to_be_bytes());
    p.extend_from_slice(&[0x01, 0x00]); // flags: RD=1
    p.extend_from_slice(&[0x00, 0x01]); // QDCOUNT=1
    p.extend_from_slice(&[0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    for label in qname.split('.') {
        p.push(label.len() as u8);
        p.extend_from_slice(label.as_bytes());
    }
    p.push(0);
    p.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // QTYPE A, QCLASS IN
    p
}

async fn spawn_mock_upstream() -> SocketAddr {
    let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = sock.local_addr().unwrap();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 4096];
        while let Ok((n, peer)) = sock.recv_from(&mut buf).await {
            let mut resp = buf[..n].to_vec();
            if resp.len() >= 3 {
                resp[2] |= 0x80; // QR=1
            }
            // Stamp a sentinel byte at the end so tests can recognize
            // upstream-originated responses.
            resp.push(UPSTREAM_SENTINEL_BYTE);
            let _ = sock.send_to(&resp, peer).await;
        }
    });
    addr
}

async fn spawn_server(engine: Engine, upstream: SocketAddr) -> SocketAddr {
    let _tmp = TempDir::new().unwrap(); // keep the fs tidy; filters_dir unused in-mem
    let config = Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        upstream,
        preset: "light".into(),
        filters_dir: std::path::PathBuf::from("ignored-in-e2e"),
        block_response: BlockResponse::Nxdomain,
    };
    let server = Server::bind(&config, engine).await.unwrap();
    let addr = server.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = server.run().await;
    });
    addr
}

async fn ask(server: SocketAddr, query: &[u8]) -> Vec<u8> {
    let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    sock.connect(server).await.unwrap();
    sock.send(query).await.unwrap();
    let mut buf = vec![0u8; 4096];
    let n = timeout(Duration::from_secs(2), sock.recv(&mut buf))
        .await
        .expect("server timed out")
        .unwrap();
    buf.truncate(n);
    buf
}

#[tokio::test]
async fn blocked_domain_receives_nxdomain() {
    let upstream = spawn_mock_upstream().await;
    let server = spawn_server(build_engine(), upstream).await;

    let resp = ask(server, &build_query(0x0001, "blocked.example.com")).await;
    assert_eq!(&resp[0..2], &[0x00, 0x01], "transaction id preserved");
    assert_eq!(resp[2] & 0x80, 0x80, "QR bit set");
    assert_eq!(resp[3] & 0x0f, 0x03, "RCODE = NXDOMAIN");
    // No upstream sentinel — proves the response was built locally.
    assert_ne!(*resp.last().unwrap(), UPSTREAM_SENTINEL_BYTE);
}

#[tokio::test]
async fn pass_domain_is_forwarded_to_upstream() {
    let upstream = spawn_mock_upstream().await;
    let server = spawn_server(build_engine(), upstream).await;

    let resp = ask(server, &build_query(0x0002, "example.org")).await;
    assert_eq!(&resp[0..2], &[0x00, 0x02]);
    assert_eq!(resp[2] & 0x80, 0x80);
    // The upstream sentinel must be present.
    assert_eq!(*resp.last().unwrap(), UPSTREAM_SENTINEL_BYTE);
}

#[tokio::test]
async fn allowlisted_domain_is_forwarded_not_blocked() {
    let upstream = spawn_mock_upstream().await;
    let server = spawn_server(build_engine(), upstream).await;

    let resp = ask(server, &build_query(0x0003, "safe.example.com")).await;
    assert_eq!(&resp[0..2], &[0x00, 0x03]);
    // Must have the sentinel → upstream response, not our NXDOMAIN.
    assert_eq!(*resp.last().unwrap(), UPSTREAM_SENTINEL_BYTE);
    assert_ne!(resp[3] & 0x0f, 0x03, "not NXDOMAIN");
}

#[tokio::test]
async fn blocked_suffix_subdomain_receives_nxdomain() {
    let upstream = spawn_mock_upstream().await;
    let server = spawn_server(build_engine(), upstream).await;

    let resp = ask(server, &build_query(0x0004, "a.b.c.adserver.net")).await;
    assert_eq!(resp[3] & 0x0f, 0x03);
    assert_ne!(*resp.last().unwrap(), UPSTREAM_SENTINEL_BYTE);
}
