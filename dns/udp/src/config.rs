//! Server configuration. Parsed from a TOML file via [`serde`].
//!
//! Example:
//! ```toml
//! listen = "0.0.0.0:53"
//! upstream = "1.1.1.1:53"
//! preset = "light"
//! filters_dir = "filters/dist"
//! block_response = "nxdomain"
//! ```

use serde::Deserialize;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_listen")]
    pub listen: SocketAddr,

    #[serde(default = "default_upstream")]
    pub upstream: SocketAddr,

    #[serde(default = "default_preset")]
    pub preset: String,

    pub filters_dir: PathBuf,

    #[serde(default)]
    pub block_response: BlockResponse,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum BlockResponse {
    #[default]
    Nxdomain,
    Zeros, // A → 0.0.0.0 / AAAA → ::
}

impl Config {
    pub fn filters_path(&self) -> PathBuf {
        self.filters_dir.join(format!("{}.bin", self.preset))
    }
}

fn default_listen() -> SocketAddr {
    "0.0.0.0:53".parse().unwrap()
}

fn default_upstream() -> SocketAddr {
    "1.1.1.1:53".parse().unwrap()
}

fn default_preset() -> String {
    "light".to_string()
}
