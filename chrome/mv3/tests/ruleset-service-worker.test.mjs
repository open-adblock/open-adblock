import test from "node:test";
import assert from "node:assert/strict";

test("filter ruleset toggles compile selected sources into dynamic rules", async () => {
  const runtimeListeners = [];
  const dynamicRules = [];
  const storageData = {
    settings: {
      theme: "system"
    },
    filterRulesets: {
      catalogVersion: "test",
      enabledIds: [],
      lastAppliedEnabledIds: [],
      lastAppliedAt: null,
      lastError: null,
      networkRuleCount: 0,
      cosmeticRuleCount: 0,
      unsupportedCount: 0,
      truncated: false,
      rulesetSummary: []
    }
  };

  installChromeMock({ runtimeListeners, dynamicRules, storageData });

  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return ["||ads.example^$script", "example.com##.ad-banner"].join("\n");
    },
    async json() {
      return {};
    }
  });

  await import("../src/background/service-worker.js?ruleset-toggle-test");
  assert.equal(runtimeListeners.length, 1);

  const response = await sendRuntimeMessage(runtimeListeners[0], {
    type: "SET_FILTER_RULESET_ENABLED",
    id: "easylist",
    enabled: true
  });

  assert.equal(response.ok, true);
  assert.equal(response.payload.networkRuleCount, 1);
  assert.equal(dynamicRules.length, 1);
  assert.equal(dynamicRules[0].condition.urlFilter, "||ads.example^");
  assert.deepEqual(storageData.filterRulesets.enabledIds, ["easylist"]);
  assert.deepEqual(storageData.cosmeticRemote.byHost["example.com"], [".ad-banner"]);

  delete globalThis.chrome;
  delete globalThis.fetch;
});

test("first-run defaults enable rulesets matching navigator languages", async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const runtimeListeners = [];
  const storageData = {
    settings: {
      theme: "system"
    }
  };

  Object.defineProperty(globalThis, "navigator", {
    value: { language: "ko-KR", languages: ["ko-KR", "en-US"] },
    configurable: true
  });
  installChromeMock({ runtimeListeners, dynamicRules: [], storageData });
  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return "||ads.example^$script";
    }
  });

  await import("../src/background/service-worker.js?language-defaults-test");
  const response = await sendRuntimeMessage(runtimeListeners[0], { type: "GET_OPTIONS_STATE" });

  assert.equal(response.ok, true);
  assert.ok(response.payload.filterRulesets.enabledIds.includes("ublock-filters"));
  assert.ok(response.payload.filterRulesets.enabledIds.includes("easylist"));
  assert.ok(response.payload.filterRulesets.enabledIds.includes("kor-1"));

  delete globalThis.chrome;
  delete globalThis.fetch;
  if (previousNavigator) {
    Object.defineProperty(globalThis, "navigator", previousNavigator);
  } else {
    delete globalThis.navigator;
  }
});

test("ruleset catalog version changes trigger automatic ruleset refresh", async () => {
  const runtimeListeners = [];
  const dynamicRules = [];
  const storageData = {
    settings: {
      theme: "system"
    },
    filterRulesets: {
      catalogVersion: "old-catalog",
      enabledIds: ["easylist"],
      lastAppliedEnabledIds: ["easylist"],
      lastAppliedAt: 123,
      lastError: null,
      networkRuleCount: 44,
      cosmeticRuleCount: 55,
      unsupportedCount: 66,
      truncated: true,
      rulesetSummary: [{ id: "easylist" }]
    }
  };

  installChromeMock({ runtimeListeners, dynamicRules, storageData });
  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return "||ads.example^$script";
    }
  });

  await import("../src/background/service-worker.js?catalog-version-reset-test");
  const response = await sendRuntimeMessage(runtimeListeners[0], { type: "GET_OPTIONS_STATE" });

  assert.equal(response.ok, true);
  assert.deepEqual(response.payload.filterRulesets.enabledIds, ["easylist"]);
  assert.deepEqual(response.payload.filterRulesets.lastAppliedEnabledIds, ["easylist"]);
  assert.equal(typeof response.payload.filterRulesets.lastAppliedAt, "number");
  assert.equal(response.payload.filterRulesets.networkRuleCount, 1);
  assert.equal(response.payload.filterRulesets.cosmeticRuleCount, 0);
  assert.equal(response.payload.filterRulesets.unsupportedCount, 0);
  assert.equal(response.payload.filterRulesets.truncated, false);
  assert.deepEqual(response.payload.filterRulesets.rulesetSummary, [
    {
      id: "easylist",
      name: "EasyList",
      group: "default",
      sourceCount: 1,
      failedSourceCount: 0,
      bytes: 21
    }
  ]);
  assert.equal(dynamicRules.length, 1);

  delete globalThis.chrome;
  delete globalThis.fetch;
});

test("startup refreshes when stored ruleset state has no matching dynamic rules", async () => {
  const runtimeListeners = [];
  const dynamicRules = [];
  const storageData = {
    settings: {
      theme: "system"
    },
    filterRulesets: {
      catalogVersion: "ruleset-2026-04-30",
      enabledIds: ["easylist"],
      lastAppliedEnabledIds: ["easylist"],
      lastAppliedAt: 123,
      lastError: null,
      networkRuleCount: 2,
      cosmeticRuleCount: 0,
      unsupportedCount: 0,
      truncated: false,
      rulesetSummary: []
    }
  };

  installChromeMock({ runtimeListeners, dynamicRules, storageData });
  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return "||ads.example^$script";
    }
  });

  await import("../src/background/service-worker.js?missing-dynamic-rules-test");
  const response = await sendRuntimeMessage(runtimeListeners[0], { type: "GET_OPTIONS_STATE" });

  assert.equal(response.ok, true);
  assert.equal(response.payload.filterRulesets.networkRuleCount, 1);
  assert.equal(dynamicRules.length, 1);

  delete globalThis.chrome;
  delete globalThis.fetch;
});

test("ruleset update respects Chrome dynamic DNR quota", async () => {
  const runtimeListeners = [];
  const dynamicRules = [
    { id: 42, action: { type: "allowAllRequests" }, condition: { urlFilter: "||kept.example^" } },
    { id: 1000000, action: { type: "block" }, condition: { urlFilter: "||old-a.example^" } },
    { id: 1005000, action: { type: "block" }, condition: { urlFilter: "||old-b.example^" } }
  ];
  const storageData = {
    settings: {
      theme: "system"
    },
    filterRulesets: {
      catalogVersion: "ruleset-2026-04-30",
      enabledIds: ["easylist"],
      lastAppliedEnabledIds: ["easylist"],
      lastAppliedAt: 123,
      lastError: null,
      networkRuleCount: 2,
      cosmeticRuleCount: 0,
      unsupportedCount: 0,
      truncated: false,
      rulesetSummary: []
    }
  };

  installChromeMock({
    runtimeListeners,
    dynamicRules,
    storageData,
    dnrConstants: { MAX_NUMBER_OF_DYNAMIC_RULES: 3 }
  });

  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return [
        "||ads0.example^$script",
        "||ads1.example^$script",
        "||ads2.example^$script",
        "||ads3.example^$script"
      ].join("\n");
    }
  });

  await import("../src/background/service-worker.js?dnr-quota-test");
  const response = await sendRuntimeMessage(runtimeListeners[0], { type: "RUN_REMOTE_UPDATE" });

  assert.equal(response.ok, true);
  assert.equal(response.payload.networkRuleCount, 2);
  assert.equal(response.payload.truncated, true);
  assert.deepEqual(
    dynamicRules.map((rule) => rule.id),
    [42, 1000000, 1000001]
  );

  delete globalThis.chrome;
  delete globalThis.fetch;
});

function installChromeMock({ runtimeListeners, dynamicRules, storageData, dnrConstants = {} }) {
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        }
      },
      getManifest() {
        return { version: "0.1.0" };
      },
      openOptionsPage() {}
    },
    alarms: {
      onAlarm: { addListener() {} },
      async create() {}
    },
    action: {
      async setBadgeBackgroundColor() {},
      async getBadgeText() {
        return "";
      }
    },
    declarativeNetRequest: {
      ...dnrConstants,
      async setExtensionActionOptions() {},
      async getDynamicRules() {
        return dynamicRules;
      },
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        for (const id of removeRuleIds) {
          const index = dynamicRules.findIndex((rule) => rule.id === id);
          if (index !== -1) dynamicRules.splice(index, 1);
        }
        dynamicRules.push(...addRules);
      },
      async getMatchedRules() {
        return { rulesMatchedInfo: [] };
      }
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") {
            return { [keys]: storageData[keys] };
          }
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storageData[key]]));
          }
          return { ...storageData };
        },
        async set(values) {
          Object.assign(storageData, values);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storageData[key];
          }
        }
      },
      onChanged: { addListener() {} }
    },
    tabs: {
      async query() {
        return [];
      }
    },
    scripting: {
      async executeScript() {}
    }
  };
}

function sendRuntimeMessage(listener, message) {
  return new Promise((resolve) => {
    listener(message, {}, resolve);
  });
}
