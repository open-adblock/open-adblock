//! Phase 2.1 — TOML config parsing.

use dns_udp::config::{BlockResponse, Config};

#[test]
fn parses_full_config() {
    let toml = r#"
listen = "0.0.0.0:5353"
upstream = "1.1.1.1:53"
preset = "pro"
filters_dir = "/tmp/filters"
block_response = "zeros"
"#;
    let c: Config = toml::from_str(toml).unwrap();
    assert_eq!(c.listen.to_string(), "0.0.0.0:5353");
    assert_eq!(c.upstream.to_string(), "1.1.1.1:53");
    assert_eq!(c.preset, "pro");
    assert_eq!(c.filters_dir.to_str().unwrap(), "/tmp/filters");
    assert!(matches!(c.block_response, BlockResponse::Zeros));
}

#[test]
fn defaults_apply_when_fields_missing() {
    let toml = r#"filters_dir = "filters/dist""#;
    let c: Config = toml::from_str(toml).unwrap();
    assert_eq!(c.listen.to_string(), "0.0.0.0:53");
    assert_eq!(c.upstream.to_string(), "1.1.1.1:53");
    assert_eq!(c.preset, "light");
    assert!(matches!(c.block_response, BlockResponse::Nxdomain));
}

#[test]
fn filters_path_helper_resolves_preset_bin() {
    let toml = r#"
filters_dir = "filters/dist"
preset = "pro"
"#;
    let c: Config = toml::from_str(toml).unwrap();
    assert_eq!(c.filters_path().to_str().unwrap(), "filters/dist/pro.bin");
}

#[test]
fn rejects_invalid_block_response() {
    let toml = r#"
filters_dir = "x"
block_response = "banana"
"#;
    let err: Result<Config, _> = toml::from_str(toml);
    assert!(err.is_err(), "unknown block_response must fail");
}
