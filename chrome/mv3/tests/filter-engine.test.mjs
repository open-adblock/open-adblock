import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileCosmeticRules,
  compileNetworkRules,
  countCosmeticRules,
  parseNetworkFilterLine
} from "../src/background/filter-engine.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const mv3Root = dirname(testDir);
const browserFiltersRoot = resolveBrowserFiltersRoot();

function resolveBrowserFiltersRoot() {
  const candidates = [
    process.env.OPEN_ADBLOCK_BROWSER_FILTERS_DIR,
    join(mv3Root, "filters"),
    join(mv3Root, "../../filters/browser")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "generated/cosmetic-index.json"))) {
      return candidate;
    }
  }

  throw new Error(
    "Missing browser filters. Run from the monorepo checkout or set OPEN_ADBLOCK_BROWSER_FILTERS_DIR."
  );
}

test("network compiler emits DNR block rules with typed resources", () => {
  const result = compileNetworkRules(
    [
      {
        text: "||ads.example^$script,image",
        defaultAction: "block"
      }
    ],
    1000,
    100
  );

  assert.equal(result.unsupported.length, 0);
  assert.equal(result.rules.length, 1);
  assert.deepEqual(result.rules[0], {
    id: 1000,
    priority: 100,
    action: { type: "block" },
    condition: {
      urlFilter: "||ads.example^",
      resourceTypes: ["script", "image"]
    }
  });
});

test("allowlist source defaults to allow action", () => {
  const result = compileNetworkRules(
    [
      {
        text: "||cdn.example^$script",
        defaultAction: "allow"
      }
    ],
    2000,
    100
  );

  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].action.type, "allow");
  assert.equal(result.rules[0].priority, 5000);
});

test("document allow filters compile to allowAllRequests", () => {
  const parsed = parseNetworkFilterLine("@@||news.example^$document", "block");

  assert.equal(parsed.action, "allowAllRequests");
  assert.deepEqual(parsed.condition, {
    urlFilter: "||news.example^",
    resourceTypes: ["main_frame"]
  });
});

test("badfilter disables a matching generated rule", () => {
  const result = compileNetworkRules(
    [
      {
        text: [
          "||ads.example^$script",
          "||ads.example^$badfilter,script"
        ].join("\n"),
        defaultAction: "block"
      }
    ],
    3000,
    100
  );

  assert.equal(result.unsupported.length, 0);
  assert.equal(result.badfilters.length, 1);
  assert.equal(result.rules.length, 0);
});

test("cosmetic compiler separates global, host, and exception selectors", () => {
  const result = compileCosmeticRules(
    [
      {
        text: [
          "##.ad-banner",
          "example.com##.sponsor",
          "example.com,~shop.example.com##.promo",
          "example.com#@#.sponsor"
        ].join("\n"),
        defaultException: false
      }
    ],
    "test-1"
  );

  assert.deepEqual(result.global, [".ad-banner"]);
  assert.deepEqual(result.byHost["example.com"], [".sponsor", ".promo"]);
  assert.deepEqual(result.exceptions.byHost["example.com"], [".sponsor"]);
  assert.deepEqual(result.exceptions.byHost["shop.example.com"], [".promo"]);
  assert.equal(countCosmeticRules(result), 3);
});

test("allowlist cosmetic files compile as exceptions", () => {
  const result = compileCosmeticRules(
    [
      {
        text: "example.com##.ad-slot",
        defaultException: true
      }
    ],
    "test-2"
  );

  assert.deepEqual(result.byHost, {});
  assert.deepEqual(result.exceptions.byHost["example.com"], [".ad-slot"]);
});

test("procedural cosmetic filters are reported unsupported", () => {
  const result = compileCosmeticRules(
    [
      {
        text: "example.com##div:has-text(Advertisement)",
        defaultException: false
      }
    ],
    "test-3"
  );

  assert.equal(result.unsupported.length, 1);
  assert.equal(result.unsupported[0].reason, "unsupported-selector");
});

test("EasyList CNN cosmetic filters compile into supported selectors and exceptions", () => {
  const result = compileCosmeticRules(
    [
      {
        text: [
          "cnn.com#@##outbrain_widget_0",
          "cnn.com###js-outbrain-rightrail-ads-module",
          "cnn.com##.ad-slot-dynamic",
          "cnn.com##.ad-slot-header__wrapper",
          "cnn.com##.zone__ads",
          "cnn.com##[data-zone-label=\"Paid Partner Content\"]"
        ].join("\n"),
        defaultException: false
      }
    ],
    "easylist-cnn"
  );

  assert.deepEqual(result.exceptions.byHost["cnn.com"], ["#outbrain_widget_0"]);
  assert.deepEqual(result.byHost["cnn.com"], [
    "#js-outbrain-rightrail-ads-module",
    ".ad-slot-dynamic",
    ".ad-slot-header__wrapper",
    ".zone__ads",
    "[data-zone-label=\"Paid Partner Content\"]"
  ]);
  assert.equal(result.unsupported.length, 0);
});

test("packaged cosmetic index contains CNN selectors for content-script fallback", async () => {
  const raw = await readFile(join(browserFiltersRoot, "generated/cosmetic-index.json"), "utf8");
  const index = JSON.parse(raw);

  assert.ok(index.version);
  assert.ok(index.byHost["cnn.com"].includes(".ad-slot-dynamic"));
  assert.ok(index.byHost["cnn.com"].includes(".zone__ads"));
  assert.ok(index.exceptions.byHost["cnn.com"].includes("#outbrain_widget_0"));
});
