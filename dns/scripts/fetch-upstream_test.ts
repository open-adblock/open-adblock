// Cross-verifies the JS FxHash64 reimplementation against reference values
// produced by `engine::compile::url_cache_filename` in Rust. If this test ever
// fails, the Rust + JS encodings will produce different cache filenames and
// the compile step will miss cached bodies.

import { assertEquals, assertRejects, assertThrows } from "std/assert/mod.ts";
import { readDnsRuleset, selectPresetSources, urlCacheFilename } from "./fetch-upstream.ts";

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

Deno.test("readDnsRuleset parses preset source metadata", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/ruleset.json`;
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: "test",
        presets: [
          {
            id: "light",
            name: "Light",
            urls: [{ url: "https://example.com/light.txt", name: "Example", license: "GPLv3" }],
          },
        ],
      }),
    );

    const ruleset = await readDnsRuleset(path);
    assertEquals(ruleset.version, "test");
    assertEquals(ruleset.presets[0].id, "light");
    assertEquals(ruleset.presets[0].urls[0].url, "https://example.com/light.txt");
    assertEquals(ruleset.presets[0].urls[0].name, "Example");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readDnsRuleset rejects presets without urls", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/ruleset.json`;
  try {
    await Deno.writeTextFile(path, JSON.stringify({ presets: [{ id: "broken", urls: [] }] }));
    await assertRejects(() => readDnsRuleset(path), Error, "at least one url");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("selectPresetSources selects all presets by default", () => {
  const sources = selectPresetSources(
    {
      presets: [
        { id: "light", urls: [{ url: "https://example.com/light.txt" }] },
        { id: "pro", urls: [{ url: "https://example.com/pro.txt" }] },
      ],
    },
    [],
  );

  assertEquals(sources.map(({ preset, source }) => `${preset.id}:${source.url}`), [
    "light:https://example.com/light.txt",
    "pro:https://example.com/pro.txt",
  ]);
});

Deno.test("selectPresetSources rejects unknown preset ids", () => {
  assertThrows(
    () => selectPresetSources({ presets: [{ id: "light", urls: [{ url: "x" }] }] }, ["pro"]),
    Error,
    "unknown DNS ruleset preset: pro",
  );
});
