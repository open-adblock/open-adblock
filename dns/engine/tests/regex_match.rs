//! Phase 1.4 — regex-based domain matching.

use engine::matcher::RuleSetBuilder;

fn with_regex(patterns: &[&str]) -> engine::matcher::RuleSet {
    let mut b = RuleSetBuilder::new();
    for p in patterns {
        b.add_regex(p);
    }
    b.build().unwrap()
}

#[test]
fn anchored_pattern_matches_only_exact_shape() {
    let rs = with_regex(&[r"^ad-\d+\.example\.com$"]);
    assert!(rs.matches("ad-0.example.com"));
    assert!(rs.matches("ad-4242.example.com"));
    assert!(!rs.matches("ad-x.example.com"));
    assert!(!rs.matches("ad-.example.com"));
    assert!(!rs.matches("pre-ad-1.example.com"));
}

#[test]
fn multiple_patterns_are_all_evaluated() {
    let rs = with_regex(&[r"^telemetry\.", r"\.tracker\.net$"]);
    assert!(rs.matches("telemetry.example.com"));
    assert!(rs.matches("x.y.tracker.net"));
    assert!(!rs.matches("safe.example.com"));
}

#[test]
fn invalid_regex_fails_build() {
    let mut b = RuleSetBuilder::new();
    b.add_regex("(");
    assert!(b.build().is_err(), "invalid regex must reject");
}
