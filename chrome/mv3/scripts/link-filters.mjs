import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const filtersRoot = resolve(
  process.env.OPEN_ADBLOCK_BROWSER_FILTERS_DIR || resolve(root, "../../filters/browser")
);
const linkPath = resolve(root, "filters");

if (!existsSync(resolve(filtersRoot, "ruleset.json"))) {
  console.error(
    `Missing browser ruleset catalog at ${filtersRoot}. Run from the monorepo checkout or set OPEN_ADBLOCK_BROWSER_FILTERS_DIR.`
  );
  process.exit(1);
}

if (existsSync(linkPath)) {
  const stat = lstatSync(linkPath);
  if (!stat.isDirectory() && !stat.isSymbolicLink()) {
    console.error(`Refusing to replace non-directory path: ${linkPath}`);
    process.exit(1);
  }
  rmSync(linkPath, { recursive: true, force: true });
}

cpSync(filtersRoot, linkPath, { recursive: true, dereference: true });
writeRulesetModule();
console.log(`filters copied from ${relative(root, filtersRoot)}`);

function writeRulesetModule() {
  const jsonPath = resolve(linkPath, "ruleset.json");
  const generatedDir = resolve(linkPath, "generated");
  const modulePath = resolve(generatedDir, "ruleset.js");
  const rulesets = JSON.parse(readFileSync(jsonPath, "utf8"));
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(
    modulePath,
    `const rulesets = ${JSON.stringify(rulesets, null, 2)};\n\nexport default rulesets;\n`
  );
}
