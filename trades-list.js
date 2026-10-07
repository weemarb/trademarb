(() => {
  const { origin, pathname } = location;
  if (origin !== "https://www.roblox.com") return;
  // This file is also injected on /counter routes. Do not wrap that page's
  // network primitives: it owns a different Angular controller and must keep
  // Roblox's native request flow intact.
  if (!/^\/trades\/?$/i.test(pathname)) return;
  if (window.__TIS_TRADES_LIST_PAGE_TAP__) return;
  window.__TIS_TRADES_LIST_PAGE_TAP__ = true;

  // Brave may allow authenticated trade requests from the page while blocking
  // the extension worker's cookie access.  Keep those fallback requests in a
  // single shared queue so list decoration cannot rate-limit a selected trade.
  if (typeof window.TIS_FETCH_TRADE_DETAIL_FIRST_PARTY !== "function") {
    const pending = new Map();
    const queue = [];
    let active = false;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const fetchWithRetry = async (tradeId, retryRateLimit) => {
      let lastError = null;
      const maxAttempts = retryRateLimit ? 5 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const res = await fetch(`https://trades.roblox.com/v2/trades/${tradeId}`, {
            method: "GET",
            credentials: "include",
            headers: { accept: "application/json" },
            cache: "no-store",
          });
          if (res.ok) return res.json();
          lastError = new Error(`trade detail http ${res.status}`);
          if (res.status !== 429 || attempt + 1 >= maxAttempts) throw lastError;
        } catch (error) {
          lastError = error;
          if (attempt + 1 >= maxAttempts || !/http 429/i.test(String(error?.message || error))) throw error;
        }
        await sleep(750 * (attempt + 1));
      }
      throw lastError || new Error("trade detail unavailable");
    };

    const pump = () => {
      if (active || !queue.length) return;
      const next = queue.shift();
      active = true;
      fetchWithRetry(next.tradeId, next.priority)
        .then(next.resolve, (error) => {
          next.rateLimited = /http 429/i.test(String(error?.message || error));
          next.reject(error);
        })
        .finally(() => {
          pending.delete(next.tradeId);
          active = false;
          // An off-screen row that receives 429 must yield the request slot
          // rather than continually starving a user-selected trade.
          setTimeout(pump, next.rateLimited ? 1800 : 250);
        });
    };

    window.TIS_FETCH_TRADE_DETAIL_FIRST_PARTY = (tradeId, priority = false) => {
      const id = String(tradeId || "");
      if (!/^\d+$/.test(id)) return Promise.reject(new Error("invalid trade id"));
      const existing = pending.get(id);
      if (existing) {
        if (priority && !active) {
          const queuedIndex = queue.indexOf(existing.entry);
          if (queuedIndex > 0) queue.unshift(queue.splice(queuedIndex, 1)[0]);
        }
        return existing.promise;
      }

      let entry;
      const promise = new Promise((resolve, reject) => {
        entry = { tradeId: id, resolve, reject, priority };
        if (priority) queue.unshift(entry);
        else queue.push(entry);
        pump();
      });
      pending.set(id, { promise, entry });
      return promise;
    };
  }

  function getTradesListRequestFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.origin !== "https://trades.roblox.com") return null;
      const match = url.pathname.match(/^\/v1\/trades\/([^/]+)$/i);
      if (!match) return null;
      const status = String(match[1] || "").trim().toLowerCase();
      if (!["inbound", "outbound", "completed", "inactive"].includes(status)) return null;
      return {
        status,
        cursor: url.searchParams.get("cursor") || "",
        limit: Math.max(1, Number(url.searchParams.get("limit")) || 25),
        sortOrder: url.searchParams.get("sortOrder") || "Desc",
      };
    } catch {
      return null;
    }
  }

  function getTradesListStatusFromUrl(rawUrl) {
    return getTradesListRequestFromUrl(rawUrl)?.status || null;
  }

  function persistTradePage(request, payload) {
    if (!request || !payload || !Array.isArray(payload.data)) return;
    const bridge = window.TIS_GENERIC?.bridgeRequest;
    if (typeof bridge !== "function") return;
    bridge("runtimeSendMessage", {
      type: "TIS_STORE_TRADE_PAGE_CACHE",
      status: request.status,
      cursor: request.cursor,
      limit: request.limit,
      sortOrder: request.sortOrder,
      payload,
    }, 10000).catch(() => {});
  }

  function emitTradesListPayload(status, payload, request = null) {
    if (!status || !payload || typeof payload !== "object") return;
    persistTradePage(request, payload);
    window.postMessage({
      type: "TIS_TRADES_LIST_DATA",
      status,
      payload,
    }, "*");
  }

  function emitTradeDetailPayload(tradeId, trade) {
    if (!tradeId || !trade || typeof trade !== "object") return;
    const bridge = window.TIS_GENERIC?.bridgeRequest;
    if (typeof bridge === "function") {
      bridge("runtimeSendMessage", {
        type: "TIS_STORE_TRADE_DETAILS",
        tradeId: String(tradeId),
        trade,
      }, 10000).catch(() => {});
    }
    window.postMessage({
      type: "TIS_TRADE_DETAIL_DATA",
      tradeId: String(tradeId),
      trade,
    }, "*");
  }

  function emitTradeDetailError(tradeId, error) {
    window.postMessage({
      type: "TIS_TRADE_DETAIL_ERROR",
      tradeId: String(tradeId || ""),
      error: String(error || "unknown error"),
    }, "*");
  }

  // Detail requests are intentionally handled by the extension service
  // worker.  The list-value renderer communicates through this event so it
  // never makes its own page-level request burst.
  const tradeDetailRequestState = new Map();
  window.addEventListener("message", (ev) => {
    const msg = ev?.data;
    if (msg?.type !== "TIS_REQUEST_TRADE_DETAILS") return;

    const tradeId = String(msg.tradeId || "");
    if (!/^\d+$/.test(tradeId) || tradeDetailRequestState.has(tradeId)) return;
    const bridge = window.TIS_GENERIC?.bridgeRequest;
    if (typeof bridge !== "function") {
      emitTradeDetailError(tradeId, "trade cache bridge unavailable");
      return;
    }

    const request = bridge("runtimeSendMessage", {
      type: "TIS_FETCH_TRADE_DETAILS",
      tradeId,
    }, 15000)
      .then((response) => {
        if (!response?.ok || !response.trade) {
          throw new Error(response?.error || "trade detail unavailable");
        }
        emitTradeDetailPayload(tradeId, response.trade);
      })
      .catch((error) => emitTradeDetailError(tradeId, String(error?.message || error)))
      .finally(() => tradeDetailRequestState.delete(tradeId));

    tradeDetailRequestState.set(tradeId, request);
  });
})();

(() => {
  if (location.origin !== "https://www.roblox.com") return;
  if (window.__TIS_COUNTER_CACHE_RECOVERY__) return;
  window.__TIS_COUNTER_CACHE_RECOVERY__ = true;

  let requestInFlight = false;
  let nextAttemptAt = 0;
  let requestedTradeId = "";
  let routeStartedAt = 0;
  let recoveryApplied = false;
  const NATIVE_COUNTER_GRACE_MS = 5000;
  const inventoryRetryStates = new WeakMap();

  function getCounterTradeId() {
    return location.pathname.match(/^\/trades\/(\d+)\/counter\/?$/i)?.[1] || "";
  }

  function getCounterScope() {
    if (!window.angular?.element) return null;
    const root = document.querySelector('[ng-controller="tradeRequestController"]');
    if (!root) return null;
    try {
      let scope = window.angular.element(root).scope?.() || window.angular.element(root).isolateScope?.() || null;
      for (let depth = 0; scope && depth < 6; depth += 1, scope = scope.$parent) {
        if (scope?.data && scope?.layout && typeof scope?.addOffer === "function") return scope;
      }
    } catch {}
    return null;
  }

  function runInScope(scope, fn) {
    if (typeof scope?.$applyAsync === "function") scope.$applyAsync(fn);
    else {
      try { scope?.$apply?.(fn); } catch { fn(); }
    }
  }

  // The trade-detail endpoint's offers are transport objects.  Counter's
  // Angular template renders `offer.slots`, labels, and isMyOffer, all of
  // which are created by its own addOffer method.  Assigning the endpoint
  // array directly therefore produces a half-rendered counter (RAP totals
  // but no cards or value totals).
  function hydrateCounterOffers(scope, sourceOffers, detail) {
    const offers = Array.isArray(sourceOffers) ? sourceOffers : [];
    if (!offers.length) return false;

    if (typeof scope?.clearOffers !== "function" || typeof scope?.addOffer !== "function") {
      return false;
    }

    scope.clearOffers();
    offers.forEach((offer) => {
      const user = { ...(offer?.user || {}) };
      user.nameForDisplay ||= detail?.user?.nameForDisplay || user.displayName || user.name || "";
      const items = (Array.isArray(offer?.items) ? offer.items : []).map((item) => {
        if (!item || typeof item !== "object") return item;
        return {
          ...item,
          id: item.id || item.collectibleItemInstanceId || item.collectibleItemId,
        };
      });
      scope.addOffer(user, Number(offer?.robux) || 0, items);
    });

    scope.data.counterTradeId = Number(getCounterTradeId()) || getCounterTradeId();
    scope.partner = detail?.user || scope.partner || null;
    scope.layout.loaded = true;
    scope.layout.tradeRequestView = "offers";
    try { scope.$broadcast?.("reloadInventory"); } catch {}
    return true;
  }

  function preventLateNativeOfferDuplicates(scope) {
    if (scope?.__tisCounterOfferGuardInstalled || typeof scope?.addOffer !== "function") return;
    const nativeAddOffer = scope.addOffer;
    scope.__tisCounterOfferGuardInstalled = true;
    scope.addOffer = function guardedAddOffer(user, robux, items) {
      const userId = String(user?.id || "");
      const existingOffers = Array.isArray(scope.data?.offers) ? scope.data.offers : [];
      // openCounterTrade clears the list before its request settles, then
      // appends each remote offer in its callback. Once our cache has rebuilt
      // the two sides, that late callback must not append a second copy.
      if (userId && existingOffers.some((offer) => String(offer?.user?.id || "") === userId)) return;
      return nativeAddOffer.apply(this, arguments);
    };
  }

  async function fetchCounterDetail(tradeId) {
    const bridge = window.TIS_GENERIC?.bridgeRequest;
    if (typeof bridge === "function") {
      try {
        const response = await bridge("runtimeSendMessage", { type: "TIS_FETCH_TRADE_DETAILS", tradeId }, 15000);
        if (response?.ok && response.trade) return response.trade;
      } catch {}
    }

    // The normal Brave profile can deny cookies to extension-worker fetches.
    // This is one explicit, first-party counter request with measured 429
    // retries, never a list-wide request burst.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`https://trades.roblox.com/v2/trades/${tradeId}`, {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (response.ok) {
        const detail = await response.json();
        if (typeof bridge === "function") {
          bridge("runtimeSendMessage", { type: "TIS_STORE_TRADE_DETAILS", tradeId, trade: detail }, 10000).catch(() => {});
        }
        return detail;
      }
      if (response.status !== 429 || attempt === 3) throw new Error(`counter trade detail http ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
    throw new Error("counter trade detail unavailable");
  }

  function recoverCounter() {
    const tradeId = getCounterTradeId();
    if (!tradeId) {
      requestedTradeId = "";
      requestInFlight = false;
      nextAttemptAt = 0;
      routeStartedAt = 0;
      recoveryApplied = false;
      return;
    }

    // Counter can be opened by Roblox's client-side router.  In that case
    // this content script was created on /trades, so detect the new trade
    // here instead of relying on a document-start URL match.
    if (tradeId !== requestedTradeId) {
      requestedTradeId = tradeId;
      requestInFlight = false;
      nextAttemptAt = 0;
      routeStartedAt = Date.now();
      recoveryApplied = false;
    }

    const scope = getCounterScope();
    if (!scope || requestInFlight || Date.now() < nextAttemptAt) return;
    // Allow Roblox's own openCounterTrade flow to finish first. Applying a
    // cached offer while that async flow is still adding offers can duplicate
    // both inventory panels and squeeze the cards into the wrong layout.
    if (Date.now() - routeStartedAt < NATIVE_COUNTER_GRACE_MS) return;

    const currentOffers = Array.isArray(scope.data?.offers) ? scope.data.offers : [];
    const hasRenderedOfferLayout =
      currentOffers.length > 0 &&
      currentOffers.every((offer) => Array.isArray(offer?.slots)) &&
      Boolean(scope.layout?.loaded);
    if (hasRenderedOfferLayout) return;
    // A cache recovery is deliberately a one-shot operation per counter
    // route. Native rendering and our recovery must never both append offers.
    if (recoveryApplied) return;

    requestInFlight = true;
    fetchCounterDetail(tradeId)
      .then((detail) => {
        if (tradeId !== getCounterTradeId()) return;
        const offers = Array.isArray(detail?.offers)
          ? detail.offers
          : [detail?.participantAOffer, detail?.participantBOffer].filter(Boolean);
        if (!offers.length) throw new Error("counter detail has no offers");
        recoveryApplied = true;
        runInScope(scope, () => {
          const nativeOffers = Array.isArray(scope.data?.offers) ? scope.data.offers : [];
          const nativeFinished =
            nativeOffers.length > 0 &&
            nativeOffers.every((offer) => Array.isArray(offer?.slots)) &&
            Boolean(scope.layout?.loaded);
          if (!nativeFinished) {
            preventLateNativeOfferDuplicates(scope);
            hydrateCounterOffers(scope, offers, detail);
          }
        });
      })
      .catch(() => {
        if (tradeId !== getCounterTradeId()) return;
        // Keep retrying the one counter request after Roblox's rate-limit
        // window without sending the user back to an empty native spinner.
        nextAttemptAt = Date.now() + 5000;
      })
      .finally(() => {
        if (tradeId === getCounterTradeId()) requestInFlight = false;
      });
  }

  function retryFailedPartnerInventories() {
    if (!getCounterTradeId()) return;
    document.querySelectorAll(".trade-inventory-panel").forEach((panel) => {
      let scope = null;
      try {
        scope = window.angular?.element(panel).scope?.() || window.angular?.element(panel).isolateScope?.() || null;
      } catch {}
      if (!scope || scope.inventoryData?.isMe || scope.loading || !scope.loadFailed || typeof scope.reload !== "function") return;

      const existingItems = scope.inventoryData?.tradableItems;
      if (Array.isArray(existingItems) && existingItems.length) {
        inventoryRetryStates.delete(scope);
        return;
      }

      const now = Date.now();
      let state = inventoryRetryStates.get(scope);
      if (!state) {
        // A failed first request is normally Roblox's 429 window. Wait before
        // retrying rather than immediately issuing the same request again.
        state = { attempts: 0, nextAttemptAt: now + 8000 };
        inventoryRetryStates.set(scope, state);
        return;
      }
      if (state.attempts >= 3 || now < state.nextAttemptAt) return;

      state.attempts += 1;
      state.nextAttemptAt = now + (8000 * (state.attempts + 1));
      runInScope(scope, () => scope.reload());
    });
  }

  // Keep watching for the lifetime of the trades app. Roblox swaps counter
  // routes without a document reload and can also clear a successful counter
  // controller several seconds after first rendering it.
  setInterval(() => {
    recoverCounter();
    retryFailedPartnerInventories();
  }, 350);
  recoverCounter();
})();

(() => {
  if (window.__TIS_TRADES_LIST_CACHE_RECOVERY__) return;
  window.__TIS_TRADES_LIST_CACHE_RECOVERY__ = true;

  const VALID_STATUSES = new Set(["inbound", "outbound", "completed", "inactive"]);
  let recoveryInFlight = null;
  let lastRecoveryAttempt = "";
  let lastRecoveryAttemptAt = 0;
  const visibleListCacheKeys = new Map();
  const visibleListPayloadKeys = new Map();
  const visibleListPayloadAt = new Map();
  const lastRevalidationStartedAt = new Map();
  const initialPageRevalidation = new Set();
  const nativeListLoadStartedAt = new Map();
  const NATIVE_LIST_GRACE_MS = 6000;
  const firstPartyTradePageRequests = new Map();
  let activeTradeAccountId = "";
  let accountSyncInFlight = null;
  let lastAccountAuthCheckAt = 0;
  let visibleThumbnailSignature = "";
  let visibleAvatarSignature = "";

  function normalizeStatus(status) {
    const value = String(status || "").trim().toLowerCase();
    return VALID_STATUSES.has(value) ? value : null;
  }

  function getTradesListScope() {
    if (!window.angular?.element) return null;
    const root = document.querySelector('[ng-controller="tradesListController"]');
    if (!root) return null;

    try {
      let scope = window.angular.element(root).scope?.() || window.angular.element(root).isolateScope?.() || null;
      for (let depth = 0; scope && depth < 6; depth += 1, scope = scope.$parent) {
        if (scope?.data?.trades && scope?.data?.tradesList && scope?.layout?.selectedTab) return scope;
      }
    } catch {}
    return null;
  }

  function getTradeAccountIdFromPage() {
    const candidates = [
      document.querySelector('meta[name="user-data"]')?.getAttribute("data-userid"),
      document.documentElement?.getAttribute("data-userid"),
      document.querySelector("#rbx-body")?.getAttribute("data-userid"),
      window.Roblox?.CurrentUser?.userId,
      window.Roblox?.CurrentUser?.id,
      window.Roblox?.UserId,
    ];
    for (const candidate of candidates) {
      const id = String(candidate || "");
      if (/^\d+$/.test(id)) return id;
    }
    return "";
  }

  function resetInPageTradeCachesForAccountSwitch() {
    recoveryInFlight = null;
    lastRecoveryAttempt = "";
    lastRecoveryAttemptAt = 0;
    visibleListCacheKeys.clear();
    visibleListPayloadKeys.clear();
    visibleListPayloadAt.clear();
    lastRevalidationStartedAt.clear();
    initialPageRevalidation.clear();
    nativeListLoadStartedAt.clear();
    visibleThumbnailSignature = "";
    visibleAvatarSignature = "";
  }

  function restartCurrentTradeListForAccount(scope, accountId) {
    if (activeTradeAccountId !== accountId) return;
    const tab = scope.layout?.selectedTab;
    if (!tab) return;
    // Re-enter the native tab pipeline after clearing every in-page reference
    // to the previous account. This avoids requiring a browser refresh after
    // Roblox's account switcher changes the authenticated session.
    runInScope(scope, () => {
      if (activeTradeAccountId !== accountId) return;
      scope.data.trades = [];
      scope.data.trade = null;
      if (scope.data.tradesList) {
        scope.data.tradesList.loading = true;
        scope.data.tradesList.noResults = false;
      }
      delete scope.__tisCachedPageSignature;
      delete scope.__tisCachedNextPageCursor;
    });
    setTimeout(() => {
      if (activeTradeAccountId !== accountId || normalizeStatus(scope.layout?.selectedTab?.value) !== normalizeStatus(tab.value)) return;
      scope.selectTab?.(tab);
    }, 0);
  }

  function syncTradeCacheAccount(scope, userId) {
    const id = String(userId || "");
    if (!/^\d+$/.test(id) || id === activeTradeAccountId) return;
    const hadActiveAccount = Boolean(activeTradeAccountId);
    activeTradeAccountId = id;
    if (hadActiveAccount) {
      resetInPageTradeCachesForAccountSwitch();
      window.postMessage({ type: "TIS_TRADE_ACCOUNT_CHANGED", userId: id }, "*");
    }

    const bridge = window.TIS_GENERIC?.bridgeRequest;
    const sync = typeof bridge === "function"
      ? bridge("runtimeSendMessage", { type: "TIS_SYNC_TRADE_CACHE_ACCOUNT", userId: id }, 10000)
      : Promise.resolve({ ok: false });
    accountSyncInFlight = Promise.resolve(sync)
      .catch(() => null)
      .finally(() => {
        accountSyncInFlight = null;
        if (hadActiveAccount) restartCurrentTradeListForAccount(scope, id);
      });
  }

  function watchTradeCacheAccount(scope) {
    const pageUserId = getTradeAccountIdFromPage();
    if (pageUserId) syncTradeCacheAccount(scope, pageUserId);

    // Some Roblox account switches leave the old user id in page markup.
    // A lightweight first-party auth check catches that case without asking
    // the user to reload the trade page.
    const now = Date.now();
    if (now - lastAccountAuthCheckAt < 10000) return;
    lastAccountAuthCheckAt = now;
    fetch("https://users.roblox.com/v1/users/authenticated", {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
      cache: "no-store",
    })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => syncTradeCacheAccount(scope, data?.id))
      .catch(() => {});
  }

  function runInScope(scope, fn) {
    if (!scope || typeof fn !== "function") return;
    if (typeof scope.$applyAsync === "function") {
      scope.$applyAsync(fn);
      return;
    }
    try {
      scope.$apply(fn);
    } catch {
      fn();
    }
  }

  function normalizeTradeSummary(trade, status) {
    if (!trade || typeof trade !== "object") return null;
    const id = String(trade.id || "");
    if (!/^\d+$/.test(id)) return null;

    const user = trade.user && typeof trade.user === "object" ? { ...trade.user } : {};
    user.nameForDisplay ||= user.displayName || user.name || "";
    return {
      ...trade,
      id: Number.isSafeInteger(Number(id)) ? Number(id) : id,
      user,
      tradeStatusType: trade.tradeStatusType || `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`,
    };
  }

  function normalizeTradeDetail(trade, summary) {
    if (!trade || typeof trade !== "object") return null;
    const detail = { ...trade };
    if (!Array.isArray(detail.offers)) {
      detail.offers = [detail.participantAOffer, detail.participantBOffer].filter(Boolean);
    }
    detail.offers.forEach((offer) => {
      (offer?.items || []).forEach((item) => {
        if (item && !item.id) item.id = item.collectibleItemInstanceId;
      });
    });
    detail.id = summary?.id ?? detail.id;
    detail.expiration = summary?.expiration ?? detail.expiration;
    detail.tradeStatusType = summary?.tradeStatusType ?? detail.tradeStatusType;
    detail.user = summary?.user ?? detail.user;
    return detail;
  }

  async function fetchSelectedTradeDetail(tradeId, summary) {
    const id = String(tradeId || "");
    if (!/^\d+$/.test(id)) throw new Error("invalid trade id");
    const bridge = window.TIS_GENERIC?.bridgeRequest;

    if (typeof bridge === "function") {
      try {
        const response = await bridge("runtimeSendMessage", { type: "TIS_FETCH_TRADE_DETAILS", tradeId: id }, 15000);
        if (response?.ok && response.trade) return normalizeTradeDetail(response.trade, summary);
      } catch {}
    }

    // Brave can block Roblox authentication cookies in extension workers even
    // while first-party page requests work.  A selected trade is one explicit
    // request, so use that first-party path rather than leave Roblox's native
    // detail spinner permanently unresolved.
    const fetchFirstParty = window.TIS_FETCH_TRADE_DETAIL_FIRST_PARTY;
    if (typeof fetchFirstParty !== "function") throw new Error("first-party trade queue unavailable");
    const detail = normalizeTradeDetail(await fetchFirstParty(id, true), summary);
    if (typeof bridge === "function" && detail) {
      bridge("runtimeSendMessage", { type: "TIS_STORE_TRADE_DETAILS", tradeId: id, trade: detail }, 10000).catch(() => {});
    }
    return detail;
  }

  function installCachedDetailSelector(scope) {
    if (!scope || scope.__tisCachedDetailSelectorInstalled || typeof scope.selectTrade !== "function") return;
    const nativeSelectTrade = scope.selectTrade;
    scope.__tisCachedDetailSelectorInstalled = true;

    scope.selectTrade = function tisSelectCachedTrade(trade) {
      if (!trade?.id) return nativeSelectTrade.apply(this, arguments);
      runInScope(scope, () => {
        if (scope.data) scope.data.trade = trade;
      });

      fetchSelectedTradeDetail(trade.id, trade)
        .then((detail) => {
          runInScope(scope, () => {
            if (String(scope.data?.trade?.id || "") === String(trade.id)) {
              scope.data.trade = detail;
            }
          });
          setTimeout(hydrateVisibleTradeThumbnails, 150);
        })
        .catch(() => {
          // Keep this selected summary in place and retry through the
          // prioritized queue. Falling back to Roblox here is what leaves its
          // spinner permanently stuck after a rate-limited request.
          setTimeout(() => {
            if (String(scope.data?.trade?.id || "") === String(trade.id)) {
              scope.selectTrade(trade);
            }
          }, 3000);
        });
    };
  }

  function normalizeCachedTradePage(payload, status) {
    const summaries = (Array.isArray(payload?.data) ? payload.data : [])
      .map((trade) => normalizeTradeSummary(trade, status))
      .filter(Boolean);
    if (summaries.some((trade) => !tradeMatchesStatus(trade, status))) {
      throw new Error(`cached ${status} page contains a different trade status`);
    }
    summaries.nextPageCursor = payload?.nextPageCursor ?? null;
    return summaries;
  }

  function getCachedTradePage(status, cursor = "") {
    const bridge = window.TIS_GENERIC?.bridgeRequest;
    if (typeof bridge !== "function") return Promise.reject(new Error("trade cache bridge unavailable"));

    return bridge("runtimeSendMessage", {
      type: "TIS_GET_TRADE_PAGE_CACHE",
      status,
      cursor,
      limit: 25,
      sortOrder: "Desc",
    }, 15000).then((response) => {
      if (!response?.ok || !response.cached || !Array.isArray(response.payload?.data)) {
        throw new Error(response?.error || "trade page is not cached");
      }
      const summaries = normalizeCachedTradePage(response.payload, status);
      // An empty cached root page can be a partial/old failure response. Only
      // a fresh revalidation is allowed to establish a genuine no-results UI.
      if (!cursor && !summaries.length) throw new Error(`empty cached ${status} root page`);
      return summaries;
    });
  }

  function getTradePageSignature(trades) {
    return (Array.isArray(trades) ? trades : []).map((trade) => String(trade?.id || "")).join(",");
  }

  function reconcileTradeListOrder(scope, status) {
    const current = Array.isArray(scope.data?.trades) ? scope.data.trades : [];
    if (current.length < 2) return false;

    // A native first page can arrive after the cached fallback was rendered.
    // Roblox appends that response, yielding old rows followed by new rows.
    // Preserve the server's intended descending-created order and remove
    // overlap without changing any row rendering or pagination UI.
    const unique = [];
    const seen = new Set();
    current.forEach((trade, index) => {
      const id = String(trade?.id || "");
      const key = id || `index:${index}`;
      if (seen.has(key)) return;
      seen.add(key);
      unique.push({ trade, index });
    });
    unique.sort((left, right) => {
      const leftTime = Date.parse(left.trade?.created || "") || 0;
      const rightTime = Date.parse(right.trade?.created || "") || 0;
      return rightTime - leftTime || left.index - right.index;
    });
    const reconciled = unique.map(({ trade }) => trade);
    if (getTradePageSignature(current) === getTradePageSignature(reconciled)) return false;

    runInScope(scope, () => {
      if (normalizeStatus(scope.layout?.selectedTab?.value) === status) {
        scope.data.trades = reconciled;
      }
    });
    return true;
  }

  function tradeMatchesStatus(trade, status) {
    const tradeStatus = normalizeStatus(trade?.tradeStatusType);
    return !tradeStatus || tradeStatus === status;
  }

  function revalidateTradePage(status, force = false, cursor = "") {
    const bridge = window.TIS_GENERIC?.bridgeRequest;
    if (typeof bridge !== "function") return Promise.reject(new Error("trade cache bridge unavailable"));

    const fetchFirstParty = () => {
      const normalizedCursor = String(cursor || "");
      const requestKey = `${status}:${normalizedCursor}`;
      const existing = firstPartyTradePageRequests.get(requestKey);
      if (existing) return existing;

      const request = (async () => {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const url =
              `https://trades.roblox.com/v1/trades/${status}` +
              `?cursor=${encodeURIComponent(normalizedCursor)}` +
              "&limit=25&sortOrder=Desc";
            const response = await fetch(url, {
              method: "GET",
              credentials: "include",
              headers: { accept: "application/json" },
              cache: "no-store",
            });
            if (response.ok) {
              const payload = await response.json();
              const summaries = normalizeCachedTradePage(payload, status);
              bridge("runtimeSendMessage", {
                type: "TIS_STORE_TRADE_PAGE_CACHE",
                status,
                cursor: normalizedCursor,
                limit: 25,
                sortOrder: "Desc",
                payload,
              }, 10000).catch(() => {});
              return summaries;
            }
            lastError = new Error(`trade page http ${response.status}`);
            if (response.status !== 429) throw lastError;
          } catch (error) {
            lastError = error;
            if (!/429/.test(String(error?.message || error))) throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
        throw lastError || new Error("trade page unavailable");
      })().finally(() => firstPartyTradePageRequests.delete(requestKey));
      firstPartyTradePageRequests.set(requestKey, request);
      return request;
    };

    // In the normal Brave profile the page has Roblox's authenticated
    // session while the service worker may not. A fresh page visit must use
    // this one first-party revalidation so old cached outbounds cannot hide
    // newly sent trades.
    if (force) return fetchFirstParty();

    return bridge("runtimeSendMessage", {
      type: "TIS_REVALIDATE_TRADE_PAGE",
      status,
      cursor,
      limit: 25,
      sortOrder: "Desc",
      force,
    }, 15000).then((response) => {
      if (!response?.ok || !Array.isArray(response.payload?.data)) {
        throw new Error(response?.error || "trade page revalidation failed");
      }
      return normalizeCachedTradePage(response.payload, status);
    }).catch(() => fetchFirstParty());
  }

  function renderCachedTradePage(scope, status, summaries) {
    if (!Array.isArray(summaries)) throw new Error("cached trade page is invalid");
    if (summaries.some((trade) => !tradeMatchesStatus(trade, status))) {
      throw new Error(`refusing to render non-${status} trades on this page`);
    }
    runInScope(scope, () => {
      if (normalizeStatus(scope.layout?.selectedTab?.value) !== status) return;
      scope.data.trades = summaries;
      scope.data.trade = null;
      scope.data.tradesList.loading = false;
      scope.data.tradesList.noResults = summaries.length === 0;
      scope.__tisCachedPageSignature = getTradePageSignature(summaries);
      scope.__tisCachedNextPageCursor = summaries.nextPageCursor ?? null;
    });
    window.postMessage({
      type: "TIS_TRADES_LIST_DATA",
      status,
      payload: { data: summaries, nextPageCursor: summaries.nextPageCursor ?? null, previousPageCursor: null },
    }, "*");

    // Native Roblox selects the first row after a list is loaded. Do the same
    // after Angular applies the cached rows so the trade pane (and its item
    // thumbnails) is ready without requiring a manual click.
    const firstTrade = summaries[0];
    if (firstTrade) {
      setTimeout(() => {
        if (normalizeStatus(scope.layout?.selectedTab?.value) !== status) return;
        if (scope.data?.trade || typeof scope.selectTrade !== "function") return;
        scope.selectTrade(firstTrade);
        setTimeout(hydrateVisibleTradeThumbnails, 300);
      }, 0);
    }
  }

  function appendCachedTradePage(scope, status, summaries) {
    if (!Array.isArray(summaries) || summaries.some((trade) => !tradeMatchesStatus(trade, status))) {
      throw new Error(`refusing to append non-${status} trades`);
    }
    const current = Array.isArray(scope.data?.trades) ? scope.data.trades : [];
    const seen = new Set(current.map((trade) => String(trade?.id || "")));
    const additions = summaries.filter((trade) => !seen.has(String(trade?.id || "")));
    const payload = {
      data: summaries,
      nextPageCursor: summaries.nextPageCursor ?? null,
      previousPageCursor: "tis-cache",
    };
    runInScope(scope, () => {
      if (normalizeStatus(scope.layout?.selectedTab?.value) !== status) return;
      scope.data.trades = [...current, ...additions];
      scope.data.tradesList.loading = false;
      scope.__tisCachedNextPageCursor = summaries.nextPageCursor ?? null;

      // ng-repeat creates the added rows during this digest.  Announce the
      // page after that point as well, otherwise a rapid scroll can coalesce
      // the renderer before the later rows exist in the DOM.
      scope.$$postDigest?.(() => {
        window.postMessage({ type: "TIS_TRADES_LIST_DATA", status, payload }, "*");
        setTimeout(() => {
          window.postMessage({ type: "TIS_TRADES_LIST_DATA", status, payload }, "*");
        }, 120);
      });
    });
    window.postMessage({
      type: "TIS_TRADES_LIST_DATA",
      status,
      // The enhancement pipeline merges pages only when this is non-null.
      payload,
    }, "*");
    return additions.length;
  }

  function persistVisibleTradeData(scope) {
    const bridge = window.TIS_GENERIC?.bridgeRequest;
    const status = normalizeStatus(scope.layout?.selectedTab?.value);
    const trades = Array.isArray(scope.data?.trades) ? scope.data.trades : [];
    if (typeof bridge !== "function" || !status || !trades.length) return;
    // Angular changes the selected tab before its next list arrives. Never
    // write those old rows under the new category while that transition is in
    // progress.
    if (trades.some((trade) => !tradeMatchesStatus(trade, status))) return;

    // Roblox may successfully populate Angular's list without issuing a
    // request we can observe.  Feed that authoritative in-page data into the
    // enhancement renderer once per distinct list, so row values do not rely
    // on a second summary request or on a fragile fetch/XHR wrapper.
    const visiblePayloadKey = `${status}:${getTradePageSignature(trades)}`;
    const renderedValueCount = document.querySelectorAll(".trade-row-container .tis-trade-row-values").length;
    const missingVisibleValues = renderedValueCount < trades.length;
    const lastPayloadAt = visibleListPayloadAt.get(status) || 0;
    if (
      visibleListPayloadKeys.get(status) !== visiblePayloadKey ||
      (missingVisibleValues && Date.now() - lastPayloadAt >= 1500)
    ) {
      visibleListPayloadKeys.set(status, visiblePayloadKey);
      visibleListPayloadAt.set(status, Date.now());
      window.postMessage({
        type: "TIS_TRADES_LIST_DATA",
        status,
        payload: {
          data: trades,
          nextPageCursor: scope.__tisCachedNextPageCursor ?? null,
          previousPageCursor: null,
        },
      }, "*");
    }

    const rootPageTrades = trades.length <= 25 ? trades : null;
    const pageKey = rootPageTrades
      ? `${status}:${rootPageTrades.map((trade) => String(trade?.id || "")).join(",")}`
      : "";
    // Cached rows are already persisted. Do not refresh their timestamp just
    // because the page was re-opened; that would prevent revalidation.
    if (rootPageTrades && visibleListCacheKeys.get(status) !== pageKey && scope.__tisCachedPageSignature !== getTradePageSignature(rootPageTrades)) {
      visibleListCacheKeys.set(status, pageKey);
      bridge("runtimeSendMessage", {
        type: "TIS_STORE_TRADE_PAGE_CACHE",
        status,
        cursor: "",
        limit: 25,
        sortOrder: "Desc",
        payload: { data: rootPageTrades, nextPageCursor: null, previousPageCursor: null },
      }, 10000).catch(() => {});
    }

    const detail = scope.data?.trade;
    const detailId = String(detail?.id || detail?.tradeId || "");
    if (/^\d+$/.test(detailId) && (Array.isArray(detail?.offers) || detail?.participantAOffer || detail?.participantBOffer)) {
      bridge("runtimeSendMessage", {
        type: "TIS_STORE_TRADE_DETAILS",
        tradeId: detailId,
        trade: detail,
      }, 10000).catch(() => {});
    }

    setTimeout(hydrateVisibleTradeThumbnails, 100);
    setTimeout(hydrateVisibleTradeAvatars, 100);
  }

  function hydrateVisibleTradeAvatars() {
    const bridge = window.TIS_GENERIC?.bridgeRequest;
    if (typeof bridge !== "function" || !window.angular?.element) return;

    const avatarsByRequestId = new Map();
    document.querySelectorAll(".trade-row thumbnail-2d.avatar-card-image").forEach((avatar) => {
      let targetId = "";
      try {
        targetId = String(window.angular.element(avatar).isolateScope?.()?.$ctrl?.thumbnailTargetId || "");
      } catch {}
      if (!/^\d+$/.test(targetId)) return;
      const requestId = `AvatarHeadshot:${targetId}`;
      const avatars = avatarsByRequestId.get(requestId) || [];
      avatars.push(avatar);
      avatarsByRequestId.set(requestId, avatars);
    });

    const requests = [...avatarsByRequestId.keys()].map((requestId) => ({
      requestId,
      targetId: requestId.split(":")[1],
      type: "AvatarHeadshot",
      size: "150x150",
      format: "Webp",
      isCircular: false,
    }));
    const signature = requests.map((request) => request.requestId).sort().join(",");
    const needsImages = [...avatarsByRequestId.values()].some((avatars) => avatars.some((avatar) => {
      const image = avatar.querySelector(":scope > img.tis-cached-avatar-image");
      return !image || !image.complete || image.naturalWidth === 0;
    }));
    if (!signature || (signature === visibleAvatarSignature && !needsImages)) return;
    visibleAvatarSignature = signature;

    bridge("runtimeSendMessage", {
      type: "TIS_FETCH_ROBLOX_ASSET_THUMBNAILS",
      thumbnailRequests: requests,
    }, 15000).then((response) => {
      if (!response?.ok || !response.thumbnails) return;
      avatarsByRequestId.forEach((avatars, requestId) => {
        const url = String(response.thumbnails[requestId] || "");
        if (!url) return;
        avatars.forEach((avatar) => {
          avatar.classList.add("tis-cached-avatar");
          let image = avatar.querySelector(":scope > img.tis-cached-avatar-image");
          if (!image) {
            image = document.createElement("img");
            image.className = "tis-cached-avatar-image";
            image.alt = "";
            image.decoding = "async";
            image.loading = "eager";
            image.addEventListener("error", () => { visibleAvatarSignature = ""; }, { once: true });
            avatar.appendChild(image);
          }
          if (image.src !== url) image.src = url;
        });
      });
    }).catch(() => {
      visibleAvatarSignature = "";
    });
  }

  function hydrateVisibleTradeThumbnails() {
    const bridge = window.TIS_GENERIC?.bridgeRequest;
    if (typeof bridge !== "function") return;

    const cardsByRequestId = new Map();
    document.querySelectorAll(".trade-item-card .item-card-thumb-container").forEach((thumb) => {
      const host = thumb.querySelector(".thumbnail-2d-container[thumbnail-target-id]");
      const targetId = String(host?.getAttribute("thumbnail-target-id") || "");
      if (!/^\d+$/.test(targetId)) return;
      const type = String(host.getAttribute("thumbnail-type") || "").toLowerCase().includes("bundle")
        ? "BundleThumbnail"
        : "Asset";
      const requestId = `${type}:${targetId}`;
      const cards = cardsByRequestId.get(requestId) || [];
      cards.push(thumb);
      cardsByRequestId.set(requestId, cards);
    });

    const requests = [...cardsByRequestId.keys()].map((requestId) => {
      const [type, targetId] = requestId.split(":");
      return { requestId, type, targetId, size: "150x150", format: "Webp", isCircular: false };
    });
    const signature = requests.map((request) => request.requestId).sort().join(",");
    const needsImages = [...cardsByRequestId.values()].some((thumbs) => thumbs.some((thumb) => {
      const image = thumb.querySelector(":scope > img.tis-thumb-memory-img");
      return !image || !image.complete || image.naturalWidth === 0;
    }));
    if (!signature || (signature === visibleThumbnailSignature && !needsImages)) return;
    visibleThumbnailSignature = signature;

    bridge("runtimeSendMessage", {
      type: "TIS_FETCH_ROBLOX_ASSET_THUMBNAILS",
      thumbnailRequests: requests,
    }, 15000).then((response) => {
      if (!response?.ok || !response.thumbnails) return;
      cardsByRequestId.forEach((thumbs, requestId) => {
        const url = String(response.thumbnails[requestId] || "");
        if (!url) return;
        thumbs.forEach((thumb) => {
          thumb.classList.add("tis-thumb-memory-thumb", "tis-thumb-memory-ready");
          let image = thumb.querySelector(":scope > img.tis-thumb-memory-img");
          if (!image) {
            image = document.createElement("img");
            image.className = "tis-thumb-memory-img";
            image.alt = "";
            image.decoding = "async";
            image.loading = "eager";
            image.addEventListener("error", () => { visibleThumbnailSignature = ""; }, { once: true });
            thumb.appendChild(image);
          }
          if (image.src !== url) image.src = url;
        });
      });
    }).catch(() => {
      visibleThumbnailSignature = "";
    });
  }

  function installCachedListLoader(scope) {
    if (!scope || scope.__tisCachedListLoaderInstalled || typeof scope.selectTab !== "function") return;
    const nativeSelectTab = scope.selectTab;
    const nativeGetNextPage = scope.getNextPage;
    scope.__tisCachedListLoaderInstalled = true;

    scope.selectTab = function tisSelectCachedTradeTab(tab) {
      const status = normalizeStatus(tab?.value);
      // Inbound is the one category whose membership can change, so keep its
      // native refresh path. Every other tab is immutable once received.
      if (!status || status === "inbound" || typeof window.TIS_GENERIC?.bridgeRequest !== "function") {
        return nativeSelectTab.apply(this, arguments);
      }

      runInScope(scope, () => {
        scope.layout.selectedTab = tab;
        scope.data.tradesList.loading = true;
        scope.data.trades = [];
        scope.data.trade = null;
      });
      try {
        const root = document.querySelector('[ng-controller="tradesListController"]');
        const injector = window.angular?.element(root).injector?.() || window.angular?.element(document.body).injector?.();
        const state = injector?.get?.("$state");
        state?.go?.(state.current?.name, { ...state.params, tab: tab.value }, { notify: false, location: true });
      } catch {}
      getCachedTradePage(status)
        .then((summaries) => {
          renderCachedTradePage(scope, status, summaries);
          revalidateCurrentTradePage(scope, status, true);
        })
        .catch(() => revalidateTradePage(status, true)
          .then((summaries) => renderCachedTradePage(scope, status, summaries))
          .catch(() => nativeSelectTab.call(scope, tab)));
    };

    if (typeof nativeGetNextPage === "function") {
      scope.getNextPage = function tisLoadCachedNextTradePage() {
        const status = normalizeStatus(scope.layout?.selectedTab?.value);
        const cursor = String(scope.__tisCachedNextPageCursor || "");
        if (!status || !cursor || typeof window.TIS_GENERIC?.bridgeRequest !== "function") {
          return nativeGetNextPage.apply(this, arguments);
        }
        if (scope.data?.tradesList?.loading) return;
        // Lock synchronously: scroll events can arrive several times before
        // Angular runs the queued $applyAsync callback.
        scope.data.tradesList.loading = true;
        const loadCursor = (pageCursor, allowOneSkip = true) => {
          const appendPage = (page) => {
            const added = appendCachedTradePage(scope, status, page);
            const nextCursor = String(page.nextPageCursor || "");
            if (!added && nextCursor && nextCursor !== pageCursor && allowOneSkip) {
              return loadCursor(nextCursor, false);
            }
            return added;
          };

          // A cursor identifies a historical page.  Show its stored rows
          // immediately when available, then refresh that cache separately.
          // Waiting on Roblox here is what made scrolling look frozen even
          // though the extension already had the exact page to display.
          return getCachedTradePage(status, pageCursor)
            .then((page) => {
              revalidateTradePage(status, true, pageCursor).catch(() => {});
              return appendPage(page);
            })
            .catch(() => revalidateTradePage(status, true, pageCursor).then(appendPage));
        };

        loadCursor(cursor).catch(() => nativeGetNextPage.call(scope));
      };
    }
  }

  function revalidateCurrentTradePage(scope, status, force = false) {
    const now = Date.now();
    const lastStarted = lastRevalidationStartedAt.get(status) || 0;
    if (!force && now - lastStarted < 20 * 1000) return;
    lastRevalidationStartedAt.set(status, now);

    revalidateTradePage(status, force).then((summaries) => {
      if (normalizeStatus(scope.layout?.selectedTab?.value) !== status) return;
      const current = Array.isArray(scope.data?.trades) ? scope.data.trades : [];
      if (getTradePageSignature(current.slice(0, summaries.length)) !== getTradePageSignature(summaries)) {
        renderCachedTradePage(scope, status, summaries);
      } else if (current.length <= summaries.length) {
        // This is the initial/root list only.  Once pagination has appended
        // rows, the root page's cursor points back into data already on
        // screen.  Replacing the continuation cursor with it caused the
        // scroller to keep re-reading duplicate pages and eventually stick.
        runInScope(scope, () => {
          scope.__tisCachedNextPageCursor = summaries.nextPageCursor ?? null;
        });
      }
    }).catch(() => {});
  }

  function recoverCachedTrades(scope) {
    persistVisibleTradeData(scope);
    installCachedDetailSelector(scope);
    installCachedListLoader(scope);

    const status = normalizeStatus(scope.layout?.selectedTab?.value);
    const listState = scope.data?.tradesList;
    const currentTrades = Array.isArray(scope.data?.trades) ? scope.data.trades : [];
    if (status && reconcileTradeListOrder(scope, status)) return;
    // Roblox sets noResults for some failed list loads as well as genuine
    // empty categories.  An empty live array must still be allowed to fall
    // through to cache recovery; otherwise a transient Roblox failure leaves
    // the entire list blank even when we have the last known rows locally.
    if (!status || !listState || currentTrades.length) {
      if (status) {
        nativeListLoadStartedAt.delete(status);
        revalidateCurrentTradePage(scope, status);
      }
      return;
    }

    const now = Date.now();
    const nativeStartedAt = nativeListLoadStartedAt.get(status) || now;
    nativeListLoadStartedAt.set(status, nativeStartedAt);
    // Always let Roblox's fresh root-page request settle before inserting
    // cached rows. Rendering cache during that request makes the native
    // response append its new page underneath stale rows.
    if (!listState.noResults && now - nativeStartedAt < NATIVE_LIST_GRACE_MS) return;

    // Roblox can mark a failed request as no-results. At that point, or once
    // its normal request window has elapsed, cached rows are the fallback.
    if (recoveryInFlight || (lastRecoveryAttempt === status && now - lastRecoveryAttemptAt < 5000)) return;
    lastRecoveryAttempt = status;
    lastRecoveryAttemptAt = now;

    recoveryInFlight = getCachedTradePage(status)
      .then((summaries) => renderCachedTradePage(scope, status, summaries))
      .catch(() => revalidateTradePage(status, true).then((summaries) => renderCachedTradePage(scope, status, summaries)))
      .finally(() => {
        recoveryInFlight = null;
      });
  }

  function checkCachedTrades() {
    if (location.origin !== "https://www.roblox.com" || !/^\/trades\/?$/i.test(location.pathname)) return;
    const scope = getTradesListScope();
    if (!scope) return;
    watchTradeCacheAccount(scope);
    if (accountSyncInFlight) return;
    const status = normalizeStatus(scope.layout?.selectedTab?.value);
    if (status && !initialPageRevalidation.has(status)) {
      initialPageRevalidation.add(status);
      revalidateCurrentTradePage(scope, status, true);
    }
    recoverCachedTrades(scope);
  }

  setInterval(checkCachedTrades, 750);
})();

(() => {
  const TAG = "[tis-rolimons]";
  if (window.__TIS_TRADES_LIST_VALUES__) return;
  window.__TIS_TRADES_LIST_VALUES__ = true;
  const shared = window.TIS_GENERIC || {};
  const getReactTradeItem = shared.getReactTradeItem || (() => null);
  const getExtensionAssetUrl = shared.getExtensionAssetUrl || ((path) => String(path || ""));
  const upsertStyle = shared.upsertStyle || ((id, text) => {
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement("style");
      style.id = id;
    }
    style.textContent = text;
    (document.head || document.documentElement).appendChild(style);
    return style;
  });
  const applyRoliIconStyles = shared.applyRoliIconStyles || ((el) => el);
  const applyRoliValueStyles = shared.applyRoliValueStyles || ((el) => el);
  const renderItemCardRoliValueRow = shared.renderItemCardRoliValueRow || (() => null);
  const formatLimitedSerialBubble = shared.formatLimitedSerialBubble || (() => false);
  const bindLimitedInfoTooltip = shared.bindLimitedInfoTooltip || (() => null);
  const buildTradeDeltaMarkup = shared.buildTradeDeltaMarkup || ((rapDiff, valueDiff) => ({ rowStateClass: "", markup: "" }));
  const bridgeRequest = shared.bridgeRequest || (async () => { throw new Error("bridge unavailable"); });

  const state = {
    data: null, // { [assetId]: { name:string|null, value:number|null, projected:boolean } }
    icon: {
      roli: null,
      proj: null,
      replacement: null,
    },
    scheduled: false,
    roliExactNameMap: null,
    roliNormalizedNameMap: null,
    offerObserver: null,
    offerObserverPanels: [],
    tradeDetailCache: new Map(),
    tradeDetailRequests: new Map(),
    tradeDetailFailedAt: new Map(),
    tradeSummaryCache: new Map(),
    tradeSummaryRequests: new Map(),
    tradeSummaryFailedAt: new Map(),
    rolimonsBadgeCache: new Map(),
    rolimonsBadgeRequests: new Map(),
    tradeRowRenderTimer: null,
    tradeListScrollerRefreshTimer: null,
    tradeListPayloadRenderTimer: null,
    lastTradeRowRenderIdentity: null,
    pendingTradeRowRenderIdentity: null,
    debugRemovalObserver: null,
    nextDebugNodeId: 1,
    debugNodeIds: new WeakMap(),
    hiddenCompletedTrades: new Set(),
    lastKnownTradeListStatus: null,
  };

  const debug = () => {};

  const fmt = (n) => {
    if (n === null || n === undefined) return "-";
    const num = Number(n);
    if (!Number.isFinite(num) || num <= 0) return "-";
    return num.toLocaleString();
  };

  const parseNum = (text) => {
    const cleaned = String(text || "").replace(/[^\d.-]/g, "");
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : 0;
  };

  const setTextIfChanged = (el, text) => {
    if (el && el.textContent !== text) el.textContent = text;
  };

  function setClassPresence(el, className, shouldHaveClass) {
    if (!el || el.classList.contains(className) === shouldHaveClass) return;
    el.classList.toggle(className, shouldHaveClass);
  }

  function getTradeDetailIdFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.origin !== "https://trades.roblox.com") return null;
      return url.pathname.match(/^\/v2\/trades\/(\d+)$/i)?.[1] || null;
    } catch {
      return null;
    }
  }

  function getDebugNodeId(node) {
    if (!node || typeof node !== "object") return "";
    let id = state.debugNodeIds.get(node);
    if (!id) {
      id = state.nextDebugNodeId++;
      state.debugNodeIds.set(node, id);
    }
    return id;
  }

  function normalizeTradeListStatus(status) {
    const normalized = String(status || "").trim().toLowerCase();
    return ["inbound", "outbound", "completed", "inactive"].includes(normalized) ? normalized : null;
  }

  function rememberTradeListStatus(status) {
    const normalized = normalizeTradeListStatus(status);
    if (normalized) state.lastKnownTradeListStatus = normalized;
    return normalized;
  }

  function getMutationElement(node) {
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    return node.parentElement || null;
  }

  function isTisOwnedElement(el) {
    if (!el) return false;

    return Boolean(
      el.id === "tis-roli-style" ||
      el.classList?.contains("tis-roli-row") ||
      el.classList?.contains("tis-proj-icon") ||
      el.classList?.contains("tis-roli-offer-total") ||
      el.classList?.contains("tis-trade-delta") ||
      el.classList?.contains("tis-trade-row-values") ||
      el.classList?.contains("tis-completed-trade-toggle") ||
      el.classList?.contains("tis-completed-trade-date") ||
      el.classList?.contains("tis-roli-verified-badge") ||
      el.closest?.(".tis-roli-row, .tis-roli-offer-total, .tis-trade-delta, .tis-proj-icon, .tis-trade-row-values, .tis-completed-trade-toggle, .tis-completed-trade-date, .tis-roli-verified-badge")
    );
  }

  function mutationBatchNeedsWork(mutations) {
    return mutations.some((mutation) => {
      const targetEl = getMutationElement(mutation.target);
      const targetOwned = isTisOwnedElement(targetEl);
      const hasNodeChanges = mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0;

      if (!targetOwned && !hasNodeChanges) return true;

      for (const node of mutation.addedNodes) {
        if (!isTisOwnedElement(getMutationElement(node))) return true;
      }

      for (const node of mutation.removedNodes) {
        if (!isTisOwnedElement(getMutationElement(node))) return true;
      }

      return !targetOwned && !hasNodeChanges;
    });
  }

  function normalizeRoliName(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function buildRoliNameMaps() {
    const exact = new Map();
    const normalized = new Map();

    for (const info of Object.values(state.data || {})) {
      const rawName = typeof info?.name === "string" ? info.name.trim() : "";
      if (!rawName) continue;

      if (!exact.has(rawName)) exact.set(rawName, info);

      const normalizedName = normalizeRoliName(rawName);
      if (!normalizedName) continue;

      if (!normalized.has(normalizedName)) {
        normalized.set(normalizedName, info);
      } else if (normalized.get(normalizedName) !== info) {
        normalized.set(normalizedName, null);
      }
    }

    state.roliExactNameMap = exact;
    state.roliNormalizedNameMap = normalized;
  }

  function ensureRoliNameMaps() {
    if (!state.roliExactNameMap || !state.roliNormalizedNameMap) {
      buildRoliNameMaps();
    }
  }

  function getValueAtPath(root, path) {
    return path.reduce((value, key) => value?.[key], root);
  }

  function getAngularScopeFromElement(el) {
    if (!el || !window.angular?.element) return null;

    try {
      const ng = window.angular.element(el);
      return ng.scope?.() || ng.isolateScope?.() || null;
    } catch {
      return null;
    }
  }

  function looksLikeTradeItemData(value) {
    if (!value || typeof value !== "object") return false;

    return Boolean(
      value.itemTarget?.targetId ||
      value.assetId ||
      value.asset?.id ||
      value.details?.assetId ||
      value.collectibleItemDetails?.assetId ||
      value.itemDetails?.assetId ||
      value.itemName ||
      value.collectibleItemId ||
      value.collectibleItemInstanceId ||
      (value.name && (value.itemType || value.assetType || value.collectibleItemId || value.collectibleItemInstanceId))
    );
  }

  function getTradeItemDataFromScope(scope) {
    const candidatePaths = [
      ["tradableItem"],
      ["slot", "tradableItem"],
      ["item"],
      ["tradeItem"],
      ["offerItem"],
      ["data", "tradableItem"],
      ["data", "slot", "tradableItem"],
      ["data", "item"],
      ["data", "offerItem"],
      ["$ctrl", "tradableItem"],
      ["$ctrl", "slot", "tradableItem"],
      ["$ctrl", "item"],
      ["$ctrl", "offerItem"],
    ];

    let current = scope;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.$parent) {
      for (const path of candidatePaths) {
        const candidate = getValueAtPath(current, path);
        if (looksLikeTradeItemData(candidate)) return candidate;
      }
    }

    return null;
  }

  function getTradeItemDataFromElement(element) {
    if (!element) return null;

    const reactItem = getReactTradeItem(element);
    if (reactItem) return reactItem;

    const candidates = [
      element,
      element.querySelector?.(".item-card-thumb-container"),
      element.querySelector?.(".thumbnail-2d-container"),
      element.querySelector?.('[ng-click*="root.onItemCardClick"]'),
      element.querySelector?.("[ng-click]"),
    ].filter(Boolean);

    for (const candidate of candidates) {
      const itemData = getTradeItemDataFromScope(getAngularScopeFromElement(candidate));
      if (itemData) return itemData;
    }

    return null;
  }

  function getAssetIdFromTradeItemData(itemData) {
    const candidates = [
      itemData?.itemTarget?.targetId,
      itemData?.assetId,
      itemData?.asset?.id,
      itemData?.details?.assetId,
      itemData?.collectibleItemDetails?.assetId,
      itemData?.itemDetails?.assetId,
    ];

    for (const candidate of candidates) {
      const value = String(candidate || "");
      if (/^\d+$/.test(value)) return value;
    }

    return null;
  }

  function getItemNameFromTradeItemData(itemData) {
    return String(
      itemData?.itemName ||
      itemData?.name ||
      itemData?.assetName ||
      itemData?.asset?.name ||
      ""
    ).trim();
  }

  function isBundleTradeItemData(itemData) {
    const type = String(
      itemData?.itemTarget?.itemType ||
      itemData?.itemType ||
      itemData?.assetType ||
      ""
    ).trim().toLowerCase();

    return type === "bundle";
  }

  function getRoliInfoByName(name) {
    const rawName = String(name || "").trim();
    if (!rawName || !state.data) return null;

    ensureRoliNameMaps();

    const exact = state.roliExactNameMap.get(rawName);
    if (exact) return exact;

    const normalizedName = normalizeRoliName(rawName);
    if (!normalizedName) return null;

    return state.roliNormalizedNameMap.get(normalizedName) || null;
  }

  function ensureStyles() {
    const css = `
      .tis-roli-offer-total .tis-roli-total-value{
        color:#05bce4 !important;
        font-weight:600;
        text-shadow:0 1px 1px rgba(0,0,0,.55);
      }
      .tis-roli-offer-total{
        min-height:22px;
      }
      .tis-roli-offer-total .icon-rolimons{
        display:inline-block;
        background-size:cover;
        width:19px;
        height:19px;
        margin-right:6px;
        transform:translateY(1px);
        background-color:transparent;
      }
      .tis-trade-delta{
        margin:12px auto 10px;
        text-align:center;
        min-height:92px;
      }
      .tis-trade-delta-detail{
        width:100%;
      }
      .tis-trade-delta-composer{
        width:100%;
        margin:0 auto 10px;
      }
      .tis-trade-delta-grid{
        display:grid;
        grid-template-columns:repeat(2, minmax(0, 1fr));
        gap:14px;
        width:100%;
      }
      .tis-trade-delta-box{
        border:1px solid rgba(255,255,255,.16);
        border-radius:14px;
        padding:16px 18px;
        background:rgba(0,0,0,.22);
      }
      .tis-trade-delta-box-single{
        max-width:520px;
        margin:0 auto;
      }
      .tis-trade-delta-label{
        display:block;
        font-size:15px;
        font-weight:700;
        letter-spacing:.08em;
        margin-bottom:8px;
        opacity:.95;
      }
      .tis-trade-delta-main{
        display:block;
        font-size:34px;
        font-weight:800;
        line-height:1.05;
      }
      .tis-trade-delta-arrow{
        margin-right:8px;
      }
      .tis-trade-delta-gain{
        color:#5fd67a;
      }
      .tis-trade-delta-loss{
        color:#ff6b6b;
      }
      .tis-trade-delta-even{
        color:#ffffff;
      }

      .tis-roli-row{
        display:flex;
        align-items:center;
        gap:0;
        margin-top:1px;
        min-height:17px;
        padding-bottom:0;
        opacity:.95;
        }
        
      .tis-roli-icon{
        width:14px;
        height:14px;
        flex:0 0 14px;
      }
      .tis-roli-value{
        color:#05bce4;
        font-weight:600;
        text-shadow:0 1px 1px rgba(0,0,0,.55);
      }
      .tis-proj-icon{
        position:absolute;
        left:6px;
        top:6px;
        width:20px;
        height:20px;
        z-index:6;
        pointer-events:none;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,.6));
      }
      .trade-sent-date.tis-trade-row-date{
        display:inline-flex;
        flex-direction:column;
        align-items:flex-start;
        justify-content:flex-start;
        vertical-align:top;
        box-sizing:border-box;
        min-width:88px;
        max-width:88px;
        padding:2px 0;
        white-space:normal;
      }
      .tis-trade-row-date-text{
        display:block;
        font-size:13px;
        line-height:1.2;
        width:100%;
        max-width:100%;
        text-align:left;
      }
      .tis-trade-row-values{
        display:block;
        margin-top:6px;
        margin-left:0;
        padding-top:0;
        text-align:left;
        font-size:15px;
        font-weight:700;
        line-height:1.2;
        white-space:normal;
        width:100%;
        max-width:100%;
      }
      .tis-trade-row-values .tis-line{
        display:block;
        width:100%;
        max-width:100%;
        text-align:left;
      }
      .tis-trade-row-values-gain{
        color:#5fd67a;
      }
      .tis-trade-row-values-loss{
        color:#ff6b6b;
      }
      .tis-trade-row-values-even{
        color:#ffffff;
      }
      .trade-row-container.tis-completed-trade-row{
        position:relative;
        overflow:visible;
        padding-left:18px;
      }
      .tis-completed-trade-toggle{
        position:absolute;
        left:14px;
        top:50%;
        z-index:10;
        width:16px;
        height:16px;
        border:0;
        border-radius:50%;
        background:rgba(0,0,0,.7);
        color:#ffffff;
        font:700 12px/16px Builder Sans, Helvetica Neue, Helvetica, Arial, sans-serif;
        text-align:center;
        padding:0;
        cursor:pointer;
        box-shadow:0 1px 3px rgba(0,0,0,.4);
        transform:translate(-50%, -50%);
      }
      .tis-completed-trade-toggle:hover{
        background:rgba(0,0,0,.9);
      }
      .trade-row-container.tis-completed-trade-hidden .trade-row-details > div > :not(.avatar){
        filter:blur(9px);
        user-select:none;
        pointer-events:none;
      }
      .trade-row-container.tis-completed-trade-hidden .trade-row-details > div > :not(.avatar) *{
        filter:none;
      }
      .trade-row-container.tis-completed-trade-hidden .avatar,
      .trade-row-container.tis-completed-trade-hidden .avatar *{
        filter:none !important;
      }
      .trade-row-container.tis-completed-trade-hidden .avatar img{
        filter:none !important;
        opacity:1 !important;
      }
      .tis-completed-trade-date{
        display:block;
        margin:-4px 0 14px;
        color:#b8b8b8;
        font-size:14px;
        line-height:1.35;
      }
      .tis-roli-verified-badge{
        display:inline-block;
        width:14px;
        height:14px;
        margin-left:5px;
        vertical-align:-2px;
        background-repeat:no-repeat;
        background-position:center center;
        background-size:14px 14px;
        text-decoration:none;
      }
    /* stop the "stackable" overlap behavior */
    .trade-inventory-panel .hlist.item-cards-stackable,
    .trades-list-detail .hlist.item-cards-stackable{
    row-gap: 18px !important;          /* space between rows */
    }

    /* roblox often sets weird margins/positioning on list items for stacking */
    .trade-inventory-panel .hlist.item-cards-stackable > li,
    .trade-inventory-panel .hlist.item-cards-stackable > .list-item,
    .trades-list-detail .hlist.item-cards-stackable > li,
    .trades-list-detail .hlist.item-cards-stackable > .list-item{
    margin-top: 0 !important;
    margin-bottom: 0 !important;
    top: auto !important;
    transform: none !important;
    overflow: visible !important;
    height: auto !important;
    }

    /* make sure the card can actually grow to fit the extra line */
    .trade-inventory-panel .item-card-container,
    .trade-inventory-panel .item-card-container .item-card-link,
    .trade-inventory-panel .item-card-container .item-card-caption,
    .trades-list-detail .item-card-container,
    .trades-list-detail .item-card-container .item-card-link,
    .trades-list-detail .item-card-container .item-card-caption{
    height: auto !important;
    overflow: visible !important;
    }

    .trade-inventory-panel .item-card-caption,
    .trades-list-detail .item-card-caption{
    display:flex !important;
    flex-direction:column !important;
    align-items:flex-start !important;
    justify-content:flex-start !important;
    }

    .trade-inventory-panel .item-card-caption .item-card-name-link,
    .trades-list-detail .item-card-caption .item-card-name-link{
    display:block !important;
    width:100% !important;
    min-height:34px !important;
    margin-bottom:2px !important;
    }

    .trade-inventory-panel .item-card-caption .item-card-name,
    .trades-list-detail .item-card-caption .item-card-name{
    line-height:1.2 !important;
    max-height:2.2em !important;
    overflow:hidden !important;
    }

    .trade-inventory-panel .item-card-caption .item-card-price,
    .trades-list-detail .item-card-caption .item-card-price{
    display:flex !important;
    align-items:center !important;
    gap:0 !important;
    min-height:17px !important;
    margin-top:1px !important;
    width:100% !important;
    overflow:visible !important;
    }

    .trade-inventory-panel .item-card-price .text-robux,
    .trade-inventory-panel .tis-roli-value,
    .trades-list-detail .item-card-price .text-robux,
    .trades-list-detail .tis-roli-value{
    line-height:1 !important;
    }

    .trade-inventory-panel .item-card-caption .item-card-price .icon-robux-16x16,
    .trades-list-detail .item-card-caption .item-card-price .icon-robux-16x16{
    transform:translateX(-4px) !important;
    }

    /* keep your pager safety padding (tweak number if needed) */
    .trade-inventory-panel .hlist.item-cards-stackable,
    .trades-list-detail .hlist.item-cards-stackable{
    padding-bottom: 1px !important;
    }

    `;
    upsertStyle("tis-roli-style", css);
  }

  function getOfferPanels() {
    if (isTradesListPage()) {
      const detailRoot = getActiveTradeDetailRoot();
      if (!detailRoot) return [];
      return Array.from(detailRoot.querySelectorAll(".trade-list-detail-offer"));
    }

    const composerRoot = getActiveComposerRoot();
    if (!composerRoot) return [];
    return Array.from(composerRoot.querySelectorAll(".trade-request-window-offer"));
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.classList?.contains("ng-hide")) return false;

    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.getClientRects().length > 0;
  }

  function getActiveTradeDetailRoot() {
    const roots = Array.from(document.querySelectorAll(".trades-list-detail > div[ng-if], .trades-list-detail > .ng-scope, .trades-list-detail"));
    return roots.find((root) => isElementVisible(root) && root.querySelector(".trade-list-detail-offer")) || null;
  }

  function getActiveComposerRoot() {
    const roots = Array.from(document.querySelectorAll(".trade-request-window"));
    return roots.find((root) => isElementVisible(root) && root.querySelector(".trade-request-window-offer")) || null;
  }

  function getNativeTotalLine(panel) {
    if (!panel) return null;

    const lines = Array.from(panel.querySelectorAll(".robux-line:not(.tis-roli-offer-total)"));
    return lines[lines.length - 1] || null;
  }

  function renameNativeRapLabel(panel) {
    const totalLine = getNativeTotalLine(panel);
    const lead = totalLine?.querySelector(".text-lead");
    setTextIfChanged(lead, "total rap:");
    return totalLine;
  }

  function getAssetIdFromOfferItem(item) {
    const scopedAssetId = getAssetIdFromTradeItemData(getTradeItemDataFromElement(item));
    if (scopedAssetId) return scopedAssetId;

    const thumb = item.querySelector(".thumbnail-2d-container[thumbnail-target-id]");
    const tid = thumb?.getAttribute("thumbnail-target-id");
    if (tid && /^\d+$/.test(String(tid))) return String(tid);

    const href = item.querySelector("a[href]")?.getAttribute("href") || "";
    const m = href.match(/\/(?:catalog|bundles)\/(\d+)(?:\/|$)/);
    if (m) return m[1];

    return null;
  }

  function getItemNameFromOfferItem(item) {
    return getItemNameFromTradeItemData(getTradeItemDataFromElement(item)) || (
      item.querySelector(".item-name a")?.textContent ||
      item.querySelector(".item-name")?.getAttribute("title") ||
      item.querySelector(".item-name")?.textContent ||
      item.querySelector(".item-card-name")?.textContent ||
      item.querySelector(".item-card-name-link")?.textContent ||
      ""
    ).trim();
  }

  function isBundleOfferItem(item) {
    if (isBundleTradeItemData(getTradeItemDataFromElement(item))) return true;

    const thumbType = item.querySelector(".thumbnail-2d-container")?.getAttribute("thumbnail-type");
    if (thumbType === "BundleThumbnail") return true;

    const href = item.querySelector("a[href]")?.getAttribute("href") || "";
    return /\/bundles\//.test(href);
  }

  function getRoliInfoFromOfferItem(item) {
    const assetId = getAssetIdFromOfferItem(item);
    if (assetId) {
      const info = state.data?.[assetId];
      if (info) return info;
    }

    if (isBundleOfferItem(item)) {
      return getRoliInfoByName(getItemNameFromOfferItem(item));
    }

    return null;
  }

  function getRapFromOfferItem(item) {
    const reactRap = Number(getTradeItemDataFromElement(item)?.recentAveragePrice);
    if (Number.isFinite(reactRap) && reactRap >= 0) return reactRap;
    return parseNum(
      item.querySelector(".item-card-price .text-robux")?.textContent ||
      item.querySelector(".item-card-price")?.textContent ||
      item.querySelector(".item-value .text-robux")?.textContent ||
      item.querySelector(".item-value")?.textContent ||
      "0"
    );
  }

  function getOfferValueFromItem(item) {
    const rap = getRapFromOfferItem(item);
    const roliValue = Number(getRoliInfoFromOfferItem(item)?.value);
    return Number.isFinite(roliValue) && roliValue > 0 ? roliValue : rap;
  }

  function getOfferRapFromItem(item) {
    return getRapFromOfferItem(item);
  }

  function getRoliInfoFromTradableItem(item) {
    const targetId = item?.itemTarget?.targetId;
    if (targetId) {
      const info = state.data?.[String(targetId)];
      if (info) return info;
    }

    if (item?.itemTarget?.itemType === "Bundle") {
      return getRoliInfoByName(item?.itemName);
    }

    return null;
  }

  function getOfferValueFromTradableItem(item) {
    const rap = Number(item?.recentAveragePrice ?? 0) || 0;
    const roliValue = Number(getRoliInfoFromTradableItem(item)?.value);
    return Number.isFinite(roliValue) && roliValue > 0 ? roliValue : rap;
  }

  function getRobuxFromPanelScope(panel) {
    let current = getAngularScopeFromElement(panel);
    const candidatePaths = [
      ["offer", "robux"],
      ["$ctrl", "offer", "robux"],
      ["tradeOffer", "robux"],
      ["data", "offer", "robux"],
      ["inventoryData", "offer", "robux"],
    ];

    for (let depth = 0; current && depth < 8; depth += 1, current = current.$parent) {
      for (const path of candidatePaths) {
        const value = parseNum(getValueAtPath(current, path) || "0");
        if (value > 0) return value;
      }
    }

    return 0;
  }

  function getRobuxFromPanel(panel) {
    const inputValue = parseNum(panel.querySelector('input[name="robux"]')?.value || "0");
    if (inputValue > 0) return inputValue;
    return getRobuxFromPanelScope(panel);
  }

  function computeOfferTotals(panel) {
    const items = panel.querySelectorAll(
      ".trade-request-item:not(.blank-item), .item-card-container[data-collectibleiteminstanceid]"
    );
    let rap = getRobuxFromPanel(panel);
    let value = rap;

    items.forEach((item) => {
      rap += getOfferRapFromItem(item);
      value += getOfferValueFromItem(item);
    });

    return { rap, value };
  }

  function getCurrentUserId() {
    const metaUserId =
      document.querySelector('meta[name="user-data"]')?.getAttribute("data-userid") ||
      document.documentElement?.getAttribute("data-userid") ||
      "";
    return /^\d+$/.test(String(metaUserId)) ? Number(metaUserId) : null;
  }

  function computeTradeOfferTotalFromData(offer) {
    let total = Number(offer?.robux ?? 0) || 0;
    const items = Array.isArray(offer?.items) ? offer.items : [];
    items.forEach((item) => {
      total += getOfferValueFromTradableItem(item);
    });
    return total;
  }

  function getTradeId(trade) {
    const raw = trade?.id;
    const id = String(raw || "");
    return /^\d+$/.test(id) ? id : null;
  }

  function getTradeUserId(trade) {
    const raw = trade?.user?.id ?? trade?.userId;
    const userId = String(raw || "");
    return /^\d+$/.test(userId) ? userId : null;
  }

  function getTradeDisplayName(trade) {
    const name =
      trade?.user?.nameForDisplay ??
      trade?.user?.displayName ??
      trade?.user?.name ??
      "";
    const normalized = String(name || "").trim();
    return normalized || null;
  }

  function looksLikeTradeSummary(trade) {
    return Boolean(
      getTradeId(trade) &&
      (
        trade?.user?.id ||
        trade?.userId ||
        trade?.created ||
        Array.isArray(trade?.offers)
      )
    );
  }

  function findTradeOnScopeChain(scope) {
    let current = scope;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.$parent) {
      if (looksLikeTradeSummary(current?.trade)) return current.trade;
      if (looksLikeTradeSummary(current?.data?.trade)) return current.data.trade;
    }
    return null;
  }

  function getTradeFromRow(row) {
    if (!row) return null;

    const candidates = [
      row.closest(".trade-row"),
      row,
      row.querySelector?.(".trade-row-details"),
      row.querySelector?.(".trade-sent-date"),
      row.querySelector?.(".text-lead"),
    ].filter(Boolean);

    for (const candidate of candidates) {
      const trade = findTradeOnScopeChain(getAngularScopeFromElement(candidate));
      if (trade) return trade;
    }

    return null;
  }

  function getTradeUserIdFromRow(row) {
    const href =
      row?.querySelector?.(".avatar-card-link")?.getAttribute("href") ||
      row?.querySelector?.(".avatar-card-link")?.href ||
      "";
    const match = String(href).match(/\/users\/(\d+)\/profile/i);
    return match?.[1] || null;
  }

  function getTradeDisplayNameFromRow(row) {
    const name = row?.querySelector?.(".text-lead")?.textContent || "";
    const normalized = String(name || "").trim();
    return normalized || null;
  }

  function buildTradeSummaryMap(items) {
    const map = new Map();
    (Array.isArray(items) ? items : []).forEach((trade) => {
      const tradeId = getTradeId(trade);
      if (tradeId && !map.has(tradeId)) map.set(tradeId, trade);
    });
    return map;
  }

  function tradeSummaryMatchesContext(context, trade) {
    if (!context || !trade) return false;

    const contextTradeId = String(context.tradeId || "");
    const tradeId = String(getTradeId(trade) || "");
    if (contextTradeId && tradeId) return contextTradeId === tradeId;

    let matched = false;

    const contextDomUserId = String(context.domUserId || "");
    const tradeUserId = String(getTradeUserId(trade) || "");
    if (contextDomUserId && tradeUserId) {
      if (contextDomUserId !== tradeUserId) return false;
      matched = true;
    }

    const contextDomName = String(context.domName || "");
    const tradeName = String(getTradeDisplayName(trade) || "");
    if (contextDomName && tradeName) {
      if (contextDomName !== tradeName) return false;
      matched = true;
    }

    const contextUserId = String(context?.trade?.user?.id ?? context?.trade?.userId ?? "");
    if (contextUserId && tradeUserId) {
      if (contextUserId !== tradeUserId) return false;
      matched = true;
    }

    const contextCreated = String(context?.trade?.created || "");
    const tradeCreated = String(trade?.created || "");
    if (contextCreated && tradeCreated) {
      if (contextCreated !== tradeCreated) return false;
      matched = true;
    }

    return matched;
  }

  function cacheMatchesVisibleContexts(cached, contexts) {
    if (!Array.isArray(cached) || !Array.isArray(contexts) || cached.length < contexts.length) return false;
    return contexts.every((context, index) => {
      const trade = cached[index];
      return tradeSummaryMatchesContext(context, trade);
    });
  }

  function resolveSummaryTradeForContext(context, summaries, summaryMap) {
    if (context?.tradeId) {
      const exactMatch = summaryMap.get(context.tradeId);
      if (exactMatch) return exactMatch;
    }

    const contextUserId = Number(context?.trade?.user?.id ?? context?.trade?.userId ?? 0) || null;
    const contextCreated = String(context?.trade?.created || "");
    if (contextUserId || contextCreated) {
      const matchedTrade = (Array.isArray(summaries) ? summaries : []).find((trade) => {
        const tradeUserId = Number(trade?.user?.id ?? trade?.userId ?? 0) || null;
        const tradeCreated = String(trade?.created || "");
        if (context?.tradeId && getTradeId(trade) === context.tradeId) return true;
        if (contextUserId && tradeUserId && contextUserId !== tradeUserId) return false;
        if (contextCreated && tradeCreated && contextCreated !== tradeCreated) return false;
        return Boolean(tradeUserId || tradeCreated);
      });
      if (matchedTrade) return matchedTrade;
    }

    if (context?.domUserId || context?.domName) {
      const domMatchedTrades = (Array.isArray(summaries) ? summaries : []).filter((trade) => {
        const tradeUserId = getTradeUserId(trade);
        const tradeName = getTradeDisplayName(trade);
        if (context.domUserId && tradeUserId && context.domUserId !== tradeUserId) return false;
        if (context.domName && tradeName && context.domName !== tradeName) return false;
        return Boolean(tradeUserId || tradeName);
      });

      if (domMatchedTrades.length === 1) return domMatchedTrades[0];
      if (domMatchedTrades.length > 1) {
        const indexedMatch = domMatchedTrades.find((trade) => summaries?.[context?.index ?? -1] === trade);
        if (indexedMatch) return indexedMatch;
      }
    }

    const indexedTrade = summaries?.[context?.index ?? -1] || null;
    if (indexedTrade) {
      return indexedTrade;
    }

    return null;
  }

  function normalizeTradeDetail(trade) {
    if (!trade || typeof trade !== "object") return null;
    if (!Array.isArray(trade.offers)) {
      trade.offers = [trade?.participantAOffer, trade?.participantBOffer].filter(Boolean);
    }
    return trade;
  }

  function storeTradeDetail(tradeId, trade, source = "unknown") {
    const id = String(tradeId || "");
    const normalizedTrade = normalizeTradeDetail(trade);
    if (!/^\d+$/.test(id) || !normalizedTrade) return false;

    state.tradeDetailCache.set(id, normalizedTrade);
    state.tradeDetailRequests.delete(id);
    state.tradeDetailFailedAt.delete(id);
    debug("stored trade detail", {
      tradeId: id,
      source,
      hasOffers: Array.isArray(normalizedTrade?.offers),
      offerCount: Array.isArray(normalizedTrade?.offers) ? normalizedTrade.offers.length : 0,
    });
    state.lastTradeRowRenderIdentity = null;
    state.pendingTradeRowRenderIdentity = null;
    // Details commonly arrive in a group.  Coalesce those updates instead of
    // rescanning every row once per response; repeated full rescans were able
    // to starve the later batches on a large list.
    scheduleTradeRowValuesRender(`trade-detail-${source}`, hasVisibleTradeRowCards() ? 60 : 20);
    return true;
  }

  function computeTradeRowTotals(summaryTrade, sourceTrade = summaryTrade) {
    const offers = Array.isArray(sourceTrade?.offers) ? sourceTrade.offers : [];
    if (!offers.length) return null;

    const currentUserId = getCurrentUserId();
    const partnerId = Number(summaryTrade?.user?.id ?? sourceTrade?.user?.id ?? 0) || null;

    let givingOffer =
      offers.find((offer) => Number(offer?.user?.id ?? offer?.userId ?? 0) === currentUserId) ||
      offers.find((offer) => offer?.isMyOffer === true) ||
      null;
    let receivingOffer =
      offers.find((offer) => Number(offer?.user?.id ?? offer?.userId ?? 0) !== currentUserId) ||
      offers.find((offer) => offer?.isMyOffer === false) ||
      null;

    if ((!givingOffer || !receivingOffer) && partnerId) {
      receivingOffer = offers.find((offer) => Number(offer?.user?.id ?? offer?.userId ?? 0) === partnerId) || receivingOffer;
      givingOffer = offers.find((offer) => Number(offer?.user?.id ?? offer?.userId ?? 0) !== partnerId) || givingOffer;
    }

    givingOffer ||= offers[0];
    receivingOffer ||= offers.find((offer) => offer !== givingOffer) || offers[1];
    if (!givingOffer || !receivingOffer) return null;

    const giving = computeTradeOfferTotalFromData(givingOffer);
    const receiving = computeTradeOfferTotalFromData(receivingOffer);
    const difference = receiving - giving;

    return { giving, receiving, difference };
  }

  function formatRelativeTime(dateInput) {
    const when = new Date(dateInput);
    const ts = when.getTime();
    if (!Number.isFinite(ts)) return null;

    const diffMs = Math.max(0, Date.now() - ts);
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;

    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;

    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;

    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? "" : "s"} ago`;
  }

  function formatDayMonthYear(dateInput) {
    const when = new Date(dateInput);
    const ts = when.getTime();
    if (!Number.isFinite(ts)) return null;

    const day = String(when.getDate()).padStart(2, "0");
    const month = String(when.getMonth() + 1).padStart(2, "0");
    const year = String(when.getFullYear());
    return `${day}/${month}/${year}`;
  }

  function getTradeCompletedDateInput(...trades) {
    for (const trade of trades) {
      if (!trade || typeof trade !== "object") continue;

      const value =
        trade.completed ??
        trade.completedAt ??
        trade.completedOn ??
        trade.updated ??
        trade.updatedAt ??
        trade.created ??
        null;

      if (value && formatDayMonthYear(value)) return value;
    }

    return null;
  }

  function getTradesListTab() {
    if (location.origin !== "https://www.roblox.com") return null;

    const pathStatus = String(location.pathname || "").match(/^\/trades\/([^/]+)\/?$/i)?.[1]?.toLowerCase() || null;
    const normalizedPathStatus = rememberTradeListStatus(pathStatus);
    if (normalizedPathStatus) {
      return normalizedPathStatus;
    }

    if (location.pathname !== "/trades") return null;

    const tab = new URLSearchParams(location.search).get("tab");
    const normalized = rememberTradeListStatus(tab);
    if (normalized) return normalized;

    const dropdownLabel =
      document.querySelector(".trade-row-list .trade-list-dropdown .rbx-selection-label")?.getAttribute("title") ||
      document.querySelector(".trade-row-list .trade-list-dropdown .rbx-selection-label")?.textContent ||
      "";
    const dropdownNormalized = rememberTradeListStatus(dropdownLabel);
    if (dropdownNormalized) {
      return dropdownNormalized;
    }

    return state.lastKnownTradeListStatus;
  }

  function getRemovedInjectedElement(node) {
    const targets = ".tis-roli-offer-total, .tis-trade-delta, .tis-trade-row-values, .tis-completed-trade-toggle";
    const el = getMutationElement(node);
    if (!el) return null;
    if (el.matches?.(targets)) return el;
    return el.querySelector?.(targets) || null;
  }

  function getRemovalParentClass(mutation) {
    const parent = mutation?.target;
    if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return "";
    const className = parent.getAttribute?.("class") || "";
    const id = parent.getAttribute?.("id") || "";
    return [parent.tagName?.toLowerCase?.() || "", id ? `#${id}` : "", className ? `.${String(className).trim().replace(/\s+/g, ".")}` : ""].join("");
  }

  function observeInjectedRemovalDebug() {
    if (state.debugRemovalObserver) return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.removedNodes.forEach((node) => {
          const removed = getRemovedInjectedElement(node);
          if (!removed) return;

          const parentClass = getRemovalParentClass(mutation);
          const record = {
            removedClass: removed.getAttribute?.("class") || "",
            removedTag: removed.tagName?.toLowerCase?.() || "",
            removedNodeId: getDebugNodeId(removed),
            parentClass,
            parentNodeId: getDebugNodeId(mutation.target),
            reason: "mutation-removed-node",
            timestamp: new Date().toISOString(),
            href: location.href,
          };
          console.debug("[tis-removal-debug]", record);
        });
      });
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    state.debugRemovalObserver = observer;
  }

  function isTradesListPage() {
    return location.origin === "https://www.roblox.com" && (
      location.pathname === "/trades" ||
      /^\/trades\/(?:inbound|outbound|completed|inactive)\/?$/i.test(location.pathname)
    );
  }

  function getTradeRowListScrollerParts() {
    const rowList = document.querySelector(".trade-row-list");
    if (!rowList) return { rowList: null, scrollerRoot: null, scrollHost: null, simplebarRoot: null };

    const scrollerRoot =
      rowList.querySelector("#trade-row-scroll-container") ||
      rowList.querySelector("[data-simplebar]") ||
      rowList.querySelector("[data-toggle='scrollbar']") ||
      null;

    const scrollHost =
      scrollerRoot?.querySelector(".simplebar-content-wrapper") ||
      rowList.querySelector("#trade-row-scroll-container .simplebar-content-wrapper") ||
      rowList.querySelector(".simplebar-content-wrapper") ||
      null;

    const simplebarRoot =
      scrollerRoot?.matches?.("[data-simplebar]") ? scrollerRoot :
      scrollerRoot?.closest?.("[data-simplebar]") ||
      scrollHost?.closest?.("[data-simplebar]") ||
      null;

    return { rowList, scrollerRoot, scrollHost, simplebarRoot };
  }

  function forceTradeRowListScrollerRefresh(reason = "unknown") {
    if (!isTradesListPage()) return;

    const { rowList, scrollerRoot, scrollHost, simplebarRoot } = getTradeRowListScrollerParts();
    if (!rowList) return;

    const recalcTargets = [simplebarRoot, scrollerRoot, scrollHost, rowList].filter(Boolean);
    const seen = new Set();
    const tryRecalculate = (target) => {
      if (!target || seen.has(target)) return false;
      seen.add(target);

      try {
        if (typeof target.SimpleBar?.recalculate === "function") {
          target.SimpleBar.recalculate();
          return true;
        }
      } catch {}

      try {
        if (typeof target.simplebar?.recalculate === "function") {
          target.simplebar.recalculate();
          return true;
        }
      } catch {}

      try {
        if (typeof target.__simplebar?.recalculate === "function") {
          target.__simplebar.recalculate();
          return true;
        }
      } catch {}

      try {
        const instance = window.SimpleBar?.instances?.get?.(target);
        if (typeof instance?.recalculate === "function") {
          instance.recalculate();
          return true;
        }
      } catch {}

      return false;
    };

    rowList.getBoundingClientRect();
    scrollerRoot?.getBoundingClientRect();
    scrollHost?.getBoundingClientRect();

    let recalculated = false;
    recalcTargets.forEach((target) => {
      if (tryRecalculate(target)) recalculated = true;
    });

    if (!recalculated) {
      window.dispatchEvent(new Event("resize"));
    }

    debug("trade row list scroller refreshed", {
      reason,
      hasRowList: Boolean(rowList),
      hasScrollerRoot: Boolean(scrollerRoot),
      hasScrollHost: Boolean(scrollHost),
      hasSimplebarRoot: Boolean(simplebarRoot),
      recalculated,
    });
  }

  function scheduleTradeRowListScrollerRefresh(reason = "unknown", delay = 0) {
    clearTimeout(state.tradeListScrollerRefreshTimer);
    state.tradeListScrollerRefreshTimer = setTimeout(() => {
      state.tradeListScrollerRefreshTimer = null;
      requestAnimationFrame(() => {
        forceTradeRowListScrollerRefresh(reason);
        requestAnimationFrame(() => forceTradeRowListScrollerRefresh(`${reason}-settled`));
      });
    }, Math.max(0, Number(delay) || 0));
  }

  function restoreTradeRowDates() {
    document.querySelectorAll(".trade-sent-date[data-tis-original-date]").forEach((el) => {
      setTextIfChanged(el, el.dataset.tisOriginalDate || "");
      delete el.dataset.tisOriginalDate;
      el.classList.remove("tis-trade-row-date");
    });
  }

  function clearTradeRowValues() {
    debug("clear trade row values");
    document.querySelectorAll(".tis-trade-row-values").forEach((el) => el.remove());
    restoreTradeRowDates();
    clearCompletedTradeRowControls();
    clearCompletedTradeDetailSubtitle();
    scheduleTradeRowListScrollerRefresh("clear-trade-row-values");
  }

  function getTradeFromDetailRoot(detailRoot) {
    if (!detailRoot) return null;

    const candidates = [
      detailRoot,
      detailRoot.querySelector?.(".trades-header-nowrap"),
      detailRoot.querySelector?.(".paired-name"),
      detailRoot.querySelector?.(".trade-list-detail-offer"),
    ].filter(Boolean);

    for (const candidate of candidates) {
      const trade = findTradeOnScopeChain(getAngularScopeFromElement(candidate));
      if (trade) return trade;
    }

    return null;
  }

  function clearCompletedTradeDetailSubtitle() {
    document.querySelectorAll(".tis-completed-trade-date").forEach((el) => el.remove());
  }

  function renderCompletedTradeDetailSubtitle(status, contexts, summaries, summaryMap) {
    const detailRoot = getActiveTradeDetailRoot();
    const heading = detailRoot?.querySelector(":scope > .trades-header-nowrap, .trades-header-nowrap");
    if (status !== "completed" || !detailRoot || !heading) {
      clearCompletedTradeDetailSubtitle();
      return;
    }

    const detailTrade = getTradeFromDetailRoot(detailRoot);
    const selectedContext =
      contexts.find((context) => context.row?.closest?.(".trade-row")?.classList?.contains("selected")) ||
      null;
    const selectedSummary = selectedContext ? resolveSummaryTradeForContext(selectedContext, summaries, summaryMap) : null;
    const resolvedTradeId = getTradeId(detailTrade) || getTradeId(selectedSummary) || selectedContext?.tradeId || null;
    const cachedDetail = resolvedTradeId ? state.tradeDetailCache.get(resolvedTradeId) || null : null;
    const completedDate = formatDayMonthYear(getTradeCompletedDateInput(detailTrade, cachedDetail, selectedSummary, selectedContext?.trade));

    let subtitle = detailRoot.querySelector(":scope > .tis-completed-trade-date");
    if (!completedDate) {
      subtitle?.remove();
      return;
    }

    if (!subtitle) {
      subtitle = document.createElement("div");
      subtitle.className = "tis-completed-trade-date";
      heading.insertAdjacentElement("afterend", subtitle);
    }

    setTextIfChanged(subtitle, `trade completed on ${completedDate}`);
  }

  function getCompletedTradePrivacyKey(context, resolvedTradeId, summaryTrade, detailTrade) {
    const id = resolvedTradeId || getTradeId(summaryTrade) || getTradeId(detailTrade) || context?.tradeId;
    if (id) return `id:${id}`;

    const fallback = [
      context?.domUserId || "",
      context?.domName || "",
      context?.index ?? "",
    ].join(":");
    return `row:${fallback}`;
  }

  function getCompletedReplacementImageUrl() {
    return state.icon.replacement || getExtensionAssetUrl("icons/replacementimg.webp");
  }

  function setCompletedTradeAvatarReplacement(row, hidden) {
    const img = row?.querySelector?.(".avatar img");
    if (!img) return;

    const replacementUrl = getCompletedReplacementImageUrl();
    if (hidden) {
      if (!Object.prototype.hasOwnProperty.call(img.dataset, "tisOriginalSrc")) {
        img.dataset.tisOriginalSrc = img.getAttribute("src") || "";
      }
      if (!Object.prototype.hasOwnProperty.call(img.dataset, "tisOriginalNgSrc")) {
        img.dataset.tisOriginalNgSrc = img.getAttribute("ng-src") || "";
      }
      if (!Object.prototype.hasOwnProperty.call(img.dataset, "tisOriginalSrcset")) {
        img.dataset.tisOriginalSrcset = img.getAttribute("srcset") || "";
      }
      if (img.getAttribute("src") !== replacementUrl) img.setAttribute("src", replacementUrl);
      if (img.getAttribute("ng-src") !== replacementUrl) img.setAttribute("ng-src", replacementUrl);
      if (img.hasAttribute("srcset")) img.removeAttribute("srcset");
      return;
    }

    if (img.dataset.tisOriginalSrc && img.getAttribute("src") === replacementUrl) {
      img.setAttribute("src", img.dataset.tisOriginalSrc);
    }
    if (img.dataset.tisOriginalNgSrc && img.getAttribute("ng-src") === replacementUrl) {
      img.setAttribute("ng-src", img.dataset.tisOriginalNgSrc);
    }
    if (img.dataset.tisOriginalSrcset) img.setAttribute("srcset", img.dataset.tisOriginalSrcset);
    delete img.dataset.tisOriginalSrc;
    delete img.dataset.tisOriginalNgSrc;
    delete img.dataset.tisOriginalSrcset;
  }

  function applyCompletedTradePrivacy(rowContainer, key) {
    const container =
      rowContainer?.matches?.(".trade-row-container") ? rowContainer :
      rowContainer?.querySelector?.(".trade-row-container") ||
      rowContainer?.closest?.(".trade-row-container") ||
      null;
    if (!container || !key) return;

    const previousKey = container.dataset.tisCompletedTradePrivacyKey || "";
    if (previousKey && previousKey !== key && state.hiddenCompletedTrades.has(previousKey)) {
      state.hiddenCompletedTrades.delete(previousKey);
      state.hiddenCompletedTrades.add(key);
    }

    const hidden = state.hiddenCompletedTrades.has(key);
    if (!container.classList.contains("tis-completed-trade-row")) {
      container.classList.add("tis-completed-trade-row");
    }
    if (container.classList.contains("tis-completed-trade-hidden") !== hidden) {
      container.classList.toggle("tis-completed-trade-hidden", hidden);
    }
    if (container.dataset.tisCompletedTradePrivacyKey !== key) {
      container.dataset.tisCompletedTradePrivacyKey = key;
    }

    let button = container.querySelector(":scope > .tis-completed-trade-toggle");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "tis-completed-trade-toggle";
      container.insertBefore(button, container.firstChild);
    }

    const buttonText = hidden ? "+" : "x";
    const buttonLabel = hidden ? "show trade" : "hide trade";
    if (button.dataset.tisCompletedTradePrivacyKey !== key) button.dataset.tisCompletedTradePrivacyKey = key;
    if (button.textContent !== buttonText) button.textContent = buttonText;
    if (button.title !== buttonLabel) button.title = buttonLabel;
    if (button.getAttribute("aria-label") !== buttonLabel) button.setAttribute("aria-label", buttonLabel);
    if (button.getAttribute("aria-pressed") !== String(hidden)) button.setAttribute("aria-pressed", String(hidden));

    setCompletedTradeAvatarReplacement(container, hidden);
  }

  function clearCompletedTradeRowControls() {
    document.querySelectorAll(".trade-row-container.tis-completed-trade-row").forEach((container) => {
      setCompletedTradeAvatarReplacement(container, false);
      container.classList.remove("tis-completed-trade-row", "tis-completed-trade-hidden");
      delete container.dataset.tisCompletedTradePrivacyKey;
    });
    document.querySelectorAll(".tis-completed-trade-toggle").forEach((button) => button.remove());
  }

  function renderCompletedTradeRowControls(contexts) {
    contexts.forEach((context) => {
      const key = getCompletedTradePrivacyKey(context, context.tradeId, context.trade, null);
      applyCompletedTradePrivacy(context.row, key);
    });
  }

  function getVisibleTradeRenderIdentity(status = getTradesListTab()) {
    if (!isTradesListPage() || !status) return "";

    const rowParts = Array.from(document.querySelectorAll(".trade-row-container")).map((row, index) => {
      const trade = getTradeFromRow(row);
      const tradeId = getTradeId(trade) || "";
      const userId = getTradeUserIdFromRow(row) || getTradeUserId(trade) || "";
      const name = getTradeDisplayNameFromRow(row) || getTradeDisplayName(trade) || "";
      const date = row.querySelector(".trade-sent-date")?.textContent?.trim() || "";
      return [
        index,
        getDebugNodeId(row),
        tradeId,
        userId,
        name,
        date,
      ].join(":");
    });

    const detailRoot = getActiveTradeDetailRoot();
    const detailHeading = detailRoot?.querySelector(".paired-name")?.textContent?.trim() || "";
    const deltaTarget = getTradeDeltaTarget();
    const targetNodeId = deltaTarget?.scope ? getDebugNodeId(deltaTarget.scope) : "";
    const offerNodeIds = getOfferPanels().map((panel) => getDebugNodeId(panel)).join(",");

    return [
      status,
      location.pathname,
      location.search,
      rowParts.join("|"),
      detailRoot ? getDebugNodeId(detailRoot) : "",
      detailHeading,
      targetNodeId,
      offerNodeIds,
    ].join("||");
  }

  function shouldRenderTradeRowsForVisibleIdentity(reason = "unknown", status = getTradesListTab()) {
    const identity = getVisibleTradeRenderIdentity(status);
    if (!identity) return false;
    if (identity === state.lastTradeRowRenderIdentity) {
      debug("skip trade row render:same visible identity", reason);
      return false;
    }
    state.pendingTradeRowRenderIdentity = identity;
    return true;
  }

  function rememberCompletedTradeRowRenderIdentity() {
    if (!state.pendingTradeRowRenderIdentity) return;
    state.lastTradeRowRenderIdentity = state.pendingTradeRowRenderIdentity;
    state.pendingTradeRowRenderIdentity = null;
  }

  function getTradeUserIdForContext(context) {
    return String(context?.domUserId || getTradeUserId(context?.trade) || "").trim();
  }

  function applyRolimonsVerifiedBadgeToRow(row, userId, verified) {
    const container =
      row?.matches?.(".trade-row-container") ? row :
      row?.querySelector?.(".trade-row-container") ||
      row?.closest?.(".trade-row-container") ||
      null;
    if (!container || !/^\d+$/.test(String(userId || ""))) return;

    const nameEl = container.querySelector(".trade-row-details .text-lead");
    if (!nameEl) return;

    if (container.dataset.tisRoliVerifiedUserId && container.dataset.tisRoliVerifiedUserId !== String(userId)) {
      nameEl.querySelector(":scope > .tis-roli-verified-badge")?.remove();
      delete container.dataset.tisRoliVerifiedRendered;
    }

    container.dataset.tisRoliVerifiedUserId = String(userId);
    container.dataset.tisRoliVerifiedChecked = "true";

    const existing = nameEl.querySelector(":scope > .tis-roli-verified-badge");
    if (!verified) {
      existing?.remove();
      container.dataset.tisRoliVerifiedRendered = "false";
      return;
    }

    if (existing) {
      const expectedHref = `https://www.rolimons.com/player/${userId}`;
      if (existing.getAttribute("href") !== expectedHref) existing.setAttribute("href", expectedHref);
      if (existing.style.backgroundImage !== `url("${state.icon.roli || getExtensionAssetUrl("icons/rolimons.svg")}")`) {
        existing.style.backgroundImage = `url("${state.icon.roli || getExtensionAssetUrl("icons/rolimons.svg")}")`;
      }
      container.dataset.tisRoliVerifiedRendered = "true";
      return;
    }

    const badge = document.createElement("a");
    badge.className = "tis-roli-verified-badge";
    badge.href = `https://www.rolimons.com/player/${userId}`;
    badge.target = "_blank";
    badge.rel = "noopener noreferrer";
    badge.setAttribute("aria-label", "Open Rolimons profile");
    badge.title = "verified on Rolimons";
    badge.style.backgroundImage = `url("${state.icon.roli || getExtensionAssetUrl("icons/rolimons.svg")}")`;
    nameEl.appendChild(badge);
    container.dataset.tisRoliVerifiedRendered = "true";
  }

  function applyRolimonsVerifiedBadgeToVisibleRows(userId, verified) {
    document.querySelectorAll(".trade-row-container").forEach((row) => {
      if (String(getTradeUserIdFromRow(row) || "") === String(userId)) {
        applyRolimonsVerifiedBadgeToRow(row, userId, verified);
      }
    });
  }

  async function fetchRolimonsBadgeStatus(userId) {
    const uid = String(userId || "");
    if (!/^\d+$/.test(uid)) return null;

    if (state.rolimonsBadgeCache.has(uid)) return state.rolimonsBadgeCache.get(uid);
    if (state.rolimonsBadgeRequests.has(uid)) return state.rolimonsBadgeRequests.get(uid);

    const request = bridgeRequest("runtimeSendMessage", {
      type: "TIS_FETCH_ROLIMONS_PLAYER_BADGES",
      userId: uid,
    }, 15000)
      .then((resp) => {
        if (!resp?.ok) throw new Error(resp?.error || "rolimons badges fetch failed");
        const details = {
          userId: uid,
          verified: resp.verified === true,
        };
        state.rolimonsBadgeCache.set(uid, details);
        return details;
      })
      .catch((err) => {
        state.rolimonsBadgeCache.set(uid, { userId: uid, verified: false, error: String(err?.message || err) });
        return state.rolimonsBadgeCache.get(uid);
      })
      .finally(() => {
        state.rolimonsBadgeRequests.delete(uid);
      });

    state.rolimonsBadgeRequests.set(uid, request);
    return request;
  }

  function renderRolimonsVerifiedBadges(contexts) {
    contexts.forEach((context) => {
      const userId = getTradeUserIdForContext(context);
      if (!/^\d+$/.test(userId)) return;

      if (context.row?.dataset?.tisRoliVerifiedUserId && context.row.dataset.tisRoliVerifiedUserId !== userId) {
        context.row.querySelector(".trade-row-details .text-lead > .tis-roli-verified-badge")?.remove();
        delete context.row.dataset.tisRoliVerifiedRendered;
        delete context.row.dataset.tisRoliVerifiedChecked;
      }

      const cached = state.rolimonsBadgeCache.get(userId);
      if (cached) {
        applyRolimonsVerifiedBadgeToRow(context.row, userId, cached.verified === true);
        return;
      }

      const container = context.row;
      if (container?.dataset?.tisRoliVerifiedRequestedUserId === userId) return;
      if (container?.dataset) container.dataset.tisRoliVerifiedRequestedUserId = userId;

      fetchRolimonsBadgeStatus(userId).then((details) => {
        if (!details) return;
        if (container?.isConnected) {
          applyRolimonsVerifiedBadgeToRow(container, userId, details.verified === true);
        }
        applyRolimonsVerifiedBadgeToVisibleRows(userId, details.verified === true);
      });
    });
  }

  function scheduleTradeRowValuesRender(reason = "unknown", delay = 350) {
    if (!isTradesListPage()) {
      clearTimeout(state.tradeRowRenderTimer);
      state.tradeRowRenderTimer = null;
      clearTradeRowValues();
      return;
    }
    debug("queue trade row render", reason, delay);
    clearTimeout(state.tradeRowRenderTimer);
    state.tradeRowRenderTimer = setTimeout(() => {
      state.tradeRowRenderTimer = null;
      debug("run trade row render", reason);
      renderTradeRowValues(reason);
    }, delay);
  }

  function renderTradeRowValuesNow(reason = "unknown") {
    if (!isTradesListPage()) {
      clearTimeout(state.tradeRowRenderTimer);
      state.tradeRowRenderTimer = null;
      clearTradeRowValues();
      return;
    }

    clearTimeout(state.tradeRowRenderTimer);
    state.tradeRowRenderTimer = null;
    debug("run trade row render now", reason);
    renderTradeRowValues(reason);
  }

  function scheduleTradeListPayloadRender(reason = "page-trades-list-data") {
    if (!isTradesListPage()) return;
    clearTimeout(state.tradeListPayloadRenderTimer);
    state.tradeListPayloadRenderTimer = setTimeout(() => {
      state.tradeListPayloadRenderTimer = null;
      renderTradeRowValues(reason);
    }, 80);
  }

  function hasVisibleTradeRowCards() {
    return Boolean(document.querySelector(".trade-row-container .trade-sent-date"));
  }

  async function fetchTradeSummaries(status, count) {
    debug("fetch trade summaries:start", { status, count });
    try {
      const resp = await bridgeRequest("runtimeSendMessage", { type: "TIS_FETCH_TRADE_SUMMARIES", status, count });
      if (resp?.ok) {
        debug("fetch trade summaries:done", {
          status,
          requested: count,
          received: Array.isArray(resp.items) ? resp.items.length : 0,
          totalFetched: resp.totalFetched,
          hasMore: resp.hasMore,
          cached: resp.cached,
        });
        return Array.isArray(resp.items) ? resp.items : [];
      }
    } catch {}

    const items = [];
    let cursor = "";
    const seen = new Set();

    while (items.length < count && cursor !== null) {
      const url =
        `https://trades.roblox.com/v1/trades/${status}` +
        `?cursor=${encodeURIComponent(cursor)}` +
        `&limit=25&sortOrder=Desc`;

      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`trade summary http ${res.status}: ${txt.slice(0, 200)}`);
      }

      const page = await res.json();
      const pageItems = Array.isArray(page?.data) ? page.data : [];
      pageItems.forEach((trade) => {
        const tradeId = getTradeId(trade);
        if (tradeId && seen.has(tradeId)) return;
        if (tradeId) seen.add(tradeId);
        items.push(trade);
      });
      cursor = page?.nextPageCursor ?? null;
      if (!pageItems.length) break;
    }

    debug("fetch trade summaries:done", {
      status,
      requested: count,
      received: items.length,
      totalFetched: items.length,
      hasMore: cursor !== null,
      cached: false,
    });
    return items.slice(0, count);
  }

  async function fetchTradeDetailWithBackground(tradeId) {
    debug("background trade detail fetch:start", tradeId);
    let responseError = null;
    try {
      const resp = await bridgeRequest("runtimeSendMessage", { type: "TIS_FETCH_TRADE_DETAILS", tradeId });
      const trade = resp?.ok ? normalizeTradeDetail(resp.trade) : null;
      if (trade) {
        debug("background trade detail fetch:done", tradeId, {
          hasOffers: Array.isArray(trade?.offers),
          offerCount: Array.isArray(trade?.offers) ? trade.offers.length : 0,
          cached: resp.cached === true,
        });
        return trade;
      }
      responseError = new Error(resp?.error || "trade detail unavailable");
    } catch (error) {
      responseError = error;
    }

    // Some Brave privacy configurations do not expose Roblox's authenticated
    // cookies to extension service workers.  This main-world fallback is
    // first-party, and queueTradeDetailFetch keeps it deliberately small.
    const fetchFirstParty = window.TIS_FETCH_TRADE_DETAIL_FIRST_PARTY;
    if (typeof fetchFirstParty !== "function") {
      throw new Error(`first-party trade queue unavailable; worker: ${String(responseError?.message || responseError || "unavailable")}`);
    }
    return normalizeTradeDetail(await fetchFirstParty(tradeId));
  }

  function queueTradeDetailFetch(tradeId) {
    const id = String(tradeId || "");
    if (!/^\d+$/.test(id)) return false;
    if (state.tradeDetailCache.has(id)) return false;
    if (state.tradeDetailRequests.has(id)) return true;

    const failedAt = state.tradeDetailFailedAt.get(id);
    if (failedAt && (Date.now() - failedAt) < 2500) {
      debug("skip trade detail fetch:cooldown", id);
      return true;
    }

    debug("queue trade detail fetch", id);
    state.tradeDetailRequests.set(id, {
      requestedAt: Date.now(),
      backgroundStarted: true,
    });

    fetchTradeDetailWithBackground(id)
      .then((trade) => {
        storeTradeDetail(id, trade, "background");
      })
      .catch((err) => {
        if (state.tradeDetailCache.has(id)) {
          state.tradeDetailRequests.delete(id);
          return;
        }

        state.tradeDetailRequests.delete(id);
        state.tradeDetailFailedAt.set(id, Date.now());
        debug("background trade detail fetch failed", id, String(err?.message || err));
        scheduleTradeRowValuesRender("trade-detail-background-failed", 900);
      });

    return true;
  }

  function queueTradeSummaryFetch(status, count) {
    const key = String(status || "").trim().toLowerCase();
    if (!["inbound", "outbound", "completed", "inactive"].includes(key)) return null;

    const cached = state.tradeSummaryCache.get(key);
    if (cached?.items?.length >= count) return Promise.resolve(cached.items.slice(0, count));

    const failedAt = state.tradeSummaryFailedAt.get(key);
    if (failedAt && (Date.now() - failedAt) < 10000) {
      debug("skip trade summary fetch:cooldown", { key, count });
      return null;
    }

    const inFlight = state.tradeSummaryRequests.get(key);
    if (inFlight && (inFlight.count || 0) >= count) return inFlight.promise;

    debug("queue trade summary fetch", { key, count });
    const promise = fetchTradeSummaries(key, count)
      .then((items) => {
        state.tradeSummaryCache.set(key, { items, fetchedAt: Date.now() });
        state.tradeSummaryFailedAt.delete(key);
        state.lastTradeRowRenderIdentity = null;
        state.pendingTradeRowRenderIdentity = null;
        if (hasVisibleTradeRowCards()) renderTradeRowValuesNow("trade-summaries-ready");
        else scheduleTradeRowValuesRender("trade-summaries-ready", 30);
        return items;
      })
      .catch((err) => {
        state.tradeSummaryFailedAt.set(key, Date.now());
        debug("trade summary fetch failed", key, String(err?.message || err));
        return [];
      })
      .finally(() => {
        const current = state.tradeSummaryRequests.get(key);
        if (current?.promise === promise) state.tradeSummaryRequests.delete(key);
      });

    state.tradeSummaryRequests.set(key, { count, promise });
    return promise;
  }

  function collectTradeRowContexts() {
    const contexts = Array.from(document.querySelectorAll(".trade-row-container")).map((row, index) => {
      const trade = getTradeFromRow(row);
      const host = row.querySelector(".trade-row-details > div, .trade-row-details");
      const dateEl = host?.querySelector(".trade-sent-date") || null;
      const tradeId = getTradeId(trade);
      const domUserId = getTradeUserIdFromRow(row);
      const domName = getTradeDisplayNameFromRow(row);
      return { row, trade, host, dateEl, tradeId, domUserId, domName, index };
    }).filter((ctx) => ctx.host);

    debug("collect trade row contexts", contexts.map((ctx) => ({
      index: ctx.index,
      tradeId: ctx.tradeId,
      domUserId: ctx.domUserId,
      domName: ctx.domName,
      hasTrade: Boolean(ctx.trade),
      created: ctx.trade?.created || null,
      userId: ctx.trade?.user?.id || null,
      userName: ctx.trade?.user?.nameForDisplay || null,
      hasDateEl: Boolean(ctx.dateEl),
    })));

    return contexts;
  }

  function ensureTradeSummariesLoaded(status, contexts) {
    const cached = state.tradeSummaryCache.get(status)?.items || [];
    const visibleTradeIds = contexts.map(({ tradeId }) => tradeId).filter(Boolean);
    const cachedTradeIds = new Set(cached.map((trade) => getTradeId(trade)).filter(Boolean));
    const cacheCoversVisibleTrades =
      visibleTradeIds.length > 0 &&
      visibleTradeIds.every((tradeId) => cachedTradeIds.has(tradeId));
    const cacheMatchesRows = cacheMatchesVisibleContexts(cached, contexts);

    if ((cacheCoversVisibleTrades && cacheMatchesRows) || (!visibleTradeIds.length && cacheMatchesRows)) {
      debug("trade summaries already loaded", { status, count: cached.length, cacheMatchesRows });
      return false;
    }

    if (cached.length && (visibleTradeIds.length || !cacheMatchesRows)) {
      state.tradeSummaryCache.delete(status);
      debug("drop stale trade summaries", {
        status,
        cachedCount: cached.length,
        visibleCount: visibleTradeIds.length,
        cacheMatchesRows,
      });
    }

    const request = queueTradeSummaryFetch(status, contexts.length);
    debug("ensure trade summaries loaded", {
      status,
      needed: contexts.length,
      cached: cached.length,
      waiting: Boolean(request),
    });
    return Boolean(request);
  }

  function ensureTradeRowDetailsLoaded(contexts, summaries, summaryMap) {
    const missingIds = [];
    let waitingCount = 0;
    const bindings = [];
    // Keep a long trade list from turning into an unbounded detail-request
    // burst.  Each finished batch schedules the next one, while cached
    // details still resolve immediately.
    const maxNewRequests = 6;

    contexts.forEach((context) => {
      const summaryTrade = resolveSummaryTradeForContext(context, summaries, summaryMap);
      const summaryTradeId = getTradeId(summaryTrade);
      const resolvedTradeId = summaryTradeId || context.tradeId;
      bindings.push({
        index: context.index,
        domUserId: context.domUserId,
        domName: context.domName,
        scopeTradeId: context.tradeId,
        summaryTradeId,
        resolvedTradeId,
        detailCached: Boolean(resolvedTradeId && state.tradeDetailCache.has(resolvedTradeId)),
      });
      if (!resolvedTradeId || state.tradeDetailCache.has(resolvedTradeId)) return;
      if (missingIds.length >= maxNewRequests) return;
      missingIds.push(resolvedTradeId);
      if (queueTradeDetailFetch(resolvedTradeId)) waitingCount++;
    });

    debug("ensure trade row details loaded", {
      contextCount: contexts.length,
      missingIds,
      pendingCount: waitingCount,
      cachedCount: contexts.filter((context) => {
        const summaryTrade = resolveSummaryTradeForContext(context, summaries, summaryMap);
        const resolvedTradeId = getTradeId(summaryTrade) || context.tradeId;
        return resolvedTradeId && state.tradeDetailCache.has(resolvedTradeId);
      }).length,
    });

    return waitingCount > 0;
  }

  function renderTradeRowValues(reason = "unknown") {
    if (!isTradesListPage()) {
      clearTradeRowValues();
      return;
    }

    ensureStyles();

    const status = getTradesListTab();
    debug("render trade row values:start", {
      href: location.href,
      tab: status,
      reason,
    });

    if (!status) {
      debug("render trade row values:status unknown, preserve existing UI");
      return;
    }

    if (!shouldRenderTradeRowsForVisibleIdentity(reason, status)) {
      return;
    }

    if (status && status !== "completed") {
      clearCompletedTradeRowControls();
      clearCompletedTradeDetailSubtitle();
    }

    const contexts = collectTradeRowContexts();
    if (!contexts.length) {
      debug("render trade row values:no contexts");
      scheduleTradeRowValuesRender("waiting-for-rows", 250);
      return;
    }

    renderRolimonsVerifiedBadges(contexts);

    if (status === "completed") {
      renderCompletedTradeRowControls(contexts);
    }

    const contextsNeedingTradeRowValues = contexts.filter((context) => {
      const existingPanel = context.dateEl?.querySelector(":scope > .tis-trade-row-values");
      return context.row?.dataset?.tisTradeRowValuesRendered !== "true" && !existingPanel;
    });

    if (!contextsNeedingTradeRowValues.length) {
      debug("render trade row values:all visible rows already rendered");
      rememberCompletedTradeRowRenderIdentity();
      return;
    }

    if (ensureTradeSummariesLoaded(status, contexts)) {
      debug("render trade row values:waiting for summary data");
      return;
    }

    const summaries = state.tradeSummaryCache.get(status)?.items || [];
    const summaryMap = buildTradeSummaryMap(summaries);
    renderRolimonsVerifiedBadges(contexts.map((context) => ({
      ...context,
      trade: context.trade || resolveSummaryTradeForContext(context, summaries, summaryMap),
    })));
    renderCompletedTradeDetailSubtitle(status, contexts, summaries, summaryMap);
    debug("render trade row values:using summaries", summaries.map((trade, index) => ({
      index,
      tradeId: getTradeId(trade),
      created: trade?.created || null,
      userId: trade?.user?.id || null,
      userName: trade?.user?.displayName || trade?.user?.name || null,
    })));

    if (ensureTradeRowDetailsLoaded(contexts, summaries, summaryMap)) {
      debug("render trade row values:waiting for detail data");
      scheduleTradeRowValuesRender("waiting-for-detail-data", 120);
    }

    let renderedAnyTradeRowValue = false;
    contextsNeedingTradeRowValues.forEach((context) => {
      const { row, trade, host, dateEl, tradeId } = context;
      const summaryTrade = resolveSummaryTradeForContext(context, summaries, summaryMap);
      const resolvedTradeId = getTradeId(summaryTrade) || tradeId;
      const legacyPanel = row.querySelector(":scope > .tis-trade-row-values");
      legacyPanel?.remove();
      let panel = dateEl?.querySelector(":scope > .tis-trade-row-values") || null;
      const detailTrade = resolvedTradeId ? state.tradeDetailCache.get(resolvedTradeId) || null : null;

      if (status === "completed") {
        const privacyKey = getCompletedTradePrivacyKey(context, resolvedTradeId, summaryTrade, detailTrade);
        applyCompletedTradePrivacy(row, privacyKey);
      }

      if (row.dataset.tisTradeRowValuesRendered === "true" || panel) {
        row.dataset.tisTradeRowValuesRendered = "true";
        return;
      }

      debug("render trade row values:row", {
        tradeId: resolvedTradeId,
        hasTrade: Boolean(summaryTrade || trade),
        hasDetailTrade: Boolean(detailTrade),
        hostFound: Boolean(host),
        dateFound: Boolean(dateEl),
        created: summaryTrade?.created ?? trade?.created ?? detailTrade?.created ?? null,
      });

      const relativeTime = formatRelativeTime(summaryTrade?.created ?? trade?.created ?? detailTrade?.created);
      if (dateEl && relativeTime) {
        if (!dateEl.dataset.tisOriginalDate) {
          dateEl.dataset.tisOriginalDate = dateEl.textContent || "";
        }
        dateEl.classList.add("tis-trade-row-date");
        let dateText = dateEl.querySelector(":scope > .tis-trade-row-date-text");
        if (!dateText) {
          dateEl.textContent = "";
          dateText = document.createElement("span");
          dateText.className = "tis-trade-row-date-text";
          dateEl.appendChild(dateText);
        }
        dateEl.style.display = "inline-flex";
        dateEl.style.flexDirection = "column";
        dateEl.style.alignItems = "flex-start";
        dateEl.style.justifyContent = "flex-start";
        dateEl.style.verticalAlign = "top";
        dateEl.style.boxSizing = "border-box";
        dateEl.style.minWidth = "88px";
        dateEl.style.maxWidth = "88px";
        dateEl.style.padding = "2px 0";
        dateEl.style.whiteSpace = "normal";
        dateText.style.display = "block";
        dateText.style.fontSize = "13px";
        dateText.style.lineHeight = "1.2";
        dateText.style.width = "100%";
        dateText.style.maxWidth = "100%";
        dateText.style.textAlign = "left";
        setTextIfChanged(dateText, relativeTime);
        debug("render trade row values:date updated", {
          tradeId: resolvedTradeId,
          relativeTime,
          original: dateEl.dataset.tisOriginalDate,
        });
      } else {
        debug("render trade row values:no relative time", {
          tradeId: resolvedTradeId,
          hasDateEl: Boolean(dateEl),
          created: summaryTrade?.created ?? trade?.created ?? detailTrade?.created ?? null,
        });
      }

      const totals = computeTradeRowTotals(summaryTrade || trade || detailTrade, detailTrade || summaryTrade || trade);

      if (!totals) {
        panel?.remove();
        debug("render trade row values:no totals", {
          tradeId: resolvedTradeId,
          hasSummaryOffers: Array.isArray(summaryTrade?.offers) || Array.isArray(trade?.offers),
          hasDetailOffers: Array.isArray(detailTrade?.offers),
          detailOfferCount: Array.isArray(detailTrade?.offers) ? detailTrade.offers.length : 0,
        });
        return;
      }

      if (!panel) {
        panel = document.createElement("span");
        panel.className = "tis-trade-row-values";
      }

      if (dateEl) {
        if (panel.parentElement !== dateEl) {
          dateEl.appendChild(panel);
        }
      } else if (host && panel.parentElement !== host) {
        host.appendChild(panel);
      }

      panel.classList.remove(
        "tis-trade-row-values-gain",
        "tis-trade-row-values-loss",
        "tis-trade-row-values-even"
      );

      if (totals.difference > 0) panel.classList.add("tis-trade-row-values-gain");
      else if (totals.difference < 0) panel.classList.add("tis-trade-row-values-loss");
      else panel.classList.add("tis-trade-row-values-even");

      panel.style.display = "block";
      panel.style.marginTop = "6px";
      panel.style.marginLeft = "0";
      panel.style.paddingTop = "0";
      panel.style.textAlign = "left";
      panel.style.fontSize = "15px";
      panel.style.fontWeight = "700";
      panel.style.lineHeight = "1.2";
      panel.style.whiteSpace = "normal";
      panel.style.width = "100%";
      panel.style.maxWidth = "100%";
      panel.style.color =
        totals.difference > 0 ? "#5fd67a" :
        totals.difference < 0 ? "#ff6b6b" :
        "#ffffff";

      const markup = [
        `<span class="tis-line">${totals.giving.toLocaleString()}</span>`,
        `<span class="tis-line">${totals.receiving.toLocaleString()}</span>`
      ].join("");

      if (panel.dataset.tisMarkup !== markup) {
        panel.innerHTML = markup;
        panel.dataset.tisMarkup = markup;
      }
      row.dataset.tisTradeRowValuesRendered = "true";
      renderedAnyTradeRowValue = true;

      debug("render trade row values:rendered", {
        tradeId: resolvedTradeId,
        giving: totals.giving,
        receiving: totals.receiving,
        difference: totals.difference,
      });
    });

    if (renderedAnyTradeRowValue) {
      scheduleTradeRowListScrollerRefresh("render-trade-row-values");
    }
    rememberCompletedTradeRowRenderIdentity();
  }

  function renderOfferTotal(panel, total) {
    if (!panel) return;
    ensureStyles();

    const totalLine = renameNativeRapLabel(panel);
    if (!totalLine) return;

    let row = panel.querySelector(".tis-roli-offer-total");
    if (!row) {
      row = document.createElement("div");
      row.className = "robux-line tis-roli-offer-total";
      totalLine.insertAdjacentElement("afterend", row);
    }

    let lead = row.querySelector(".text-lead");
    if (!lead) {
      lead = document.createElement("span");
      lead.className = "text-lead";
      row.appendChild(lead);
    }
    setTextIfChanged(lead, "total value:");

    let amt = row.querySelector(".robux-line-amount");
    if (!amt) {
      amt = document.createElement("span");
      amt.className = "robux-line-amount";
      row.appendChild(amt);
    }

    let icon = amt.querySelector(".icon-rolimons");
    if (!icon) {
      icon = document.createElement("span");
      icon.className = "icon icon-rolimons";
      amt.appendChild(icon);
      applyRoliIconStyles(icon, state.icon.roli || getExtensionAssetUrl("icons/rolimons.svg"));
    }

    let v = amt.querySelector(".tis-roli-total-value");
    if (!v) {
      v = document.createElement("span");
      v.className = "text-robux-lg robux-line-value tis-roli-total-value";
      amt.appendChild(v);
      applyRoliValueStyles(v);
    }
    setTextIfChanged(v, (Number(total) || 0).toLocaleString());
  }

  function refreshOfferTotals() {
    if (!isTradePage()) return;
    observeOfferPanels();
    const totals = getOfferPanels().map((panel) => {
      const offerTotals = computeOfferTotals(panel);
      renderOfferTotal(panel, offerTotals.value);
      return offerTotals;
    });

    renderTradeDelta(totals);
  }

  function scheduleOfferTotalsRefresh(reason = "unknown") {
    if (!isTradePage()) return;
    if (state.offerTotalsScheduled) return;
    state.offerTotalsScheduled = true;
    debug("queue offer total refresh", reason);
    setTimeout(() => {
      state.offerTotalsScheduled = false;
      debug("run offer total refresh");
      refreshOfferTotals();
    }, 0);
  }

  function observeOfferPanels() {
    if (!isTradePage()) {
      try { state.offerObserver?.disconnect(); } catch {}
      state.offerObserver = null;
      state.offerObserverPanels = [];
      return;
    }
    const panels = getOfferPanels().filter(Boolean);
    if (!panels.length) return;

    const samePanels =
      state.offerObserver &&
      state.offerObserverPanels.length === panels.length &&
      panels.every((panel, index) => state.offerObserverPanels[index] === panel);

    if (samePanels) return;

    try { state.offerObserver?.disconnect(); } catch {}

    const obs = new MutationObserver((mutations) => {
      if (!mutationBatchNeedsWork(mutations)) return;
      debug("offer observer batch", mutations.length);
      scheduleOfferTotalsRefresh("offer-dom");
    });

    panels.forEach((panel) => {
      obs.observe(panel, { childList: true, subtree: true });
    });

    state.offerObserver = obs;
    state.offerObserverPanels = panels;
    debug("observing offer panels", panels.length);
  }

  function findDirectChildByClass(parent, className) {
    if (!parent) return null;
    return Array.from(parent.children).find((el) => el.classList?.contains(className)) || null;
  }

  function clearTradeDelta() {
    document.querySelectorAll(".tis-trade-delta").forEach((el) => el.remove());
  }

  function getTradeDeltaTarget() {
    const detailRoot = getActiveTradeDetailRoot();
    const detailOffers = Array.from(detailRoot?.querySelectorAll(".trade-list-detail-offer") || []);
    const receiveOfferBlock = detailOffers[1] || null;
    const receiveDivider = receiveOfferBlock?.querySelector(":scope > .rbx-divider");
    if (receiveOfferBlock?.parentElement && receiveDivider) {
      return {
        anchor: receiveDivider,
        position: "beforebegin",
        scope: receiveOfferBlock,
        variant: "detail",
      };
    }

    const receiveHeader = Array.from(detailRoot?.querySelectorAll(".trade-list-detail-offer-header") || [])
      .find((el) => (el.textContent || "").trim().toLowerCase() === "items you will receive");
    const receiveHeaderBlock = receiveHeader?.parentElement;
    const receiveHeaderDivider = receiveHeaderBlock?.querySelector(":scope > .rbx-divider");
    if (receiveHeaderBlock?.parentElement && receiveHeaderDivider) {
      return {
        anchor: receiveHeaderDivider,
        position: "beforebegin",
        scope: receiveHeaderBlock,
        variant: "detail",
      };
    }

    const composerRoot = getActiveComposerRoot();
    const yourRequestHeader = Array.from(composerRoot?.querySelectorAll(".trade-request-window-offer > h2") || [])
      .find((el) => (el.textContent || "").trim().toLowerCase() === "your request");
    if (yourRequestHeader?.parentElement) {
      return {
        anchor: yourRequestHeader,
        position: "beforebegin",
        scope: yourRequestHeader.parentElement,
        variant: "composer",
      };
    }

    const composerButton = composerRoot?.querySelector(".trade-request-window-offers-parent .btn-cta-md.btn-full-width");
    if (composerButton) {
      return {
        anchor: composerButton,
        position: "beforebegin",
        scope: composerButton.parentElement,
        variant: "composer",
      };
    }

    const tradeButtons = detailRoot?.querySelector(".trade-buttons");
    if (tradeButtons) {
      return {
        anchor: tradeButtons.querySelector("button") || tradeButtons,
        position: "beforebegin",
        scope: tradeButtons,
        variant: "detail",
      };
    }

    const detailOffersContainer = detailRoot?.querySelector(":scope > .col-xs-12");
    if (detailOffersContainer) {
      return {
        anchor: detailOffersContainer,
        position: "afterend",
        scope: detailOffersContainer.parentElement,
        variant: "detail",
      };
    }

    return null;
  }

  function renderTradeDelta(totals) {
    ensureStyles();
    const target = getTradeDeltaTarget();
    if (!target?.anchor) {
      return;
    }

    if (!Array.isArray(totals) || totals.length < 2) {
      return;
    }

    // insertAdjacentElement(beforebegin/afterend) makes the delta a sibling of
    // the anchor. Always look in that actual parent; using an assumed scope
    // caused every refresh to miss the previous row and append another one.
    const expectedParent = target.anchor.parentElement;
    if (!expectedParent) return;

    const existingRows = Array.from(expectedParent.children)
      .filter((element) => element.classList?.contains("tis-trade-delta"));
    let row = existingRows.shift() || null;
    existingRows.forEach((duplicate) => duplicate.remove());

    // A trade detail is singular. Clean up stale rows left by React route
    // swaps or by older builds before rendering the canonical row.
    document.querySelectorAll(".tis-trade-delta").forEach((element) => {
      if (element !== row) element.remove();
    });

    if (!row) {
      row = document.createElement("div");
      row.className = "tis-trade-delta";
    }

    if (row.parentElement !== expectedParent) {
      target.anchor.insertAdjacentElement(target.position, row);
    }

    setClassPresence(row, "tis-trade-delta-detail", target.variant !== "composer");
    setClassPresence(row, "tis-trade-delta-composer", target.variant === "composer");

    const giveRap = Number(totals?.[0]?.rap) || 0;
    const receiveRap = Number(totals?.[1]?.rap) || 0;
    const rapDiff = receiveRap - giveRap;

    const giveValue = Number(totals?.[0]?.value) || 0;
    const receiveValue = Number(totals?.[1]?.value) || 0;
    const valueDiff = receiveValue - giveValue;

    const { rowStateClass, markup } = buildTradeDeltaMarkup(rapDiff, valueDiff);
    setClassPresence(row, "tis-trade-delta-gain", rowStateClass === "tis-trade-delta-gain");
    setClassPresence(row, "tis-trade-delta-loss", rowStateClass === "tis-trade-delta-loss");
    setClassPresence(row, "tis-trade-delta-even", rowStateClass === "tis-trade-delta-even");
    if (row.dataset.tisMarkup !== markup) {
      row.innerHTML = markup;
      row.dataset.tisMarkup = markup;
    }
  }

  async function loadIcon(name) {
    return getExtensionAssetUrl(name);
  }

  async function ensureIcons() {
    try {
      if (!state.icon.roli) state.icon.roli = await loadIcon("icons/rolimons.svg");
      if (!state.icon.proj) state.icon.proj = await loadIcon("icons/projected.png");
      if (!state.icon.replacement) state.icon.replacement = await loadIcon("icons/replacementimg.webp");

    } catch (e) {
      console.warn(TAG, "icon load failed (fine for now):", e);
    }
  }

  function isTradePage() {
    const { origin, pathname } = location;
    return origin === "https://www.roblox.com" && (
      pathname === "/trades" ||
      /^\/trades\/(?:inbound|outbound|completed|inactive)\/?$/i.test(pathname)
    );
  }

  function getTradableItemFromCard(card) {
    return getTradeItemDataFromElement(card);
  }

  function getItemNameFromCard(card) {
    return (
      getItemNameFromTradeItemData(getTradableItemFromCard(card)) ||
      card.querySelector(".item-card-name")?.textContent ||
      ""
    ).trim();
  }

  function getAssetIdFromCard(card) {
    const scopedAssetId = getAssetIdFromTradeItemData(getTradableItemFromCard(card));
    if (scopedAssetId) return scopedAssetId;

    // fallback: thumbnail-target-id
    const t = card.querySelector(".thumbnail-2d-container[thumbnail-target-id]");
    const id1 = t?.getAttribute("thumbnail-target-id");
    if (id1 && /^\d+$/.test(id1)) return id1;

    // fallback: catalog link
    const a = card.querySelector('a[href*="/catalog/"]');
    const href = a?.getAttribute("href") || "";
    const m = href.match(/\/catalog\/(\d+)(?:\/|$)/);
    if (m) return m[1];

    return null;
  }

  function getCollectibleItemInstanceIdFromCard(card) {
    const itemData = getTradableItemFromCard(card);
    const candidates = [
      itemData?.collectibleItemInstanceId,
      itemData?.collectibleItemDetails?.collectibleItemInstanceId,
      itemData?.itemDetails?.collectibleItemInstanceId,
      itemData?.details?.collectibleItemInstanceId,
      card.querySelector(".item-card-container")?.getAttribute("data-collectibleiteminstanceid"),
      card.getAttribute?.("data-collectibleiteminstanceid"),
    ];

    for (const candidate of candidates) {
      const value = String(candidate || "");
      if (value && value !== "undefined" && value !== "null") return value;
    }

    return null;
  }

  function getSerialTooltipLineFromCard(card) {
    const itemData = getTradableItemFromCard(card);
    const serial = Number(itemData?.serialNumber);
    if (!Number.isFinite(serial) || serial <= 0) return null;

    const stock = Number(itemData?.assetStock ?? itemData?.layoutOptions?.assetStock ?? 0);
    if (Number.isFinite(stock) && stock > 0) return `#${serial}/${stock}`;
    return `#${serial}`;
  }

  function getRoliInfoFromCard(card) {
    const assetId = getAssetIdFromCard(card);
    if (assetId) {
      const info = state.data?.[assetId];
      if (info) return info;
    }

    const tradableItem = getTradableItemFromCard(card);
    const isBundle = isBundleTradeItemData(tradableItem) ||
      card.querySelector('.thumbnail-2d-container[thumbnail-type="BundleThumbnail"]') ||
      card.querySelector('a[href*="/bundles/"]');

    if (isBundle) {
      return getRoliInfoByName(getItemNameFromCard(card));
    }

    return null;
  }

  function decorateCard(card) {
    if (!state.data) return;

    const info = getRoliInfoFromCard(card);

    // fallback: if roli has no value, show roblox RAP again (blue)
    const rapText =
    card.querySelector(".item-card-caption .item-card-price .text-robux")?.textContent?.trim() ||
    card.querySelector(".item-card-caption .item-card-price")?.textContent?.trim() ||
    "-";

    const roliText = fmt(info?.value);
    renderItemCardRoliValueRow(card, {
      valueText: roliText === "-" ? rapText : roliText,
      iconUrl: state.icon.roli || getExtensionAssetUrl("icons/rolimons.svg"),
    });

    const thumb = card.querySelector(".item-card-thumb-container");
    if (thumb) {
    if (!thumb.style.position) thumb.style.position = "relative";

    let p = thumb.querySelector(":scope .tis-proj-icon");
    if (info?.projected) {
        if (!p) {
        p = document.createElement("img");
        p.className = "tis-proj-icon";
        p.alt = "";
        p.src = state.icon.proj || getExtensionAssetUrl("icons/projected.png");
        thumb.appendChild(p);
        }
    } else {
        p?.remove();
    }
    }

    const limitedIcon = thumb?.querySelector(".limited-icon-container") || card.querySelector(".limited-icon-container");
    const collectibleAssetId = getCollectibleItemInstanceIdFromCard(card);
    const serialLine = getSerialTooltipLineFromCard(card);
    if (limitedIcon) {
      const itemData = getTradableItemFromCard(card);
      if (itemData?.serialNumber !== null && itemData?.serialNumber !== undefined) {
        formatLimitedSerialBubble(limitedIcon, { serial: itemData.serialNumber });
      }
      bindLimitedInfoTooltip(limitedIcon, {
        enabled: Boolean(collectibleAssetId),
        lines: serialLine ? [serialLine, collectibleAssetId] : [collectibleAssetId],
        copyValue: collectibleAssetId || "",
        copyLineIndex: serialLine ? 1 : 0,
      });
    }

    const caption = card.querySelector(".item-card-caption");
    const link = card.querySelector(".item-card-link");
    const container = card.querySelector(".item-card-container");
    const listItem = card.closest("li, .list-item");
    [caption, link, container, listItem].forEach((el) => {
      if (!el) return;
      el.style.height = "auto";
      el.style.overflow = "visible";
    });
  }

  function decorateAllNow() {
    if (!state.data || !isTradePage()) return;
    ensureStyles();
    const cards = document.querySelectorAll(".item-card-container");
    debug("decorate pass", { cards: cards.length, url: location.href });
    cards.forEach(decorateCard);
    scheduleTradeRowValuesRender("decorate-pass", 1200);
  }

  function scheduleDecorate(reason = "unknown") {
    if (!isTradePage()) return;
    if (state.scheduled) return;
    state.scheduled = true;
    debug("queue decorate", reason);
    setTimeout(() => {
      state.scheduled = false;
      decorateAllNow();
    }, 50);
  }

  async function fetchRolimonsItemDetailsDirect() {
    const res = await fetch("https://api.rolimons.com/items/v2/itemdetails", {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`rolimons http ${res.status}: ${txt.slice(0, 200)}`);
    }

    const json = await res.json();
    const items = json?.items;
    if (!items || typeof items !== "object") throw new Error("missing .items");

    const slim = Object.create(null);
    for (const [id, arr] of Object.entries(items)) {
      const name = typeof arr?.[0] === "string" ? arr[0] : null;
      const rap = arr?.[2];
      const value = arr?.[3];
      const projFlag = arr?.[7];
      slim[id] = {
        name,
        rap: (rap === -1 ? null : rap),
        value: (value === -1 ? null : value),
        projected: projFlag === 1 || projFlag === "1",
      };
    }

    return slim;
  }

  async function fetchRolimonsItemDetails() {
    try {
      const resp = await bridgeRequest("runtimeSendMessage", { type: "TIS_ROLIMONS_GET_ITEMDETAILS" });
      if (resp?.ok) return resp.data;
      throw new Error(resp?.error || "rolimons itemdetails bridge failed");
    } catch (err) {
      throw new Error(`rolimons itemdetails bridge failed: ${err?.message || err}`);
    }
  }

  async function init() {
    if (!isTradePage()) return false;

    await ensureIcons();

    try {
      state.data = await fetchRolimonsItemDetails();
      state.roliExactNameMap = null;
      state.roliNormalizedNameMap = null;
      window.postMessage({ type: "TIS_ROLI_ITEMDETAILS", data: state.data }, "*");
      decorateAllNow();
      refreshOfferTotals();
      scheduleTradeRowValuesRender("init", 1400);
    } catch (e) {
      console.warn(TAG, "rolimons fetch failed:", e);
      return false;
    }

    const mo = new MutationObserver((mutations) => {
      if (!mutationBatchNeedsWork(mutations)) return;
      debug("decorate observer batch", mutations.length);
      scheduleDecorate("dom-mutation");
      scheduleOfferTotalsRefresh("dom-mutation");
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    observeInjectedRemovalDebug();
    observeOfferPanels();
    scheduleOfferTotalsRefresh("init");
    return true;
  }

  // roblox SPA: try a few times
  let lastUrl = location.href;
  let initialized = false;
  let initInFlight = false;
  let nextInitAttemptAt = 0;
  window.addEventListener("message", (ev) => {
    if (!isTradePage()) return;
    const msg = ev?.data;
    if (msg?.type === "TIS_OFFER_TOTAL_VALUE") scheduleOfferTotalsRefresh("offer-total-message");
    if (msg?.type === "TIS_TRADES_LIST_DATA") {
      const status = rememberTradeListStatus(msg.status);
      const items = Array.isArray(msg.payload?.data) ? msg.payload.data : [];
      if (!status || !items.length) {
        debug("ignore trades list payload", { status, count: items.length });
        return;
      }

      const previousPageCursor = msg.payload?.previousPageCursor ?? null;
      const cachedItems = state.tradeSummaryCache.get(status)?.items || [];
      let mergedItems = items;

      if (previousPageCursor !== null && cachedItems.length) {
        const seen = new Set(cachedItems.map((trade) => getTradeId(trade)).filter(Boolean));
        mergedItems = [...cachedItems];
        items.forEach((trade) => {
          const tradeId = getTradeId(trade);
          if (tradeId && seen.has(tradeId)) return;
          if (tradeId) seen.add(tradeId);
          mergedItems.push(trade);
        });
      }

      state.tradeSummaryCache.set(status, {
        items: mergedItems,
        fetchedAt: Date.now(),
      });
      state.tradeSummaryFailedAt.delete(status);
      debug("received trades list payload", {
        status,
        count: mergedItems.length,
        pageCount: items.length,
        previousPageCursor,
        nextPageCursor: msg.payload?.nextPageCursor ?? null,
      });
      scheduleOfferTotalsRefresh("page-trades-list-data");
      scheduleTradeListPayloadRender("page-trades-list-data");
    }
    if (msg?.type === "TIS_TRADE_DETAIL_DATA") {
      const tradeId = String(msg.tradeId || "");
      if (!/^\d+$/.test(tradeId) || !msg.trade || typeof msg.trade !== "object") return;
      debug("received trade detail payload", {
        tradeId,
        hasOffers: Array.isArray(msg.trade?.offers),
        offerCount: Array.isArray(msg.trade?.offers) ? msg.trade.offers.length : 0,
      });
      storeTradeDetail(tradeId, msg.trade, "page");
    }
    if (msg?.type === "TIS_TRADE_DETAIL_ERROR") {
      const tradeId = String(msg.tradeId || "");
      if (!/^\d+$/.test(tradeId)) return;
      debug("received trade detail error", tradeId, msg.error || "unknown error");
      const requestState = state.tradeDetailRequests.get(tradeId);
      if (requestState?.backgroundStarted) {
        state.tradeDetailRequests.delete(tradeId);
        state.tradeDetailFailedAt.set(tradeId, Date.now());
      } else {
        scheduleTradeRowValuesRender("page-trade-detail-error", 120);
      }
    }
  });
  document.addEventListener("input", (ev) => {
    if (!isTradePage()) return;
    if (ev.target?.matches?.('.trade-request-window-offer input[name="robux"]')) {
      scheduleOfferTotalsRefresh("robux-input");
    }
  }, true);
  document.addEventListener("change", (ev) => {
    if (!isTradePage()) return;
    if (ev.target?.matches?.('.trade-request-window-offer input[name="robux"]')) {
      scheduleOfferTotalsRefresh("robux-change");
    }
  }, true);
  document.addEventListener("click", (ev) => {
    if (!isTradePage()) return;
    const roliVerifiedBadge = ev.target?.closest?.(".tis-roli-verified-badge");
    if (roliVerifiedBadge) {
      ev.stopImmediatePropagation();
      return;
    }

    const privacyToggle = ev.target?.closest?.(".tis-completed-trade-toggle");
    if (privacyToggle) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const key =
        privacyToggle.dataset.tisCompletedTradePrivacyKey ||
        privacyToggle.closest?.(".trade-row-container")?.dataset?.tisCompletedTradePrivacyKey ||
        "";
      if (key) {
        if (state.hiddenCompletedTrades.has(key)) state.hiddenCompletedTrades.delete(key);
        else state.hiddenCompletedTrades.add(key);
        applyCompletedTradePrivacy(privacyToggle.closest?.(".trade-row-container"), key);
      }
      return;
    }
  }, true);
  document.addEventListener("click", (ev) => {
    if (!isTradePage()) return;
    if (ev.target?.closest?.(".trade-row, .trade-list-dropdown, .group-dropdown.trade-list-dropdown")) {
      scheduleOfferTotalsRefresh("trade-list-click");
      setTimeout(() => scheduleOfferTotalsRefresh("trade-list-click-post"), 80);
      setTimeout(() => scheduleOfferTotalsRefresh("trade-list-click-late"), 220);
      setTimeout(() => scheduleOfferTotalsRefresh("trade-list-click-later"), 500);
      setTimeout(() => scheduleOfferTotalsRefresh("trade-list-click-latest"), 1000);
    }
  }, true);

  const t = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      observeOfferPanels();
      if (!isTradePage()) {
        state.lastKnownTradeListStatus = null;
        state.lastTradeRowRenderIdentity = null;
        state.pendingTradeRowRenderIdentity = null;
        clearTradeRowValues();
        clearTradeDelta();
        return;
      }
      if (state.data) {
        window.postMessage({ type: "TIS_ROLI_ITEMDETAILS", data: state.data }, "*");
      }
      scheduleDecorate("url-change");
      scheduleOfferTotalsRefresh("url-change");
      scheduleTradeRowValuesRender("url-change", 1400);
    }
    if (!initialized && !initInFlight && isTradePage() && Date.now() >= nextInitAttemptAt) {
      initInFlight = true;
      init()
        .then((ok) => {
          initialized = Boolean(ok);
          nextInitAttemptAt = initialized ? 0 : Date.now() + 10000;
        })
        .catch(() => {
          initialized = false;
          nextInitAttemptAt = Date.now() + 10000;
        })
        .finally(() => {
          initInFlight = false;
        });
    }
  }, 250);
})();
