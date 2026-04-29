//! Phase 1.2 — exact domain matching via FxHash32 sorted array.

use engine::matcher::RuleSetBuilder;

#[test]
fn blocks_listed_domain() {
    let rs = RuleSetBuilder::new()
        .with_exact(&["ads.com", "track.io", "pixel.example.com"])
        .build_ok();
    assert!(rs.matches("ads.com"));
    assert!(rs.matches("track.io"));
    assert!(rs.matches("pixel.example.com"));
}

#[test]
fn does_not_match_unlisted_domain() {
    let rs = RuleSetBuilder::new().with_exact(&["ads.com"]).build_ok();
    assert!(!rs.matches("example.com"));
    assert!(!rs.matches(""));
}

#[test]
fn exact_does_not_imply_suffix() {
    // Exact rule for "ads.com" must NOT match "foo.ads.com".
    let rs = RuleSetBuilder::new().with_exact(&["ads.com"]).build_ok();
    assert!(rs.matches("ads.com"));
    assert!(!rs.matches("foo.ads.com"));
    assert!(!rs.matches("sub.ads.com"));
}

#[test]
fn case_is_normalized() {
    let rs = RuleSetBuilder::new().with_exact(&["ADS.com"]).build_ok();
    assert!(rs.matches("ads.com"));
    assert!(rs.matches("ADS.COM"));
}

#[test]
fn deduplicates_duplicate_entries() {
    let rs = RuleSetBuilder::new()
        .with_exact(&["ads.com", "ads.com", "ads.com"])
        .build_ok();
    assert_eq!(rs.exact_hashes.len(), 1);
    assert!(rs.matches("ads.com"));
}

// Convenience helpers for terser tests.
trait BuilderExt {
    fn with_exact(self, list: &[&str]) -> Self;
    fn build_ok(self) -> engine::matcher::RuleSet;
}

impl BuilderExt for RuleSetBuilder {
    fn with_exact(mut self, list: &[&str]) -> Self {
        for d in list {
            self.add_exact(d);
        }
        self
    }
    fn build_ok(self) -> engine::matcher::RuleSet {
        self.build().expect("ruleset built")
    }
}
