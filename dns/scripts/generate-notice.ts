#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Render `NOTICE.template` from the same directory as a preset `.urls` file by
 * substituting upstream sources (comments after `#` become the license annotation).
 *
 * Usage:
 *   deno run --allow-read scripts/generate-notice.ts <preset> <urls-file> > NOTICE.txt
 */

interface ParsedUrl {
  url: string;
  annotation: string;
}

async function readUrlsWithAnnotations(path: string): Promise<ParsedUrl[]> {
  const text = await Deno.readTextFile(path);
  const out: ParsedUrl[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const hash = line.indexOf("#");
    const url = hash >= 0 ? line.slice(0, hash).trim() : line.trim();
    const annotation = hash >= 0 ? line.slice(hash + 1).trim() : "";
    if (url) out.push({ url, annotation });
  }
  return out;
}

function renderSources(sources: ParsedUrl[]): string {
  return sources
    .map((s) => `  - ${s.url}${s.annotation ? `    ${s.annotation}` : ""}`)
    .join("\n");
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

async function main(args: string[]) {
  if (args.length < 2) {
    console.error("usage: generate-notice.ts <preset> <urls-file>");
    Deno.exit(2);
  }
  const [preset, urlsFile] = args;
  const template = await Deno.readTextFile(childPath(parentDir(urlsFile), "NOTICE.template"));
  const sources = await readUrlsWithAnnotations(urlsFile);
  const rendered = template
    .replaceAll("{preset}", preset)
    .replaceAll("{sources}", renderSources(sources))
    .replaceAll("{timestamp}", new Date().toISOString());
  console.log(rendered);
}

if (import.meta.main) {
  await main(Deno.args);
}
