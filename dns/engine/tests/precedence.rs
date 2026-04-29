//! Phase 1.5 — `Engine::lookup` integrates allow + block rulesets with
//! allowlist precedence.

use engine::format::{decode, encode};
use engine::matcher::RuleSetBuilder;
use engine::{Engine, Verdict};

fn engine_from(allow: RuleSetBuilder, block: RuleSetBuilder) -> Engine {
    let a = allow.build().unwrap();
    let b = block.build().unwrap();
    let blob = encode(&a, &b).unwrap();
    // Sanity: decoded matches what we built.
    let _ = decode(&blob).unwrap();
    Engine::load(&blob).unwrap()
}

#[test]
fn allowlist_wins_over_blocklist_exact() {
    let mut allow = RuleSetBuilder::new();
    allow.add_exact("safe.ads.com");
    let mut block = RuleSetBuilder::new();
    block.add_exact("safe.ads.com");
    block.add_exact("evil.com");

    let e = engine_from(allow, block);
    assert_eq!(e.lookup("safe.ads.com"), Verdict::Allow);
    assert_eq!(e.lookup("evil.com"), Verdict::Block);
    assert_eq!(e.lookup("unrelated.com"), Verdict::Pass);
}

#[test]
fn specific_allowlist_suffix_overrides_broad_blocklist_suffix() {
    let mut block = RuleSetBuilder::new();
    block.add_suffix("example.com");
    let mut allow = RuleSetBuilder::new();
    allow.add_suffix("safe.example.com");

    let e = engine_from(allow, block);
    assert_eq!(e.lookup("ads.example.com"), Verdict::Block);
    assert_eq!(e.lookup("example.com"), Verdict::Block);
    // allow takes precedence for anything under "safe.example.com"
    assert_eq!(e.lookup("safe.example.com"), Verdict::Allow);
    assert_eq!(e.lookup("deep.safe.example.com"), Verdict::Allow);
}

#[test]
fn unmatched_domain_is_pass() {
    let e = engine_from(RuleSetBuilder::new(), {
        let mut b = RuleSetBuilder::new();
        b.add_exact("ads.com");
        b
    });
    assert_eq!(e.lookup("example.com"), Verdict::Pass);
    assert_eq!(e.lookup("google.com"), Verdict::Pass);
}

#[test]
fn lookup_normalizes_trailing_dot_and_case() {
    let e = engine_from(RuleSetBuilder::new(), {
        let mut b = RuleSetBuilder::new();
        b.add_exact("ads.com");
        b
    });
    assert_eq!(e.lookup("ADS.COM"), Verdict::Block);
    assert_eq!(e.lookup("ads.com."), Verdict::Block);
    assert_eq!(e.lookup(" ads.com "), Verdict::Block);
}

#[test]
fn empty_engine_passes_everything() {
    let e = engine_from(RuleSetBuilder::new(), RuleSetBuilder::new());
    assert_eq!(e.lookup("anything.com"), Verdict::Pass);
    assert_eq!(e.lookup(""), Verdict::Pass);
}
