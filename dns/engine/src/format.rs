//! Binary blob format for compiled filters.
//!
//! Layout (little-endian):
//! ```text
//! magic        "DNSB"   4 bytes
//! version      u16      2 bytes
//! flags        u16      2 bytes (reserved)
//! sections     u32      4 bytes (count)
//! section_table: [kind: u16, offset: u32, len: u32] * sections
//! payload:     bytes
//! ```
//!
//! Section kinds:
//! - 1: allow_exact  (sorted u32 FxHash list)
//! - 2: allow_suffix (FST of reversed-label domains)
//! - 3: allow_regex  (newline-separated regex patterns)
//! - 4: block_exact
//! - 5: block_suffix
//! - 6: block_regex

use crate::matcher::RuleSet;
use byteorder::{LittleEndian as LE, ReadBytesExt, WriteBytesExt};
use std::io::{self, Cursor, Write};
use thiserror::Error;

pub const MAGIC: &[u8; 4] = b"DNSB";
pub const VERSION: u16 = 1;

pub const KIND_ALLOW_EXACT: u16 = 1;
pub const KIND_ALLOW_SUFFIX: u16 = 2;
pub const KIND_ALLOW_REGEX: u16 = 3;
pub const KIND_BLOCK_EXACT: u16 = 4;
pub const KIND_BLOCK_SUFFIX: u16 = 5;
pub const KIND_BLOCK_REGEX: u16 = 6;

#[derive(Debug, Error)]
pub enum FormatError {
    #[error("bad magic bytes")]
    BadMagic,
    #[error("unsupported version: {0}")]
    UnsupportedVersion(u16),
    #[error("truncated blob")]
    Truncated,
    #[error("malformed section (kind={kind}): {msg}")]
    MalformedSection { kind: u16, msg: String },
    #[error("io: {0}")]
    Io(#[from] io::Error),
}

#[derive(Debug)]
pub struct Decoded {
    pub allow: RuleSet,
    pub block: RuleSet,
}

pub fn encode(allow: &RuleSet, block: &RuleSet) -> Result<Vec<u8>, FormatError> {
    let mut sections: Vec<(u16, Vec<u8>)> = Vec::new();
    if !allow.exact_hashes.is_empty() {
        sections.push((KIND_ALLOW_EXACT, encode_exact(&allow.exact_hashes)));
    }
    if !allow.suffix_fst.is_empty() {
        sections.push((KIND_ALLOW_SUFFIX, allow.suffix_fst.clone()));
    }
    if !allow.regexes_raw.is_empty() {
        sections.push((KIND_ALLOW_REGEX, encode_regex(&allow.regexes_raw)));
    }
    if !block.exact_hashes.is_empty() {
        sections.push((KIND_BLOCK_EXACT, encode_exact(&block.exact_hashes)));
    }
    if !block.suffix_fst.is_empty() {
        sections.push((KIND_BLOCK_SUFFIX, block.suffix_fst.clone()));
    }
    if !block.regexes_raw.is_empty() {
        sections.push((KIND_BLOCK_REGEX, encode_regex(&block.regexes_raw)));
    }

    let header_size = 4 + 2 + 2 + 4;
    let table_entry_size = 2 + 4 + 4;
    let table_size = sections.len() * table_entry_size;
    let mut payload_offset: u32 = (header_size + table_size) as u32;

    let mut out = Vec::with_capacity(payload_offset as usize);
    out.write_all(MAGIC)?;
    out.write_u16::<LE>(VERSION)?;
    out.write_u16::<LE>(0)?;
    out.write_u32::<LE>(sections.len() as u32)?;

    let mut offsets = Vec::with_capacity(sections.len());
    for (_, data) in &sections {
        offsets.push(payload_offset);
        payload_offset += data.len() as u32;
    }
    for ((kind, data), offset) in sections.iter().zip(offsets.iter()) {
        out.write_u16::<LE>(*kind)?;
        out.write_u32::<LE>(*offset)?;
        out.write_u32::<LE>(data.len() as u32)?;
    }
    for (_, data) in &sections {
        out.write_all(data)?;
    }
    Ok(out)
}

pub fn decode(blob: &[u8]) -> Result<Decoded, FormatError> {
    if blob.len() < 12 {
        return Err(FormatError::Truncated);
    }
    if &blob[0..4] != MAGIC {
        return Err(FormatError::BadMagic);
    }
    let mut cur = Cursor::new(&blob[4..]);
    let version = cur.read_u16::<LE>()?;
    if version != VERSION {
        return Err(FormatError::UnsupportedVersion(version));
    }
    let _flags = cur.read_u16::<LE>()?;
    let count = cur.read_u32::<LE>()? as usize;

    let table_start = 12;
    let table_entry_size = 10;
    let table_end = table_start + count * table_entry_size;
    if blob.len() < table_end {
        return Err(FormatError::Truncated);
    }

    let mut allow = RuleSet::default();
    let mut block = RuleSet::default();

    for i in 0..count {
        let entry = &blob[table_start + i * table_entry_size..];
        let mut ec = Cursor::new(entry);
        let kind = ec.read_u16::<LE>()?;
        let offset = ec.read_u32::<LE>()? as usize;
        let len = ec.read_u32::<LE>()? as usize;
        let end = offset.checked_add(len).ok_or(FormatError::Truncated)?;
        if end > blob.len() {
            return Err(FormatError::Truncated);
        }
        let data = &blob[offset..end];
        match kind {
            KIND_ALLOW_EXACT => allow.exact_hashes = decode_exact(data)?,
            KIND_ALLOW_SUFFIX => allow.suffix_fst = data.to_vec(),
            KIND_ALLOW_REGEX => allow.regexes_raw = decode_regex(data)?,
            KIND_BLOCK_EXACT => block.exact_hashes = decode_exact(data)?,
            KIND_BLOCK_SUFFIX => block.suffix_fst = data.to_vec(),
            KIND_BLOCK_REGEX => block.regexes_raw = decode_regex(data)?,
            other => {
                return Err(FormatError::MalformedSection {
                    kind: other,
                    msg: "unknown section kind".into(),
                })
            }
        }
    }

    allow.rebuild()?;
    block.rebuild()?;

    Ok(Decoded { allow, block })
}

fn encode_exact(hashes: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(hashes.len() * 4);
    for h in hashes {
        out.write_u32::<LE>(*h).unwrap();
    }
    out
}

fn decode_exact(data: &[u8]) -> Result<Vec<u32>, FormatError> {
    if !data.len().is_multiple_of(4) {
        return Err(FormatError::MalformedSection {
            kind: KIND_ALLOW_EXACT,
            msg: "exact section length not divisible by 4".into(),
        });
    }
    let mut out = Vec::with_capacity(data.len() / 4);
    let mut cur = Cursor::new(data);
    while (cur.position() as usize) < data.len() {
        out.push(cur.read_u32::<LE>()?);
    }
    Ok(out)
}

fn encode_regex(patterns: &[String]) -> Vec<u8> {
    patterns.join("\n").into_bytes()
}

fn decode_regex(data: &[u8]) -> Result<Vec<String>, FormatError> {
    let s = std::str::from_utf8(data).map_err(|_| FormatError::MalformedSection {
        kind: KIND_BLOCK_REGEX,
        msg: "regex section not valid UTF-8".into(),
    })?;
    Ok(s.lines()
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect())
}
