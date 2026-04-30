//! `engine-compile` — build a binary filter blob from a DNS ruleset preset.
//!
//! Usage:
//!   engine-compile \
//!     --ruleset  ../filters/dns/ruleset.json  \
//!     --preset   light                         \
//!     --fetched  ../filters/dns/fetched       \
//!     -o         ../filters/dns/dist/light.bin
//!
//! Upstream URLs are not fetched here — a separate `fetch-upstream.ts` script
//! populates `--fetched` with files named `<url_cache_filename(url)>`.

use anyhow::{anyhow, bail, Context, Result};
use engine::compile::{apply_rules, parse, sniff_format, url_cache_filename};
use engine::format::encode;
use engine::matcher::RuleSetBuilder;
use serde::Deserialize;
use std::env;
use std::fs;
use std::path::PathBuf;

struct Args {
    ruleset: PathBuf,
    preset: String,
    fetched: PathBuf,
    out: PathBuf,
}

#[derive(Debug, Deserialize)]
struct DnsRuleset {
    presets: Vec<DnsPreset>,
}

#[derive(Debug, Deserialize)]
struct DnsPreset {
    id: String,
    urls: Vec<DnsSource>,
}

#[derive(Debug, Deserialize)]
struct DnsSource {
    url: String,
}

fn parse_args() -> Result<Args> {
    let mut ruleset = None;
    let mut preset = None;
    let mut fetched = None;
    let mut out = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--ruleset" => ruleset = args.next().map(PathBuf::from),
            "--preset" => preset = args.next(),
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
        ruleset: ruleset.ok_or_else(|| anyhow!("--ruleset <file> required"))?,
        preset: preset.ok_or_else(|| anyhow!("--preset <id> required"))?,
        fetched: fetched.ok_or_else(|| anyhow!("--fetched <dir> required"))?,
        out: out.ok_or_else(|| anyhow!("-o <file> required"))?,
    })
}

fn print_help() {
    eprintln!(
        "engine-compile --ruleset <file> --preset <id> --fetched <dir> -o <out>\n\
         \n\
         Reads the preset from DNS ruleset catalog <file>, looks up each URL in\n\
         <dir> under `<url_cache_filename>`, parses it, and produces a binary\n\
         filter blob."
    );
}

fn main() -> Result<()> {
    let args = parse_args()?;

    let mut allow = RuleSetBuilder::new();
    let mut block = RuleSetBuilder::new();

    let ruleset = read_ruleset(&args.ruleset)?;
    let preset = ruleset
        .presets
        .iter()
        .find(|preset| preset.id == args.preset)
        .ok_or_else(|| anyhow!("unknown DNS ruleset preset: {}", args.preset))?;
    let urls = preset
        .urls
        .iter()
        .map(|source| source.url.trim())
        .filter(|url| !url.is_empty())
        .collect::<Vec<_>>();
    if urls.is_empty() {
        bail!("DNS ruleset preset {} contains no URLs", args.preset);
    }

    for (index, url) in urls.iter().enumerate() {
        let cache_name = url_cache_filename(url);
        let cache_path = args.fetched.join(&cache_name);
        let body = match fs::read_to_string(&cache_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "warning: skip {url} (source {}): cache miss {}: {e}",
                    index + 1,
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

fn read_ruleset(path: &PathBuf) -> Result<DnsRuleset> {
    let text =
        fs::read_to_string(path).with_context(|| format!("reading ruleset {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parsing ruleset {}", path.display()))
}
