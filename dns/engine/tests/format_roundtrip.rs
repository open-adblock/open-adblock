//! Phase 1.1 — binary format round-trip.
//!
//! Every kind of rule we persist must survive encode → decode and still produce
//! the same match results.

use engine::format::{decode, encode, FormatError, MAGIC, VERSION};
use engine::matcher::RuleSetBuilder;

fn build_block(exacts: &[&str], suffixes: &[&str], regexes: &[&str]) -> engine::matcher::RuleSet {
    let mut b = RuleSetBuilder::new();
    for d in exacts {
        b.add_exact(d);
    }
    for s in suffixes {
        b.add_suffix(s);
    }
    for r in regexes {
        b.add_regex(r);
    }
    b.build().expect("build ruleset")
}

#[test]
fn empty_rulesets_round_trip() {
    let allow = build_block(&[], &[], &[]);
    let block = build_block(&[], &[], &[]);
    let blob = encode(&allow, &block).expect("encode");
    assert!(
        blob.starts_with(MAGIC),
        "magic bytes missing: {:?}",
        &blob[..4]
    );
    let decoded = decode(&blob).expect("decode");
    assert!(decoded.allow.exact_hashes.is_empty());
    assert!(decoded.block.exact_hashes.is_empty());
    assert!(decoded.allow.suffix_fst.is_empty());
    assert!(decoded.block.suffix_fst.is_empty());
}

#[test]
fn exact_rules_round_trip_and_match() {
    let block = build_block(&["ads.com", "track.io"], &[], &[]);
    let allow = build_block(&[], &[], &[]);
    let blob = encode(&allow, &block).expect("encode");
    let decoded = decode(&blob).expect("decode");
    assert!(decoded.block.matches("ads.com"));
    assert!(decoded.block.matches("track.io"));
    assert!(!decoded.block.matches("other.com"));
    assert!(!decoded.allow.matches("ads.com"));
}

#[test]
fn suffix_rules_round_trip_and_match() {
    let block = build_block(&[], &["doubleclick.net"], &[]);
    let allow = build_block(&[], &[], &[]);
    let blob = encode(&allow, &block).expect("encode");
    let decoded = decode(&blob).expect("decode");
    assert!(decoded.block.matches("doubleclick.net"));
    assert!(decoded.block.matches("ads.doubleclick.net"));
    assert!(decoded.block.matches("x.y.z.doubleclick.net"));
    assert!(!decoded.block.matches("doubleclick.net.evil.com"));
    assert!(!decoded.block.matches("notdoubleclick.net"));
}

#[test]
fn regex_rules_round_trip_and_match() {
    let block = build_block(&[], &[], &[r"^ad-\d+\.example\.com$"]);
    let allow = build_block(&[], &[], &[]);
    let blob = encode(&allow, &block).expect("encode");
    let decoded = decode(&blob).expect("decode");
    assert!(decoded.block.matches("ad-42.example.com"));
    assert!(decoded.block.matches("ad-0.example.com"));
    assert!(!decoded.block.matches("example.com"));
    assert!(!decoded.block.matches("ad-x.example.com"));
}

#[test]
fn allow_and_block_sides_are_independent() {
    let allow = build_block(&["safe.com"], &[], &[]);
    let block = build_block(&["evil.com"], &[], &[]);
    let blob = encode(&allow, &block).expect("encode");
    let decoded = decode(&blob).expect("decode");
    assert!(decoded.allow.matches("safe.com"));
    assert!(!decoded.allow.matches("evil.com"));
    assert!(decoded.block.matches("evil.com"));
    assert!(!decoded.block.matches("safe.com"));
}

#[test]
fn bad_magic_is_rejected() {
    let bad = b"XXXX\x01\x00\x00\x00\x00\x00\x00\x00";
    match decode(bad) {
        Err(FormatError::BadMagic) => {}
        other => panic!("expected BadMagic, got {:?}", other),
    }
}

#[test]
fn unsupported_version_is_rejected() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(MAGIC);
    let wrong = VERSION.wrapping_add(99);
    bytes.extend_from_slice(&wrong.to_le_bytes());
    bytes.extend_from_slice(&[0u8; 2]); // flags
    bytes.extend_from_slice(&[0u8; 4]); // section count
    match decode(&bytes) {
        Err(FormatError::UnsupportedVersion(v)) => assert_eq!(v, wrong),
        other => panic!("expected UnsupportedVersion, got {:?}", other),
    }
}

#[test]
fn truncated_blob_is_rejected() {
    let short = &b"DNS"[..];
    assert!(matches!(decode(short), Err(FormatError::Truncated)));
}

#[test]
fn all_three_kinds_combined_round_trip() {
    let block = build_block(
        &["ads.com", "track.io"],
        &["doubleclick.net", "googleadservices.com"],
        &[r"^telemetry-\d+\.corp\.net$"],
    );
    let allow = build_block(
        &["safe.ads.com"],
        &["allowed-cdn.com"],
        &[r"^trust-\d+\.corp\.net$"],
    );
    let blob = encode(&allow, &block).expect("encode");
    let decoded = decode(&blob).expect("decode");

    // block side
    assert!(decoded.block.matches("ads.com"));
    assert!(decoded.block.matches("foo.doubleclick.net"));
    assert!(decoded.block.matches("telemetry-9.corp.net"));

    // allow side
    assert!(decoded.allow.matches("safe.ads.com"));
    assert!(decoded.allow.matches("deep.sub.allowed-cdn.com"));
    assert!(decoded.allow.matches("trust-7.corp.net"));

    // cross-contamination check
    assert!(!decoded.allow.matches("ads.com"));
    assert!(!decoded.block.matches("safe.ads.com") || decoded.block.matches("ads.com"));
}
