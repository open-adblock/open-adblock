// Cross-verifies the JS FxHash64 reimplementation against reference values
// produced by `engine::compile::url_cache_filename` in Rust. If this test ever
// fails, the Rust + JS encodings will produce different cache filenames and
// the compile step will miss cached bodies.

import { assertEquals } from "std/assert/mod.ts";
import { urlCacheFilename } from "./fetch-upstream.ts";

const REFERENCE: Record<string, string> = {
  "foo": "f3b780e5596a0ef1.txt",
  "hello world": "2e52733fe3a9edd0.txt",
  "https://example.com/a.txt": "f951d3ffbcc16563.txt",
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/light.txt":
    "1e3103f25b0b0898.txt",
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/pro.txt":
    "a0b67361b0312f33.txt",
};

Deno.test("urlCacheFilename matches Rust engine::compile::url_cache_filename", () => {
  for (const [input, expected] of Object.entries(REFERENCE)) {
    assertEquals(urlCacheFilename(input), expected, `mismatch for ${JSON.stringify(input)}`);
  }
});
