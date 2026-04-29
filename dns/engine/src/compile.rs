//! Source-list parsers and the IR builder that feeds [`crate::matcher::RuleSetBuilder`].
//!
//! Supported upstream formats (auto-detected from the first non-comment lines):
//! - `hosts` — `0.0.0.0 domain.com` / `127.0.0.1 domain.com`
//! - `domains` — bare `domain.com` per line
//! - `adblock` — `||domain.com^` block, `@@||domain.com^` allow
//! - `dnsmasq` — `address=/domain.com/0.0.0.0` / `server=/domain.com/`
//!
//! Custom rule files (not auto-detected; caller specifies):
//! - `wildcards.txt` — `*.example.com` suffix rules
//! - `regex.txt` — raw regex patterns, one per line
//! - `block.txt` / `allow.txt` — one domain per line (same as `domains` format)

use crate::matcher::RuleSetBuilder;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CompileError {
    #[error("unknown source format; first lines did not match any known pattern")]
    UnknownFormat,
    #[error("parse error on line {line}: {msg}")]
    ParseError { line: usize, msg: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFormat {
    Hosts,
    Domains,
    AdBlock,
    Dnsmasq,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Block,
    Allow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rule {
    Exact { domain: String, action: Action },
    Suffix { domain: String, action: Action },
    Regex { pattern: String, action: Action },
}

/// Sniff the format of a source file by scanning up to the first ~100 non-empty,
/// non-comment lines.
pub fn sniff_format(text: &str) -> Result<SourceFormat, CompileError> {
    let mut checked = 0usize;
    let mut hosts = 0;
    let mut domains = 0;
    let mut adblock = 0;
    let mut dnsmasq = 0;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        if line.starts_with("address=") || line.starts_with("server=") {
            dnsmasq += 1;
        } else if line.starts_with("||") || line.starts_with("@@||") {
            adblock += 1;
        } else if let Some(rest) = line.split_whitespace().next() {
            // hosts lines start with an IP address
            if rest.parse::<std::net::IpAddr>().is_ok() {
                hosts += 1;
            } else if looks_like_domain(rest) && line.split_whitespace().count() == 1 {
                domains += 1;
            }
        }
        checked += 1;
        if checked >= 100 {
            break;
        }
    }
    let (best_kind, best_count) = [
        (SourceFormat::Hosts, hosts),
        (SourceFormat::Domains, domains),
        (SourceFormat::AdBlock, adblock),
        (SourceFormat::Dnsmasq, dnsmasq),
    ]
    .into_iter()
    .max_by_key(|(_, c)| *c)
    .unwrap();
    if best_count == 0 {
        return Err(CompileError::UnknownFormat);
    }
    Ok(best_kind)
}

pub fn parse(text: &str, format: SourceFormat) -> Result<Vec<Rule>, CompileError> {
    let mut rules = Vec::new();
    for (idx, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        match format {
            SourceFormat::Hosts => parse_hosts_line(line, idx + 1, &mut rules)?,
            SourceFormat::Domains => parse_domain_line(line, idx + 1, &mut rules)?,
            SourceFormat::AdBlock => parse_adblock_line(line, idx + 1, &mut rules)?,
            SourceFormat::Dnsmasq => parse_dnsmasq_line(line, idx + 1, &mut rules)?,
        }
    }
    Ok(rules)
}

fn parse_hosts_line(line: &str, lineno: usize, out: &mut Vec<Rule>) -> Result<(), CompileError> {
    let mut it = line.split_whitespace();
    let ip = it.next().ok_or_else(|| CompileError::ParseError {
        line: lineno,
        msg: "missing IP".into(),
    })?;
    if ip.parse::<std::net::IpAddr>().is_err() {
        // Not a hosts line; skip.
        return Ok(());
    }
    // Pi-hole / AdGuard convention: each blocked domain matches the name AND
    // all subdomains. Emit a Suffix rule.
    for domain in it {
        if !looks_like_domain(domain) {
            continue;
        }
        out.push(Rule::Suffix {
            domain: domain.to_ascii_lowercase(),
            action: Action::Block,
        });
    }
    Ok(())
}

fn parse_domain_line(line: &str, lineno: usize, out: &mut Vec<Rule>) -> Result<(), CompileError> {
    let domain = line
        .split_whitespace()
        .next()
        .ok_or_else(|| CompileError::ParseError {
            line: lineno,
            msg: "empty".into(),
        })?;
    if !looks_like_domain(domain) {
        return Ok(());
    }
    // `domains` format (Hagezi, OISD) per their docs: "Domains (including
    // possible subdomains)". Emit Suffix so `accounts.doubleclick.net` also
    // matches `anything.accounts.doubleclick.net`.
    out.push(Rule::Suffix {
        domain: domain.to_ascii_lowercase(),
        action: Action::Block,
    });
    Ok(())
}

fn parse_adblock_line(line: &str, _lineno: usize, out: &mut Vec<Rule>) -> Result<(), CompileError> {
    let (action, rest) = if let Some(r) = line.strip_prefix("@@||") {
        (Action::Allow, r)
    } else if let Some(r) = line.strip_prefix("||") {
        (Action::Block, r)
    } else {
        return Ok(());
    };
    let domain = rest.trim_end_matches('^').trim_end_matches('/');
    if !looks_like_domain(domain) {
        return Ok(());
    }
    // AdBlock Plus `||domain^` conventionally blocks subdomains as well.
    out.push(Rule::Suffix {
        domain: domain.to_ascii_lowercase(),
        action,
    });
    Ok(())
}

fn parse_dnsmasq_line(line: &str, _lineno: usize, out: &mut Vec<Rule>) -> Result<(), CompileError> {
    // address=/domain.com/0.0.0.0  → block domain.com (and subdomains, per dnsmasq)
    if let Some(rest) = line.strip_prefix("address=/") {
        let mut parts = rest.splitn(2, '/');
        if let Some(domain) = parts.next() {
            if !looks_like_domain(domain) {
                return Ok(());
            }
            // dnsmasq `address=/example.com/0.0.0.0` blocks example.com AND its subdomains.
            out.push(Rule::Suffix {
                domain: domain.to_ascii_lowercase(),
                action: Action::Block,
            });
            out.push(Rule::Exact {
                domain: domain.to_ascii_lowercase(),
                action: Action::Block,
            });
        }
    }
    Ok(())
}

/// Apply a list of rules to a [`RuleSetBuilder`], routing to the correct side (allow/block).
pub fn apply_rules(rules: &[Rule], allow: &mut RuleSetBuilder, block: &mut RuleSetBuilder) {
    for r in rules {
        let target = |a: Action| match a {
            Action::Allow => &mut *allow as *mut _,
            Action::Block => &mut *block as *mut _,
        };
        let _ = target;
        match r {
            Rule::Exact { domain, action } => match action {
                Action::Allow => allow.add_exact(domain),
                Action::Block => block.add_exact(domain),
            },
            Rule::Suffix { domain, action } => match action {
                Action::Allow => allow.add_suffix(domain),
                Action::Block => block.add_suffix(domain),
            },
            Rule::Regex { pattern, action } => match action {
                Action::Allow => allow.add_regex(pattern),
                Action::Block => block.add_regex(pattern),
            },
        }
    }
}

/// Stable filename used by the CLI and the `fetch-upstream` script to cache the
/// body of an upstream URL. 16-char hex of FxHash64 — sufficient for the small
/// URL sets we work with (user-controlled, tens to hundreds).
pub fn url_cache_filename(url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = fxhash::FxHasher64::default();
    url.hash(&mut h);
    format!("{:016x}.txt", h.finish())
}

fn looks_like_domain(s: &str) -> bool {
    if s.is_empty() || s.len() > 253 {
        return false;
    }
    if s.starts_with('.') || s.ends_with('.') {
        return false;
    }
    if !s.contains('.') {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}
