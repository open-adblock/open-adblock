import test from "node:test";
import assert from "node:assert/strict";

import {
  BYTES_SAVED_PER_BLOCKED_ITEM,
  applyPageActivitySnapshot,
  getPageBlockedCount,
  parseBadgeCount
} from "../src/background/stats.js";

test("badge parser handles plain and compact Chrome badge counts", () => {
  assert.equal(parseBadgeCount("23"), 23);
  assert.equal(parseBadgeCount("1.2K"), 1200);
  assert.equal(parseBadgeCount("2M"), 2000000);
  assert.equal(parseBadgeCount(""), 0);
});

test("page activity increments pages once per tab URL and blocked counts by delta", () => {
  const first = applyPageActivitySnapshot(
    { stats: { lifetimeBlocked: 0, pagesSeen: 0, bandwidthSavedBytesEstimate: 0, startedAt: 1 }, pageStats: {} },
    { tabId: 7, url: "https://cnn.com/", hostname: "cnn.com", cosmeticBlocked: 3, networkBlocked: 5 },
    10
  );

  assert.equal(first.stats.pagesSeen, 1);
  assert.equal(first.stats.lifetimeBlocked, 8);
  assert.equal(first.stats.bandwidthSavedBytesEstimate, 8 * BYTES_SAVED_PER_BLOCKED_ITEM);
  assert.equal(getPageBlockedCount(first.pageStats, 7), 8);

  const second = applyPageActivitySnapshot(
    first,
    { tabId: 7, url: "https://cnn.com/", hostname: "cnn.com", cosmeticBlocked: 4, networkBlocked: 9 },
    20
  );

  assert.equal(second.stats.pagesSeen, 1);
  assert.equal(second.stats.lifetimeBlocked, 13);
  assert.equal(getPageBlockedCount(second.pageStats, 7), 13);

  const repeatedLowerCount = applyPageActivitySnapshot(
    second,
    { tabId: 7, url: "https://cnn.com/", hostname: "cnn.com", cosmeticBlocked: 1, networkBlocked: 2 },
    30
  );

  assert.equal(repeatedLowerCount.stats.pagesSeen, 1);
  assert.equal(repeatedLowerCount.stats.lifetimeBlocked, 13);
  assert.equal(getPageBlockedCount(repeatedLowerCount.pageStats, 7), 13);
});

test("new URL in same tab starts a new page counter baseline", () => {
  const first = applyPageActivitySnapshot(
    { stats: { lifetimeBlocked: 10, pagesSeen: 2, bandwidthSavedBytesEstimate: 0, startedAt: 1 }, pageStats: {} },
    { tabId: 9, url: "https://example.com/a", hostname: "example.com", networkBlocked: 2 },
    10
  );
  const second = applyPageActivitySnapshot(
    first,
    { tabId: 9, url: "https://example.com/b", hostname: "example.com", networkBlocked: 1 },
    20
  );

  assert.equal(second.stats.pagesSeen, 4);
  assert.equal(second.stats.lifetimeBlocked, 13);
  assert.equal(getPageBlockedCount(second.pageStats, 9), 1);
});
