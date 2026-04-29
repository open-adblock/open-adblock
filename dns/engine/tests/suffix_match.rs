//! Phase 1.3 — suffix (wildcard) matching via FST of label-reversed domains.

use engine::matcher::RuleSetBuilder;

fn with_suffixes(list: &[&str]) -> engine::matcher::RuleSet {
    let mut b = RuleSetBuilder::new();
    for s in list {
        b.add_suffix(s);
    }
    b.build().unwrap()
}

#[test]
fn suffix_matches_exact_and_subdomains() {
    let rs = with_suffixes(&["doubleclick.net"]);
    assert!(rs.matches("doubleclick.net"));
    assert!(rs.matches("ads.doubleclick.net"));
    assert!(rs.matches("pagead.l.doubleclick.net"));
    assert!(rs.matches("a.b.c.d.e.doubleclick.net"));
}

#[test]
fn suffix_does_not_match_label_suffix_within_a_different_label() {
    // "doubleclick.net" must NOT match "notdoubleclick.net" (no dot boundary).
    let rs = with_suffixes(&["doubleclick.net"]);
    assert!(!rs.matches("notdoubleclick.net"));
    assert!(!rs.matches("xdoubleclick.net"));
}

#[test]
fn suffix_does_not_match_if_rule_is_a_prefix_of_query() {
    // Rule "doubleclick.net" must NOT match "doubleclick.net.evil.com".
    let rs = with_suffixes(&["doubleclick.net"]);
    assert!(!rs.matches("doubleclick.net.evil.com"));
    assert!(!rs.matches("doubleclick.net.x"));
}

#[test]
fn multiple_suffix_rules() {
    let rs = with_suffixes(&["ads.com", "doubleclick.net", "googleadservices.com"]);
    assert!(rs.matches("pixel.ads.com"));
    assert!(rs.matches("ads.com"));
    assert!(rs.matches("deep.sub.googleadservices.com"));
    assert!(!rs.matches("example.com"));
}

#[test]
fn suffix_rule_for_tld_matches_everything_under_it() {
    let rs = with_suffixes(&["test"]);
    assert!(rs.matches("foo.test"));
    assert!(rs.matches("bar.baz.test"));
    // But doesn't match unrelated.
    assert!(!rs.matches("foo.example"));
}

#[test]
fn suffix_case_insensitive() {
    let rs = with_suffixes(&["DoubleClick.NET"]);
    assert!(rs.matches("ads.doubleclick.net"));
}
