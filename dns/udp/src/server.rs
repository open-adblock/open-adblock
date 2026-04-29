//! Main dispatch loop: read packet → extract QNAME → engine lookup →
//! either NXDOMAIN (block), allow pass-through, or forward to upstream.

use crate::blocklist::{build_response, extract_qname, BlockAction};
use crate::config::{BlockResponse, Config};
use crate::resolver::Resolver;
use anyhow::{Context, Result};
use engine::{Engine, Verdict};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::UdpSocket;
use tracing::{debug, warn};

pub struct Server {
    socket: Arc<UdpSocket>,
    engine: Arc<Engine>,
    resolver: Arc<Resolver>,
    block_action: BlockAction,
}

impl Server {
    pub async fn bind(config: &Config, engine: Engine) -> Result<Self> {
        let socket = UdpSocket::bind(config.listen)
            .await
            .with_context(|| format!("bind {}", config.listen))?;
        let resolver = Resolver::new(config.upstream).await?;
        let block_action = match config.block_response {
            BlockResponse::Nxdomain => BlockAction::Nxdomain,
            BlockResponse::Zeros => BlockAction::Zeros,
        };
        Ok(Self {
            socket: Arc::new(socket),
            engine: Arc::new(engine),
            resolver: Arc::new(resolver),
            block_action,
        })
    }

    pub fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.socket.local_addr()
    }

    /// Run the dispatch loop forever.
    pub async fn run(self) -> Result<()> {
        let mut buf = vec![0u8; 4096];
        loop {
            let (n, peer) = match self.socket.recv_from(&mut buf).await {
                Ok(pair) => pair,
                Err(e) => {
                    warn!("recv_from: {e}");
                    continue;
                }
            };
            let packet = buf[..n].to_vec();
            let socket = self.socket.clone();
            let engine = self.engine.clone();
            let resolver = self.resolver.clone();
            let action = self.block_action;
            tokio::spawn(async move {
                handle_packet(packet, peer, socket, engine, resolver, action).await;
            });
        }
    }
}

async fn handle_packet(
    packet: Vec<u8>,
    peer: SocketAddr,
    socket: Arc<UdpSocket>,
    engine: Arc<Engine>,
    resolver: Arc<Resolver>,
    block_action: BlockAction,
) {
    let qname = match extract_qname(&packet) {
        Some(q) => q,
        None => {
            debug!("malformed query from {peer}, ignoring");
            return;
        }
    };
    let verdict = engine.lookup(&qname);
    let response = match verdict {
        Verdict::Block => {
            debug!("block {qname} from {peer}");
            build_response(&packet, block_action)
        }
        Verdict::Allow | Verdict::Pass => match resolver.forward(&packet).await {
            Ok(r) => r,
            Err(e) => {
                warn!("forward {qname} failed: {e}");
                build_response(&packet, BlockAction::Nxdomain)
            }
        },
    };
    if !response.is_empty() {
        if let Err(e) = socket.send_to(&response, peer).await {
            warn!("send_to {peer}: {e}");
        }
    }
}
