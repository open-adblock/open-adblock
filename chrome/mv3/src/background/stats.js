export const BYTES_SAVED_PER_BLOCKED_ITEM = 64 * 1024;
const MAX_TAB_STATS = 200;

export function createDefaultStats(now = Date.now()) {
  return {
    lifetimeBlocked: 0,
    pagesSeen: 0,
    bandwidthSavedBytesEstimate: 0,
    startedAt: now
  };
}

export function applyPageActivitySnapshot(state, snapshot, now = Date.now()) {
  const stats = normalizeStats(state.stats, now);
  const pageStats = { ...(state.pageStats || {}) };
  const tabKey = getTabKey(snapshot);
  const url = String(snapshot.url || "");
  const hostname = String(snapshot.hostname || "");
  const previous = pageStats[tabKey];
  const sameDocument = previous?.url === url;
  const base = sameDocument
    ? previous
    : {
        url,
        hostname,
        networkBlocked: 0,
        cosmeticBlocked: 0,
        updatedAt: now
      };

  const networkBlocked = Math.max(
    Number(base.networkBlocked || 0),
    sanitizeCount(snapshot.networkBlocked, Number(base.networkBlocked || 0))
  );
  const cosmeticBlocked = Math.max(
    Number(base.cosmeticBlocked || 0),
    sanitizeCount(snapshot.cosmeticBlocked, Number(base.cosmeticBlocked || 0))
  );
  const blockedDelta =
    networkBlocked -
    Number(base.networkBlocked || 0) +
    cosmeticBlocked -
    Number(base.cosmeticBlocked || 0);

  const nextStats = {
    ...stats,
    pagesSeen: stats.pagesSeen + (sameDocument ? 0 : 1),
    lifetimeBlocked: stats.lifetimeBlocked + blockedDelta,
    bandwidthSavedBytesEstimate:
      stats.bandwidthSavedBytesEstimate + blockedDelta * BYTES_SAVED_PER_BLOCKED_ITEM
  };

  pageStats[tabKey] = {
    url,
    hostname,
    networkBlocked,
    cosmeticBlocked,
    updatedAt: now
  };

  return {
    stats: nextStats,
    pageStats: prunePageStats(pageStats),
    tabPageStats: pageStats[tabKey],
    delta: {
      blocked: blockedDelta,
      pagesSeen: sameDocument ? 0 : 1
    }
  };
}

export function getPageBlockedCount(pageStats, tabId) {
  const entry = pageStats?.[String(tabId)];
  if (!entry) return 0;
  return Number(entry.networkBlocked || 0) + Number(entry.cosmeticBlocked || 0);
}

export function parseBadgeCount(text) {
  if (!text) return 0;
  const normalized = String(text).trim().toUpperCase();
  const match = normalized.match(/^([\d,.]+)\s*([KM])?$/);
  if (!match) return 0;

  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return 0;

  const multiplier = match[2] === "M" ? 1000000 : match[2] === "K" ? 1000 : 1;
  return Math.round(value * multiplier);
}

function normalizeStats(value, now) {
  return {
    ...createDefaultStats(now),
    ...(value || {}),
    lifetimeBlocked: sanitizeCount(value?.lifetimeBlocked),
    pagesSeen: sanitizeCount(value?.pagesSeen),
    bandwidthSavedBytesEstimate: sanitizeCount(value?.bandwidthSavedBytesEstimate)
  };
}

function sanitizeCount(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.round(number);
}

function getTabKey(snapshot) {
  if (snapshot.tabId !== undefined && snapshot.tabId !== null) {
    return String(snapshot.tabId);
  }
  return `url:${snapshot.url || ""}`;
}

function prunePageStats(pageStats) {
  const entries = Object.entries(pageStats);
  if (entries.length <= MAX_TAB_STATS) return pageStats;

  return Object.fromEntries(
    entries
      .sort(([, a], [, b]) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, MAX_TAB_STATS)
  );
}
