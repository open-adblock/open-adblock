#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net
/**
 * Download upstream blocklist URLs listed in `filters/dns/ruleset.json` into
 * a `fetched/` directory next to the ruleset catalog. Uses ETag /
 * Last-Modified for conditional fetches so reruns are cheap.
 *
 * The cache filename must match `engine::compile::url_cache_filename(url)` in
 * the Rust engine — a 16-char hex of FxHash64 + `.txt`. We reimplement that
 * hash here (FxHash 64-bit rotating variant).
 *
 * Usage:
 *   deno run -A scripts/fetch-upstream.ts ../filters/dns/ruleset.json [preset ...]
 */

function fxHash64(s: string): bigint {
  // Mirrors `fxhash::FxHasher64` (0.2.1) + stable-Rust `<str as Hash>::hash`.
  // The hasher chunks into 8-byte little-endian words, then 4-byte, then
  // per-byte remainders. The `Hash for str` impl writes the UTF-8 bytes and
  // then a 0xff terminator via `write_u8`, which the hasher processes as a
  // single separate `hash_word(0xff)` step (not appended to the byte stream).
  const ROT = 5n;
  const K = 0x517cc1b727220a95n;
  const MASK = (1n << 64n) - 1n;
  const step = (h: bigint, word: bigint): bigint => {
    return ((((h << ROT) | (h >> (64n - ROT))) & MASK) ^ word) * K & MASK;
  };
  const bytes = new TextEncoder().encode(s);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let h = 0n;
  let i = 0;
  while (bytes.length - i >= 8) {
    h = step(h, dv.getBigUint64(i, /*littleEndian=*/ true));
    i += 8;
  }
  if (bytes.length - i >= 4) {
    h = step(h, BigInt(dv.getUint32(i, true)));
    i += 4;
  }
  for (; i < bytes.length; i++) {
    h = step(h, BigInt(bytes[i]));
  }
  // Separate write call from write_u8(0xff)
  h = step(h, 0xffn);
  return h;
}

export function urlCacheFilename(url: string): string {
  const h = fxHash64(url);
  return `${h.toString(16).padStart(16, "0")}.txt`;
}

export interface DnsRulesetSource {
  url: string;
  name?: string;
  license?: string;
}

export interface DnsRulesetPreset {
  id: string;
  name?: string;
  description?: string;
  urls: DnsRulesetSource[];
}

export interface DnsRuleset {
  version?: string;
  presets: DnsRulesetPreset[];
}

interface CacheMeta {
  etag?: string;
  lastModified?: string;
}

async function readMeta(metaPath: string): Promise<CacheMeta> {
  try {
    return JSON.parse(await Deno.readTextFile(metaPath)) as CacheMeta;
  } catch {
    return {};
  }
}

async function writeMeta(metaPath: string, meta: CacheMeta): Promise<void> {
  await Deno.writeTextFile(metaPath, JSON.stringify(meta));
}

function parentDir(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

function childPath(dir: string, child: string): string {
  if (dir === ".") return child;
  if (dir.endsWith("/")) return `${dir}${child}`;
  return `${dir}/${child}`;
}

function fetchedDirFor(rulesetFile: string): string {
  return childPath(parentDir(rulesetFile), "fetched");
}

async function ensureDir(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
}

async function fetchOne(url: string, outDir: string): Promise<"fresh" | "cached" | "error"> {
  const bodyPath = `${outDir}/${urlCacheFilename(url)}`;
  const metaPath = `${bodyPath}.meta.json`;
  const meta = await readMeta(metaPath);
  const headers: Record<string, string> = {
    "user-agent": "open-adblock-dns/0.1 (+https://github.com/open-adblock/open-adblock)",
  };
  if (meta.etag) headers["if-none-match"] = meta.etag;
  if (meta.lastModified) headers["if-modified-since"] = meta.lastModified;

  let resp: Response;
  try {
    resp = await fetch(url, { headers });
  } catch (e) {
    console.error(`! ${url} fetch error: ${e}`);
    return "error";
  }

  if (resp.status === 304) {
    console.log(`  ${url} → 304 not modified (${urlCacheFilename(url)})`);
    return "cached";
  }
  if (!resp.ok) {
    console.error(`! ${url} → ${resp.status} ${resp.statusText}`);
    return "error";
  }
  const body = new Uint8Array(await resp.arrayBuffer());
  await Deno.writeFile(bodyPath, body);
  await writeMeta(metaPath, {
    etag: resp.headers.get("etag") ?? undefined,
    lastModified: resp.headers.get("last-modified") ?? undefined,
  });
  console.log(`  ${url} → ${body.byteLength} bytes (${urlCacheFilename(url)})`);
  return "fresh";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readDnsRuleset(path: string): Promise<DnsRuleset> {
  const raw = JSON.parse(await Deno.readTextFile(path)) as unknown;
  if (!isRecord(raw) || !Array.isArray(raw.presets)) {
    throw new Error(`DNS ruleset must contain a presets array: ${path}`);
  }

  const presets = raw.presets.map((preset, index): DnsRulesetPreset => {
    if (!isRecord(preset) || typeof preset.id !== "string" || !Array.isArray(preset.urls)) {
      throw new Error(`DNS ruleset preset ${index} must contain id and urls`);
    }
    const urls = preset.urls.map((source, sourceIndex): DnsRulesetSource => {
      if (!isRecord(source) || typeof source.url !== "string" || source.url.trim() === "") {
        throw new Error(`DNS ruleset preset ${preset.id} source ${sourceIndex} must contain url`);
      }
      return {
        url: source.url.trim(),
        name: typeof source.name === "string" ? source.name : undefined,
        license: typeof source.license === "string" ? source.license : undefined,
      };
    }).filter((source) => source.url.length > 0);
    if (urls.length === 0) {
      throw new Error(`DNS ruleset preset ${preset.id} must contain at least one url`);
    }
    return {
      id: preset.id,
      name: typeof preset.name === "string" ? preset.name : undefined,
      description: typeof preset.description === "string" ? preset.description : undefined,
      urls,
    };
  });

  return {
    version: typeof raw.version === "string" ? raw.version : undefined,
    presets,
  };
}

export function selectPresetSources(
  ruleset: DnsRuleset,
  presetIds: string[],
): Array<{ preset: DnsRulesetPreset; source: DnsRulesetSource }> {
  const selectedIds = presetIds.length > 0
    ? new Set(presetIds)
    : new Set(ruleset.presets.map((preset) => preset.id));
  const knownIds = new Set(ruleset.presets.map((preset) => preset.id));
  for (const id of selectedIds) {
    if (!knownIds.has(id)) {
      throw new Error(`unknown DNS ruleset preset: ${id}`);
    }
  }
  const selected: Array<{ preset: DnsRulesetPreset; source: DnsRulesetSource }> = [];
  for (const preset of ruleset.presets) {
    if (!selectedIds.has(preset.id)) continue;
    for (const source of preset.urls) {
      selected.push({ preset, source });
    }
  }
  return selected;
}

async function main(args: string[]) {
  if (args.length === 0) {
    console.error("usage: fetch-upstream.ts <ruleset.json> [preset ...]");
    Deno.exit(2);
  }
  const [rulesetFile, ...presetIds] = args;
  const ruleset = await readDnsRuleset(rulesetFile);
  const sources = selectPresetSources(ruleset, presetIds);
  const fetchedDir = fetchedDirFor(rulesetFile);
  await ensureDir(fetchedDir);
  let errors = 0;
  let currentPreset = "";
  for (const { preset, source } of sources) {
    if (preset.id !== currentPreset) {
      currentPreset = preset.id;
      console.log(`== ${preset.id}`);
    }
    const r = await fetchOne(source.url, fetchedDir);
    if (r === "error") errors += 1;
  }
  if (errors > 0) {
    console.error(`${errors} upstream(s) failed`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main(Deno.args);
}
