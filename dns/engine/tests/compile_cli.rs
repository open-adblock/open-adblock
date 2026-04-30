//! Phase 1.7 — `engine-compile` CLI integration test.
//!
//! Given a directory layout:
//! - `ruleset.json` (DNS presets and upstream URLs)
//! - `fetched-dir` (cached upstream content, filename = engine URL cache name)
//!
//! The CLI must emit a `filters.bin` that round-trips to an Engine producing the
//! expected verdicts.

use assert_cmd::Command;
use engine::{Engine, Verdict};
use std::fs;
use tempfile::TempDir;

fn cache_name(s: &str) -> String {
    engine::compile::url_cache_filename(s)
}

#[test]
fn cli_compiles_ruleset_preset_into_engine_blob() {
    let tmp = TempDir::new().unwrap();
    let fetched = tmp.path().join("fetched");
    fs::create_dir_all(&fetched).unwrap();

    let upstream_url = "https://example.com/adblock.txt";
    fs::write(
        fetched.join(cache_name(upstream_url)),
        "||upstream-blocked.example.com^\n@@||hand-allowed.example.com^\n||ads.example.com^\n",
    )
    .unwrap();

    let ruleset = tmp.path().join("ruleset.json");
    fs::write(
        &ruleset,
        format!(
            r#"{{
              "version": "test",
              "presets": [
                {{"id": "light", "urls": [{{"url": "{upstream_url}"}}]}}
              ]
            }}"#
        ),
    )
    .unwrap();
    let out = tmp.path().join("filters.bin");

    let mut cmd = Command::cargo_bin("engine-compile").unwrap();
    cmd.arg("--ruleset")
        .arg(&ruleset)
        .arg("--preset")
        .arg("light")
        .arg("--fetched")
        .arg(&fetched)
        .arg("-o")
        .arg(&out);
    cmd.assert().success();

    let blob = fs::read(&out).unwrap();
    let engine = Engine::load(&blob).expect("load blob");

    assert_eq!(
        engine.lookup("upstream-blocked.example.com"),
        Verdict::Block
    );
    assert_eq!(engine.lookup("hand-allowed.example.com"), Verdict::Allow);
    // Upstream adblock suffix rule.
    assert_eq!(engine.lookup("pixel.ads.example.com"), Verdict::Block);
    assert_eq!(engine.lookup("ads.example.com"), Verdict::Block);
    assert_eq!(engine.lookup("unrelated.com"), Verdict::Pass);
}

#[test]
fn cli_compiles_only_selected_preset() {
    let tmp = TempDir::new().unwrap();
    let fetched = tmp.path().join("fetched");
    fs::create_dir_all(&fetched).unwrap();

    let light_url = "https://example.com/light.txt";
    let pro_url = "https://example.com/pro.txt";
    fs::write(
        fetched.join(cache_name(light_url)),
        "light-only.example.com\n",
    )
    .unwrap();
    fs::write(fetched.join(cache_name(pro_url)), "pro-only.example.com\n").unwrap();

    let ruleset = tmp.path().join("ruleset.json");
    fs::write(
        &ruleset,
        format!(
            r#"{{
              "presets": [
                {{"id": "light", "urls": [{{"url": "{light_url}"}}]}},
                {{"id": "pro", "urls": [{{"url": "{pro_url}"}}]}}
              ]
            }}"#
        ),
    )
    .unwrap();

    let out = tmp.path().join("filters.bin");
    Command::cargo_bin("engine-compile")
        .unwrap()
        .args([
            "--ruleset",
            ruleset.to_str().unwrap(),
            "--preset",
            "pro",
            "--fetched",
            fetched.to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ])
        .assert()
        .success();

    let engine = Engine::load(&fs::read(&out).unwrap()).unwrap();
    assert_eq!(engine.lookup("pro-only.example.com"), Verdict::Block);
    assert_eq!(engine.lookup("light-only.example.com"), Verdict::Pass);
    assert_eq!(engine.lookup("safe.com"), Verdict::Pass);
}

#[test]
fn cli_errors_when_ruleset_file_missing() {
    let tmp = TempDir::new().unwrap();
    let out = tmp.path().join("filters.bin");
    let missing = tmp.path().join("does-not-exist.json");
    Command::cargo_bin("engine-compile")
        .unwrap()
        .args([
            "--ruleset",
            missing.to_str().unwrap(),
            "--preset",
            "light",
            "--fetched",
            tmp.path().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ])
        .assert()
        .failure();
}
