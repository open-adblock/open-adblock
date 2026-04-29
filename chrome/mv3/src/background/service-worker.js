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
import cosmeticPackagedIndex from "../../filters/generated/cosmetic-index.js";

const DEFAULT_REMOTE_MANIFEST_URL = "https://cdn.jsdelivr.net/gh/open-adblock/open-adblock@main/filters/manifest.json";
const DEFAULT_REPORT_ENDPOINT_URL = "https://reports.openadblock.org/api/reports";
const REMOTE_ALARM_NAME = "openadblock.remote-filter-update";
const USER_SITE_RULE_START = 100000;
const USER_SITE_RULE_MAX = 5000;
const REMOTE_RULE_START = 1000000;
const REMOTE_RULE_MAX = 20000;
const REPORT_TIMEOUT_MS = 10000;

const STORAGE_DEFAULTS = {
  settings: {
    theme: "system",
    remoteUpdates: true,
    remoteManifestUrl: DEFAULT_REMOTE_MANIFEST_URL,
    reportEndpointUrl: DEFAULT_REPORT_ENDPOINT_URL
  },
  siteState: {},
  stats: {
    ...createDefaultStats()
  },
  pageStats: {},
  reports: [],
  cosmeticPackaged: {
    version: null,
    updatedAt: 0,
    global: [],
    byHost: {},
    exceptions: {
      global: [],
      byHost: {}
    },
    unsupported: []
  },
  userCosmeticRules: [],
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
    reportEndpointUrl: DEFAULT_REPORT_ENDPOINT_URL,
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
  await loadPackagedCosmeticIndex();
  await configureActionCountBadge();
  await syncPausedSiteRules();
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

async function loadPackagedCosmeticIndex() {
  try {
    const cosmeticPackaged = cosmeticPackagedIndex;
    if (!isCosmeticIndex(cosmeticPackaged)) {
      throw new Error("Packaged cosmetic filter index is invalid");
    }

    const current = await chrome.storage.local.get("cosmeticPackaged");
    if (
      current.cosmeticPackaged?.version !== cosmeticPackaged.version ||
      current.cosmeticPackaged?.updatedAt !== cosmeticPackaged.updatedAt
    ) {
      await chrome.storage.local.set({ cosmeticPackaged });
    }
  } catch (error) {
    console.warn("OpenAdBlock packaged cosmetic filters unavailable", error);
  }
}

function isCosmeticIndex(value) {
  return Boolean(
    value &&
      Array.isArray(value.global) &&
      value.byHost &&
      Array.isArray(value.exceptions?.global) &&
      value.exceptions?.byHost
  );
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
    case "REMOVE_USER_COSMETIC_RULE":
      return removeUserCosmeticRule(message.id);
    case "REMOVE_REPORT":
      return removeReport(message.id);
    case "RUN_REMOTE_UPDATE":
      return updateRemoteFilters({ force: true });
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
    "userCosmeticRules",
    "reports"
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
    userCosmeticRuleCount: (storage.userCosmeticRules || []).length,
    reportCount: (storage.reports || []).length
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

  const storage = await chrome.storage.local.get(["reports", "settings", "filters", "siteState", "stats", "pageStats"]);
  const reports = storage.reports || [];
  const manifest = chrome.runtime.getManifest();
  const category = normalizeReportCategory(message.category);
  const details = String(message.details || message.reason || "").slice(0, 2000);
  const includeUrl = message.includeUrl !== false;
  const includeScreenshot = message.includeScreenshot !== false;
  const endpointUrl = normalizeReportEndpointUrl(
    storage.settings?.reportEndpointUrl || storage.filters?.reportEndpointUrl
  );
  const screenshot = includeScreenshot ? await captureReportScreenshot(tab?.windowId) : null;
  const report = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url: includeUrl ? url : "",
    hostname,
    category,
    details,
    reason: details || getReportCategoryLabel(category),
    includeUrl,
    includeScreenshot,
    screenshotIncluded: Boolean(screenshot?.dataUrl),
    screenshotUrl: null,
    status: "pending",
    issueNumber: null,
    issueUrl: null,
    error: null,
    createdAt: Date.now()
  };
  const pageStats = tab?.id ? storage.pageStats?.[String(tab.id)] || null : null;
  const payload = {
    id: report.id,
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

  try {
    const result = await submitReport(endpointUrl, payload);
    report.status = "submitted";
    report.issueNumber = result.issue?.number || null;
    report.issueUrl = result.issue?.url || null;
    report.screenshotUrl = result.issue?.screenshotUrl || null;
  } catch (error) {
    report.status = "failed";
    report.error = error.message || String(error);
  }

  await chrome.storage.local.set({ reports: [report, ...reports].slice(0, 100) });
  return report;
}

async function getOptionsState() {
  return chrome.storage.local.get([
    "settings",
    "siteState",
    "stats",
    "pageStats",
    "reports",
    "userCosmeticRules",
    "cosmeticPackaged",
    "cosmeticRemote",
    "filters"
  ]);
}

async function saveSettings(partialSettings) {
  const { settings = STORAGE_DEFAULTS.settings } = await chrome.storage.local.get("settings");
  const nextSettings = {
    ...settings,
    ...pick(partialSettings, ["theme", "remoteUpdates", "remoteManifestUrl", "reportEndpointUrl"])
  };

  if (!["system", "light", "dark"].includes(nextSettings.theme)) {
    nextSettings.theme = "system";
  }

  nextSettings.remoteUpdates = Boolean(nextSettings.remoteUpdates);
  nextSettings.remoteManifestUrl = normalizeRemoteManifestUrl(nextSettings.remoteManifestUrl);
  nextSettings.reportEndpointUrl = normalizeReportEndpointUrl(nextSettings.reportEndpointUrl);

  await chrome.storage.local.set({ settings: nextSettings });
  return { settings: nextSettings };
}

async function removeUserCosmeticRule(id) {
  const { userCosmeticRules = [] } = await chrome.storage.local.get("userCosmeticRules");
  const nextRules = userCosmeticRules.filter((rule) => rule.id !== id);
  await chrome.storage.local.set({ userCosmeticRules: nextRules });
  return { removed: userCosmeticRules.length !== nextRules.length };
}

async function removeReport(id) {
  const { reports = [] } = await chrome.storage.local.get("reports");
  const nextReports = reports.filter((report) => report.id !== id);
  await chrome.storage.local.set({ reports: nextReports });
  return { removed: reports.length !== nextReports.length };
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

async function updateRemoteFilters({ force = false } = {}) {
  const { settings = STORAGE_DEFAULTS.settings } = await chrome.storage.local.get("settings");

  if (!force && !settings.remoteUpdates) {
    return { skipped: true, reason: "Remote updates are disabled" };
  }

  const manifestUrl = normalizeRemoteManifestUrl(settings.remoteManifestUrl);
  const manifest = await fetchJson(manifestUrl);
  validateRemoteManifest(manifest);

  const networkTexts = [];
  const cosmeticSources = [];
  const sourceSummary = [];

  for (const file of manifest.files || []) {
    const fileUrl = new URL(file.url, manifestUrl).toString();
    const text = await fetchText(fileUrl);

    if (file.sha256) {
      const actualHash = await sha256(text);
      if (actualHash !== file.sha256.toLowerCase()) {
        throw new Error(`Checksum mismatch for ${file.url}`);
      }
    }

    sourceSummary.push({
      name: String(file.name || file.type || file.url),
      url: fileUrl,
      license: String(file.license || "unknown"),
      revision: file.revision ? String(file.revision) : undefined
    });

    if (file.type === "network") {
      networkTexts.push({ text, defaultAction: "block" });
    } else if (file.type === "allowlist-network") {
      networkTexts.push({ text, defaultAction: "allow" });
    } else if (file.type === "cosmetic" || file.type === "allowlist-cosmetic") {
      cosmeticSources.push({
        text,
        defaultException: file.type === "allowlist-cosmetic"
      });
    }
  }

  const networkRules = compileNetworkRules(networkTexts, REMOTE_RULE_START, REMOTE_RULE_MAX);
  const cosmeticRemote = compileCosmeticRules(cosmeticSources, manifest.version);
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules
    .map((rule) => rule.id)
    .filter((id) => id >= REMOTE_RULE_START && id < REMOTE_RULE_START + REMOTE_RULE_MAX);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: networkRules.rules
  });

  const filters = {
    buildId: STORAGE_DEFAULTS.filters.buildId,
    builtAt: STORAGE_DEFAULTS.filters.builtAt,
    remoteVersion: String(manifest.version || ""),
    remoteUpdatedAt: Date.now(),
    remoteLastError: null,
    reportEndpointUrl: normalizeReportEndpointUrl(manifest.reportEndpointUrl),
    sourceSummary
  };

  await chrome.storage.local.set({ cosmeticRemote, filters });

  return {
    version: filters.remoteVersion,
    networkRuleCount: networkRules.rules.length,
    cosmeticRuleCount: countCosmeticRules(cosmeticRemote),
    unsupportedCount: networkRules.unsupported.length + cosmeticRemote.unsupported.length
  };
}

async function recordRemoteError(error) {
  const { filters = STORAGE_DEFAULTS.filters } = await chrome.storage.local.get("filters");
  await chrome.storage.local.set({
    filters: {
      ...filters,
      remoteLastError: error.message || String(error)
    }
  });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "omit"
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.json();
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

function validateRemoteManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) {
    throw new Error("Unsupported remote filter manifest schema");
  }

  if (!Array.isArray(manifest.files)) {
    throw new Error("Remote filter manifest must include files");
  }

  if (manifest.reportEndpointUrl !== undefined && typeof manifest.reportEndpointUrl !== "string") {
    throw new Error("Remote filter manifest reportEndpointUrl must be a string");
  }

  for (const file of manifest.files) {
    if (!file || typeof file.url !== "string" || typeof file.type !== "string") {
      throw new Error("Remote filter file entries require url and type");
    }

    if (!["network", "allowlist-network", "cosmetic", "allowlist-cosmetic"].includes(file.type)) {
      throw new Error(`Unsupported remote filter file type: ${file.type}`);
    }
  }
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRemoteManifestUrl(url) {
  try {
    const parsed = new URL(url || DEFAULT_REMOTE_MANIFEST_URL);
    if (parsed.protocol !== "https:") {
      return DEFAULT_REMOTE_MANIFEST_URL;
    }
    return parsed.toString();
  } catch {
    return DEFAULT_REMOTE_MANIFEST_URL;
  }
}

function normalizeReportEndpointUrl(url) {
  try {
    const parsed = new URL(url || DEFAULT_REPORT_ENDPOINT_URL);
    const isLocalHttp =
      parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !isLocalHttp) {
      return DEFAULT_REPORT_ENDPOINT_URL;
    }
    return parsed.toString();
  } catch {
    return DEFAULT_REPORT_ENDPOINT_URL;
  }
}

function normalizeReportCategory(value) {
  if (value === "missed_ad" || value === "false_positive" || value === "other") return value;
  return "breakage";
}

function getReportCategoryLabel(value) {
  switch (normalizeReportCategory(value)) {
    case "missed_ad":
      return "Missed ad";
    case "false_positive":
      return "Site incorrectly blocked";
    case "other":
      return "Other";
    default:
      return "Page broken";
  }
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
