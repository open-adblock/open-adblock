#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net
/**
 * Download upstream blocklist URLs listed in one or more `.urls` files into
 * a `fetched/` directory next to the `.urls` files. Uses ETag / Last-Modified
 * for conditional fetches so reruns are cheap.
 *
 * The cache filename must match `engine::compile::url_cache_filename(url)` in
 * the Rust engine — a 16-char hex of FxHash64 + `.txt`. We reimplement that
 * hash here (FxHash 64-bit rotating variant).
 *
 * Usage:
 *   deno run -A scripts/fetch-upstream.ts ../filters/dns/light.urls ../filters/dns/pro.urls
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

function stripComment(line: string): string {
  return line.split("#")[0].trim();
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

function fetchedDirFor(urlsFiles: string[]): string {
  const dirs = new Set(urlsFiles.map(parentDir));
  if (dirs.size === 1) {
    return childPath([...dirs][0], "fetched");
  }
  return "filters/fetched";
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

async function readUrls(urlsFile: string): Promise<string[]> {
  const text = await Deno.readTextFile(urlsFile);
  return text.split("\n").map(stripComment).filter((l) => l.length > 0);
}

async function main(args: string[]) {
  if (args.length === 0) {
    console.error("usage: fetch-upstream.ts <urls-file> [urls-file ...]");
    Deno.exit(2);
  }
  const fetchedDir = fetchedDirFor(args);
  await ensureDir(fetchedDir);
  let errors = 0;
  for (const f of args) {
    console.log(`== ${f}`);
    const urls = await readUrls(f);
    for (const u of urls) {
      const r = await fetchOne(u, fetchedDir);
      if (r === "error") errors += 1;
    }
  }
  if (errors > 0) {
    console.error(`${errors} upstream(s) failed`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main(Deno.args);
}
