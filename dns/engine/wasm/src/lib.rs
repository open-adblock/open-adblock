use engine::{Engine, Verdict};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmEngine {
    inner: Engine,
}

#[wasm_bindgen]
impl WasmEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(blob: &[u8]) -> Result<WasmEngine, JsError> {
        let inner = Engine::load(blob).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Self { inner })
    }

    /// 0 = Pass, 1 = Block, 2 = Allow
    pub fn lookup(&self, domain: &str) -> u8 {
        match self.inner.lookup(domain) {
            Verdict::Pass => 0,
            Verdict::Block => 1,
            Verdict::Allow => 2,
        }
    }
}
