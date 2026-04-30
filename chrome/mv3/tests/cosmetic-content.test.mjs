import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const testDir = dirname(fileURLToPath(import.meta.url));
const mv3Root = dirname(testDir);

test("content script injects ruleset cosmetic selectors", async () => {
  const script = await readFile(join(mv3Root, "src/content/cosmetic.js"), "utf8");
  const messages = [];
  const document = createDocument({
    ".ad-slot-header__wrapper": 1,
    ".zone__ads": 2
  });
  const storage = {
    siteState: {},
    userCosmeticRules: [],
    cosmeticRemote: {
      ...emptyCosmeticIndex(),
      byHost: {
        "cnn.com": [".ad-slot-header__wrapper", ".zone__ads"]
      }
    }
  };
  const context = {
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          messages.push(message);
          callback?.();
        }
      },
      storage: {
        local: {
          get(keys, callback) {
            callback(Object.fromEntries(keys.map((key) => [key, storage[key]])));
          }
        },
        onChanged: {
          addListener() {}
        }
      }
    },
    clearTimeout() {},
    document,
    location: {
      hostname: "www.cnn.com",
      href: "https://www.cnn.com/"
    },
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    }
  };
  context.globalThis = context;
  context.window = context;

  vm.runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const style = document.getElementById("openadblock-cosmetic-style");
  assert.ok(style);
  assert.match(style.textContent, /\.ad-slot-header__wrapper\{display:none!important;\}/);
  assert.match(style.textContent, /\.zone__ads\{display:none!important;\}/);
  assert.equal(messages.at(-1).type, "PAGE_ACTIVITY");
  assert.equal(messages.at(-1).url, "https://www.cnn.com/");
  assert.equal(messages.at(-1).hostname, "www.cnn.com");
  assert.equal(messages.at(-1).cosmeticBlocked, 3);
});

test("content script injects NYPost generic CSS before page activity counting", async () => {
  const script = await readFile(join(mv3Root, "src/content/cosmetic.js"), "utf8");
  const messages = [];
  const document = createDocument({
    ".ad-slot": 2,
    ".dfp-ad": 2,
    ".widget_nypost_dfp_ad_widget": 1
  });
  const storage = {
    siteState: {},
    userCosmeticRules: [],
    cosmeticRemote: {
      ...emptyCosmeticIndex(),
      global: [".ad-slot", ".dfp-ad", "+js(aopw, _sp_)", "img[src$=\"/knewz_300x250.png\"]:upward(.widget_text)"],
      byHost: {
        "nypost.com": [".ad.ad--container", ".widget_nypost_dfp_ad_widget"]
      }
    }
  };
  const context = {
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          messages.push(message);
          callback?.();
        }
      },
      storage: {
        local: {
          get(keys, callback) {
            callback(Object.fromEntries(keys.map((key) => [key, storage[key]])));
          }
        },
        onChanged: {
          addListener() {}
        }
      }
    },
    clearTimeout() {},
    document,
    location: {
      hostname: "www.nypost.com",
      href: "https://nypost.com/"
    },
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    }
  };
  context.globalThis = context;
  context.window = context;

  vm.runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const style = document.getElementById("openadblock-cosmetic-style");
  assert.ok(style);
  assert.match(style.textContent, /\.ad-slot\{display:none!important;\}/);
  assert.match(style.textContent, /\.dfp-ad\{display:none!important;\}/);
  assert.match(style.textContent, /\.ad\.ad--container\{display:none!important;\}/);
  assert.match(style.textContent, /\.widget_nypost_dfp_ad_widget\{display:none!important;\}/);
  assert.doesNotMatch(style.textContent, /\+js/);
  assert.doesNotMatch(style.textContent, /:upward/);
  assert.equal(messages.at(-1).hostname, "www.nypost.com");
  assert.equal(messages.at(-1).cosmeticBlocked, 5);
});

function emptyCosmeticIndex() {
  return {
    global: [],
    byHost: {},
    exceptions: {
      global: [],
      byHost: {}
    }
  };
}

function createDocument(selectorCounts) {
  const elementsById = new Map();
  const documentElement = {
    children: [],
    appendChild(element) {
      this.children.push(element);
      if (element.id) {
        elementsById.set(element.id, element);
      }
    }
  };

  return {
    documentElement,
    addEventListener() {},
    createElement(tagName) {
      assert.equal(tagName, "style");
      return {
        dataset: {},
        id: "",
        textContent: "",
        remove() {
          elementsById.delete(this.id);
        }
      };
    },
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    querySelector(selector) {
      return selectorCounts[selector] ? {} : null;
    },
    querySelectorAll(selector) {
      return Array.from({ length: selectorCounts[selector] || 0 }, () => ({}));
    }
  };
}
