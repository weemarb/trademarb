let cache = {
  userId: null,
  items: null,
  fetchedAt: 0
};

const CACHE_MS = 2 * 60 * 1000;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const ROLI_CORS_RULE_ID = 9001;
const ROLI_PLAYER_CORS_RULE_ID = 9002;

async function installRoliCorsRule() {
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ROLI_CORS_RULE_ID, ROLI_PLAYER_CORS_RULE_ID],
    addRules: [
      {
        id: ROLI_CORS_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            // overwrite rolimons' fixed ACAO so extension fetch can read it
            { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
            { header: "Access-Control-Allow-Methods", operation: "set", value: "GET, OPTIONS" },
            { header: "Access-Control-Allow-Headers", operation: "set", value: "*" }
          ]
        },
        condition: {
          urlFilter: "||api.rolimons.com/items/v2/itemdetails",
          resourceTypes: ["xmlhttprequest"]
        }
      },
      {
        id: ROLI_PLAYER_CORS_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Accept", operation: "set", value: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
            { header: "Accept-Language", operation: "set", value: "en-US,en;q=0.9" },
            { header: "Referer", operation: "set", value: "https://www.rolimons.com/players" }
          ],
          responseHeaders: [
            { header: "Access-Control-Allow-Origin", operation: "set", value: extensionOrigin },
            { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" },
            { header: "Access-Control-Allow-Methods", operation: "set", value: "GET, OPTIONS" },
            { header: "Access-Control-Allow-Headers", operation: "set", value: "*" }
          ]
        },
        condition: {
          regexFilter: "^https://www\\.rolimons\\.com/(?:player|playerrolibadges)/[0-9]+",
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ]
  });
}

chrome.runtime.onInstalled.addListener(() => {
  installRoliCorsRule().catch(e => console.warn("[tis-sw] rule install failed", e));
});

// service worker restarts a lot. do it on startup too.
installRoliCorsRule().catch(e => console.warn("[tis-sw] rule install failed", e));


async function fetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      "accept": "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`http ${res.status} on ${url}\n${text.slice(0, 400)}`);
  }
  return res.json();
}

async function fetchJsonWithRetry(url, attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) break;
      await sleep(200 * (attempt + 1));
    }
  }
  throw lastError || new Error(`failed to fetch ${url}`);
}

async function getAuthedUserId() {
  const data = await fetchJson("https://users.roblox.com/v1/users/authenticated");
  if (!data?.id) throw new Error("couldn’t read authenticated user id (not logged in?)");
  return data.id;
}

function flattenTradableItems(apiItems) {
  const flat = [];
  for (const group of apiItems || []) {
    const instances = group?.instances || [];
    for (const inst of instances) {
      flat.push({
        collectibleItemInstanceId: inst.collectibleItemInstanceId,
        collectibleItemId: group.collectibleItemId,
        itemName: inst.itemName ?? group.itemName,
        recentAveragePrice: Number(inst.recentAveragePrice ?? group.recentAveragePrice ?? 0) || 0,
        originalPrice: inst.originalPrice ?? group.originalPrice ?? null,
        assetStock: inst.assetStock ?? group.assetStock ?? null,
        itemTarget: inst.itemTarget ?? group.itemTarget ?? null,
        thumbnailUrl:
          inst.thumbnailUrl ??
          group.thumbnailUrl ??
          inst.imageUrl ??
          group.imageUrl ??
          inst.thumbnail?.imageUrl ??
          group.thumbnail?.imageUrl ??
          null,
        serialNumber: inst.serialNumber ?? null,
        isOnHold: !!inst.isOnHold
      });
    }
  }
  return flat;
}

async function fetchAllTradables(userId) {
  let cursor = "";
  const allGroups = [];

  for (let safety = 0; safety < 200; safety++) {
    const url =
      `https://trades.roblox.com/v2/users/${userId}/tradableitems` +
      `?sortBy=CreationTime&cursor=${encodeURIComponent(cursor)}` +
      `&limit=100&sortOrder=Desc`;

    // roblox sometimes burps 500s. retry a couple times.
    let data;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        data = await fetchJson(url);
        break;
      } catch (e) {
        const msg = String(e?.message || e);
        if (!msg.includes("http 500")) throw e;
        await sleep(150 * (attempt + 1));
      }
    }

    if (!data) throw new Error("trades api kept returning 500");

    if (Array.isArray(data?.items)) allGroups.push(...data.items);

    cursor = data?.nextPageCursor ?? null;
    if (!cursor) break;
  }

  return flattenTradableItems(allGroups);
}

// optional: clear cache when extension is reloaded/updated
chrome.runtime.onInstalled.addListener(() => {
  cache.userId = null;
  cache.items = null;
  cache.fetchedAt = 0;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "tis_fetch_inventory") return; // IMPORTANT: don't return true here

  (async () => {
    try {
      const now = Date.now();

      // always re-check user id if missing (or if forced)
      if (!cache.userId || msg.forceRefresh) {
        cache.userId = await getAuthedUserId();
      }

      if (!cache.items || (now - cache.fetchedAt) > CACHE_MS || msg.forceRefresh) {
        cache.items = await fetchAllTradables(cache.userId);
        cache.fetchedAt = now;
      }

      sendResponse({
        ok: true,
        userId: cache.userId,
        count: cache.items.length,
        items: cache.items
      });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err?.message || err)
      });
    }
  })();

  return true; // only for this message type
});
// background.js (mv3 service worker)
function chromeStorageLocalGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (value) => resolve(value || {}));
  });
}

function chromeStorageLocalSet(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set(value, () => resolve());
  });
}

function extractBalancedObjectLiteral(text, marker) {
  const markerIndex = String(text || "").indexOf(marker);
  if (markerIndex < 0) return null;

  const start = String(text || "").indexOf("{", markerIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }

    if (ch === "\"" || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function parseRolimonsPlayerBadges(html) {
  const objectLiteral = extractBalancedObjectLiteral(html, "player_details_data");
  if (!objectLiteral) throw new Error("missing player_details_data");

  let raw;
  try {
    raw = JSON.parse(objectLiteral);
  } catch {
    raw = JSON.parse(objectLiteral.replace(/,\s*([}\]])/g, "$1"));
  }

  const badges = raw?.badges && typeof raw.badges === "object" ? raw.badges : {};
  return {
    userId: Number(raw?.player_id || 0) || null,
    playerName: String(raw?.player_name || ""),
    verified: Object.prototype.hasOwnProperty.call(badges, "verified"),
    badgeCount: Number(raw?.badge_count || 0) || 0,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_FETCH_ROLIMONS_PLAYER") return;

  (async () => {
    const userId = String(msg.userId || "");
    if (!/^\d+$/.test(userId)) throw new Error("bad userId");

    const cached = roliPlayerCache.get(userId);
    const now = Date.now();
    if (cached?.html && (now - cached.fetchedAt) < ROLI_PLAYER_CACHE_MS) {
      sendResponse({ ok: true, html: cached.html, cached: true, source: cached.source || "cache" });
      return;
    }

    const url = `https://www.rolimons.com/player/${userId}`;
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
        cache: "no-store",
      });
    } catch (err) {
      throw new Error(`rolimons player network failure for ${url}: ${err?.message || err}`);
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`rolimons player http ${res.status} for ${url}: ${txt.slice(0, 240)}`);
    }

    let html = await res.text();
    if (!html.includes("player_details_data")) {
      const snippet = html.replace(/\s+/g, " ").slice(0, 240);
      throw new Error(`rolimons player_details_data missing for ${url}: ${snippet}`);
    }

    roliPlayerCache.set(userId, {
      html,
      fetchedAt: Date.now(),
      source: "www",
    });

    sendResponse({ ok: true, html, cached: false, source: "www" });
  })().catch(async (primaryErr) => {
    try {
      const userId = String(msg.userId || "");
      const fallbackUrl = `https://api.rolimons.com/players/v1/playerinfo/${userId}`;
      const fallbackRes = await fetch(fallbackUrl, {
        method: "GET",
        credentials: "include",
        headers: { "accept": "application/json" },
        cache: "no-store",
      });

      const body = await fallbackRes.text().catch(() => "");
      sendResponse({
        ok: false,
        error: `${primaryErr?.message || primaryErr}; api fallback http ${fallbackRes.status}: ${body.slice(0, 240)}`,
      });
    } catch (fallbackErr) {
      sendResponse({
        ok: false,
        error: `${primaryErr?.message || primaryErr}; api fallback failed: ${fallbackErr?.message || fallbackErr}`,
      });
    }
  });

  return true; // keep message channel open for async
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_FETCH_ROLIMONS_PLAYER_BADGES") return;

  (async () => {
    const userId = String(msg.userId || "");
    if (!/^\d+$/.test(userId)) throw new Error("bad userId");

    const cached = roliPlayerBadgeCache.get(userId);
    const now = Date.now();
    if (cached && (now - cached.fetchedAt) < ROLI_PLAYER_BADGE_CACHE_MS) {
      sendResponse({ ok: true, ...cached.data, cached: true, source: "memory" });
      return;
    }

    const storageKey = `${ROLI_PLAYER_BADGE_STORAGE_PREFIX}${userId}`;
    const stored = (await chromeStorageLocalGet(storageKey))[storageKey];
    if (stored?.data && (now - Number(stored.fetchedAt || 0)) < ROLI_PLAYER_BADGE_CACHE_MS) {
      roliPlayerBadgeCache.set(userId, {
        data: stored.data,
        fetchedAt: Number(stored.fetchedAt || now),
      });
      sendResponse({ ok: true, ...stored.data, cached: true, source: "storage" });
      return;
    }

    const url = `https://www.rolimons.com/playerrolibadges/${userId}`;
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`rolimons badge http ${res.status}: ${txt.slice(0, 240)}`);
    }

    const data = parseRolimonsPlayerBadges(await res.text());
    data.userId ||= Number(userId);

    roliPlayerBadgeCache.set(userId, { data, fetchedAt: now });
    await chromeStorageLocalSet({
      [storageKey]: {
        data,
        fetchedAt: now,
      },
    });

    sendResponse({ ok: true, ...data, cached: false, source: "www" });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});
// rolimons itemdetails fetch (service worker)
let roliCache = { data: null, fetchedAt: 0 };
const ROLI_CACHE_MS = 10 * 60 * 1000;
const roliPlayerCache = new Map();
const ROLI_PLAYER_CACHE_MS = 10 * 60 * 1000;
const roliPlayerBadgeCache = new Map();
const ROLI_PLAYER_BADGE_CACHE_MS = 2 * 24 * 60 * 60 * 1000;
const ROLI_PLAYER_BADGE_STORAGE_PREFIX = "tis_roli_player_badges:";
const thumbnailCache = new Map();
const THUMBNAIL_CACHE_MS = 30 * 60 * 1000;
const tradeDetailCache = new Map();
const tradeDetailFetchRequests = new Map();
const tradeDetailFetchQueue = [];
let activeTradeDetailFetches = 0;
const MAX_CONCURRENT_TRADE_DETAIL_FETCHES = 8;
const TRADE_DETAIL_CACHE_MS = 2 * 60 * 1000;
const tradeSummaryCache = new Map();
const TRADE_SUMMARY_CACHE_MS = 30 * 1000;
const TRADE_CACHE_STORAGE_PREFIX = "tis_trade_cache_v1:";
const TRADE_CACHE_PAGE_LIMIT_PER_STATUS = 12;
// There are twelve cached list pages per status (25 rows each).  Retain the
// matching amount of immutable detail data so revisiting those rows does not
// turn into another network burst.
const TRADE_CACHE_DETAIL_LIMIT = 350;
const TRADE_CACHE_REVALIDATE_MS = 20 * 1000;

let tradeCacheUserId = null;
let tradeCacheUserIdFetchedAt = 0;
let tradeCacheAccountEpoch = 0;
let tradeCacheWriteQueue = Promise.resolve();
let persistentTradeDetailsKey = "";
let persistentTradeDetails = null;
let persistentTradeDetailsRead = null;

function resetTradeRuntimeCachesForAccount(userId) {
  const normalizedUserId = String(userId || "");
  if (!/^\d+$/.test(normalizedUserId)) return false;
  const changed = tradeCacheUserId !== normalizedUserId;
  tradeCacheUserId = normalizedUserId;
  tradeCacheUserIdFetchedAt = Date.now();
  if (!changed) return false;

  // Storage is already namespaced by user id. Clear only process-local data
  // so a Roblox account switch never exposes one account's list while the
  // other account's page is still alive.
  tradeCacheAccountEpoch += 1;
  tradeSummaryCache.clear();
  tradeDetailCache.clear();
  tradeDetailFetchRequests.clear();
  tradeDetailFetchQueue.length = 0;
  persistentTradeDetailsKey = "";
  persistentTradeDetails = null;
  persistentTradeDetailsRead = null;
  cache.userId = null;
  cache.items = null;
  cache.fetchedAt = 0;
  return true;
}

function pumpTradeDetailFetchQueue() {
  while (activeTradeDetailFetches < MAX_CONCURRENT_TRADE_DETAIL_FETCHES && tradeDetailFetchQueue.length) {
    const next = tradeDetailFetchQueue.shift();
    activeTradeDetailFetches += 1;
    fetchJsonWithRetry(`https://trades.roblox.com/v2/trades/${next.tradeId}`)
      .then((trade) => {
        if (!trade || typeof trade !== "object") throw new Error("missing trade payload");
        if (!Array.isArray(trade.offers)) {
          trade.offers = [trade.participantAOffer, trade.participantBOffer].filter(Boolean);
        }
        next.resolve(trade);
      })
      .catch(next.reject)
      .finally(() => {
        activeTradeDetailFetches -= 1;
        pumpTradeDetailFetchQueue();
      });
  }
}

function fetchTradeDetailQueued(tradeId) {
  const id = String(tradeId || "");
  const pending = tradeDetailFetchRequests.get(id);
  if (pending) return pending;

  const request = new Promise((resolve, reject) => {
    tradeDetailFetchQueue.push({ tradeId: id, resolve, reject });
    pumpTradeDetailFetchQueue();
  }).finally(() => {
    tradeDetailFetchRequests.delete(id);
  });
  tradeDetailFetchRequests.set(id, request);
  return request;
}

function getTradePageKey(cursor, limit, sortOrder) {
  return `${String(cursor || "")}|${Math.max(1, Number(limit) || 25)}|${String(sortOrder || "Desc").toLowerCase()}`;
}

async function getTradeCacheUserId() {
  const now = Date.now();
  if (tradeCacheUserId && (now - tradeCacheUserIdFetchedAt) < 5 * 60 * 1000) {
    return tradeCacheUserId;
  }

  // The user-id request is only for namespacing browser storage.  It must not
  // prevent list values from loading on a profile where that endpoint or its
  // host permission is unavailable; trade-detail fetching itself can still
  // succeed with the existing trades host permission.
  try {
    tradeCacheUserId = String(await getAuthedUserId());
  } catch {
    tradeCacheUserId = "local-profile";
  }
  tradeCacheUserIdFetchedAt = now;
  return tradeCacheUserId;
}

async function getStoredTradeCache() {
  const userId = await getTradeCacheUserId();
  const key = `${TRADE_CACHE_STORAGE_PREFIX}${userId}`;
  const stored = (await chromeStorageLocalGet(key))[key];
  return {
    key,
    value: stored && typeof stored === "object"
      ? stored
      : { version: 1, pages: {}, details: {} },
  };
}

function normalizeTradePagePayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) return null;
  return {
    data: payload.data,
    nextPageCursor: payload.nextPageCursor ?? null,
    previousPageCursor: payload.previousPageCursor ?? null,
  };
}

async function readStoredTradePageEntry(status, cursor, limit, sortOrder) {
  const { value } = await getStoredTradeCache();
  const page = value?.pages?.[status]?.[getTradePageKey(cursor, limit, sortOrder)];
  const payload = normalizeTradePagePayload(page?.payload);
  return payload ? { payload, fetchedAt: Number(page?.fetchedAt || 0) } : null;
}

async function readStoredTradePage(status, cursor, limit, sortOrder) {
  return (await readStoredTradePageEntry(status, cursor, limit, sortOrder))?.payload || null;
}

async function readPersistentTradeDetails() {
  const userId = await getTradeCacheUserId();
  const key = `${TRADE_CACHE_STORAGE_PREFIX}${userId}`;
  if (persistentTradeDetailsKey === key && persistentTradeDetails) return persistentTradeDetails;
  if (persistentTradeDetailsRead?.key === key) return persistentTradeDetailsRead.promise;

  const promise = chromeStorageLocalGet(key).then((stored) => {
    const cache = stored?.[key];
    const details = cache?.details && typeof cache.details === "object" ? cache.details : {};
    persistentTradeDetailsKey = key;
    persistentTradeDetails = details;
    return details;
  }).finally(() => {
    if (persistentTradeDetailsRead?.key === key) persistentTradeDetailsRead = null;
  });
  persistentTradeDetailsRead = { key, promise };
  return promise;
}

function queueTradeCacheWrite(write) {
  const accountEpoch = tradeCacheAccountEpoch;
  const task = tradeCacheWriteQueue.then(async () => {
    // A write queued by the previous Roblox account must never resolve its
    // storage key after a switch and land in the new account's cache.
    if (accountEpoch !== tradeCacheAccountEpoch) return false;
    const { key, value } = await getStoredTradeCache();
    if (accountEpoch !== tradeCacheAccountEpoch) return false;
    return write(key, value);
  });
  tradeCacheWriteQueue = task.catch(() => {});
  return task;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_SYNC_TRADE_CACHE_ACCOUNT") return;

  try {
    const userId = String(msg.userId || "");
    if (!/^\d+$/.test(userId)) throw new Error("bad account userId");
    sendResponse({ ok: true, changed: resetTradeRuntimeCachesForAccount(userId) });
  } catch (err) {
    sendResponse({ ok: false, error: String(err?.message || err) });
  }
});

async function storeTradePage(status, cursor, limit, sortOrder, payload) {
  const normalized = normalizeTradePagePayload(payload);
  if (!normalized) return false;

  return queueTradeCacheWrite(async (key, value) => {
    const pages = value.pages && typeof value.pages === "object" ? value.pages : {};
    const statusPages = pages[status] && typeof pages[status] === "object" ? pages[status] : {};
    const pageKey = getTradePageKey(cursor, limit, sortOrder);
    statusPages[pageKey] = { payload: normalized, fetchedAt: Date.now() };

    const staleKeys = Object.keys(statusPages)
      .sort((a, b) => Number(statusPages[b]?.fetchedAt || 0) - Number(statusPages[a]?.fetchedAt || 0))
      .slice(TRADE_CACHE_PAGE_LIMIT_PER_STATUS);
    staleKeys.forEach((staleKey) => delete statusPages[staleKey]);

    pages[status] = statusPages;
    await chromeStorageLocalSet({
      [key]: {
        version: 1,
        pages,
        details: value.details && typeof value.details === "object" ? value.details : {},
      },
    });
    return true;
  });
}

async function readStoredTradeDetail(tradeId) {
  const entry = (await readPersistentTradeDetails())?.[tradeId];
  return entry?.trade && typeof entry.trade === "object" ? entry.trade : null;
}

async function storeTradeDetail(tradeId, trade) {
  if (!trade || typeof trade !== "object") return false;
  return queueTradeCacheWrite(async (key, value) => {
    const details = value.details && typeof value.details === "object" ? value.details : {};
    details[tradeId] = { trade, fetchedAt: Date.now() };

    const staleIds = Object.keys(details)
      .sort((a, b) => Number(details[b]?.fetchedAt || 0) - Number(details[a]?.fetchedAt || 0))
      .slice(TRADE_CACHE_DETAIL_LIMIT);
    staleIds.forEach((staleId) => delete details[staleId]);

    await chromeStorageLocalSet({
      [key]: {
        version: 1,
        pages: value.pages && typeof value.pages === "object" ? value.pages : {},
        details,
      },
    });
    if (persistentTradeDetailsKey === key) persistentTradeDetails = details;
    return true;
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_ROLIMONS_GET_ITEMDETAILS") return;

  (async () => {
    const now = Date.now();
    if (roliCache.data && (now - roliCache.fetchedAt) < ROLI_CACHE_MS) {
      sendResponse({ ok: true, data: roliCache.data, cached: true });
      return;
    }

    const url = "https://api.rolimons.com/items/v2/itemdetails";
    const res = await fetch(url, {
      method: "GET",
      credentials: "omit",
      headers: { "accept": "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`rolimons http ${res.status}: ${txt.slice(0, 200)}`);
    }

    const json = await res.json();
    const items = json?.items;
    if (!items || typeof items !== "object") throw new Error("missing .items");

    // slim it down hard: { id: { name, value, projected } }
    const slim = Object.create(null);
    for (const [id, arr] of Object.entries(items)) {
      const name = typeof arr?.[0] === "string" ? arr[0] : null;
      const rap = arr?.[2];
      const value = arr?.[3];
      const projFlag = arr?.[7];
      const projected = projFlag === 1 || projFlag === "1"; // v2 uses 1 / -1
      slim[id] = {
        name,
        rap: (rap === -1 ? null : rap),
        value: (value === -1 ? null : value),
        projected,
      };
    }

    roliCache.data = slim;
    roliCache.fetchedAt = Date.now();

    sendResponse({ ok: true, data: slim, cached: false });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_REVALIDATE_TRADE_PAGE") return;

  (async () => {
    const status = String(msg.status || "").trim().toLowerCase();
    const cursor = String(msg.cursor || "");
    const limit = Math.max(1, Number(msg.limit) || 25);
    const sortOrder = String(msg.sortOrder || "Desc");
    if (!["inbound", "outbound", "completed", "inactive"].includes(status)) {
      throw new Error("bad status");
    }

    const stored = await readStoredTradePageEntry(status, cursor, limit, sortOrder);
    const age = stored ? Date.now() - stored.fetchedAt : Infinity;
    if (!msg.force && stored && age >= 0 && age < TRADE_CACHE_REVALIDATE_MS) {
      sendResponse({ ok: true, payload: stored.payload, cached: true, revalidated: false, fetchedAt: stored.fetchedAt });
      return;
    }

    const url =
      `https://trades.roblox.com/v1/trades/${status}` +
      `?cursor=${encodeURIComponent(cursor)}` +
      `&limit=${encodeURIComponent(limit)}` +
      `&sortOrder=${encodeURIComponent(sortOrder)}`;
    const payload = await fetchJsonWithRetry(url);
    if (!await storeTradePage(status, cursor, limit, sortOrder, payload)) {
      throw new Error("could not store revalidated trade page");
    }
    sendResponse({ ok: true, payload: normalizeTradePagePayload(payload), cached: false, revalidated: true, fetchedAt: Date.now() });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_FETCH_ROBLOX_ASSET_THUMBNAILS") return;

  (async () => {
    const rawRequests = Array.isArray(msg.thumbnailRequests) && msg.thumbnailRequests.length
      ? msg.thumbnailRequests
      : (Array.isArray(msg.assetIds) ? msg.assetIds : [msg.assetId]).map((id) => ({
        requestId: String(id || ""),
        targetId: String(id || ""),
        type: "Asset",
        size: "150x150",
        format: "Webp",
        isCircular: false,
      }));

    const requests = Array.from(new Map(rawRequests.map((request) => {
      const targetId = String(request?.targetId || request?.assetId || "");
      const type = String(request?.type || "Asset");
      const requestId = String(request?.requestId || `${type}:${targetId}`);
      if (!/^\d+$/.test(targetId) || !requestId) return null;
      return [requestId, {
        requestId,
        targetId: Number(targetId),
        type,
        size: String(request?.size || "150x150"),
        format: String(request?.format || "Webp"),
        isCircular: Boolean(request?.isCircular),
      }];
    }).filter(Boolean)).values());

    if (!requests.length) {
      sendResponse({ ok: true, thumbnails: {} });
      return;
    }

    const now = Date.now();
    const thumbnails = {};
    const missing = [];

    requests.forEach((request) => {
      const cached = thumbnailCache.get(request.requestId);
      if (cached?.imageUrl && (now - cached.fetchedAt) < THUMBNAIL_CACHE_MS) {
        thumbnails[request.requestId] = cached.imageUrl;
      } else {
        missing.push(request);
      }
    });

    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const res = await fetch("https://thumbnails.roblox.com/v1/batch", {
        method: "POST",
        credentials: "include",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify(chunk.map((request) => ({
          requestId: request.requestId,
          targetId: request.targetId,
          type: request.type,
          size: request.size,
          format: request.format,
          isCircular: request.isCircular,
        }))),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`roblox thumbnail batch http ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = await res.json();
      const rows = Array.isArray(json?.data) ? json.data : [];
      rows.forEach((row) => {
        const requestId = String(row?.requestId || "");
        const imageUrl = String(row?.imageUrl || "");
        if (!requestId || !imageUrl) return;
        thumbnails[requestId] = imageUrl;
        thumbnailCache.set(requestId, { imageUrl, fetchedAt: Date.now() });
      });
    }

    sendResponse({ ok: true, thumbnails });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_GET_TRADE_PAGE_CACHE") return;

  (async () => {
    const status = String(msg.status || "").trim().toLowerCase();
    const cursor = String(msg.cursor || "");
    const limit = Math.max(1, Number(msg.limit) || 25);
    const sortOrder = String(msg.sortOrder || "Desc");
    if (!["inbound", "outbound", "completed", "inactive"].includes(status)) {
      throw new Error("bad status");
    }

    const payload = await readStoredTradePage(status, cursor, limit, sortOrder);
    sendResponse({ ok: true, payload, cached: Boolean(payload) });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_STORE_TRADE_PAGE_CACHE") return;

  (async () => {
    const status = String(msg.status || "").trim().toLowerCase();
    const cursor = String(msg.cursor || "");
    const limit = Math.max(1, Number(msg.limit) || 25);
    const sortOrder = String(msg.sortOrder || "Desc");
    if (!["inbound", "outbound", "completed", "inactive"].includes(status)) {
      throw new Error("bad status");
    }

    const stored = await storeTradePage(status, cursor, limit, sortOrder, msg.payload);
    sendResponse({ ok: stored });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_STORE_TRADE_DETAILS") return;

  (async () => {
    const tradeId = String(msg.tradeId || "");
    if (!/^\d+$/.test(tradeId)) throw new Error("bad tradeId");

    const trade = msg.trade;
    if (!trade || typeof trade !== "object") throw new Error("missing trade payload");
    if (!Array.isArray(trade.offers)) {
      trade.offers = [trade.participantAOffer, trade.participantBOffer].filter(Boolean);
    }

    tradeDetailCache.set(tradeId, { trade, fetchedAt: Date.now() });
    // Do not make the live page wait for chrome.storage.  A long trade list
    // can request hundreds of immutable details at once; serialising those
    // durable writes before responding made later rows look unenhanced even
    // though their network responses had already arrived.
    storeTradeDetail(tradeId, trade).catch(() => {});
    sendResponse({ ok: true });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_FETCH_TRADE_DETAILS") return;

  (async () => {
    const tradeId = String(msg.tradeId || "");
    if (!/^\d+$/.test(tradeId)) throw new Error("bad tradeId");

    const cached = tradeDetailCache.get(tradeId);
    const now = Date.now();
    if (cached && (now - cached.fetchedAt) < TRADE_DETAIL_CACHE_MS) {
      sendResponse({ ok: true, trade: cached.trade, cached: true });
      return;
    }

    const storedTrade = await readStoredTradeDetail(tradeId);
    if (storedTrade) {
      tradeDetailCache.set(tradeId, { trade: storedTrade, fetchedAt: now });
      sendResponse({ ok: true, trade: storedTrade, cached: true, persistent: true });
      return;
    }

    const trade = await fetchTradeDetailQueued(tradeId);

    tradeDetailCache.set(tradeId, {
      trade,
      fetchedAt: now,
    });
    // Persist independently of the response so list decoration is driven by
    // the fetched data, not by a potentially long storage write queue.
    storeTradeDetail(tradeId, trade).catch(() => {});
    sendResponse({ ok: true, trade, cached: false });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_FETCH_TRADE_SUMMARIES") return;

  (async () => {
    const status = String(msg.status || "").trim().toLowerCase();
    const wantedCount = Math.max(1, Number(msg.count) || 1);
    if (!["inbound", "outbound", "completed", "inactive"].includes(status)) {
      throw new Error("bad status");
    }

    const now = Date.now();
    const cached = tradeSummaryCache.get(status);
    const liveCache = cached && (now - cached.fetchedAt) < TRADE_SUMMARY_CACHE_MS
      ? { items: [...cached.items], nextPageCursor: cached.nextPageCursor ?? null }
      : { items: [], nextPageCursor: "" };

    while (liveCache.items.length < wantedCount && liveCache.nextPageCursor !== null) {
      const cursor = liveCache.nextPageCursor || "";
      let page = await readStoredTradePage(status, cursor, 25, "Desc");
      if (!page) {
        const url =
          `https://trades.roblox.com/v1/trades/${status}` +
          `?cursor=${encodeURIComponent(cursor)}` +
          `&limit=25&sortOrder=Desc`;

        page = await fetchJsonWithRetry(url);
        await storeTradePage(status, cursor, 25, "Desc", page);
      }
      const items = Array.isArray(page?.data) ? page.data : [];
      liveCache.items.push(...items);
      liveCache.nextPageCursor = page?.nextPageCursor ?? null;
      if (!items.length) break;
    }

    tradeSummaryCache.set(status, {
      items: liveCache.items,
      nextPageCursor: liveCache.nextPageCursor,
      fetchedAt: now,
    });

    sendResponse({
      ok: true,
      items: liveCache.items.slice(0, wantedCount),
      totalFetched: liveCache.items.length,
      hasMore: liveCache.nextPageCursor !== null,
      cached: Boolean(cached),
    });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});
