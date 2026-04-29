//! Phase 1.6 — source format parsers and auto-detection.

use engine::compile::{parse, sniff_format, Action, Rule, SourceFormat};

fn load_fixture(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e))
}

fn suffix_block_domains(rules: &[Rule]) -> Vec<String> {
    rules
        .iter()
        .filter_map(|r| match r {
            Rule::Suffix {
                domain,
                action: Action::Block,
            } => Some(domain.clone()),
            _ => None,
        })
        .collect()
}

fn suffix_allow_domains(rules: &[Rule]) -> Vec<String> {
    rules
        .iter()
        .filter_map(|r| match r {
            Rule::Suffix {
                domain,
                action: Action::Allow,
            } => Some(domain.clone()),
            _ => None,
        })
        .collect()
}

// ---- sniffing ----

#[test]
fn sniffs_hosts_format() {
    assert_eq!(
        sniff_format(&load_fixture("hosts.sample")).unwrap(),
        SourceFormat::Hosts
    );
}

#[test]
fn sniffs_domains_format() {
    assert_eq!(
        sniff_format(&load_fixture("domains.sample")).unwrap(),
        SourceFormat::Domains
    );
}

#[test]
fn sniffs_adblock_format() {
    assert_eq!(
        sniff_format(&load_fixture("adblock.sample")).unwrap(),
        SourceFormat::AdBlock
    );
}

#[test]
fn sniffs_dnsmasq_format() {
    assert_eq!(
        sniff_format(&load_fixture("dnsmasq.sample")).unwrap(),
        SourceFormat::Dnsmasq
    );
}

#[test]
fn sniff_rejects_non_list_text() {
    let text = "# just a readme\n# nothing to match here\n";
    assert!(sniff_format(text).is_err());
}

// ---- parsing ----

#[test]
fn hosts_parser_extracts_blocked_domains_as_suffix_rules() {
    let text = load_fixture("hosts.sample");
    let rules = parse(&text, SourceFormat::Hosts).unwrap();
    let blocks = suffix_block_domains(&rules);
    // Pi-hole/AdGuard treat hosts entries as suffix rules.
    assert!(blocks.contains(&"ads.example.com".to_string()));
    assert!(blocks.contains(&"tracker.example.net".to_string()));
    assert!(blocks.contains(&"metrics.example.org".to_string()));
    assert!(blocks.contains(&"other-on-same-line.example.com".to_string()));
    // 127.0.0.1 localhost — "localhost" is not a valid domain (no dot), filtered.
    assert!(!blocks.contains(&"localhost".to_string()));
}

#[test]
fn domains_parser_emits_suffix_rules() {
    let text = load_fixture("domains.sample");
    let rules = parse(&text, SourceFormat::Domains).unwrap();
    let blocks = suffix_block_domains(&rules);
    assert_eq!(blocks.len(), 3);
    assert!(blocks.contains(&"ads.example.com".to_string()));
}

#[test]
fn adblock_parser_splits_block_and_allow_as_suffix_rules() {
    let text = load_fixture("adblock.sample");
    let rules = parse(&text, SourceFormat::AdBlock).unwrap();
    let blocks = suffix_block_domains(&rules);
    let allows = suffix_allow_domains(&rules);
    assert!(blocks.contains(&"ads.example.com".to_string()));
    assert!(blocks.contains(&"tracker.example.net".to_string()));
    assert!(allows.contains(&"safe.ads.example.com".to_string()));
    assert!(!blocks.iter().any(|d| d.contains('/')));
}

#[test]
fn dnsmasq_parser_produces_suffix_plus_exact() {
    let text = load_fixture("dnsmasq.sample");
    let rules = parse(&text, SourceFormat::Dnsmasq).unwrap();
    // For each `address=/domain/ip`, we emit both Suffix and Exact Block rules,
    // because dnsmasq matches domain AND subdomains.
    let has_suffix_for = |d: &str| {
        rules
            .iter()
            .any(|r| matches!(r, Rule::Suffix { domain, action: Action::Block } if domain == d))
    };
    let has_exact_for = |d: &str| {
        rules
            .iter()
            .any(|r| matches!(r, Rule::Exact { domain, action: Action::Block } if domain == d))
    };
    assert!(has_suffix_for("ads.example.com"));
    assert!(has_exact_for("ads.example.com"));
    assert!(has_suffix_for("tracker.example.net"));
    // server= lines are upstream overrides, not block rules → skipped.
    assert!(!has_suffix_for("safe.example.com"));
    assert!(!has_exact_for("safe.example.com"));
}

#[test]
fn comments_and_blank_lines_are_ignored_everywhere() {
    let text = "# header\n\n! another\n\nads.example.com\n";
    let rules = parse(text, SourceFormat::Domains).unwrap();
    let blocks = suffix_block_domains(&rules);
    assert_eq!(blocks, vec!["ads.example.com".to_string()]);
}
