//! Matchers for domain rules. Three tiers composed in a [`RuleSet`]:
//!
//! 1. Exact: FxHash32 of the domain, sorted `Vec<u32>`, binary search.
//! 2. Suffix: FST of label-reversed domain (e.g. `ads.example.com` → `com.example.ads`).
//!    A suffix rule `*.example.com` stores key `com.example`; a query matches iff
//!    one of its label-reversed prefixes equals a stored key.
//! 3. Regex: small list of `regex::Regex` patterns, evaluated linearly.

use fst::Set;
use regex::Regex;
use std::collections::BTreeSet;

use crate::format::FormatError;

pub const SUFFIX_SEPARATOR: char = '.';

#[derive(Default, Clone, Debug)]
pub struct RuleSet {
    // Serialized pieces (written to/read from the blob).
    pub exact_hashes: Vec<u32>,
    pub suffix_fst: Vec<u8>,
    pub regexes_raw: Vec<String>,

    // Derived pieces built at load time from the above.
    #[doc(hidden)]
    pub(crate) suffix_set: Option<Set<Vec<u8>>>,
    #[doc(hidden)]
    pub(crate) regexes: Vec<Regex>,
}

impl RuleSet {
    /// Returns true if any matcher matches the domain. Input is normalized
    /// (case-folded, trimmed, trailing dot stripped).
    pub fn matches(&self, domain: &str) -> bool {
        let q = normalize_query(domain);
        if q.is_empty() {
            return false;
        }
        if self.match_exact(&q) {
            return true;
        }
        if self.match_suffix(&q) {
            return true;
        }
        self.match_regex(&q)
    }

    fn match_exact(&self, domain: &str) -> bool {
        if self.exact_hashes.is_empty() {
            return false;
        }
        let h = hash_domain(domain);
        self.exact_hashes.binary_search(&h).is_ok()
    }

    fn match_suffix(&self, domain: &str) -> bool {
        let set = match &self.suffix_set {
            Some(s) => s,
            None => return false,
        };
        // Label-reverse the domain and test every prefix that aligns with a label boundary.
        // e.g. "ads.example.com" reversed = "com.example.ads". Prefixes aligned with
        // dots: "com", "com.example", "com.example.ads".
        let reversed = label_reverse(domain);
        let mut start = 0usize;
        let bytes = reversed.as_bytes();
        for (i, b) in bytes.iter().enumerate() {
            if *b == SUFFIX_SEPARATOR as u8 {
                let prefix = &bytes[..i];
                if set.contains(prefix) {
                    return true;
                }
                start = i + 1;
            }
        }
        // Whole string is also a valid boundary (the last label).
        let _ = start;
        if set.contains(bytes) {
            return true;
        }
        false
    }

    fn match_regex(&self, domain: &str) -> bool {
        self.regexes.iter().any(|r| r.is_match(domain))
    }

    pub(crate) fn rebuild(&mut self) -> Result<(), FormatError> {
        self.suffix_set = if self.suffix_fst.is_empty() {
            None
        } else {
            Some(
                Set::new(self.suffix_fst.clone()).map_err(|e| FormatError::MalformedSection {
                    kind: 0,
                    msg: format!("fst: {e}"),
                })?,
            )
        };
        self.regexes = self
            .regexes_raw
            .iter()
            .map(|p| Regex::new(p))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| FormatError::MalformedSection {
                kind: 0,
                msg: format!("regex: {e}"),
            })?;
        Ok(())
    }
}

/// Builder that accumulates rules by kind and produces a [`RuleSet`] with both the
/// serialized pieces and derived caches populated.
#[derive(Default)]
pub struct RuleSetBuilder {
    exact: BTreeSet<String>,
    suffix: BTreeSet<String>,
    regex: Vec<String>,
}

impl RuleSetBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_exact(&mut self, domain: &str) {
        let n = normalize_rule_domain(domain);
        if !n.is_empty() {
            self.exact.insert(n);
        }
    }

    pub fn add_suffix(&mut self, domain: &str) {
        let n = normalize_rule_domain(domain);
        if !n.is_empty() {
            self.suffix.insert(label_reverse(&n));
        }
    }

    pub fn add_regex(&mut self, pattern: &str) {
        let p = pattern.trim();
        if !p.is_empty() {
            self.regex.push(p.to_string());
        }
    }

    pub fn build(self) -> Result<RuleSet, FormatError> {
        let mut exact_hashes: Vec<u32> = self.exact.iter().map(|s| hash_domain(s)).collect();
        exact_hashes.sort_unstable();
        exact_hashes.dedup();

        let suffix_fst = if self.suffix.is_empty() {
            Vec::new()
        } else {
            // BTreeSet iterates in sorted order, which FST requires.
            let set =
                Set::from_iter(self.suffix.iter()).map_err(|e| FormatError::MalformedSection {
                    kind: 0,
                    msg: format!("fst build: {e}"),
                })?;
            set.into_fst().into_inner()
        };

        let mut rs = RuleSet {
            exact_hashes,
            suffix_fst,
            regexes_raw: self.regex,
            suffix_set: None,
            regexes: Vec::new(),
        };
        rs.rebuild()?;
        Ok(rs)
    }
}

pub fn hash_domain(domain: &str) -> u32 {
    use std::hash::{Hash, Hasher};
    let mut h = fxhash::FxHasher32::default();
    domain.hash(&mut h);
    h.finish() as u32
}

pub fn label_reverse(domain: &str) -> String {
    let mut labels: Vec<&str> = domain.split(SUFFIX_SEPARATOR).collect();
    labels.reverse();
    labels.join(&SUFFIX_SEPARATOR.to_string())
}

fn normalize_rule_domain(s: &str) -> String {
    s.trim()
        .trim_end_matches('.')
        .trim_start_matches('.')
        .to_ascii_lowercase()
}

fn normalize_query(s: &str) -> String {
    s.trim().trim_end_matches('.').to_ascii_lowercase()
}
