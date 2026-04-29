import { cpSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const filtersRoot = resolve(
  process.env.OPEN_ADBLOCK_BROWSER_FILTERS_DIR || resolve(root, "../../filters/browser")
);
const linkPath = resolve(root, "filters");

if (!existsSync(resolve(filtersRoot, "generated/cosmetic-index.json"))) {
  console.error(
    `Missing browser filters at ${filtersRoot}. Run from the monorepo checkout or set OPEN_ADBLOCK_BROWSER_FILTERS_DIR.`
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
writeCosmeticIndexModule();
console.log(`filters copied from ${relative(root, filtersRoot)}`);

function writeCosmeticIndexModule() {
  const jsonPath = resolve(linkPath, "generated/cosmetic-index.json");
  const modulePath = resolve(linkPath, "generated/cosmetic-index.js");
  const cosmeticIndex = JSON.parse(readFileSync(jsonPath, "utf8"));
  writeFileSync(
    modulePath,
    `const cosmeticIndex = ${JSON.stringify(cosmeticIndex, null, 2)};\n\nexport default cosmeticIndex;\n`
  );
}
