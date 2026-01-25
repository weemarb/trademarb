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

async function installRoliCorsRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ROLI_CORS_RULE_ID],
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
      }
    ]
  });

  console.log("[tis-sw] installed rolimons cors rule");
}

chrome.runtime.onInstalled.addListener(() => {
  installRoliCorsRule().catch(e => console.warn("[tis-sw] rule install failed", e));
});

// service worker restarts a lot. do it on startup too.
installRoliCorsRule().catch(() => {});


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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "TIS_FETCH_ROLIMONS_PLAYER") return;

  (async () => {
    const userId = String(msg.userId || "");
    if (!/^\d+$/.test(userId)) throw new Error("bad userId");

    const url = `https://www.rolimons.com/player/${userId}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`rolimons http ${res.status}`);

    const html = await res.text();
    sendResponse({ ok: true, html });
  })().catch(err => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true; // keep message channel open for async
});
// rolimons itemdetails fetch (service worker)
let roliCache = { data: null, fetchedAt: 0 };
const ROLI_CACHE_MS = 10 * 60 * 1000;

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

    // slim it down hard: { id: { value, projected } }
    const slim = Object.create(null);
    for (const [id, arr] of Object.entries(items)) {
      const value = arr?.[3];
      const projFlag = arr?.[7];
      const projected = projFlag === 1 || projFlag === "1"; // v2 uses 1 / -1
      slim[id] = {
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
