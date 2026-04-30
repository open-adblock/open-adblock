#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Render `NOTICE.template` from the same directory as `ruleset.json` by
 * substituting the selected preset's upstream source metadata.
 *
 * Usage:
 *   deno run --allow-read scripts/generate-notice.ts <preset> <ruleset.json> > NOTICE.txt
 */

import { readDnsRuleset } from "./fetch-upstream.ts";
import type { DnsRulesetSource } from "./fetch-upstream.ts";

function renderSources(sources: DnsRulesetSource[]): string {
  return sources
    .map((s) => {
      const annotation = [s.name, s.license].filter(Boolean).join(" ");
      return `  - ${s.url}${annotation ? `    ${annotation}` : ""}`;
    })
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
    console.error("usage: generate-notice.ts <preset> <ruleset.json>");
    Deno.exit(2);
  }
  const [presetId, rulesetFile] = args;
  const template = await Deno.readTextFile(childPath(parentDir(rulesetFile), "NOTICE.template"));
  const ruleset = await readDnsRuleset(rulesetFile);
  const preset = ruleset.presets.find((entry) => entry.id === presetId);
  if (!preset) {
    console.error(`unknown DNS ruleset preset: ${presetId}`);
    Deno.exit(2);
  }
  const rendered = template
    .replaceAll("{preset}", preset.id)
    .replaceAll("{sources}", renderSources(preset.urls))
    .replaceAll("{timestamp}", new Date().toISOString());
  console.log(rendered);
}

if (import.meta.main) {
  await main(Deno.args);
}
