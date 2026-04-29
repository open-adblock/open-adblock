//! DNS filter matching engine.
//!
//! Core API: [`Engine::load`] parses a compiled filter blob, and [`Engine::lookup`]
//! returns a [`Verdict`] for a given domain.

pub mod compile;
pub mod format;
pub mod matcher;

use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Verdict {
    Pass = 0,
    Block = 1,
    Allow = 2,
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("filter blob: {0}")]
    Format(#[from] format::FormatError),
    #[error("compile: {0}")]
    Compile(#[from] compile::CompileError),
}

pub struct Engine {
    allow: matcher::RuleSet,
    block: matcher::RuleSet,
}

impl Engine {
    pub fn load(blob: &[u8]) -> Result<Self, EngineError> {
        let decoded = format::decode(blob)?;
        Ok(Self {
            allow: decoded.allow,
            block: decoded.block,
        })
    }

    pub fn lookup(&self, domain: &str) -> Verdict {
        if self.allow.matches(domain) {
            return Verdict::Allow;
        }
        if self.block.matches(domain) {
            return Verdict::Block;
        }
        Verdict::Pass
    }
}
