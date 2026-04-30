import {
  compileCosmeticRules,
  compileNetworkRules,
  countCosmeticRules
} from "./filter-engine.js";
import {
  applyPageActivitySnapshot,
  createDefaultStats,
  getPageBlockedCount,
  parseBadgeCount
} from "./stats.js";
import rulesetCatalog from "../../filters/generated/ruleset.js";

const DEFAULT_REPORT_ENDPOINT_URL = "https://report.open-adblock.com/api/reports";
const REMOTE_ALARM_NAME = "openadblock.remote-filter-update";
const USER_SITE_RULE_START = 100000;
const USER_SITE_RULE_MAX = 5000;
const REMOTE_RULE_START = 1000000;
const REMOTE_RULE_ID_RANGE = 25000;
const REMOTE_RULE_MAX = 25000;
const REMOTE_RULE_BATCH_SIZE = 500;
const DEFAULT_DYNAMIC_RULE_LIMIT = 5000;
const FILTER_RULESET_CATALOG_VERSION = "ruleset-2026-04-30";
const REPORT_TIMEOUT_MS = 10000;
const LEGACY_STORAGE_KEYS = ["reports"];

const STORAGE_DEFAULTS = {
  settings: {
    theme: "system"
  },
  siteState: {},
  stats: {
    ...createDefaultStats()
  },
  pageStats: {},
  userCosmeticRules: [],
  filterRulesets: createDefaultFilterRulesetState(),
  cosmeticRemote: {
    version: null,
    updatedAt: 0,
    global: [],
    byHost: {},
    exceptions: {
      global: [],
      byHost: {}
    }
  },
  filters: {
    buildId: "packaged-0.1.0",
    builtAt: "2026-04-28T00:00:00.000Z",
    remoteVersion: null,
    remoteUpdatedAt: null,
    remoteLastError: null,
    sourceSummary: []
  }
};

let initializationPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  queueInitialization();
});

chrome.runtime.onStartup.addListener(() => {
  queueInitialization();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REMOTE_ALARM_NAME) {
    ensureInitialized()
      .then(() => updateRemoteFilters())
      .catch((error) => recordRemoteError(error));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

queueInitialization();

function queueInitialization() {
  ensureInitialized().catch((error) => console.error("OpenAdBlock initialization failed", error));
}

function ensureInitialized() {
  if (!initializationPromise) {
    initializationPromise = initializeExtension().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }
  return initializationPromise;
}

async function initializeExtension() {
  await ensureStorageDefaults();
  await removeLegacySettingsConfig();
  await ensureFilterRulesetState();
  await removeLegacyStorageKeys();
  await configureActionCountBadge();
  await syncPausedSiteRules();
  await updateRulesetFiltersIfNeeded();
  await chrome.alarms.create(REMOTE_ALARM_NAME, {
    delayInMinutes: 5,
    periodInMinutes: 24 * 60
  });
}

async function ensureStorageDefaults() {
  const current = await chrome.storage.local.get(Object.keys(STORAGE_DEFAULTS));
  const next = {};

  for (const [key, value] of Object.entries(STORAGE_DEFAULTS)) {
    if (current[key] === undefined) {
      next[key] = value;
    }
  }

  if (Object.keys(next).length > 0) {
    await chrome.storage.local.set(next);
  }
}

async function removeLegacySettingsConfig() {
  const { settings, filters } = await chrome.storage.local.get(["settings", "filters"]);
  const updates = {};

  if (settings) {
    const nextSettings = { ...settings };
    delete nextSettings.remoteUpdates;
    delete nextSettings.remoteManifestUrl;
    delete nextSettings.reportEndpointUrl;
    if (Object.keys(nextSettings).length !== Object.keys(settings).length) {
      updates.settings = nextSettings;
    }
  }

  if (filters && Object.prototype.hasOwnProperty.call(filters, "reportEndpointUrl")) {
    const { reportEndpointUrl: _reportEndpointUrl, ...nextFilters } = filters;
    updates.filters = nextFilters;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

async function ensureFilterRulesetState() {
  const { filterRulesets } = await chrome.storage.local.get("filterRulesets");
  const defaults = createDefaultFilterRulesetState();
  const catalogChanged = filterRulesets?.catalogVersion !== FILTER_RULESET_CATALOG_VERSION;
  const catalogIds = new Set(getFilterRulesetCatalog().map((ruleset) => ruleset.id));
  const currentEnabledIds = Array.isArray(filterRulesets?.enabledIds)
    ? filterRulesets.enabledIds.filter((id) => catalogIds.has(id))
    : defaults.enabledIds;

  const nextState = {
    ...defaults,
    ...filterRulesets,
    catalogVersion: FILTER_RULESET_CATALOG_VERSION,
    enabledIds: [...new Set(currentEnabledIds)],
    lastAppliedEnabledIds: catalogChanged ? [] : filterRulesets?.lastAppliedEnabledIds || [],
    lastAppliedAt: catalogChanged ? null : filterRulesets?.lastAppliedAt || null,
    networkRuleCount: catalogChanged ? 0 : Number(filterRulesets?.networkRuleCount || 0),
    cosmeticRuleCount: catalogChanged ? 0 : Number(filterRulesets?.cosmeticRuleCount || 0),
    unsupportedCount: catalogChanged ? 0 : Number(filterRulesets?.unsupportedCount || 0),
    truncated: catalogChanged ? false : Boolean(filterRulesets?.truncated),
    rulesetSummary: catalogChanged ? [] : filterRulesets?.rulesetSummary || []
  };
  const currentEnabledKey = Array.isArray(filterRulesets?.enabledIds)
    ? filterRulesets.enabledIds.join("|")
    : "";

  if (
    !filterRulesets ||
    catalogChanged ||
    currentEnabledKey !== nextState.enabledIds.join("|")
  ) {
    await chrome.storage.local.set({ filterRulesets: nextState });
  }

  return nextState;
}

function createDefaultFilterRulesetState() {
  return {
    catalogVersion: FILTER_RULESET_CATALOG_VERSION,
    enabledIds: getDefaultEnabledRulesetIds(),
    lastAppliedEnabledIds: [],
    lastAppliedAt: null,
    lastError: null,
    networkRuleCount: 0,
    cosmeticRuleCount: 0,
    unsupportedCount: 0,
    truncated: false,
    rulesetSummary: []
  };
}

function getDefaultEnabledRulesetIds() {
  const languageCodes = getNavigatorLanguageCodes();
  return getFilterRulesetCatalog()
    .filter((ruleset) => ruleset.defaultEnabled || rulesetMatchesLanguages(ruleset, languageCodes))
    .map((ruleset) => ruleset.id);
}

function getFilterRulesetCatalog() {
  return rulesetCatalog
    .map(normalizeFilterRulesetEntry)
    .filter(Boolean);
}

function normalizeFilterRulesetEntry(entry) {
  if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string") return null;

  const excludedPlatforms = Array.isArray(entry.excludedPlatforms)
    ? entry.excludedPlatforms.map((platform) => String(platform).toLowerCase())
    : [];
  if (excludedPlatforms.includes("chromium") || excludedPlatforms.includes("chrome")) return null;

  const urls = Array.isArray(entry.urls)
    ? entry.urls
        .map((url) => resolveRulesetUrl(String(url), entry))
        .filter((url) => isHttpsUrl(url))
    : [];
  if (urls.length === 0) return null;

  return {
    id: entry.id,
    name: entry.name,
    group: String(entry.group || "misc"),
    lang: entry.lang ? String(entry.lang) : "",
    tags: entry.tags ? String(entry.tags) : "",
    homeURL: isHttpsUrl(entry.homeURL) ? String(entry.homeURL) : "",
    urls,
    trusted: Boolean(entry.trusted),
    defaultEnabled: Boolean(entry.enabled)
  };
}

function resolveRulesetUrl(url, entry) {
  return url.replaceAll("{commit}", String(entry.commit || "master"));
}

function isHttpsUrl(url) {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function getNavigatorLanguageCodes() {
  const browserNavigator = globalThis.navigator;
  const languages = Array.isArray(browserNavigator?.languages) && browserNavigator.languages.length
    ? browserNavigator.languages
    : [browserNavigator?.language].filter(Boolean);
  const codes = new Set();

  for (const language of languages) {
    const code = String(language || "")
      .trim()
      .toLowerCase()
      .split("-")[0]
      .replace(/[^a-z]/g, "");
    if (code) codes.add(code);
  }

  return codes;
}

function rulesetMatchesLanguages(ruleset, languageCodes) {
  if (!ruleset.lang || languageCodes.size === 0) return false;
  return ruleset.lang
    .split(/\s+/)
    .map((lang) => lang.trim().toLowerCase())
    .some((lang) => languageCodes.has(lang));
}

async function removeLegacyStorageKeys() {
  await chrome.storage.local.remove(LEGACY_STORAGE_KEYS);
}

async function configureActionCountBadge() {
  try {
    await chrome.declarativeNetRequest.setExtensionActionOptions({
      displayActionCountAsBadgeText: true
    });
    await chrome.action.setBadgeBackgroundColor({ color: "#84cc16" });
  } catch (error) {
    console.warn("OpenAdBlock badge count unavailable", error);
  }
}

async function updateRulesetFiltersIfNeeded() {
  const { filterRulesets } = await chrome.storage.local.get("filterRulesets");

  if (filterRulesets?.lastAppliedAt && await hasExpectedRemoteRules(filterRulesets)) return;

  try {
    await updateRemoteFilters();
  } catch (error) {
    await recordRemoteError(error);
  }
}

async function hasExpectedRemoteRules(filterRulesets) {
  const enabledIds = Array.isArray(filterRulesets.enabledIds) ? filterRulesets.enabledIds : [];
  const appliedEnabledIds = Array.isArray(filterRulesets.lastAppliedEnabledIds)
    ? filterRulesets.lastAppliedEnabledIds
    : [];
  if (enabledIds.join("|") !== appliedEnabledIds.join("|")) return false;

  const expectedCount = Number(filterRulesets.networkRuleCount || 0);
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const remoteRuleCount = currentRules.filter((rule) => isRemoteRuleId(rule.id)).length;
  return remoteRuleCount === expectedCount;
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") {
    throw new Error("Invalid message");
  }

  await ensureInitialized();

  switch (message.type) {
    case "GET_POPUP_STATE":
      return getPopupState();
    case "SET_SITE_PAUSED":
      return setSitePaused(message.hostname, Boolean(message.paused));
    case "START_ELEMENT_PICKER":
      return startElementPicker();
    case "ADD_USER_COSMETIC_RULE":
      return addUserCosmeticRule(message, sender);
    case "PAGE_ACTIVITY":
      return recordPageActivity(message, sender);
    case "REPORT_BREAKAGE":
      return reportBreakage(message);
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return {};
    case "GET_OPTIONS_STATE":
      return getOptionsState();
    case "SAVE_SETTINGS":
      return saveSettings(message.settings || {});
    case "SET_FILTER_RULESET_ENABLED":
      return setFilterRulesetEnabled(message.id, Boolean(message.enabled));
    case "REMOVE_USER_COSMETIC_RULE":
      return removeUserCosmeticRule(message.id);
    case "RUN_REMOTE_UPDATE":
      return updateRemoteFilters();
    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

async function getPopupState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url || "";
  const hostname = getHostname(tabUrl);
  const storage = await chrome.storage.local.get([
    "settings",
    "siteState",
    "stats",
    "pageStats",
    "filters",
    "userCosmeticRules"
  ]);
  const paused = Boolean(hostname && storage.siteState?.[hostname]?.paused);
  const networkBlocked = tab?.id ? await getTabNetworkBlockedCount(tab.id) : 0;
  const statsState =
    tab?.id && isSupportedPage(tabUrl)
      ? await recordPageActivitySnapshot({
          tabId: tab.id,
          url: tabUrl,
          hostname,
          networkBlocked
        })
      : {
          stats: storage.stats || STORAGE_DEFAULTS.stats,
          pageStats: storage.pageStats || STORAGE_DEFAULTS.pageStats
        };
  const pageBlocked = tab?.id ? getPageBlockedCount(statsState.pageStats, tab.id) : 0;
  const manifest = chrome.runtime.getManifest();

  return {
    version: manifest.version,
    tabId: tab?.id || null,
    url: tabUrl,
    hostname,
    supportedPage: isSupportedPage(tabUrl),
    paused,
    pageBlocked,
    pageStats: tab?.id ? statsState.pageStats?.[String(tab.id)] || null : null,
    settings: storage.settings || STORAGE_DEFAULTS.settings,
    stats: statsState.stats || storage.stats || STORAGE_DEFAULTS.stats,
    filters: storage.filters || STORAGE_DEFAULTS.filters,
    userCosmeticRuleCount: (storage.userCosmeticRules || []).length
  };
}

async function getBadgeText(tabId) {
  try {
    return await chrome.action.getBadgeText({ tabId });
  } catch {
    return "";
  }
}

async function getTabNetworkBlockedCount(tabId) {
  const badgeCount = parseBadgeCount(await getBadgeText(tabId));
  if (badgeCount > 0) return badgeCount;

  return getMatchedRuleCount(tabId);
}

async function getMatchedRuleCount(tabId) {
  try {
    const details = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
    return Array.isArray(details?.rulesMatchedInfo) ? details.rulesMatchedInfo.length : 0;
  } catch {
    return 0;
  }
}

async function recordPageActivity(message, sender) {
  return recordPageActivitySnapshot({
    tabId: sender.tab?.id,
    url: message.url || sender.tab?.url || "",
    hostname: message.hostname || getHostname(message.url || sender.tab?.url || ""),
    cosmeticBlocked: message.cosmeticBlocked
  });
}

async function recordPageActivitySnapshot(snapshot) {
  const current = await chrome.storage.local.get(["stats", "pageStats"]);
  const next = applyPageActivitySnapshot(
    {
      stats: current.stats || STORAGE_DEFAULTS.stats,
      pageStats: current.pageStats || STORAGE_DEFAULTS.pageStats
    },
    snapshot
  );
  await chrome.storage.local.set({
    stats: next.stats,
    pageStats: next.pageStats
  });
  return next;
}

async function setSitePaused(hostname, paused) {
  const cleanHostname = normalizeHostname(hostname);
  if (!cleanHostname) {
    throw new Error("A valid hostname is required");
  }

  const { siteState = {} } = await chrome.storage.local.get("siteState");
  const nextSiteState = { ...siteState };

  if (paused) {
    nextSiteState[cleanHostname] = {
      paused: true,
      updatedAt: Date.now()
    };
  } else {
    delete nextSiteState[cleanHostname];
  }

  await chrome.storage.local.set({ siteState: nextSiteState });
  await syncPausedSiteRules();
  return { hostname: cleanHostname, paused };
}

async function syncPausedSiteRules() {
  const { siteState = {} } = await chrome.storage.local.get("siteState");
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules
    .map((rule) => rule.id)
    .filter((id) => id >= USER_SITE_RULE_START && id < USER_SITE_RULE_START + USER_SITE_RULE_MAX);

  const pausedHosts = Object.entries(siteState)
    .filter(([, state]) => state?.paused)
    .map(([hostname]) => normalizeHostname(hostname))
    .filter(Boolean)
    .slice(0, USER_SITE_RULE_MAX);

  const addRules = pausedHosts.map((hostname, index) => ({
    id: USER_SITE_RULE_START + index,
    priority: 10000,
    action: { type: "allowAllRequests" },
    condition: {
      urlFilter: `||${hostname}^`,
      resourceTypes: ["main_frame", "sub_frame"]
    }
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules
  });
}

async function startElementPicker() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isSupportedPage(tab.url)) {
    throw new Error("Element picker can only run on web pages");
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content/picker.js"]
  });

  return { tabId: tab.id };
}

async function addUserCosmeticRule(message, sender) {
  const selector = sanitizeSelector(message.selector);
  const hostname = normalizeHostname(message.hostname || getHostname(sender.tab?.url || ""));

  if (!hostname || !selector) {
    throw new Error("A hostname and CSS selector are required");
  }

  const { userCosmeticRules = [] } = await chrome.storage.local.get("userCosmeticRules");
  const id = stableRuleId(`${hostname}:${selector}`);
  const exists = userCosmeticRules.some((rule) => rule.id === id);
  const nextRules = exists
    ? userCosmeticRules
    : [
        ...userCosmeticRules,
        {
          id,
          hostname,
          selector,
          source: "block-element",
          createdAt: Date.now()
        }
      ];

  await chrome.storage.local.set({ userCosmeticRules: nextRules });
  return { id, hostname, selector, created: !exists };
}

async function reportBreakage(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = message.url || tab?.url || "";
  const hostname = normalizeHostname(message.hostname || getHostname(url));

  if (!hostname) {
    throw new Error("A valid page is required");
  }

  const storage = await chrome.storage.local.get(["filters", "siteState", "pageStats"]);
  const manifest = chrome.runtime.getManifest();
  const category = normalizeReportCategory(message.category);
  const details = String(message.details || message.reason || "").slice(0, 2000);
  const includeUrl = message.includeUrl !== false;
  const includeScreenshot = message.includeScreenshot !== false;
  const endpointUrl = DEFAULT_REPORT_ENDPOINT_URL;
  const screenshot = includeScreenshot ? await captureReportScreenshot(tab?.windowId) : null;
  const reportId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pageStats = tab?.id ? storage.pageStats?.[String(tab.id)] || null : null;
  const payload = {
    id: reportId,
    category,
    details,
    page: {
      url,
      hostname
    },
    privacy: {
      includeUrl
    },
    extension: {
      version: manifest.version
    },
    userAgent: navigator.userAgent,
    screenshot: screenshot?.dataUrl ? { dataUrl: screenshot.dataUrl } : undefined,
    diagnostics: {
      paused: Boolean(storage.siteState?.[hostname]?.paused),
      pageBlocked: tab?.id ? getPageBlockedCount(storage.pageStats || {}, tab.id) : 0,
      pageStats,
      screenshot: {
        requested: includeScreenshot,
        captured: Boolean(screenshot?.dataUrl),
        error: screenshot?.error || null
      },
      filters: {
        buildId: storage.filters?.buildId,
        remoteVersion: storage.filters?.remoteVersion,
        remoteUpdatedAt: storage.filters?.remoteUpdatedAt
      }
    }
  };
  const result = await submitReport(endpointUrl, payload);

  return {
    id: reportId,
    status: "submitted",
    issueNumber: result.issue?.number || null,
    issueUrl: result.issue?.url || null,
    screenshotUrl: result.issue?.screenshotUrl || null
  };
}

async function getOptionsState() {
  const state = await chrome.storage.local.get([
    "settings",
    "siteState",
    "stats",
    "pageStats",
    "userCosmeticRules",
    "filterRulesets",
    "cosmeticRemote",
    "filters"
  ]);

  return {
    ...state,
    filterRulesetCatalog: getFilterRulesetCatalog()
  };
}

async function saveSettings(partialSettings) {
  const { settings = STORAGE_DEFAULTS.settings } = await chrome.storage.local.get("settings");
  const nextSettings = {
    ...settings,
    ...pick(partialSettings, ["theme"])
  };
  delete nextSettings.remoteUpdates;
  delete nextSettings.remoteManifestUrl;
  delete nextSettings.reportEndpointUrl;

  if (!["system", "light", "dark"].includes(nextSettings.theme)) {
    nextSettings.theme = "system";
  }

  await chrome.storage.local.set({ settings: nextSettings });
  return { settings: nextSettings };
}

async function setFilterRulesetEnabled(id, enabled) {
  const catalog = getFilterRulesetCatalog();
  const ruleset = catalog.find((entry) => entry.id === id);
  if (!ruleset) {
    throw new Error("Unknown filter ruleset");
  }

  const currentState = await ensureFilterRulesetState();
  const enabledIds = new Set(currentState.enabledIds || []);

  if (enabled) {
    enabledIds.add(ruleset.id);
  } else {
    enabledIds.delete(ruleset.id);
  }

  const nextState = {
    ...currentState,
    enabledIds: catalog
      .map((entry) => entry.id)
      .filter((catalogId) => enabledIds.has(catalogId)),
    lastError: null
  };

  await chrome.storage.local.set({ filterRulesets: nextState });
  return updateRemoteFilters();
}

async function removeUserCosmeticRule(id) {
  const { userCosmeticRules = [] } = await chrome.storage.local.get("userCosmeticRules");
  const nextRules = userCosmeticRules.filter((rule) => rule.id !== id);
  await chrome.storage.local.set({ userCosmeticRules: nextRules });
  return { removed: userCosmeticRules.length !== nextRules.length };
}

async function submitReport(endpointUrl, payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok || body?.ok === false) {
      throw new Error(body?.error || `Report failed with ${response.status}`);
    }

    return body;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Report timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function captureReportScreenshot(windowId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 60
    });
    if (!dataUrl) {
      return { dataUrl: "", error: "Screenshot capture returned no data" };
    }
    return { dataUrl, error: null };
  } catch (error) {
    return {
      dataUrl: "",
      error: error.message || String(error)
    };
  }
}

async function updateRemoteFilters() {
  const { filterRulesets = createDefaultFilterRulesetState() } = await chrome.storage.local.get("filterRulesets");

  const catalog = getFilterRulesetCatalog();
  const enabledIds = new Set(
    Array.isArray(filterRulesets.enabledIds) ? filterRulesets.enabledIds : getDefaultEnabledRulesetIds()
  );
  const selectedRulesets = catalog.filter((ruleset) => enabledIds.has(ruleset.id));

  const networkTexts = [];
  const cosmeticSources = [];
  const sourceSummary = [];
  const rulesetSummary = [];
  const fetchErrors = [];

  for (const ruleset of selectedRulesets) {
    const fetchedTexts = [];

    for (const url of ruleset.urls) {
      try {
        const text = await fetchText(url);
        fetchedTexts.push({ text, url });

        networkTexts.push({ text, defaultAction: "block" });
        cosmeticSources.push({ text, defaultException: false });
      } catch (error) {
        fetchErrors.push(`${ruleset.id}: ${error.message || String(error)}`);
      }
    }

    sourceSummary.push({
      id: ruleset.id,
      name: ruleset.name,
      group: ruleset.group,
      url: ruleset.homeURL || ruleset.urls[0],
      license: "upstream",
      sourceCount: fetchedTexts.length,
      failedSourceCount: ruleset.urls.length - fetchedTexts.length
    });

    rulesetSummary.push({
      id: ruleset.id,
      name: ruleset.name,
      group: ruleset.group,
      sourceCount: fetchedTexts.length,
      failedSourceCount: ruleset.urls.length - fetchedTexts.length,
      bytes: fetchedTexts.reduce((sum, source) => sum + source.text.length, 0)
    });
  }

  if (selectedRulesets.length > 0 && networkTexts.length === 0) {
    throw new Error(fetchErrors[0] || "No enabled filter source could be fetched");
  }

  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules
    .map((rule) => rule.id)
    .filter(isRemoteRuleId);
  const nonRemoteRuleCount = currentRules.length - removeRuleIds.length;
  const remoteRuleLimit = getAvailableRemoteRuleLimit(nonRemoteRuleCount);

  const networkRules = compileNetworkRules(networkTexts, REMOTE_RULE_START, remoteRuleLimit);
  const cosmeticRemote = compileCosmeticRules(cosmeticSources, FILTER_RULESET_CATALOG_VERSION);

  const ruleApplyResult = await replaceRemoteDynamicRules(removeRuleIds, networkRules.rules);
  const appliedNetworkRules = ruleApplyResult.appliedRules;
  const ruleApplyErrors = ruleApplyResult.skippedRules.map((entry) => entry.error);
  const remoteErrors = [...fetchErrors, ...ruleApplyErrors];

  const nextFilterRulesets = {
    ...createDefaultFilterRulesetState(),
    ...filterRulesets,
    catalogVersion: FILTER_RULESET_CATALOG_VERSION,
    enabledIds: selectedRulesets.map((ruleset) => ruleset.id),
    lastAppliedEnabledIds: selectedRulesets.map((ruleset) => ruleset.id),
    lastAppliedAt: Date.now(),
    lastError: formatFetchErrors(remoteErrors),
    networkRuleCount: appliedNetworkRules.length,
    cosmeticRuleCount: countCosmeticRules(cosmeticRemote),
    unsupportedCount:
      networkRules.unsupported.length + cosmeticRemote.unsupported.length + ruleApplyResult.skippedRules.length,
    truncated: networkRules.rules.length >= remoteRuleLimit || appliedNetworkRules.length < networkRules.rules.length,
    rulesetSummary
  };

  const nextFilters = {
    buildId: STORAGE_DEFAULTS.filters.buildId,
    builtAt: STORAGE_DEFAULTS.filters.builtAt,
    remoteVersion: FILTER_RULESET_CATALOG_VERSION,
    remoteUpdatedAt: Date.now(),
    remoteLastError: formatFetchErrors(remoteErrors),
    sourceSummary
  };

  await chrome.storage.local.set({
    cosmeticRemote,
    filters: nextFilters,
    filterRulesets: nextFilterRulesets
  });

  return {
    version: nextFilters.remoteVersion,
    networkRuleCount: appliedNetworkRules.length,
    cosmeticRuleCount: countCosmeticRules(cosmeticRemote),
    unsupportedCount: nextFilterRulesets.unsupportedCount,
    enabledRulesetCount: selectedRulesets.length,
    truncated: nextFilterRulesets.truncated
  };
}

async function replaceRemoteDynamicRules(removeRuleIds, candidateRules) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: []
  });

  const appliedRules = [];
  const skippedRules = [];

  for (let index = 0; index < candidateRules.length; index += REMOTE_RULE_BATCH_SIZE) {
    const batch = candidateRules.slice(index, index + REMOTE_RULE_BATCH_SIZE);
    const result = await addDynamicRuleBatch(batch);
    appliedRules.push(...result.appliedRules);
    skippedRules.push(...result.skippedRules);
    if (result.limitReached) break;
  }

  return { appliedRules, skippedRules };
}

async function addDynamicRuleBatch(rules) {
  if (rules.length === 0) {
    return { appliedRules: [], skippedRules: [], limitReached: false };
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
    return { appliedRules: rules, skippedRules: [], limitReached: false };
  } catch (error) {
    if (isRuleLimitError(error)) {
      return {
        appliedRules: [],
        skippedRules: [{ rule: null, error: error.message || String(error) }],
        limitReached: true
      };
    }

    if (rules.length === 1) {
      return {
        appliedRules: [],
        skippedRules: [{ rule: rules[0], error: error.message || String(error) }],
        limitReached: false
      };
    }

    const middle = Math.floor(rules.length / 2);
    const first = await addDynamicRuleBatch(rules.slice(0, middle));
    if (first.limitReached) return first;

    const second = await addDynamicRuleBatch(rules.slice(middle));
    return {
      appliedRules: [...first.appliedRules, ...second.appliedRules],
      skippedRules: [...first.skippedRules, ...second.skippedRules],
      limitReached: second.limitReached
    };
  }
}

function isRuleLimitError(error) {
  const message = (error?.message || String(error)).toLowerCase();
  return message.includes("rule limit") || message.includes("maximum number") || message.includes("quota");
}

function isRemoteRuleId(id) {
  return id >= REMOTE_RULE_START && id < REMOTE_RULE_START + REMOTE_RULE_ID_RANGE;
}

function getAvailableRemoteRuleLimit(nonRemoteRuleCount) {
  const dynamicRuleLimit = getDynamicRuleLimit();
  return Math.max(0, Math.min(REMOTE_RULE_MAX, dynamicRuleLimit - nonRemoteRuleCount));
}

function getDynamicRuleLimit() {
  const dnr = chrome.declarativeNetRequest || {};
  const candidates = [
    dnr.MAX_NUMBER_OF_DYNAMIC_RULES,
    dnr.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES
  ]
    .map((candidate) => Number(candidate))
    .filter((value) => Number.isFinite(value) && value > 0);

  return candidates.length > 0 ? Math.max(...candidates) : DEFAULT_DYNAMIC_RULE_LIMIT;
}

async function recordRemoteError(error) {
  const {
    filters = STORAGE_DEFAULTS.filters,
    filterRulesets = createDefaultFilterRulesetState()
  } = await chrome.storage.local.get(["filters", "filterRulesets"]);
  const message = error.message || String(error);
  await chrome.storage.local.set({
    filters: {
      ...filters,
      remoteLastError: message
    },
    filterRulesets: {
      ...filterRulesets,
      lastError: message
    }
  });
}

function formatFetchErrors(errors) {
  if (!errors.length) return null;
  const visibleErrors = errors.slice(0, 3).join("; ");
  const remainingCount = errors.length - 3;
  return remainingCount > 0 ? `${visibleErrors}; ${remainingCount} more source errors` : visibleErrors;
}

async function fetchText(url) {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "omit"
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

function normalizeReportCategory(value) {
  if (value === "missed_ad" || value === "false_positive" || value === "other") return value;
  return "breakage";
}

function normalizeHostname(value) {
  if (!value || typeof value !== "string") return "";
  const raw = value.trim().toLowerCase();
  if (!raw) return "";

  try {
    const hostname = raw.includes("://") ? new URL(raw).hostname : raw;
    return hostname
      .replace(/^\*\./, "")
      .replace(/^\.+|\.+$/g, "")
      .replace(/[^a-z0-9.-]/g, "");
  } catch {
    return "";
  }
}

function getHostname(url) {
  try {
    const parsed = new URL(url);
    return normalizeHostname(parsed.hostname);
  } catch {
    return "";
  }
}

function isSupportedPage(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
  }
}

function sanitizeSelector(selector) {
  if (!selector || typeof selector !== "string") return "";
  const trimmed = selector.trim();
  if (!trimmed || trimmed.length > 1000) return "";
  return trimmed.replace(/[\u0000-\u001f\u007f]/g, "");
}

function stableRuleId(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `rule-${(hash >>> 0).toString(36)}`;
}

function pick(value, keys) {
  const output = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      output[key] = value[key];
    }
  }
  return output;
}
