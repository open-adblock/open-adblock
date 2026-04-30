import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const errors = [];
const browserFiltersRoot = join(root, "filters");
const manifest = readJson("manifest.json");

validateManifest();
validateRules();
validateHtml();
validateJavaScript();
validateRuntimeFilterAssets();
if (hasRuntimeFilterAssets()) {
  validateJsonFiles();
  validateRulesetCatalog();
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("OpenAdBlock MV3 validation passed");

function validateManifest() {
  if (manifest.manifest_version !== 3) {
    errors.push("manifest.json must use manifest_version 3");
  }

  assertFile(manifest.background?.service_worker, "background service worker");
  assertFile(manifest.action?.default_popup, "action default popup");
  assertFile(manifest.options_page, "options page");

  for (const [size, iconPath] of Object.entries(manifest.icons || {})) {
    assertFile(iconPath, `extension icon ${size}`);
  }

  for (const [size, iconPath] of Object.entries(manifest.action?.default_icon || {})) {
    assertFile(iconPath, `action icon ${size}`);
  }

  for (const resource of manifest.declarative_net_request?.rule_resources || []) {
    assertFile(resource.path, `DNR ruleset ${resource.id}`);
  }

  for (const script of manifest.content_scripts || []) {
    for (const jsPath of script.js || []) {
      assertFile(jsPath, "content script");
    }
  }

  const permissions = new Set(manifest.permissions || []);
  for (const permission of [
    "declarativeNetRequest",
    "declarativeNetRequestFeedback",
    "storage",
    "tabs",
    "alarms",
    "scripting",
    "activeTab"
  ]) {
    if (!permissions.has(permission)) {
      errors.push(`manifest.json missing permission: ${permission}`);
    }
  }

  if (!(manifest.host_permissions || []).includes("<all_urls>")) {
    errors.push("manifest.json must include broad <all_urls> host access for MVP");
  }
}

function validateRules() {
  for (const resource of manifest.declarative_net_request?.rule_resources || []) {
    const rules = readJson(resource.path);
    if (!Array.isArray(rules)) {
      errors.push(`${resource.path} must be an array`);
      continue;
    }

    const ids = new Set();
    for (const rule of rules) {
      if (!Number.isInteger(rule.id)) {
        errors.push(`${resource.path} contains a rule without integer id`);
      }
      if (ids.has(rule.id)) {
        errors.push(`${resource.path} contains duplicate rule id ${rule.id}`);
      }
      ids.add(rule.id);

      if (!rule.action?.type || !rule.condition) {
        errors.push(`${resource.path} rule ${rule.id} missing action or condition`);
      }
    }
  }
}

function validateHtml() {
  for (const htmlPath of [manifest.action.default_popup, manifest.options_page]) {
    const html = readText(htmlPath);
    if (/<script[^>]+src=["']https?:\/\//i.test(html)) {
      errors.push(`${htmlPath} loads remote script`);
    }
    if (/<link[^>]+href=["']https?:\/\//i.test(html)) {
      errors.push(`${htmlPath} loads remote stylesheet`);
    }
  }
}

function validateJavaScript() {
  const files = [
    manifest.background.service_worker,
    "src/background/filter-engine.js",
    "src/background/stats.js",
    "src/popup/popup.js",
    "src/options/options.js",
    "src/content/cosmetic.js",
    "src/content/picker.js"
  ];

  if (existsSync(join(root, "filters/generated/ruleset.js"))) {
    files.push("filters/generated/ruleset.js");
  }

  for (const file of files) {
    try {
      execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" });
    } catch (error) {
      errors.push(`${file} failed syntax check: ${String(error.stderr || error.message).trim()}`);
    }
  }
}

function validateJsonFiles() {
  for (const file of ["ruleset.json"]) {
    readFilterJson(file);
  }
}

function validateRulesetCatalog() {
  const rulesets = readFilterJson("ruleset.json");
  if (!Array.isArray(rulesets) || rulesets.length === 0) {
    errors.push("browser filters ruleset.json must contain an array of rulesets");
    return;
  }

  const ids = new Set();
  for (const ruleset of rulesets) {
    if (!ruleset?.id || !ruleset?.name || !Array.isArray(ruleset.urls) || ruleset.urls.length === 0) {
      errors.push("browser filters ruleset.json contains a ruleset without id, name, or urls");
      continue;
    }
    if (ids.has(ruleset.id)) {
      errors.push(`browser filters ruleset.json contains duplicate ruleset id ${ruleset.id}`);
    }
    ids.add(ruleset.id);
  }
}

function validateRuntimeFilterAssets() {
  const missingFiles = [
    "ruleset.json",
    "generated/ruleset.js"
  ].filter((file) => !existsSync(join(browserFiltersRoot, file)));

  if (missingFiles.length === 0) return;

  errors.push(
    `Missing runtime browser filters: ${missingFiles.map((file) => `filters/${file}`).join(", ")}. Run \`npm run filters:link\` before validating or loading this unpacked extension.`
  );
}

function hasRuntimeFilterAssets() {
  return (
    existsSync(join(browserFiltersRoot, "ruleset.json")) &&
    existsSync(join(browserFiltersRoot, "generated/ruleset.js"))
  );
}

function assertFile(relativePath, label) {
  if (!relativePath || !existsSync(join(root, relativePath))) {
    errors.push(`Missing ${label}: ${relativePath || "(empty)"}`);
  }
}

function readJson(relativePath) {
  try {
    return JSON.parse(readText(relativePath));
  } catch (error) {
    errors.push(`${relativePath} is not valid JSON: ${error.message}`);
    return {};
  }
}

function readText(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function readFilterJson(relativePath) {
  try {
    return JSON.parse(readFilterText(relativePath));
  } catch (error) {
    errors.push(`browser filters ${relativePath} is not valid JSON: ${error.message}`);
    return {};
  }
}

function readFilterText(relativePath) {
  return readFileSync(join(browserFiltersRoot, relativePath), "utf8");
}
