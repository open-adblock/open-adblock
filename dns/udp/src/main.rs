use anyhow::{Context, Result};
use dns_udp::{config::Config, server::Server};
use engine::Engine;
use std::env;
use std::fs;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,dns_udp=info".into()),
        )
        .init();

    let config_path = env::args()
        .nth(1)
        .or_else(|| {
            let mut args = env::args();
            let mut found = None;
            while let Some(a) = args.next() {
                if a == "--config" {
                    found = args.next();
                    break;
                }
            }
            found
        })
        .unwrap_or_else(|| "udp/config.toml".into());

    let cfg_text = fs::read_to_string(&config_path)
        .with_context(|| format!("reading config {config_path}"))?;
    let config: Config = toml::from_str(&cfg_text).context("parsing config")?;

    let blob = fs::read(config.filters_path())
        .with_context(|| format!("reading filters blob {}", config.filters_path().display()))?;
    let engine = Engine::load(&blob).context("loading engine")?;

    tracing::info!(
        "dns-udp listening on {} (preset={}, upstream={})",
        config.listen,
        config.preset,
        config.upstream
    );
    let server = Server::bind(&config, engine).await?;
    server.run().await
}
