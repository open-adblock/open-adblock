//! `engine-compile` — build a binary filter blob from upstream URL lists and
//! custom rule files.
//!
//! Usage:
//!   engine-compile \
//!     --urls     ../filters/dns/light.urls    \
//!     --custom   ../filters/dns/custom        \
//!     --fetched  ../filters/dns/fetched       \
//!     -o         ../filters/dns/dist/light.bin
//!
//! Upstream URLs are not fetched here — a separate `fetch-upstream.ts` script
//! populates `--fetched` with files named `<url_cache_filename(url)>`.

use anyhow::{anyhow, bail, Context, Result};
use engine::compile::{apply_rules, parse, sniff_format, url_cache_filename, Action, Rule};
use engine::format::encode;
use engine::matcher::RuleSetBuilder;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

struct Args {
    urls: PathBuf,
    custom: PathBuf,
    fetched: PathBuf,
    out: PathBuf,
}

fn parse_args() -> Result<Args> {
    let mut urls = None;
    let mut custom = None;
    let mut fetched = None;
    let mut out = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--urls" => urls = args.next().map(PathBuf::from),
            "--custom" => custom = args.next().map(PathBuf::from),
            "--fetched" => fetched = args.next().map(PathBuf::from),
            "-o" | "--out" => out = args.next().map(PathBuf::from),
            "-h" | "--help" => {
                print_help();
                std::process::exit(0);
            }
            other => bail!("unknown argument: {other}"),
        }
    }
    Ok(Args {
        urls: urls.ok_or_else(|| anyhow!("--urls <file> required"))?,
        custom: custom.ok_or_else(|| anyhow!("--custom <dir> required"))?,
        fetched: fetched.ok_or_else(|| anyhow!("--fetched <dir> required"))?,
        out: out.ok_or_else(|| anyhow!("-o <file> required"))?,
    })
}

fn print_help() {
    eprintln!(
        "engine-compile --urls <file> --custom <dir> --fetched <dir> -o <out>\n\
         \n\
         Reads the URL list at <file> (one URL per line, `#` comments), looks up each\n\
         in <dir> under `<url_cache_filename>`, parses it, and merges with rules in\n\
         <custom>/{{block,allow,wildcards,regex}}.txt to produce a binary filter blob."
    );
}

fn main() -> Result<()> {
    let args = parse_args()?;

    let mut allow = RuleSetBuilder::new();
    let mut block = RuleSetBuilder::new();

    // Upstreams from URL list.
    let urls_text = fs::read_to_string(&args.urls)
        .with_context(|| format!("reading urls file {}", args.urls.display()))?;
    for (lineno, line) in urls_text.lines().enumerate() {
        let trimmed = strip_comment(line);
        if trimmed.is_empty() {
            continue;
        }
        let url = trimmed;
        let cache_name = url_cache_filename(url);
        let cache_path = args.fetched.join(&cache_name);
        let body = match fs::read_to_string(&cache_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "warning: skip {url} (line {}): cache miss {}: {e}",
                    lineno + 1,
                    cache_path.display()
                );
                continue;
            }
        };
        let fmt = sniff_format(&body).with_context(|| format!("sniffing format for {url}"))?;
        let rules = parse(&body, fmt).with_context(|| format!("parsing {url}"))?;
        eprintln!("  {url}: {:?}, {} rules", fmt, rules.len());
        apply_rules(&rules, &mut allow, &mut block);
    }

    // Custom rule files.
    load_custom_domains(
        &args.custom,
        "block.txt",
        Action::Block,
        &mut block,
        &mut allow,
    )?;
    load_custom_domains(
        &args.custom,
        "allow.txt",
        Action::Allow,
        &mut block,
        &mut allow,
    )?;
    load_custom_wildcards(&args.custom, "wildcards.txt", &mut block)?;
    load_custom_regex(&args.custom, "regex.txt", &mut block)?;

    let allow_set = allow.build()?;
    let block_set = block.build()?;
    let blob = encode(&allow_set, &block_set)?;

    if let Some(parent) = args.out.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).ok();
        }
    }
    fs::write(&args.out, &blob).with_context(|| format!("writing {}", args.out.display()))?;

    eprintln!(
        "compiled {} bytes → {}  (allow: {} exact / {} suffix fst bytes / {} regex; \
         block: {} exact / {} suffix fst bytes / {} regex)",
        blob.len(),
        args.out.display(),
        allow_set.exact_hashes.len(),
        allow_set.suffix_fst.len(),
        allow_set.regexes_raw.len(),
        block_set.exact_hashes.len(),
        block_set.suffix_fst.len(),
        block_set.regexes_raw.len(),
    );
    Ok(())
}

fn strip_comment(line: &str) -> &str {
    let no_hash = line.split('#').next().unwrap_or("").trim();
    no_hash
}

fn load_custom_domains(
    dir: &Path,
    name: &str,
    action: Action,
    block: &mut RuleSetBuilder,
    allow: &mut RuleSetBuilder,
) -> Result<()> {
    let path = dir.join(name);
    let text = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    for line in text.lines() {
        let line = strip_comment(line);
        if line.is_empty() {
            continue;
        }
        let domain = line.split_whitespace().next().unwrap_or("");
        if domain.is_empty() {
            continue;
        }
        let rule = Rule::Exact {
            domain: domain.to_ascii_lowercase(),
            action,
        };
        apply_rules(std::slice::from_ref(&rule), allow, block);
    }
    Ok(())
}

fn load_custom_wildcards(dir: &Path, name: &str, block: &mut RuleSetBuilder) -> Result<()> {
    let path = dir.join(name);
    let text = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    for line in text.lines() {
        let line = strip_comment(line);
        if line.is_empty() {
            continue;
        }
        // Accept both `*.example.com` and bare `example.com` (suffix rule).
        let domain = line.trim_start_matches("*.").to_ascii_lowercase();
        block.add_suffix(&domain);
    }
    Ok(())
}

fn load_custom_regex(dir: &Path, name: &str, block: &mut RuleSetBuilder) -> Result<()> {
    let path = dir.join(name);
    let text = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    for line in text.lines() {
        let line = strip_comment(line);
        if line.is_empty() {
            continue;
        }
        block.add_regex(line);
    }
    Ok(())
}
