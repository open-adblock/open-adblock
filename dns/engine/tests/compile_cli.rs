//! Phase 1.7 — `engine-compile` CLI integration test.
//!
//! Given a directory layout:
//! - `urls-file` (list of upstream URLs, one per line, comments with `#`)
//! - `fetched-dir` (cached upstream content, filename = sha1 of URL or similar)
//! - `custom-dir` (block.txt, allow.txt, wildcards.txt, regex.txt)
//!
//! The CLI must emit a `filters.bin` that round-trips to an Engine producing the
//! expected verdicts.

use assert_cmd::Command;
use engine::{Engine, Verdict};
use std::fs;
use tempfile::TempDir;

fn sha1_hex(s: &str) -> String {
    // Small vendored SHA1 only for tests would be nicer, but we just need any
    // stable filename derivation the CLI uses. The CLI reads back the same
    // mapping, so we expose a helper that matches it.
    engine::compile::url_cache_filename(s)
}

#[test]
fn cli_compiles_custom_rules_into_engine_blob() {
    let tmp = TempDir::new().unwrap();
    let custom = tmp.path().join("custom");
    let fetched = tmp.path().join("fetched");
    fs::create_dir_all(&custom).unwrap();
    fs::create_dir_all(&fetched).unwrap();

    fs::write(custom.join("block.txt"), "hand-blocked.example.com\n").unwrap();
    fs::write(custom.join("allow.txt"), "hand-allowed.example.com\n").unwrap();
    fs::write(custom.join("wildcards.txt"), "*.ads.example.com\n").unwrap();
    fs::write(custom.join("regex.txt"), r"^telemetry-\d+\.corp\.net$").unwrap();

    // Empty urls file — no upstreams.
    let urls_file = tmp.path().join("light.urls");
    fs::write(&urls_file, "# no upstreams for this test\n").unwrap();

    let out = tmp.path().join("filters.bin");

    let mut cmd = Command::cargo_bin("engine-compile").unwrap();
    cmd.arg("--urls")
        .arg(&urls_file)
        .arg("--custom")
        .arg(&custom)
        .arg("--fetched")
        .arg(&fetched)
        .arg("-o")
        .arg(&out);
    cmd.assert().success();

    let blob = fs::read(&out).unwrap();
    let engine = Engine::load(&blob).expect("load blob");

    assert_eq!(engine.lookup("hand-blocked.example.com"), Verdict::Block);
    assert_eq!(engine.lookup("hand-allowed.example.com"), Verdict::Allow);
    // Wildcard suffix
    assert_eq!(engine.lookup("pixel.ads.example.com"), Verdict::Block);
    assert_eq!(engine.lookup("ads.example.com"), Verdict::Block);
    // Regex
    assert_eq!(engine.lookup("telemetry-7.corp.net"), Verdict::Block);
    // Pass
    assert_eq!(engine.lookup("unrelated.com"), Verdict::Pass);
}

#[test]
fn cli_reads_upstream_from_fetched_dir() {
    let tmp = TempDir::new().unwrap();
    let custom = tmp.path().join("custom");
    let fetched = tmp.path().join("fetched");
    fs::create_dir_all(&custom).unwrap();
    fs::create_dir_all(&fetched).unwrap();

    // Write an upstream list file (domains format).
    let upstream_url = "https://example.com/mylist.txt";
    let cache_name = sha1_hex(upstream_url);
    fs::write(
        fetched.join(&cache_name),
        "# my list\nupstream-blocked.example.com\nanother.example.com\n",
    )
    .unwrap();

    let urls_file = tmp.path().join("light.urls");
    fs::write(&urls_file, format!("{upstream_url}\n")).unwrap();

    let out = tmp.path().join("filters.bin");
    Command::cargo_bin("engine-compile")
        .unwrap()
        .args([
            "--urls",
            urls_file.to_str().unwrap(),
            "--custom",
            custom.to_str().unwrap(),
            "--fetched",
            fetched.to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ])
        .assert()
        .success();

    let engine = Engine::load(&fs::read(&out).unwrap()).unwrap();
    assert_eq!(
        engine.lookup("upstream-blocked.example.com"),
        Verdict::Block
    );
    assert_eq!(engine.lookup("another.example.com"), Verdict::Block);
    assert_eq!(engine.lookup("safe.com"), Verdict::Pass);
}

#[test]
fn cli_errors_when_urls_file_missing() {
    let tmp = TempDir::new().unwrap();
    let out = tmp.path().join("filters.bin");
    let missing = tmp.path().join("does-not-exist.urls");
    Command::cargo_bin("engine-compile")
        .unwrap()
        .args([
            "--urls",
            missing.to_str().unwrap(),
            "--custom",
            tmp.path().to_str().unwrap(),
            "--fetched",
            tmp.path().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ])
        .assert()
        .failure();
}
