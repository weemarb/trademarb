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
const TRADE_DETAIL_CACHE_MS = 2 * 60 * 1000;
const tradeSummaryCache = new Map();
const TRADE_SUMMARY_CACHE_MS = 30 * 1000;

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

    const trade = await fetchJson(`https://trades.roblox.com/v2/trades/${tradeId}`);
    if (!trade || typeof trade !== "object") throw new Error("missing trade payload");

    if (!Array.isArray(trade.offers)) {
      trade.offers = [trade.participantAOffer, trade.participantBOffer].filter(Boolean);
    }

    tradeDetailCache.set(tradeId, {
      trade,
      fetchedAt: now,
    });

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
      const url =
        `https://trades.roblox.com/v1/trades/${status}` +
        `?cursor=${encodeURIComponent(cursor)}` +
        `&limit=25&sortOrder=Desc`;

      const page = await fetchJson(url);
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
