(() => {
  if (window.__openAdblockCosmeticLoaded) return;
  window.__openAdblockCosmeticLoaded = true;

  const STYLE_ID = "openadblock-cosmetic-style";
  const STORAGE_KEYS = ["siteState", "userCosmeticRules", "cosmeticRemote"];
  let applyTimer = null;
  let lastReportedActivityKey = "";

  scheduleApply();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (STORAGE_KEYS.some((key) => changes[key])) {
      scheduleApply();
    }
  });

  function scheduleApply() {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyTimer = null;
      applyCosmeticRules().catch(() => removeStyle());
    }, 10);
  }

  async function applyCosmeticRules() {
    const hostname = normalizeHostname(location.hostname);
    if (!hostname) {
      removeStyle();
      return;
    }

    const storage = await storageGet(STORAGE_KEYS);
    if (storage.siteState?.[hostname]?.paused) {
      reportPageActivity(hostname, 0);
      removeStyle();
      return;
    }

    const selectors = [];
    const exceptions = new Set();
    const remote = storage.cosmeticRemote || {};

    collectRemoteSelectors(remote, hostname, selectors, exceptions);
    collectUserSelectors(storage.userCosmeticRules || [], hostname, selectors);

    const validSelectors = [...new Set(selectors)]
      .filter((selector) => selector && !exceptions.has(selector))
      .filter(isSelectorUsable);

    if (validSelectors.length === 0) {
      reportPageActivity(hostname, 0);
      removeStyle();
      return;
    }

    const css = validSelectors
      .map((selector) => `${selector}{display:none!important;}`)
      .join("\n");

    upsertStyle(css);
    setTimeout(() => {
      reportPageActivity(hostname, countMatchingElements(validSelectors));
    }, 50);
  }

  function collectRemoteSelectors(remote, hostname, selectors, exceptions) {
    for (const selector of remote.global || []) {
      selectors.push(selector);
    }

    for (const [domain, domainSelectors] of Object.entries(remote.byHost || {})) {
      if (hostMatches(hostname, domain)) {
        selectors.push(...domainSelectors);
      }
    }

    for (const selector of remote.exceptions?.global || []) {
      exceptions.add(selector);
    }

    for (const [domain, domainSelectors] of Object.entries(remote.exceptions?.byHost || {})) {
      if (hostMatches(hostname, domain)) {
        for (const selector of domainSelectors) {
          exceptions.add(selector);
        }
      }
    }
  }

  function collectUserSelectors(rules, hostname, selectors) {
    for (const rule of rules) {
      if (hostMatches(hostname, rule.hostname)) {
        selectors.push(rule.selector);
      }
    }
  }

  function upsertStyle(css) {
    const root = document.documentElement;
    if (!root) {
      document.addEventListener("DOMContentLoaded", () => upsertStyle(css), { once: true });
      return;
    }

    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.dataset.openadblock = "cosmetic";
      root.appendChild(style);
    }
    style.textContent = css;
  }

  function removeStyle() {
    document.getElementById(STYLE_ID)?.remove();
  }

  function isSelectorUsable(selector) {
    const lowered = selector.toLowerCase();
    return (
      !selector.includes("[data-openadblock-picker-ui]") &&
      !selector.includes("{") &&
      !selector.includes("}") &&
      !lowered.includes("+js(") &&
      !lowered.includes(":upward(") &&
      !lowered.includes(":-abp-")
    );
  }

  function countMatchingElements(selectors) {
    let count = 0;
    for (const selector of selectors) {
      try {
        count += document.querySelectorAll(selector).length;
      } catch {
        // Ignore selectors that become invalid in this document.
      }
    }
    return Math.min(count, 10000);
  }

  function reportPageActivity(hostname, cosmeticBlocked) {
    const activityKey = `${location.href}:${cosmeticBlocked}`;
    if (activityKey === lastReportedActivityKey) return;
    lastReportedActivityKey = activityKey;

    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) return;

    runtime.sendMessage(
      {
        type: "PAGE_ACTIVITY",
        url: location.href,
        hostname,
        cosmeticBlocked
      },
      () => {
        // The service worker can be unavailable during extension reloads.
        void runtime.lastError;
      }
    );
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  }

  function normalizeHostname(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, "")
      .replace(/[^a-z0-9.-]/g, "");
  }

  function hostMatches(hostname, domain) {
    const normalizedDomain = normalizeHostname(domain);
    return Boolean(
      normalizedDomain &&
        (hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`))
    );
  }
})();
