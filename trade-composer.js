(() => {
  const TAG = "[tis-injected]";
  const shared = window.TIS_GENERIC || {};
  const getExtensionAssetUrl = shared.getExtensionAssetUrl || ((path) => String(path || "").replace(/^\/+/, ""));
  const applyRoliIconStyles = shared.applyRoliIconStyles || ((el) => el);
  const bindLimitedInfoTooltip = shared.bindLimitedInfoTooltip || (() => null);
  const formatLimitedSerialBubble = shared.formatLimitedSerialBubble || (() => false);
  const bridgeRequest = shared.bridgeRequest || (async () => { throw new Error("bridge unavailable"); });
  const getReactTradeItem = shared.getReactTradeItem || (() => null);
  const getReactInventoryController = shared.getReactInventoryController || (() => null);

  if (window.__TIS_LOADED__) {
    window.dispatchEvent(new CustomEvent("TIS_ACTIVATE"));
    return;
  }
  window.__TIS_LOADED__ = true;

  const PAGE_SIZE = 10;
  const REACT_PAGE_SIZE = 12;
  const THUMBNAIL_PAGE_MEMORY_TTL_MS = 30 * 60 * 1000;
  const THUMBNAIL_MY_MEMORY_TTL_MS = 4 * 60 * 60 * 1000;
  const THUMBNAIL_MEMORY_MAX = 800;
  const THUMBNAIL_MEMORY_STORAGE_PREFIX = "tis-thumbnail-memory-v1:";

  const cache = {
    openDD: null,              // { el, anchor }
    roli: null,
    pageContextKey: null,
    panelStates: new WeakMap(),
    panelStatesByKey: new Map(),
    panelStateList: [],
    inventoryDataByOwnerId: new Map(),
    inventoryPromiseByOwnerId: new Map(),
    nativeTradablePagesByOwnerId: new Map(),
    tradableRateLimitUntilByUrl: new Map(),
    tradableItemsPageCache: new Map(),
    rolimonsPlayerByOwnerId: new Map(),
    rolimonsPlayerPromiseByOwnerId: new Map(),
    thumbnailUrlByRequestKey: new Map(),
    thumbnailPromiseByRequestKey: new Map(),
    preloadedThumbnailUrls: new Set(),
    pageThumbnailMemoryByItemKey: new Map(),
    myThumbnailMemoryByItemKey: new Map(),
    myThumbnailMemoryLoadedForUserId: "",
    myThumbnailMemorySaveTimer: null,
    thumbnailMemoryObserver: null,
    lastOfferTotalSignature: "",

  };

  const debug = () => {};

  function getTradesListStatusFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.origin !== "https://trades.roblox.com") return null;
      const match = url.pathname.match(/^\/v1\/trades\/([^/]+)$/i);
      if (!match) return null;
      const status = String(match[1] || "").trim().toLowerCase();
      return ["inbound", "outbound", "completed", "inactive"].includes(status) ? status : null;
    } catch {
      return null;
    }
  }

  function getTradableItemsRequestFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.origin !== "https://trades.roblox.com") return null;
      const match = url.pathname.match(/^\/v2\/users\/([^/]+)\/tradableitems$/i);
      if (!match) return null;
      return {
        ownerId: String(match[1] || ""),
        cursor: String(url.searchParams.get("cursor") || ""),
      };
    } catch {
      return null;
    }
  }

  function rememberNativeTradableItems(request, payload) {
    if (!request || !payload || !Array.isArray(payload.items)) return;

    const ownerId = String(payload.userId || request.ownerId || "");
    if (!/^\d+$/.test(ownerId)) return;

    let pages = cache.nativeTradablePagesByOwnerId.get(ownerId);
    if (!pages) {
      pages = new Map();
      cache.nativeTradablePagesByOwnerId.set(ownerId, pages);
    }
    pages.set(String(request.cursor || ""), payload);
  }

  async function waitForNativeTradableItems(ownerId, cursor, timeoutMs = 1200) {
    const key = String(ownerId || "");
    const pageCursor = String(cursor || "");
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);

    do {
      const payload = cache.nativeTradablePagesByOwnerId.get(key)?.get(pageCursor);
      if (payload) return payload;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (true);
  }

  function emitTradesListPayload(status, payload) {
    if (!status || !payload || typeof payload !== "object") return;
    window.postMessage({
      type: "TIS_TRADES_LIST_DATA",
      status,
      payload,
    }, "*");
  }

  function emitTradeDetailPayload(tradeId, trade) {
    if (!tradeId || !trade || typeof trade !== "object") return;
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

  async function fetchTradeDetailWithPage(tradeId) {
    const res = await fetch(`https://trades.roblox.com/v2/trades/${tradeId}`, {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`http ${res.status}: ${text.slice(0, 200)}`);
    }

    const trade = await res.json();
    if (!Array.isArray(trade?.offers)) {
      trade.offers = [trade?.participantAOffer, trade?.participantBOffer].filter(Boolean);
    }
    return trade;
  }

  function setupTradesListNetworkTap() {
    if (window.__TIS_TRADES_LIST_TAP__) return;
    window.__TIS_TRADES_LIST_TAP__ = true;

    // Roblox's current React bundle can retain fetch before content scripts
    // replace window.fetch. Response.json remains shared, so observing it
    // lets us reuse the inventory payload without issuing a duplicate request.
    const originalResponseJson = Response.prototype.json;
    Response.prototype.json = async function tisResponseJsonTap() {
      const payload = await originalResponseJson.apply(this, arguments);
      try {
        const tradableRequest = getTradableItemsRequestFromUrl(this.url);
        if (tradableRequest && this.ok) rememberNativeTradableItems(tradableRequest, payload);
      } catch (err) {
        debug("response json tap failed", String(err?.message || err));
      }
      return payload;
    };

    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = async function tisFetchTap(input, init) {
        const response = await originalFetch.apply(this, arguments);
        try {
          const url = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input?.url;
          const status = getTradesListStatusFromUrl(url);
          const tradableRequest = getTradableItemsRequestFromUrl(url);
          if (status) {
            response.clone().json()
              .then((payload) => emitTradesListPayload(status, payload))
              .catch((err) => debug("trades list fetch clone failed", status, String(err?.message || err)));
          }
          if (tradableRequest && response.ok) {
            response.clone().json()
              .then((payload) => rememberNativeTradableItems(tradableRequest, payload))
              .catch((err) => debug("tradable items fetch clone failed", String(err?.message || err)));
          }
        } catch (err) {
          debug("trades list fetch tap failed", String(err?.message || err));
        }
        return response;
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function tisXhrOpen(method, url) {
      this.__tisTradesListUrl = typeof url === "string" ? url : String(url || "");
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function tisXhrSend(body) {
      const status = getTradesListStatusFromUrl(this.__tisTradesListUrl);
      const tradableRequest = getTradableItemsRequestFromUrl(this.__tisTradesListUrl);
      if (status || tradableRequest) {
        this.addEventListener("loadend", function onTisTradesListLoadEnd() {
          try {
            if (this.readyState !== 4 || this.status < 200 || this.status >= 300) return;
            const payload = this.responseType === "json"
              ? this.response
              : JSON.parse(this.responseText || "null");
            if (status) emitTradesListPayload(status, payload);
            if (tradableRequest) rememberNativeTradableItems(tradableRequest, payload);
          } catch (err) {
            debug("network tap xhr parse failed", status || "tradable-items", String(err?.message || err));
          }
        }, { once: true });
      }

      return originalSend.apply(this, arguments);
    };

    debug("trades list network tap installed");
  }

  setupTradesListNetworkTap();

  function getMutationElement(node) {
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    return node.parentElement || null;
  }

  function isTisOwnedElement(el) {
    if (!el) return false;

    return Boolean(
      el.id === "tis-multi-style" ||
      el.id === "tis-roli-style" ||
      el.classList?.contains("tis-controls") ||
      el.classList?.contains("tis-multi-dd") ||
      el.classList?.contains("tis-multi-row") ||
      el.classList?.contains("tis-multi-btn") ||
      el.classList?.contains("tis-multi-plus") ||
      el.classList?.contains("tis-pager-label") ||
      el.classList?.contains("tis-bag-of-holding-card") ||
      el.classList?.contains("tis-wishlist-match-name") ||
      el.classList?.contains("tis-roli-row") ||
      el.classList?.contains("tis-proj-icon") ||
      el.classList?.contains("tis-roli-offer-total") ||
      el.classList?.contains("tis-trade-delta") ||
      el.classList?.contains("tis-thumb-memory-img") ||
      el.classList?.contains("tis-react-item-cards") ||
      el.classList?.contains("tis-react-inventory-card") ||
      el.closest?.(".tis-controls, .tis-multi-dd, .tis-bag-of-holding-card, .tis-roli-row, .tis-roli-offer-total, .tis-trade-delta, .tis-thumb-memory-img, .tis-react-item-cards")
    );
  }

  function mutationBatchNeedsInit(mutations) {
    return mutations.some((mutation) => {
      if (!isTisOwnedElement(getMutationElement(mutation.target))) return true;

      for (const node of mutation.addedNodes) {
        if (!isTisOwnedElement(getMutationElement(node))) return true;
      }

      for (const node of mutation.removedNodes) {
        if (!isTisOwnedElement(getMutationElement(node))) return true;
      }

      return false;
    });
  }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const idFromInst = (inst) => String(inst?.id || inst?.collectibleItemInstanceId || "");
    const inOffers = (root, inst) => (typeof root?.isItemInOffers === "function" ? root.isItemInOffers(inst) : false);

    function pickRandomAvailable(group, root) {
    const pool = group.instances.filter(inst => {
        if (inst.isOnHold) return false;
        if (!idFromInst(inst)) return false;
        if (root && inOffers(root, inst)) return false;
        return true;
    });
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
    }


  // calls roblox's real click handler, but "impersonates" a real card click
// by temporarily swapping scope.tradableItem to the instance you want.
window.tisAddToOfferVanilla = function tisAddToOfferVanilla(tradableItem, clickedEl) {
  const reactPanel = clickedEl?.closest?.(".trade-inventory-panel") ||
    document.querySelectorAll(".trade-inventory-panel")[tradableItem?.userId === getUserId() ? 0 : 1] ||
    null;
  const reactController = getReactInventoryController(reactPanel);
  if (reactController?.onItemClick) {
    if (reactController.isItemUnavailable?.(tradableItem) && !reactController.isItemInOffers?.(tradableItem)) {
      return false;
    }
    return dispatchReactInventoryClick(reactPanel, tradableItem);
  }

  if (!window.angular?.element) {
    console.warn("[tis] angular not available");
    return false;
  }

  const el =
    clickedEl ||
    document.querySelector('.item-card-thumb-container[ng-click*="root.onItemCardClick"]');

  if (!el) {
    console.warn("[tis] couldnt find item-card element to borrow scope from");
    return false;
  }

  const ngEl = window.angular.element(el);
  const scope = ngEl.scope?.() || ngEl.isolateScope?.();
  const root = scope?.root;

  if (!scope || !root || typeof root.onItemCardClick !== "function") {
    console.warn("[tis] root.onItemCardClick not found", { scope, root });
    return false;
  }

  const prev = scope.tradableItem;

  const run = () => {
    // impersonate the card's tradableItem, then run vanilla click
    scope.tradableItem = tradableItem;
    try {
      // roblox code expects the argument, so give it too
      root.onItemCardClick(tradableItem);
    } finally {
      // restore so angular doesn't get weird later
      scope.tradableItem = prev;
    }
  };

  if (typeof scope.$applyAsync === "function") {
    scope.$applyAsync(run);
  } else {
    try {
      scope.$apply(run);
    } catch {
      run();
    }
  }

  return true;
};


  (() => {
  if (document.getElementById("tis-multi-style")) return;
  const s = document.createElement("style");
  s.id = "tis-multi-style";
  s.textContent = `
    .tis-multi-btn{
      border:0;
      background:transparent;
      color:#cfd3d8;
      font-weight:600;
      font-size:12px;
      padding:0;
      margin:0;
      cursor:pointer;
      text-shadow:0 1px 1px rgba(0,0,0,.6);
    }
    .tis-multi-plus-float{
    position:absolute;
    right:6px;
    bottom:6px;
    z-index:5;
    padding:0 6px;
    border-radius:6px;
    background:rgba(0,0,0,.25);
    }

    .tis-multi-wrap{
      display:flex;
      align-items:center;
      gap:8px;
    }
    .tis-multi-plus{
      border:0;
      background:transparent;
      color:#cfd3d8;
      font-weight:800;
      font-size:14px;
      padding:0;
      margin:0;
      cursor:pointer;
      text-shadow:0 1px 1px rgba(0,0,0,.6);
      line-height:1;
    }
    .tis-multi-plus:hover{ opacity:.9; }
    .tis-multi-dd{
      position:absolute;
      z-index:2147483647;
      min-width:240px;
      max-height:260px;
      overflow:auto;
      background:#111317;
      border:1px solid rgba(255,255,255,.12);
      border-radius:10px;
      box-shadow:0 12px 28px rgba(0,0,0,.55);
      padding:8px;
    }
    .tis-multi-row{
      display:flex;
      gap:8px;
      align-items:center;
      padding:6px 6px;
      border-radius:8px;
      cursor:pointer;
      color:#e6e9ee;
      user-select:none;
      font-size:12px;
      line-height:1.2;
    }
    .tis-multi-row:hover{ background:rgba(255,255,255,.06); }
    .tis-multi-row input{ cursor:pointer; }
    .tis-multi-row code{
      color:#a9b0ba;
      font-size:11px;
      word-break:break-all;
    }
    .tis-bag-of-holding-anchor{
      position:relative;
      overflow:visible !important;
    }
    .tis-bag-of-holding-dock{
      position:absolute;
      left:-152px;
      top:0;
      width:140px;
      min-width:140px;
      max-width:140px;
      z-index:3;
      display:flex;
      flex-direction:column;
      gap:8px;
    }
    .tis-bag-of-holding-card{
      display:block;
      cursor:default;
      user-select:none;
      width:140px;
      min-width:140px;
      max-width:140px;
      flex:0 0 140px;
    }
    .tis-bag-of-holding-card.tis-bag-of-holding-active{
      outline:2px solid rgba(5,188,228,.7);
      box-shadow:0 0 0 1px rgba(5,188,228,.25), 0 10px 20px rgba(0,0,0,.28);
    }
    .tis-bag-of-holding-card.tis-not-for-trade-active{
      outline:2px solid rgba(245,197,66,.78);
      box-shadow:0 0 0 1px rgba(245,197,66,.28), 0 10px 20px rgba(0,0,0,.28);
    }
    .tis-bag-of-holding-card .item-card-link{
      cursor:default;
    }
    .tis-bag-of-holding-thumb{
      position:relative;
      display:flex;
      align-items:center;
      justify-content:center;
      width:100%;
      aspect-ratio:1 / 1;
      background:rgba(17,19,23,.7);
    }
    .tis-bag-of-holding-image{
      display:block;
      width:100%;
      height:100%;
      object-fit:contain;
      pointer-events:none;
    }
    .trade-inventory-panel .item-card-thumb-container[ng-click*="root.onItemCardClick"],
    .trade-inventory-panel .item-card-thumb-container[ng-click*="root.onItemCardClick"] > thumbnail-2d,
    .trade-inventory-panel .item-card-thumb-container[ng-click*="root.onItemCardClick"] .thumbnail-2d-container{
      background-color:#d0d9fb1f !important;
    }
    .trade-inventory-panel .item-card-thumb-container[ng-click*="root.onItemCardClick"]{
      position:relative !important;
      overflow:hidden !important;
    }

    /* keep roblox's thumbnail box alive so the bg matches immediately */
    .item-card-thumb-container.tis-thumb-memory-thumb > thumbnail-2d,
    .item-card-thumb-container.tis-thumb-memory-thumb .thumbnail-2d-container{
      display:block !important;
      width:100% !important;
      height:100% !important;
      visibility:visible !important;
      opacity:1 !important;
      background-color:#d0d9fb1f !important;
    }

    .item-card-thumb-container.tis-thumb-memory-thumb > thumbnail-2d{
      position:absolute !important;
      inset:0;
      z-index:0 !important;
      pointer-events:none;
    }

    /* hide roblox's actual render/loading crap, not the whole box */
    .item-card-thumb-container.tis-thumb-memory-thumb > thumbnail-2d img:not(.tis-thumb-memory-img),
    .item-card-thumb-container.tis-thumb-memory-thumb > thumbnail-2d canvas,
    .item-card-thumb-container.tis-thumb-memory-thumb > thumbnail-2d [class*="loading" i],
    .item-card-thumb-container.tis-thumb-memory-thumb > thumbnail-2d [class*="spinner" i],
    .item-card-thumb-container.tis-thumb-memory-thumb > thumbnail-2d [class*="shimmer" i],
    .item-card-thumb-container.tis-thumb-memory-thumb > thumbnail-2d [class*="skeleton" i],
    .item-card-thumb-container.tis-thumb-memory-thumb > thumbnail-2d [class*="placeholder" i]{
      visibility:hidden !important;
      opacity:0 !important;
    }

    .item-card-thumb-container.tis-thumb-memory-thumb > img.tis-thumb-memory-img{
      position:absolute !important;
      inset:0;
      z-index:1 !important;
      display:block;
      width:100%;
      height:100%;
      object-fit:contain;
      pointer-events:none;
      background:transparent !important;
    }

    /* Roblox's unavailable container owns both the held overlay and selected check. */
    .trade-item-card .item-card-thumb-container.tis-thumb-memory-thumb > .item-card-equipped{
      position:absolute !important;
      inset:0 !important;
      z-index:30 !important;
      pointer-events:none !important;
    }
    .trade-item-card .item-card-thumb-container.tis-thumb-memory-thumb > .item-card-equipped > .icon-check-selection{
      position:relative !important;
      z-index:31 !important;
    }
    .trade-item-card .item-card-thumb-container.tis-thumb-memory-thumb > .item-card-equipped > .item-card-holding{
      position:relative !important;
      z-index:31 !important;
    }

    /* These extension overlays can sit above the cached thumbnail too. */
    .item-card-thumb-container.tis-thumb-memory-thumb > .limited-icon-container,
    .item-card-thumb-container.tis-thumb-memory-thumb > .tis-multi-plus-float,
    .item-card-thumb-container.tis-thumb-memory-thumb > .tis-proj-icon{
      z-index:20 !important;
    }

    /* The native load-failed message is wrong once our inventory replacement rendered. */
    .trade-inventory-panel .container-empty[ng-show*="loadFailed"]{
      display:none !important;
    }

    .tis-thumb-memory-original-hidden{
      display:none !important;
    }
    .tis-not-for-trade-card .tis-bag-of-holding-image{
      object-fit:contain;
    }
    .tis-bag-of-holding-card .item-card-name{
      text-transform:lowercase;
    }
    .tis-bag-of-holding-value-row{
      display:flex;
      align-items:center;
      gap:0;
    }
    .tis-bag-of-holding-value-icon{
      flex:0 0 auto;
    }
    .tis-bag-of-holding-count-wrap{
      position:absolute;
      right:6px;
      bottom:6px;
      z-index:5;
      padding:0 6px;
      border-radius:6px;
      background:rgba(0,0,0,.25);
      pointer-events:none;
    }
    .tis-bag-of-holding-count{
      pointer-events:none;
    }

    .trade-inventory-panel .item-card-thumb-container[ng-click*="root.onItemCardClick"] > .icon-check-selection,
    .trade-inventory-panel .item-card-thumb-container[ng-click*="root.onItemCardClick"] > .icon-checkmark,
    .trade-inventory-panel .item-card-thumb-container[ng-click*="root.onItemCardClick"] > .icon-checkmark-on{
      position:absolute !important;
      top:6px !important;
      right:6px !important;
      z-index:40 !important;
      pointer-events:none !important;
    }

    /* cached thumbnail stays below overlays */
    .trade-inventory-panel .item-card-thumb-container[ng-click*="root.onItemCardClick"] > img.tis-thumb-memory-img{
      position:absolute !important;
      inset:0 !important;
      z-index:1 !important;
      display:block !important;
      width:100% !important;
      height:100% !important;
      object-fit:contain !important;
      pointer-events:none !important;
      background:transparent !important;
    }

    /* serial / limited / sparkle / plus overlays */
    .trade-inventory-panel .item-card-thumb-container[ng-click*="root.onItemCardClick"] > .limited-icon-container,
    .trade-inventory-panel .item-card-thumb-container[ng-click*="root.onItemCardClick"] > .tis-multi-plus-float,
    .trade-inventory-panel .item-card-thumb-container[ng-click*="root.onItemCardClick"] > .tis-proj-icon{
      position:absolute !important;
      z-index:20 !important;
    }

    .trade-inventory-panel > div .tis-react-item-cards{
      min-height:0;
    }
    .tis-react-inventory-card .thumbnail-2d-container{
      display:block;
      position:relative;
      width:100%;
      height:100%;
    }
    .tis-react-inventory-card .tis-react-card-image{
      display:block;
      width:100%;
      height:100%;
      object-fit:contain;
    }
    .tis-react-inventory-card.tis-react-selected .item-card-thumb-container-inner{
      outline:3px solid #00b06f;
      outline-offset:-3px;
      border-radius:8px;
    }
    .tis-react-inventory-card.tis-react-unavailable{
      opacity:.55;
    }
  `;
  const mount = document.head || document.documentElement;
  if (mount) {
    mount.appendChild(s);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      const lateMount = document.head || document.documentElement;
      if (lateMount && !document.getElementById("tis-multi-style")) {
        lateMount.appendChild(s);
      }
    }, { once: true });
  }
})();

  const isOnTradePage = () => {
    const u = location.href;
    return (
      u.startsWith("https://www.roblox.com/users/") && u.includes("/trade")
    ) || (
      u.startsWith("https://www.roblox.com/trades/") && u.includes("/counter")
    );
  };

  const isActive = (panelState) => {
    return panelState?.all !== null;
  };

  function isBagOfHoldingEnabled() {
    return document.documentElement?.dataset?.tisBagOfHolding === "true";
  }

  function getTradePageContextKey() {
    if (!isOnTradePage()) return null;
    return `${location.origin}${location.pathname}${location.search}`;
  }

  function syncControlValues(panel, panelState = getPanelState(panel)) {
    if (!panel || !panelState) return;

    const minInput = panel.querySelector('.tis-input[data-tis-filter="min"]');
    const maxInput = panel.querySelector('.tis-input[data-tis-filter="max"]');
    const searchInput = panel.querySelector('.tis-input[data-tis-filter="search"]');

    if (minInput) {
      const next = panelState.min === null || !Number.isFinite(panelState.min) ? "" : String(panelState.min);
      if (minInput.value !== next) minInput.value = next;
    }

    if (maxInput) {
      const next = panelState.max === null || !Number.isFinite(panelState.max) ? "" : String(panelState.max);
      if (maxInput.value !== next) maxInput.value = next;
    }

    if (searchInput) {
      const next = String(panelState.searchQuery || "");
      if (searchInput.value !== next) searchInput.value = next;
    }
  }

  function resetInventoryViewState(reason = "unknown") {
    cache.panelStateList.forEach((panelState) => {
      try { panelState.offerObs?.disconnect(); } catch {}
    });
    cache.panelStates = new WeakMap();
    cache.panelStatesByKey = new Map();
    cache.panelStateList = [];
    cache.inventoryDataByOwnerId.clear();
    cache.inventoryPromiseByOwnerId.clear();
    cache.pageThumbnailMemoryByItemKey.clear();
    cache.lastOfferTotalSignature = "";

    closeMultiDD();
    debug("reset inventory view state", reason);
  }

  async function fetchTradableItemsPage(url) {
    const key = String(url || "");
    const now = Date.now();
    const cached = cache.tradableItemsPageCache.get(key);
    const rateLimitUntil = Number(cache.tradableRateLimitUntilByUrl.get(key) || 0);

    if (rateLimitUntil > now) {
      throw new Error(`tradable items cooldown until ${rateLimitUntil}`);
    }

    if (cached?.data && (now - cached.at) < 30000) {
      return cached.data;
    }

    if (cached?.promise) {
      return cached.promise;
    }

    const promise = (async () => {
      const res = await fetch(key, { credentials: "include" });

      if (!res.ok) {
        if (res.status === 429) {
          cache.tradableRateLimitUntilByUrl.set(key, Date.now() + 30000);
        }
        const txt = await res.text().catch(() => "");
        throw new Error(`http ${res.status} from trades api: ${txt.slice(0, 200)}`);
      }

      const data = await res.json();
      cache.tradableItemsPageCache.set(key, {
        data,
        at: Date.now(),
      });
      return data;
    })().catch((err) => {
      const latest = cache.tradableItemsPageCache.get(key);
      if (latest?.promise) cache.tradableItemsPageCache.delete(key);
      throw err;
    });

    cache.tradableItemsPageCache.set(key, {
      promise,
      at: now,
    });

    return promise;
  }

  function extractBalancedObjectLiteral(source, marker) {
    const text = String(source || "");
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return null;

    const start = text.indexOf("{", markerIndex);
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let quote = "";
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      const next = text[i + 1];

      if (inLineComment) {
        if (ch === "\n" || ch === "\r") inLineComment = false;
        continue;
      }

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          inString = false;
        }
        continue;
      }

      if (ch === "/" && next === "/") {
        inLineComment = true;
        i += 1;
        continue;
      }

      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 1;
        continue;
      }

      if (ch === "\"" || ch === "'" || ch === "`") {
        inString = true;
        quote = ch;
        continue;
      }

      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }

    return null;
  }

  function parseRolimonsPlayerDetails(html, expectedUserId = null) {
    const objectLiteral = extractBalancedObjectLiteral(html, "player_details_data");
    if (!objectLiteral) throw new Error("missing player_details_data");

    let raw;
    try {
      raw = JSON.parse(objectLiteral);
    } catch {
      raw = JSON.parse(objectLiteral.replace(/,\s*([}\]])/g, "$1"));
    }

    const wishlistAssetIds = new Set();
    const wishlistIds = raw?.wishlist?.asset_ids;
    if (Array.isArray(wishlistIds)) {
      wishlistIds.forEach((id) => {
        const value = String(id || "");
        if (/^\d+$/.test(value)) wishlistAssetIds.add(value);
      });
    }

    const nftAssetIds = new Set();
    const nftAssets = [];
    const addNftAssetId = (id) => {
      const value = String(id || "");
      if (!/^\d+$/.test(value) || nftAssetIds.has(value)) return;
      nftAssetIds.add(value);
      nftAssets.push(value);
    };

    const askingAssets = raw?.asking_list?.assets;
    if (Array.isArray(askingAssets)) {
      askingAssets.forEach((asset) => {
        const isNft = asset?.nft === true || asset?.nft === 1 || asset?.nft === "1" || asset?.nft === "true";
        // Rolimons also marks an item as not-for-trade by setting the asking
        // value to its 404000 sentinel. This is a request value, not the
        // item's Rolimons value, so it belongs with `nft` in this list.
        const hasNotForTradeAskingValue = String(asset?.value ?? "") === "404000";
        const tags = Array.isArray(asset?.tags)
          ? asset.tags
          : [asset?.tags, asset?.tag, asset?.tagId, asset?.tag_id];
        const isNotForTradeTag = tags.some((tag) =>
          [tag, tag?.id, tag?.value, tag?.tag].some((value) => String(value || "") === "404000")
        );
        if (!isNft && !hasNotForTradeAskingValue && !isNotForTradeTag) return;
        addNftAssetId(asset?.id ?? asset?.asset_id ?? asset?.assetId ?? asset?.item_id ?? asset?.itemId ?? asset?.itemid ?? asset?.item?.id);
      });
    }

    return {
      userId: Number(raw?.player_id || expectedUserId || 0) || null,
      playerName: String(raw?.player_name || ""),
      wishlistAssetIds,
      nftAssetIds,
      nftAssets,
      lastUpdated: Number(raw?.wishlist?.last_updated || 0) || null,
    };
  }

  async function fetchRolimonsPlayerDetails(userId) {
    const uid = String(userId || "");
    if (!/^\d+$/.test(uid)) return null;

    const cached = cache.rolimonsPlayerByOwnerId.get(uid);
    if (cached) return cached;

    const existing = cache.rolimonsPlayerPromiseByOwnerId.get(uid);
    if (existing) return existing;

    const promise = (async () => {
      const resp = await bridgeRequest("runtimeSendMessage", {
        type: "TIS_FETCH_ROLIMONS_PLAYER",
        userId: uid,
      }, 15000);

      if (!resp?.ok || typeof resp.html !== "string") {
        throw new Error(resp?.error || "rolimons player fetch failed");
      }

      const details = parseRolimonsPlayerDetails(resp.html, uid);
      cache.rolimonsPlayerByOwnerId.set(uid, details);
      return details;
    })().catch((err) => {
      cache.rolimonsPlayerPromiseByOwnerId.delete(uid);
      throw err;
    });

    cache.rolimonsPlayerPromiseByOwnerId.set(uid, promise);
    return promise;
  }

  function getAssetIdForInst(inst) {
    const candidates = [
      inst?.itemTarget?.targetId,
      inst?.assetId,
      inst?.asset?.id,
      inst?.details?.assetId,
      inst?.collectibleItemDetails?.assetId,
      inst?.itemDetails?.assetId,
      inst?.collectibleItemId,
    ];

    for (const candidate of candidates) {
      const value = String(candidate || "");
      if (/^\d+$/.test(value)) return value;
    }

    return null;
  }

  function getGroupKeyForInst(inst) {
    const type = inst?.itemTarget?.itemType || "Asset";
    const tid = inst?.itemTarget?.targetId || getAssetIdForInst(inst) || "0";
    return `${type}:${tid}`;
  }

  function isNotForTradeAssetId(panelState, assetId) {
    const value = String(assetId || "");
    return Boolean(value && panelState?.playerDetails?.nftAssetIds?.has(value));
  }

  function isNotForTradeInstance(panelState, inst) {
    return isNotForTradeAssetId(panelState, getAssetIdForInst(inst));
  }

  function addToGroupMap(map, inst) {
    const key = getGroupKeyForInst(inst);
    let g = map.get(key);
    if (!g) {
      g = { key, instances: [], rep: null, count: 0, viewRep: null };
      map.set(key, g);
    }
    g.instances.push(inst);
  }

  function finalizeGroups(map, preferTradableRep = true) {
    return Array.from(map.values()).map((g) => {
      g.count = g.instances.length;
      g.rep = preferTradableRep ? (g.instances.find(x => !x.isOnHold) || g.instances[0]) : g.instances[0];
      g.viewRep = null;
      return g;
    });
  }

  function rebuildInventoryGroups(panelState) {
    if (!panelState) return [];

    panelState.groupMap = new Map();
    panelState.mainGroupMap = new Map();
    panelState.bagGroupMap = new Map();
    panelState.nftGroupMap = new Map();

    for (const inst of panelState.all || []) {
      const isNft = isNotForTradeInstance(panelState, inst);
      addToGroupMap(panelState.groupMap, inst);
      if (inst?.isOnHold) addToGroupMap(panelState.bagGroupMap, inst);
      if (isNft) addToGroupMap(panelState.nftGroupMap, inst);
      if (!inst?.isOnHold && !isNft) addToGroupMap(panelState.mainGroupMap, inst);
    }

    panelState.groups = finalizeGroups(panelState.groupMap, true);
    panelState.mainGroups = finalizeGroups(panelState.mainGroupMap, true);
    panelState.bagGroups = finalizeGroups(panelState.bagGroupMap, false);
    panelState.nftGroups = finalizeGroups(panelState.nftGroupMap, false);
    panelState.computed = getMainGroups(panelState).slice();
    panelState.bagComputed = panelState.bagGroups.slice();
    panelState.nftComputed = panelState.nftGroups.slice();
    return panelState.nftGroups;
  }

  function hydratePanelStateFromAll(panelState, all) {
    panelState.all = all;
    panelState.loadingPromise = null;
    panelState.instById = new Map();
    for (const inst of all) {
      const id = String(inst.id || inst.collectibleItemInstanceId || "");
      if (id) panelState.instById.set(id, inst);
    }

    panelState.instKeyById = new Map();
    for (const inst of all) {
      const id = String(inst.id || inst.collectibleItemInstanceId || "");
      if (!id) continue;
      panelState.instKeyById.set(id, getGroupKeyForInst(inst));
    }

    rebuildInventoryGroups(panelState);
    preloadThumbnailsForGroups(panelState, panelState.mainGroups.slice(0, PAGE_SIZE * 4), "hydrate-main");
    preloadThumbnailsForGroups(panelState, panelState.bagGroups.slice(0, PAGE_SIZE * 2), "hydrate-bag");
    ensureNotForTradeThumbnailsLoaded(panelState, "hydrate-inventory");
    debug("inventory grouped", {
      groups: panelState.groups.length,
      mainGroups: panelState.mainGroups.length,
      bagGroups: panelState.bagGroups.length,
      nftGroups: panelState.nftGroups.length,
      panelKey: panelState.panelKey,
    });
    return all;
  }

  function createNotForTradeInstance(assetId, panelState) {
    const id = String(assetId || "");
    const info = cache.roli?.[id] || null;
    const rap = Number(info?.rap ?? info?.recentAveragePrice ?? 0) || 0;
    const name = String(info?.name || `Asset ${id}`).trim();

    return {
      id: `tis-nft-${id}`,
      collectibleItemInstanceId: `tis-nft-${id}`,
      collectibleItemId: id,
      userId: panelState?.ownerId || null,
      itemTarget: {
        itemType: "Asset",
        targetId: Number(id),
      },
      itemName: name,
      recentAveragePrice: rap,
      originalPrice: 0,
      assetStock: 0,
      layoutOptions: {
        isIconDisabled: false,
        isUnique: false,
        isLimitedNumberShown: false,
        limitedNumber: null,
      },
      __tisNotForTrade: true,
    };
  }

  function rebuildNotForTradeGroups(panelState) {
    if (!panelState?.all) {
      panelState.nftGroupMap = new Map();
      panelState.nftGroups = [];
      panelState.nftComputed = [];
      return [];
    }
    rebuildInventoryGroups(panelState);
    ensureNotForTradeThumbnailsLoaded(panelState, "rebuild-not-for-trade-groups");
    return panelState.nftGroups;
  }

  function getRolimonsPlayerDetailsForPanelState(panelState) {
    if (!panelState) return null;
    if (panelState.playerDetails) return panelState.playerDetails;

    const ownerId = resolvePanelOwnerId(panelState);
    const cached = ownerId ? cache.rolimonsPlayerByOwnerId.get(String(ownerId)) : null;
    if (cached) {
      panelState.playerDetails = cached;
      rebuildNotForTradeGroups(panelState);
      ensureNotForTradeThumbnailsLoaded(panelState, "cached-rolimons-player");
      return cached;
    }

    return null;
  }

  function getCounterpartyPanelState(panelState) {
    if (!panelState) return null;
    const preferred = cache.panelStateList.find((candidate) => {
      if (candidate === panelState) return false;
      return candidate.isMine !== panelState.isMine;
    });
    if (preferred) return preferred;

    const ownerId = resolvePanelOwnerId(panelState);
    return cache.panelStateList.find((candidate) => {
      if (candidate === panelState) return false;
      const candidateOwnerId = resolvePanelOwnerId(candidate);
      return ownerId && candidateOwnerId && ownerId !== candidateOwnerId;
    }) || null;
  }

  function refreshPlayerDetailsDependentViews(reason = "player-details") {
    cache.panelStateList.forEach((panelState) => {
      const livePanel = getLivePanel(panelState);
      if (!livePanel) return;

      if (panelState.playerDetails) {
        rebuildNotForTradeGroups(panelState);
        ensureNotForTradeThumbnailsLoaded(panelState, `${reason}-refresh`);
      }

      if (panelState.all || panelState.viewMode === "nft") {
        try { applyToAngular(livePanel, panelState); } catch (err) {
          debug("player detail refresh apply failed", reason, String(err?.message || err));
        }
      }

      try { renderBagOfHoldingCard(livePanel, panelState); } catch {}
    });
  }

  async function ensureRolimonsPlayerDetailsForPanel(panelState) {
    if (!panelState) return null;

    const ownerId = resolvePanelOwnerId(panelState);
    if (!ownerId) return null;

    const ownerKey = String(ownerId);
    if (panelState.playerDetails && String(panelState.playerDetails.userId || ownerKey) === ownerKey) {
      await ensureNotForTradeThumbnailsLoaded(panelState, "existing-rolimons-player");
      return panelState.playerDetails;
    }

    const details = await fetchRolimonsPlayerDetails(ownerKey);
    panelState.playerDetails = details;
    panelState.playerDetailsOwnerId = ownerKey;
    rebuildNotForTradeGroups(panelState);
    await ensureNotForTradeThumbnailsLoaded(panelState, "rolimons-player-loaded");
    refreshPlayerDetailsDependentViews("rolimons-player-loaded");
    return details;
  }

  function noteRolimonsPlayerDetailsError(panelState, err) {
    if (!panelState) return;
    const message = String(err?.message || err || "unknown rolimons player error");
    if (panelState.playerDetailsLastError === message) return;
    panelState.playerDetailsLastError = message;
    console.warn(`${TAG} rolimons player details failed for ${panelState.panelKey}:`, message);
  }


  function getUserId() {
    // most reliable on roblox pages
    const meta = document.querySelector('meta[name="user-data"]');
    const fromMeta = meta?.getAttribute("data-userid");
    if (fromMeta && /^\d+$/.test(fromMeta)) return Number(fromMeta);

    const body = document.querySelector("#rbx-body");
    const fromBody = body?.getAttribute("data-userid");
    if (fromBody && /^\d+$/.test(fromBody)) return Number(fromBody);

    // fallback-ish
    const rb = window.Roblox;
    const maybe =
      rb?.UserId ||
      rb?.CurrentUser?.userId ||
      rb?.CurrentUser?.id ||
      rb?.users?.getCurrentUser?.()?.id;

    if (maybe && String(maybe).match(/^\d+$/)) return Number(maybe);

    return null;
  }

  function getTradePartnerUserIdFromUrl() {
    const match = location.pathname.match(/^\/users\/(\d+)\/trade/i);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  function getInventoryPanels() {
    return Array.from(document.querySelectorAll(".trade-inventory-panel"));
  }

  function removeBuiltInItemTypeDropdown(panel) {
  if (!panel) return;

  panel.querySelectorAll(".inventory-type-dropdown").forEach((el) => el.remove());
  panel.querySelectorAll(".inventory-filter-row").forEach((el) => {
    if (!el.closest(".tis-controls")) el.style.display = "none";
  });

  const btns = panel.querySelectorAll('button.input-dropdown-btn[data-toggle="dropdown"]');
  btns.forEach((btn) => {
    const kill =
      btn.closest(".inventory-type-dropdown") ||
      btn.closest(".input-group-btn") ||
      btn.closest(".input-group") ||
      btn.parentElement;

    if (kill) kill.remove();
  });
  }

  function getBagOfHoldingList(panel) {
    return panel?.querySelector("ul.tis-react-item-cards, ul.item-cards, ul.hlist.item-cards, .item-cards") || null;
  }

  function getBagOfHoldingAnchor(panel) {
    return panel?.querySelector(".tis-bag-of-holding-anchor") || null;
  }

  function getBagOfHoldingDock(panel) {
    return panel?.querySelector(".tis-bag-of-holding-dock") || null;
  }

  function getBagOfHoldingCard(panel) {
    return panel?.querySelector(".tis-bag-of-holding-card:not(.tis-not-for-trade-card)") || null;
  }

  function getNotForTradeCard(panel) {
    return panel?.querySelector(".tis-not-for-trade-card") || null;
  }

  function removeBagOfHoldingCard(panel) {
    getBagOfHoldingDock(panel)?.remove();
  }

  function ensureBagOfHoldingLayout(panel) {
    const list = getBagOfHoldingList(panel);
    if (!panel || !list) return { list, anchor: null, dock: null };

    const anchor = list.parentElement || panel;
    if (!anchor) return { list, anchor: null, dock: null };
    anchor.classList.add("tis-bag-of-holding-anchor");

    let dock = getBagOfHoldingDock(panel);
    if (!dock) {
      dock = document.createElement("div");
      dock.className = "tis-bag-of-holding-dock";
      anchor.appendChild(dock);
    } else if (dock.parentElement !== anchor) {
      anchor.appendChild(dock);
    }

    return { list, anchor, dock };
  }

  function computeBagOfHoldingTotals(panelState) {
    const onHoldItems = Array.isArray(panelState?.all)
      ? panelState.all.filter((inst) => inst?.isOnHold)
      : [];

    let rap = 0;
    let value = 0;

    onHoldItems.forEach((inst) => {
      rap += Number(inst?.recentAveragePrice ?? 0) || 0;
      value += offerValueForInst(inst);
    });

    return {
      count: onHoldItems.length,
      rap,
      value,
    };
  }

  function computeGroupTotals(groups) {
    let rap = 0;
    let value = 0;
    let count = 0;

    (Array.isArray(groups) ? groups : []).forEach((group) => {
      const instances = Array.isArray(group?.instances) ? group.instances : [];
      const groupCount = instances.length || Number(group?.count || 0) || 0;
      count += groupCount;

      if (instances.length) {
        instances.forEach((inst) => {
          rap += Number(inst?.recentAveragePrice ?? 0) || 0;
          value += offerValueForInst(inst);
        });
        return;
      }

      const rep = group?.rep;
      if (!rep || !groupCount) return;
      rap += (Number(rep?.recentAveragePrice ?? 0) || 0) * groupCount;
      value += offerValueForInst(rep) * groupCount;
    });

    return { count, rap, value };
  }

  function computeMainInventoryTotals(panelState) {
    return computeGroupTotals(getMainGroups(panelState));
  }

  function computeNotForTradeTotals(panelState) {
    return computeGroupTotals(panelState?.nftGroups || []);
  }

  async function fetchRobloxThumbnailRequests(requests) {
    const normalized = Array.from(new Map((Array.isArray(requests) ? requests : [])
      .map((request) => ({
        targetId: String(request?.targetId || ""),
        type: String(request?.type || "Asset"),
        requestId: String(request?.requestId || `${request?.type || "Asset"}:${request?.targetId || ""}`),
        size: String(request?.size || "150x150"),
        format: String(request?.format || "Webp"),
        isCircular: Boolean(request?.isCircular),
      }))
      .filter((request) => /^\d+$/.test(request.targetId) && request.requestId)
      .map((request) => [request.requestId, request])).values());

    if (!normalized.length) return {};

    const thumbnails = {};
    const missing = [];

    normalized.forEach((request) => {
      const cached = cache.thumbnailUrlByRequestKey.get(request.requestId);
      if (cached) {
        thumbnails[request.requestId] = cached;
        preloadThumbnailUrls(cached);
      }
      else missing.push(request);
    });

    if (!missing.length) return thumbnails;

    const toFetch = missing.filter((request) => !cache.thumbnailPromiseByRequestKey.has(request.requestId));
    const buildRows = (rows) => {
      const out = {};
      Object.entries(rows && typeof rows === "object" ? rows : {}).forEach(([requestId, imageUrl]) => {
        const url = normalizeThumbnailUrl(imageUrl);
        if (!requestId || !url) return;
        cache.thumbnailUrlByRequestKey.set(String(requestId), url);
        preloadThumbnailUrls(url);
        out[String(requestId)] = url;
      });
      return out;
    };

    const fetchDirect = async (batch) => {
      const res = await fetch("https://thumbnails.roblox.com/v1/batch", {
        method: "POST",
        credentials: "include",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify(batch.map((request) => ({
          requestId: request.requestId,
          targetId: Number(request.targetId),
          type: request.type,
          size: request.size,
          format: request.format,
          isCircular: request.isCircular,
        }))),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`thumbnail batch http ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = await res.json();
      const rows = {};
      (Array.isArray(json?.data) ? json.data : []).forEach((row) => {
        const requestId = String(row?.requestId || "");
        const imageUrl = normalizeThumbnailUrl(row?.imageUrl);
        if (!requestId || !imageUrl) return;
        rows[requestId] = imageUrl;
      });
      return rows;
    };

    if (toFetch.length) {
      const batchPromise = (async () => {
        let rows = {};
        try {
          const resp = await bridgeRequest("runtimeSendMessage", {
            type: "TIS_FETCH_ROBLOX_ASSET_THUMBNAILS",
            thumbnailRequests: toFetch,
          }, 10000);

          if (!resp?.ok) throw new Error(resp?.error || "thumbnail bridge failed");
          rows = buildRows(resp?.thumbnails);
        } catch (err) {
          debug("thumbnail bridge failed, trying direct batch", String(err?.message || err));
          rows = buildRows(await fetchDirect(toFetch));
        }

        const unresolved = toFetch.filter((request) => !rows[request.requestId]);
        if (unresolved.length) {
          debug("thumbnail bridge missing rows, trying direct batch", unresolved.map((request) => request.requestId));
          Object.assign(rows, buildRows(await fetchDirect(unresolved)));
        }

        Object.assign(thumbnails, rows);
        return rows;
      })();

      toFetch.forEach((request) => {
        const perRequestPromise = batchPromise
          .then((rows) => String(rows?.[request.requestId] || cache.thumbnailUrlByRequestKey.get(request.requestId) || ""))
          .finally(() => cache.thumbnailPromiseByRequestKey.delete(request.requestId));
        cache.thumbnailPromiseByRequestKey.set(request.requestId, perRequestPromise);
      });
    }

    const pendingResults = await Promise.allSettled(missing.map(async (request) => {
      const url = await cache.thumbnailPromiseByRequestKey.get(request.requestId);
      return [request.requestId, url];
    }));
    pendingResults.forEach((result) => {
      if (result.status !== "fulfilled") return;
      const [requestId, url] = result.value || [];
      if (requestId && url) thumbnails[requestId] = url;
    });

    normalized.forEach((request) => {
      const cached = cache.thumbnailUrlByRequestKey.get(request.requestId);
      if (cached) thumbnails[request.requestId] = cached;
    });

    return thumbnails;
  }

  function getThumbnailTypeForGroup(group) {
    const rep = group?.rep || group?.instances?.[0] || null;
    return getThumbnailTypeForInst(rep, group?.key?.split?.(":")?.[0]);
  }

  function getThumbnailTargetIdForGroup(group) {
    const rep = group?.rep || group?.instances?.[0] || null;
    const candidates = [getThumbnailTargetIdForInst(rep), getAssetIdForGroup(group)];

    for (const candidate of candidates) {
      const value = String(candidate || "");
      if (/^\d+$/.test(value)) return value;
    }

    return "";
  }

  function getThumbnailTypeForInst(inst, fallbackType = "Asset") {
    const itemType = String(inst?.itemTarget?.itemType || fallbackType || "Asset").toLowerCase();
    return itemType.includes("bundle") ? "BundleThumbnail" : "Asset";
  }

  function getThumbnailTargetIdForInst(inst) {
    const candidates = [
      inst?.itemTarget?.targetId,
      getAssetIdForInst(inst),
    ];

    for (const candidate of candidates) {
      const value = String(candidate || "");
      if (/^\d+$/.test(value)) return value;
    }

    return "";
  }

  function getThumbnailMemoryKey(type, targetId) {
    const normalizedType = String(type || "Asset").toLowerCase().includes("bundle") ? "BundleThumbnail" : "Asset";
    const id = String(targetId || "");
    return /^\d+$/.test(id) ? `${normalizedType}:${id}` : "";
  }

  function getThumbnailMemoryKeyForInst(inst) {
    return getThumbnailMemoryKey(getThumbnailTypeForInst(inst), getThumbnailTargetIdForInst(inst));
  }

  function getThumbnailMemoryKeyForThumb(thumb, tradableItem = null) {
    const candidates = Array.from(thumb?.querySelectorAll?.(".thumbnail-2d-container[thumbnail-target-id], thumbnail-2d[thumbnail-target-id], [thumbnail-target-id]") || []);
    for (const node of candidates) {
      const domTargetId = node?.getAttribute?.("thumbnail-target-id");
      const domType = node?.getAttribute?.("thumbnail-type");
      const fromDom = getThumbnailMemoryKey(domType, domTargetId);
      if (fromDom) return fromDom;
    }

    const href = String(thumb?.closest?.(".item-card-container")?.querySelector?.(".item-card-caption a[href]")?.getAttribute?.("href") || "");
    const bundleMatch = href.match(/\/bundles\/(\d+)/i);
    if (bundleMatch) return getThumbnailMemoryKey("BundleThumbnail", bundleMatch[1]);
    const assetMatch = href.match(/\/catalog\/(\d+)/i);
    if (assetMatch) return getThumbnailMemoryKey("Asset", assetMatch[1]);

    const targetFromContainer = thumb?.querySelector?.(".thumbnail-2d-container")?.getAttribute?.("thumbnail-target-id");
    const typeFromContainer = thumb?.querySelector?.(".thumbnail-2d-container")?.getAttribute?.("thumbnail-type");
    const fromContainer = getThumbnailMemoryKey(typeFromContainer, targetFromContainer);
    if (fromContainer) return fromContainer;

    return getThumbnailMemoryKeyForInst(tradableItem);
  }

  function normalizeThumbnailUrl(url) {
    const clean = String(url || "").trim();
    if (!clean) return "";
    return /^(https?:|data:|blob:|chrome-extension:)/i.test(clean) ? clean : "";
  }

  function normalizeRenderedRobloxThumbnailUrl(url) {
    const clean = normalizeThumbnailUrl(url);
    if (!clean) return "";
    return /^https:\/\/tr\.rbxcdn\.com\//i.test(clean) ? clean : "";
  }

  function preloadThumbnailUrls(urls) {
    (Array.isArray(urls) ? urls : [urls]).forEach((url) => {
      const clean = normalizeThumbnailUrl(url);
      if (!clean || cache.preloadedThumbnailUrls.has(clean)) return;
      cache.preloadedThumbnailUrls.add(clean);
      try {
        const image = new Image();
        image.decoding = "async";
        image.src = clean;
      } catch {}
    });
  }

  function getKnownThumbnailUrlForInst(inst) {
    const candidates = [
      inst?.thumbnailUrl,
      inst?.imageUrl,
      inst?.thumbnail?.imageUrl,
      inst?.itemDetails?.thumbnailUrl,
      inst?.itemDetails?.imageUrl,
      inst?.collectibleItemDetails?.thumbnailUrl,
      inst?.collectibleItemDetails?.imageUrl,
      inst?.details?.thumbnailUrl,
      inst?.details?.imageUrl,
    ];

    for (const candidate of candidates) {
      const url = normalizeThumbnailUrl(candidate);
      if (url) return url;
    }

    return "";
  }

  function getKnownThumbnailUrlForGroup(group) {
    const candidates = [
      group?.rep,
      group?.viewRep,
      ...(Array.isArray(group?.instances) ? group.instances : []),
    ];

    for (const inst of candidates) {
      const url = getKnownThumbnailUrlForInst(inst);
      if (url) return url;
    }

    return "";
  }

  function pruneThumbnailMemoryMap(map, ttlMs) {
    const now = Date.now();
    for (const [key, entry] of map.entries()) {
      if (!entry?.url || (now - Number(entry.at || 0)) > ttlMs) map.delete(key);
    }

    if (map.size <= THUMBNAIL_MEMORY_MAX) return;
    const entries = Array.from(map.entries()).sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0));
    while (entries.length && map.size > THUMBNAIL_MEMORY_MAX) {
      const [key] = entries.shift();
      map.delete(key);
    }
  }

  function getMyThumbnailMemoryStorageKey() {
    const uid = getUserId();
    return uid ? `${THUMBNAIL_MEMORY_STORAGE_PREFIX}${uid}` : "";
  }

  function loadMyThumbnailMemory() {
    const storageKey = getMyThumbnailMemoryStorageKey();
    if (!storageKey || cache.myThumbnailMemoryLoadedForUserId === storageKey) return;

    cache.myThumbnailMemoryLoadedForUserId = storageKey;
    cache.myThumbnailMemoryByItemKey.clear();

    try {
      const raw = sessionStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      Object.entries(parsed && typeof parsed === "object" ? parsed : {}).forEach(([key, entry]) => {
        const itemKey = String(key || "");
        const url = normalizeRenderedRobloxThumbnailUrl(entry?.url);
        const at = Number(entry?.at || 0);
        if (!itemKey || !url || !at) return;
        cache.myThumbnailMemoryByItemKey.set(itemKey, { url, at });
      });
      pruneThumbnailMemoryMap(cache.myThumbnailMemoryByItemKey, THUMBNAIL_MY_MEMORY_TTL_MS);
    } catch {
      cache.myThumbnailMemoryByItemKey.clear();
    }
  }

  function scheduleMyThumbnailMemorySave() {
    clearTimeout(cache.myThumbnailMemorySaveTimer);
    cache.myThumbnailMemorySaveTimer = setTimeout(() => {
      const storageKey = getMyThumbnailMemoryStorageKey();
      if (!storageKey) return;

      pruneThumbnailMemoryMap(cache.myThumbnailMemoryByItemKey, THUMBNAIL_MY_MEMORY_TTL_MS);
      const payload = {};
      cache.myThumbnailMemoryByItemKey.forEach((entry, key) => {
        if (entry?.url) payload[key] = entry;
      });

      try {
        sessionStorage.setItem(storageKey, JSON.stringify(payload));
      } catch {}
    }, 250);
  }

  function rememberThumbnailUrl(itemKey, url, panelState = null) {
    const key = String(itemKey || "");
    const clean = normalizeRenderedRobloxThumbnailUrl(url);
    if (!key || !clean) return false;

    if (/^(?:Asset|BundleThumbnail):\d+$/.test(key)) {
      cache.thumbnailUrlByRequestKey.set(key, clean);
    }
    preloadThumbnailUrls(clean);

    const now = Date.now();
    const existing = cache.pageThumbnailMemoryByItemKey.get(key);
    if (!existing || existing.url !== clean) {
      cache.pageThumbnailMemoryByItemKey.set(key, { url: clean, at: now });
    } else {
      existing.at = now;
    }
    pruneThumbnailMemoryMap(cache.pageThumbnailMemoryByItemKey, THUMBNAIL_PAGE_MEMORY_TTL_MS);

    if (panelState?.isMine) {
      loadMyThumbnailMemory();
      const myExisting = cache.myThumbnailMemoryByItemKey.get(key);
      if (!myExisting || myExisting.url !== clean) {
        cache.myThumbnailMemoryByItemKey.set(key, { url: clean, at: now });
      } else {
        myExisting.at = now;
      }
      scheduleMyThumbnailMemorySave();
    }

    return true;
  }

  function getRememberedThumbnailUrl(itemKey) {
    const key = String(itemKey || "");
    if (!key) return "";

    pruneThumbnailMemoryMap(cache.pageThumbnailMemoryByItemKey, THUMBNAIL_PAGE_MEMORY_TTL_MS);
    const pageEntry = cache.pageThumbnailMemoryByItemKey.get(key);
    const pageUrl = normalizeRenderedRobloxThumbnailUrl(pageEntry?.url);
    if (pageUrl) {
      preloadThumbnailUrls(pageUrl);
      return pageUrl;
    }

    loadMyThumbnailMemory();
    pruneThumbnailMemoryMap(cache.myThumbnailMemoryByItemKey, THUMBNAIL_MY_MEMORY_TTL_MS);
    const myEntry = cache.myThumbnailMemoryByItemKey.get(key);
    const myUrl = normalizeRenderedRobloxThumbnailUrl(myEntry?.url);
    if (myUrl) preloadThumbnailUrls(myUrl);
    return myUrl;
  }

  function getThumbMemoryHost(thumb) {
    return (
      thumb?.querySelector?.(".thumbnail-2d-container[thumbnail-target-id]") ||
      thumb?.querySelector?.(".thumbnail-2d-container") ||
      thumb?.querySelector?.("thumbnail-2d") ||
      null
    );
  }

  function upsertThumbMemoryImage(thumb, url) {
    const host = getThumbMemoryHost(thumb);
    const clean = normalizeRenderedRobloxThumbnailUrl(url);
    if (!thumb || !clean) return null;

    thumb.classList?.add?.("tis-thumb-memory-thumb", "tis-thumb-memory-ready");
    host?.classList?.add?.("tis-thumb-memory-host");

    let img = thumb.querySelector?.(":scope > img.tis-thumb-memory-img");
    if (!img) {
      img = document.createElement("img");
      img.className = "tis-thumb-memory-img";
      img.dataset.tisThumbMemoryCreated = "true";
      img.alt = "";
      img.title = "";
      img.decoding = "async";
      img.loading = "eager";

      thumb.insertBefore(img, thumb.firstChild);

      const firstOverlay = thumb.querySelector?.(
        ":scope > .limited-icon-container, :scope > .tis-multi-plus-float, :scope > .tis-proj-icon, :scope > .icon-check-selection, :scope > .icon-checkmark, :scope > .icon-checkmark-on"
      );

      thumb.insertBefore(img, firstOverlay || null);
    }

    if (img.getAttribute("ng-src") !== clean) img.setAttribute("ng-src", clean);
    if (img.src !== clean) img.src = clean;

    return img;
  }

  function removeThumbMemoryImage(thumb) {
    const host = getThumbMemoryHost(thumb);

    thumb?.querySelector?.(":scope > img.tis-thumb-memory-img")?.remove();
    thumb?.classList?.remove?.("tis-thumb-memory-thumb", "tis-thumb-memory-ready");

    host?.classList?.remove?.("tis-thumb-memory-host");

    host?.querySelectorAll?.(":scope > img.tis-thumb-memory-img").forEach((img) => {
      if (img.dataset?.tisThumbMemoryCreated === "true") img.remove();
      else img.classList.remove("tis-thumb-memory-img");
    });

    host?.querySelectorAll?.(".tis-thumb-memory-original-hidden").forEach((realImg) => {
      realImg.classList.remove("tis-thumb-memory-original-hidden");
    });
  }

  function getRenderedThumbnailUrlFromThumb(thumb) {
    const imgs = Array.from(thumb?.querySelectorAll?.("img:not(.tis-thumb-memory-img)") || []);
    for (const img of imgs) {
      const url = normalizeRenderedRobloxThumbnailUrl(img.currentSrc || img.src || img.getAttribute("ng-src") || img.getAttribute("src"));
      if (url) return url;
    }
    return "";
  }

  function hasLoadedRenderedThumbnail(thumb) {
    const imgs = Array.from(thumb?.querySelectorAll?.("img:not(.tis-thumb-memory-img)") || []);
    return imgs.some((img) => {
      const url = normalizeRenderedRobloxThumbnailUrl(img.currentSrc || img.src || img.getAttribute("ng-src") || img.getAttribute("src"));
      return Boolean(url && img.complete && img.naturalWidth > 0);
    });
  }

  function bindRenderedThumbnailHarvest(img, thumb, panelState, itemKey) {
    if (!img || img.classList?.contains("tis-thumb-memory-img") || img.__tisThumbMemoryBound) return;
    img.__tisThumbMemoryBound = true;

    const harvest = (loaded = false) => {
      const url = normalizeRenderedRobloxThumbnailUrl(img.currentSrc || img.src || img.getAttribute("ng-src") || img.getAttribute("src"));
      if (url) rememberThumbnailUrl(itemKey, url, panelState);
      if (url) {
        const rememberedUrl = getRememberedThumbnailUrl(itemKey) || url;
        upsertThumbMemoryImage(thumb, rememberedUrl);
      }
    };

    img.addEventListener("load", () => harvest(true), { passive: true });
    if (img.complete && img.naturalWidth > 0) harvest(true);
    else harvest(false);
  }

  function syncThumbnailMemoryForThumb(thumb, panelState, tradableItem = null) {
    const itemKey = getThumbnailMemoryKeyForThumb(thumb, tradableItem);
    if (!itemKey) {
      removeThumbMemoryImage(thumb);
      return;
    }

    const renderedUrl = getRenderedThumbnailUrlFromThumb(thumb);
    if (renderedUrl) rememberThumbnailUrl(itemKey, renderedUrl, panelState);

    Array.from(thumb?.querySelectorAll?.("img:not(.tis-thumb-memory-img)") || []).forEach((img) => {
      bindRenderedThumbnailHarvest(img, thumb, panelState, itemKey);
    });

    const rememberedUrl = getRememberedThumbnailUrl(itemKey);
    if (rememberedUrl) upsertThumbMemoryImage(thumb, rememberedUrl);
    else removeThumbMemoryImage(thumb);
  }

  function syncThumbnailMemoryForPanel(panel, panelState = getPanelState(panel)) {
    if (!panel || !panelState) return;
    const thumbs = panel.querySelectorAll('.item-card-thumb-container[ng-click*="root.onItemCardClick"]');
    thumbs.forEach((thumb) => {
      let ti = null;
      try {
        const ng = window.angular?.element?.(thumb);
        const sc = ng?.scope?.() || ng?.isolateScope?.();
        ti = sc?.tradableItem || null;
      } catch {}
      syncThumbnailMemoryForThumb(thumb, panelState, ti);
    });
  }

  function installThumbnailMemoryObserver() {
    if (cache.thumbnailMemoryObserver) return;

    const queue = new Set();
    let microtaskQueued = false;
    const flush = () => {
      microtaskQueued = false;
      const thumbs = Array.from(queue);
      queue.clear();
      thumbs.forEach((candidate) => {
        const panel = candidate.closest?.(".trade-inventory-panel");
        const panelState = getPanelState(panel);
        if (!panelState) return;
        syncThumbnailMemoryForThumb(candidate, panelState, null);
      });
    };

    const enqueueThumb = (thumb) => {
      if (!thumb || !thumb.isConnected) return;
      // Let the queued flush do the sync once. The old path did the same
      // thumbnail work immediately and then repeated it in the microtask.
      queue.add(thumb);
      if (!microtaskQueued) {
        microtaskQueued = true;
        queueMicrotask(flush);
      }
    };

    cache.thumbnailMemoryObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "attributes") {
          const el = mutation.target;
          const thumb = el?.closest?.('.item-card-thumb-container[ng-click*="root.onItemCardClick"]');
          if (thumb) enqueueThumb(thumb);
          return;
        }

        mutation.addedNodes.forEach((node) => {
          if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.classList?.contains("tis-thumb-memory-img")) return;

          if (node.matches?.('.item-card-thumb-container[ng-click*="root.onItemCardClick"]')) {
            enqueueThumb(node);
          }
          node.querySelectorAll?.('.item-card-thumb-container[ng-click*="root.onItemCardClick"], img:not(.tis-thumb-memory-img)').forEach((child) => {
            const thumb = child.matches?.('.item-card-thumb-container[ng-click*="root.onItemCardClick"]')
              ? child
              : child.closest?.('.item-card-thumb-container[ng-click*="root.onItemCardClick"]');
            if (thumb) enqueueThumb(thumb);
          });
        });
      });
    });

    cache.thumbnailMemoryObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "ng-src"],
    });
  }

  function getThumbnailPanelKey(panelState) {
    const ownerId = resolvePanelOwnerId(panelState) || panelState?.ownerId || "";
    return String(ownerId || panelState?.panelKey || "panel");
  }

  function getThumbnailRequestForGroup(group, panelState) {
    const targetId = getThumbnailTargetIdForGroup(group);
    if (!targetId) return null;
    const type = getThumbnailTypeForGroup(group);
    const requestId = getThumbnailMemoryKey(type, targetId);
    return {
      targetId,
      type,
      requestId,
      groupKey: String(group?.key || `${type}:${targetId}`),
      knownUrl: getKnownThumbnailUrlForGroup(group),
      size: "150x150",
      format: "Webp",
      isCircular: false,
    };
  }

  function getNotForTradeThumbnailRequests(panelState) {
    return getThumbnailRequestsForGroups(panelState?.nftGroups || [], panelState);
  }

  function getNotForTradePoolKey(panelState) {
    const ownerKey = getThumbnailPanelKey(panelState);
    const requestIds = getNotForTradeThumbnailRequests(panelState)
      .map((request) => request.requestId)
      .sort()
      .join(",");
    return `${ownerKey}|${requestIds}`;
  }

  function getNotForTradeIconChoices(panelState) {
    const requests = getNotForTradeThumbnailRequests(panelState);
    const choices = [];

    requests.forEach((request) => {
      const clean = normalizeThumbnailUrl(panelState.nftIconImageByRequestKey?.get(request.requestId));
      if (clean && !choices.some((x) => x.requestId === request.requestId)) {
        choices.push({
          requestId: request.requestId,
          groupKey: request.groupKey,
          targetId: request.targetId,
          type: request.type,
          url: clean,
        });
      }
    });

    return choices;
  }

  function chooseNotForTradeIcon(panelState, options = {}) {
    const choices = getNotForTradeIconChoices(panelState);
    if (!choices.length) return null;

    const poolKey = getNotForTradePoolKey(panelState);
    if (!options.force && panelState?.nftIconChoiceUrl && panelState?.nftIconChoicePoolKey === poolKey) {
      const existing = choices.find((choice) => choice.url === panelState.nftIconChoiceUrl);
      if (existing) return existing;
    }

    const previousUrl = String(options.excludeUrl || "");
    let nextPool = choices;
    if (previousUrl && nextPool.length > 1) {
      const withoutPrevious = nextPool.filter((choice) => choice.url !== previousUrl);
      if (withoutPrevious.length) nextPool = withoutPrevious;
    }

    const otherPanelUrls = new Set();
    if (options.avoidOtherPanels !== false) {
      cache.panelStateList.forEach((candidate) => {
        if (!candidate || candidate === panelState) return;
        const url = String(candidate.nftIconChoiceUrl || "");
        if (url) otherPanelUrls.add(url);
      });
    }

    if (otherPanelUrls.size && nextPool.length > 1) {
      const withoutOtherPanelChoices = nextPool.filter((choice) => !otherPanelUrls.has(choice.url));
      if (withoutOtherPanelChoices.length) nextPool = withoutOtherPanelChoices;
    }

    const next = nextPool[Math.floor(Math.random() * nextPool.length)];
    panelState.nftIconChoiceRequestId = next.requestId || "";
    panelState.nftIconChoiceUrl = next.url;
    panelState.nftIconChoicePoolKey = poolKey;
    return next;
  }

  function getSelectedNotForTradeIcon(panelState) {
    if (!panelState?.nftIconChoiceUrl) return null;
    if (panelState.nftIconChoicePoolKey !== getNotForTradePoolKey(panelState)) return null;
    return getNotForTradeIconChoices(panelState).find((choice) => choice.url === panelState.nftIconChoiceUrl) || null;
  }

  function repickNotForTradeIcon(panelState, previousUrl = "") {
    if (!panelState) return null;
    panelState.nftIconChoiceRequestId = "";
    panelState.nftIconChoiceUrl = "";
    panelState.nftIconChoicePoolKey = "";
    const promise = ensureNotForTradeThumbnailsLoaded(panelState, "repick-not-for-trade-icon");
    const choice = chooseNotForTradeIcon(panelState, {
      force: true,
      excludeUrl: previousUrl,
      avoidOtherPanels: true,
    });

    if (!choice && promise?.then) {
      promise.then(() => {
        const livePanel = getLivePanel(panelState);
        chooseNotForTradeIcon(panelState, {
          force: true,
          excludeUrl: previousUrl,
          avoidOtherPanels: true,
        });
        if (livePanel) renderNotForTradeCard(livePanel, panelState);
      }).catch(() => {});
    }

    return choice;
  }

  function storeNotForTradeThumbnailUrls(panelState, thumbnails) {
    if (!panelState || !thumbnails || typeof thumbnails !== "object") return false;
    if (!panelState.nftIconImageByRequestKey) panelState.nftIconImageByRequestKey = new Map();
    const requestsById = new Map(getNotForTradeThumbnailRequests(panelState).map((request) => [request.requestId, request]));

    let changed = false;
    Object.entries(thumbnails).forEach(([id, url]) => {
      const requestId = String(id || "");
      const clean = normalizeThumbnailUrl(url);
      if (!requestId || !clean) return;
      if (panelState.nftIconImageByRequestKey.get(requestId) !== clean) changed = true;
      panelState.nftIconImageByRequestKey.set(requestId, clean);
      cache.thumbnailUrlByRequestKey.set(requestId, clean);
      const request = requestsById.get(requestId);
      if (request) rememberThumbnailUrlsForRequests(panelState, [request], { [requestId]: clean });
    });
    return changed;
  }

  function storeKnownNotForTradeThumbnailUrls(panelState, requests) {
    if (!panelState || !Array.isArray(requests)) return false;
    if (!panelState.nftIconImageByRequestKey) panelState.nftIconImageByRequestKey = new Map();

    let changed = false;
    requests.forEach((request) => {
      const requestId = String(request?.requestId || "");
      const knownUrl = normalizeThumbnailUrl(request?.knownUrl);
      if (!requestId || !knownUrl) return;
      if (panelState.nftIconImageByRequestKey.get(requestId) !== knownUrl) changed = true;
      panelState.nftIconImageByRequestKey.set(requestId, knownUrl);
      cache.thumbnailUrlByRequestKey.set(requestId, knownUrl);
      rememberThumbnailUrlsForRequests(panelState, [request], { [requestId]: knownUrl });
    });
    return changed;
  }

  function ensureNotForTradeThumbnailsLoaded(panelState, reason = "unknown") {
    if (!panelState?.all || !panelState.playerDetails) return null;
    const requests = getNotForTradeThumbnailRequests(panelState);
    if (!requests.length) return null;

    if (!panelState.nftIconImageByRequestKey) panelState.nftIconImageByRequestKey = new Map();
    storeKnownNotForTradeThumbnailUrls(panelState, requests);
    if (!getSelectedNotForTradeIcon(panelState)) chooseNotForTradeIcon(panelState);

    const key = requests.map((request) => request.requestId).sort().join(",");
    const hasEveryCached = requests.every((request) => panelState.nftIconImageByRequestKey.has(request.requestId) || cache.thumbnailUrlByRequestKey.has(request.requestId));
    if (hasEveryCached) {
      requests.forEach((request) => {
        const cached = normalizeThumbnailUrl(cache.thumbnailUrlByRequestKey.get(request.requestId));
        if (cached && !panelState.nftIconImageByRequestKey.has(request.requestId)) {
          panelState.nftIconImageByRequestKey.set(request.requestId, cached);
        }
      });
      if (!getSelectedNotForTradeIcon(panelState)) chooseNotForTradeIcon(panelState);
      return null;
    }

    if (panelState.nftIconThumbnailFetchInFlight && panelState.nftIconThumbnailFetchKey === key) {
      return panelState.nftIconThumbnailFetchPromise || null;
    }

    panelState.nftIconThumbnailFetchKey = key;
    panelState.nftIconThumbnailFetchInFlight = true;
    debug("fetch not-for-trade thumbnails", { reason, count: requests.length, panelKey: panelState.panelKey });

    const promise = fetchRobloxThumbnailRequests(requests)
      .then((thumbnails) => {
        const changed = storeNotForTradeThumbnailUrls(panelState, thumbnails);
        const hadChoice = Boolean(getSelectedNotForTradeIcon(panelState));
        if (!hadChoice) chooseNotForTradeIcon(panelState);

        const livePanel = getLivePanel(panelState);
        if (livePanel && (changed || (!hadChoice && panelState.nftIconChoiceUrl))) {
          renderNotForTradeCard(livePanel, panelState);
        }
        return thumbnails;
      })
      .catch((err) => {
        debug("not-for-trade thumbnail failed", key, String(err?.message || err));
        return {};
      })
      .finally(() => {
        panelState.nftIconThumbnailFetchInFlight = false;
        panelState.nftIconThumbnailFetchPromise = null;
      });

    panelState.nftIconThumbnailFetchPromise = promise;
    return promise;
  }

  function getMainGroups(panelState) {
    if (!panelState) return [];
    return isBagOfHoldingEnabled() ? (panelState.mainGroups || []) : (panelState.groups || []);
  }

  function getMainGroupMap(panelState) {
    if (!panelState) return new Map();
    return isBagOfHoldingEnabled() ? (panelState.mainGroupMap || new Map()) : (panelState.groupMap || new Map());
  }

  function getActiveGroups(panelState) {
    if (!panelState) return [];
    if (panelState.viewMode === "nft") return panelState.nftGroups || [];
    return panelState.viewMode === "bag" ? (panelState.bagGroups || []) : getMainGroups(panelState);
  }

  function getActiveGroupMap(panelState) {
    if (!panelState) return new Map();
    if (panelState.viewMode === "nft") return panelState.nftGroupMap || new Map();
    return panelState.viewMode === "bag" ? (panelState.bagGroupMap || new Map()) : getMainGroupMap(panelState);
  }

  function getActiveComputed(panelState) {
    if (!panelState) return [];
    if (panelState.viewMode === "nft") return panelState.nftComputed || [];
    return panelState.viewMode === "bag" ? (panelState.bagComputed || []) : (panelState.computed || []);
  }

  function setActiveComputed(panelState, items) {
    if (!panelState) return;
    if (panelState.viewMode === "nft") panelState.nftComputed = items;
    else if (panelState.viewMode === "bag") panelState.bagComputed = items;
    else panelState.computed = items;
  }

  function toggleBagOfHoldingView(panel, panelState = getPanelState(panel)) {
    if (!panel || !panelState) return;
    const previousView = panelState.viewMode;
    const previousNftIconUrl = panelState.nftIconChoiceUrl;
    panelState.viewMode = previousView === "bag" ? "main" : "bag";
    panelState.pageIndex = 0;
    closeMultiDD();
    if (previousView !== "main" && panelState.viewMode === "main") {
      repickNotForTradeIcon(panelState, previousNftIconUrl);
    }
    applyToAngular(panel, panelState);
    renderBagOfHoldingCard(panel, panelState);
  }

  function toggleNotForTradeView(panel, panelState = getPanelState(panel)) {
    if (!panel || !panelState) return;
    const leavingNftView = panelState.viewMode === "nft";
    const previousNftIconUrl = panelState.nftIconChoiceUrl;

    panelState.viewMode = leavingNftView ? "main" : "nft";
    panelState.pageIndex = 0;
    closeMultiDD();
    rebuildNotForTradeGroups(panelState);
    if (leavingNftView) repickNotForTradeIcon(panelState, previousNftIconUrl);
    applyToAngular(panel, panelState);
    renderBagOfHoldingCard(panel, panelState);
  }

  function createBagOfHoldingCard(panelState) {
    const card = document.createElement("div");
    card.className = "item-card-container tis-bag-of-holding-card";
    card.dataset.tisPanelKey = panelState.panelKey;
    card.innerHTML = `
      <div class="item-card-link">
        <div class="item-card-thumb-container tis-bag-of-holding-thumb">
          <img class="tis-bag-of-holding-image" alt="bag of holding">
          <div class="tis-bag-of-holding-count-wrap">
            <button type="button" class="tis-multi-btn tis-bag-of-holding-count" tabindex="-1">0</button>
          </div>
        </div>
      </div>
      <div class="item-card-caption">
        <div class="item-card-name-link">
          <div class="item-card-name" title="bag of holding">bag of holding</div>
        </div>
        <div class="text-overflow item-card-price tis-bag-of-holding-rap-row">
          <span class="icon-robux-16x16"></span>
          <span class="text-robux tis-bag-of-holding-rap-value">0</span>
        </div>
        <div class="text-overflow item-card-price tis-bag-of-holding-value-row">
          <span class="icon icon-rolimons tis-bag-of-holding-value-icon"></span>
          <span class="text-robux tis-bag-of-holding-value">0</span>
        </div>
      </div>
    `;
    return card;
  }

  function createNotForTradeCard(panelState) {
    const card = document.createElement("div");
    card.className = "item-card-container tis-bag-of-holding-card tis-not-for-trade-card";
    card.dataset.tisPanelKey = panelState.panelKey;
    card.innerHTML = `
      <div class="item-card-link">
        <div class="item-card-thumb-container tis-bag-of-holding-thumb">
          <img class="tis-bag-of-holding-image" alt="not for trade items">
          <div class="tis-bag-of-holding-count-wrap">
            <button type="button" class="tis-multi-btn tis-bag-of-holding-count" tabindex="-1">0</button>
          </div>
        </div>
      </div>
      <div class="item-card-caption">
        <div class="item-card-name-link">
          <div class="item-card-name" title="not for trade items">not for trade items</div>
        </div>
        <div class="text-overflow item-card-price tis-bag-of-holding-rap-row">
          <span class="icon-robux-16x16"></span>
          <span class="text-robux tis-bag-of-holding-rap-value">0</span>
        </div>
        <div class="text-overflow item-card-price tis-bag-of-holding-value-row">
          <span class="icon icon-rolimons tis-bag-of-holding-value-icon"></span>
          <span class="text-robux tis-bag-of-holding-value">0</span>
        </div>
      </div>
    `;
    return card;
  }

  function renderBagOfHoldingCard(panel, panelState = getPanelState(panel)) {
    if (!panel) return;
    if (!isBagOfHoldingEnabled()) {
      const wasSideView = panelState?.viewMode === "bag" || panelState?.viewMode === "nft";
      if (panelState) panelState.viewMode = "main";
      syncInventoryLabel(panel, panelState);
      removeBagOfHoldingCard(panel);
      if (wasSideView && panelState?.all) {
        setTimeout(() => {
          if (panel.isConnected) applyToAngular(panel, panelState);
        }, 0);
      }
      return;
    }
    if (!panelState?.all) return;

    const { dock } = ensureBagOfHoldingLayout(panel);
    if (!dock) return;

    let card = getBagOfHoldingCard(panel);
    if (!card) card = createBagOfHoldingCard(panelState);
    if (card.parentElement !== dock) {
      dock.insertBefore(card, dock.firstChild);
    }

    const image = card.querySelector(".tis-bag-of-holding-image");
    const imageWrap = card.querySelector(".tis-bag-of-holding-thumb");
    const nameEl = card.querySelector(".item-card-name");
    const rapValue = card.querySelector(".tis-bag-of-holding-rap-value");
    const valueValue = card.querySelector(".tis-bag-of-holding-value");
    const valueIcon = card.querySelector(".tis-bag-of-holding-value-icon");
    const countBtn = card.querySelector(".tis-bag-of-holding-count");
    const inBagView = panelState.viewMode === "bag";
    const totals = inBagView ? computeMainInventoryTotals(panelState) : computeBagOfHoldingTotals(panelState);
    const imagePath = inBagView ? "icons/return.jpg" : (totals.count > 0 ? "icons/bagfull.webp" : "icons/bagempty.webp");
    const bagName = inBagView ? "return to inventory" : "bag of holding";

    if (image) {
      image.src = getExtensionAssetUrl(imagePath);
      image.alt = bagName;
      image.title = bagName;
    }
    if (imageWrap) imageWrap.title = bagName;
    if (nameEl) {
      nameEl.textContent = bagName;
      nameEl.title = bagName;
    }
    if (rapValue) rapValue.textContent = totals.rap.toLocaleString();
    if (valueValue) valueValue.textContent = totals.value.toLocaleString();
    if (valueIcon) applyRoliIconStyles(valueIcon, getExtensionAssetUrl("icons/rolimons.svg"));
    if (valueValue) {
      valueValue.style.color = "#05bce4";
      valueValue.style.fontWeight = "600";
      valueValue.style.textShadow = "0 1px 1px rgba(0,0,0,.55)";
    }
    if (countBtn) countBtn.textContent = String(totals.count);
    card.classList.toggle("tis-bag-of-holding-active", panelState.viewMode === "bag");
    card.classList.remove("tis-not-for-trade-active");
    syncInventoryLabel(panel, panelState);
    card.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleBagOfHoldingView(panel, panelState);
    };

    renderNotForTradeCard(panel, panelState, dock);
  }

  function renderNotForTradeCard(panel, panelState = getPanelState(panel), dock = null) {
    if (!panel || !panelState || !isBagOfHoldingEnabled()) return;
    const targetDock = dock || getBagOfHoldingDock(panel) || ensureBagOfHoldingLayout(panel).dock;
    if (!targetDock) return;

    let card = getNotForTradeCard(panel);
    if (!card) card = createNotForTradeCard(panelState);
    if (card.parentElement !== targetDock) targetDock.appendChild(card);

    const image = card.querySelector(".tis-bag-of-holding-image");
    const imageWrap = card.querySelector(".tis-bag-of-holding-thumb");
    const nameEl = card.querySelector(".item-card-name");
    const rapValue = card.querySelector(".tis-bag-of-holding-rap-value");
    const valueValue = card.querySelector(".tis-bag-of-holding-value");
    const valueIcon = card.querySelector(".tis-bag-of-holding-value-icon");
    const countBtn = card.querySelector(".tis-bag-of-holding-count");
    const inNftView = panelState.viewMode === "nft";
    const totals = inNftView ? computeMainInventoryTotals(panelState) : computeNotForTradeTotals(panelState);
    const thumbnailRequests = getNotForTradeThumbnailRequests(panelState);
    const hasNftItems = thumbnailRequests.length > 0 && totals.count > 0;
    const emptyImageUrl = getExtensionAssetUrl("icons/bagempty.webp");
    if (!panelState.nftIconImageByRequestKey) panelState.nftIconImageByRequestKey = new Map();
    if (!inNftView && hasNftItems && !getSelectedNotForTradeIcon(panelState)) {
      ensureNotForTradeThumbnailsLoaded(panelState, "render-not-for-trade-card");
    }
    const iconChoice = !inNftView && hasNftItems ? getSelectedNotForTradeIcon(panelState) : null;
    const imageUrl = inNftView
      ? getExtensionAssetUrl("icons/return.jpg")
      : (iconChoice?.url || (hasNftItems ? "" : emptyImageUrl));
    const cardName = inNftView ? "return to inventory" : "not for trade items";

    if (image) {
      image.dataset.tisAssetId = iconChoice?.targetId || "";
      image.dataset.tisRequestId = iconChoice?.requestId || "";
      image.dataset.tisImageRole = inNftView ? "return" : "not-for-trade";
      image.onerror = () => {
        image.onerror = null;
        const failedRequestId = String(image.dataset.tisRequestId || "");
        const failedUrl = String(image.currentSrc || image.src || image.getAttribute("src") || "");
        if (failedRequestId) {
          panelState.nftIconImageByRequestKey?.delete?.(failedRequestId);
          cache.thumbnailUrlByRequestKey.delete(failedRequestId);
        }
        if (panelState.nftIconChoiceUrl === failedUrl || panelState.nftIconChoiceRequestId === failedRequestId) {
          panelState.nftIconChoiceRequestId = "";
          panelState.nftIconChoiceUrl = "";
          panelState.nftIconChoicePoolKey = "";
        }
        const nextChoice = hasNftItems ? chooseNotForTradeIcon(panelState, { force: true, excludeUrl: failedUrl }) : null;
        const nextUrl = nextChoice?.url || (hasNftItems ? "" : emptyImageUrl);
        if (nextUrl) {
          image.style.visibility = "";
          if (image.src !== nextUrl) image.src = nextUrl;
        } else if (!hasNftItems && image.src !== emptyImageUrl) {
          image.style.visibility = "";
          image.src = emptyImageUrl;
        } else if (hasNftItems) {
          const retry = ensureNotForTradeThumbnailsLoaded(panelState, "not-for-trade-image-error");
          if (retry?.then) {
            retry.then(() => {
              const livePanel = getLivePanel(panelState);
              if (livePanel) renderNotForTradeCard(livePanel, panelState);
            }).catch(() => {});
          }
        }
      };
      if (imageUrl) {
        image.style.visibility = "";
        if (image.src !== imageUrl) image.src = imageUrl;
      } else if (hasNftItems) {
        image.style.visibility = "";
      } else {
        image.style.visibility = "";
        if (image.src !== emptyImageUrl) image.src = emptyImageUrl;
      }
      image.alt = cardName;
      image.title = cardName;
    }
    if (imageWrap) imageWrap.title = cardName;
    if (nameEl) {
      nameEl.textContent = cardName;
      nameEl.title = cardName;
    }
    if (rapValue) rapValue.textContent = totals.rap.toLocaleString();
    if (valueValue) valueValue.textContent = totals.value.toLocaleString();
    if (valueIcon) applyRoliIconStyles(valueIcon, getExtensionAssetUrl("icons/rolimons.svg"));
    if (valueValue) {
      valueValue.style.color = "#05bce4";
      valueValue.style.fontWeight = "600";
      valueValue.style.textShadow = "0 1px 1px rgba(0,0,0,.55)";
    }
    if (countBtn) countBtn.textContent = String(totals.count);
    card.classList.toggle("tis-not-for-trade-active", inNftView);
    card.classList.remove("tis-bag-of-holding-active");
    card.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleNotForTradeView(panel, panelState);
    };
  }

  function renderAllBagOfHoldingCards() {
    getInventoryPanels().forEach((panel) => {
      const panelState = getPanelState(panel);
      if (!panelState) return;
      renderBagOfHoldingCard(panel, panelState);
    });
  }

  

  function findAngularInventoryScope(panel) {
    if (!panel || !window.angular?.element) return null;

    // try scope, then isolateScope
    let s = window.angular.element(panel).scope?.() || window.angular.element(panel).isolateScope?.();
    // walk parents until we find inventoryData.tradableItems
    while (s) {
      if (s.inventoryData && Array.isArray(s.inventoryData.tradableItems)) return s;
      if (s.inventory && Array.isArray(s.inventory.tradableItems)) return s;
      s = s.$parent;
    }
    return null;
  }

  function getInventoryPanelLabel(panel) {
    return String(panel?.querySelector("h2.inventory-label")?.textContent || "").trim();
  }

  function getMainInventoryLabel(panelState, panel = getLivePanel(panelState) || panelState?.panel) {
    const liveLabel = getInventoryPanelLabel(panel);
    const fallback = panelState?.isMine ? "your inventory" : "their inventory";
    const base = String(panelState?.baseInventoryLabel || liveLabel || fallback).trim().toLowerCase();
    if (!panelState?.baseInventoryLabel && base) panelState.baseInventoryLabel = base;
    if (!base) return fallback;
    if (base.includes("bag of holding")) return fallback;
    if (base.includes("not for trade")) return fallback;
    return base;
  }

  function getBagInventoryLabel(panelState, panel = getLivePanel(panelState) || panelState?.panel) {
    const base = getMainInventoryLabel(panelState, panel);
    if (base.includes("inventory")) return base.replace(/inventory/i, "bag of holding");
    return `${base} bag of holding`.trim();
  }

  function getNotForTradeInventoryLabel(panelState, panel = getLivePanel(panelState) || panelState?.panel) {
    const base = getMainInventoryLabel(panelState, panel);
    if (base.includes("inventory")) return base.replace(/inventory/i, "not for trade items");
    return `${base} not for trade items`.trim();
  }

  function syncInventoryLabel(panel, panelState = getPanelState(panel)) {
    const header = panel?.querySelector("h2.inventory-label") || panel?.querySelector(".inventory-header h2") || panel?.querySelector("h2");
    if (!header || !panelState) return;
    const label = panelState.viewMode === "bag"
      ? getBagInventoryLabel(panelState, panel)
      : (panelState.viewMode === "nft"
        ? getNotForTradeInventoryLabel(panelState, panel)
        : getMainInventoryLabel(panelState, panel));
    if (header.textContent !== label) header.textContent = label;
  }

  function getInventoryPanelOwnerId(panel) {
    const reactUserId = getReactInventoryController(panel)?.user?.id;
    if (/^\d+$/.test(String(reactUserId || ""))) return Number(reactUserId);

    const scope = findAngularInventoryScope(panel);
    const candidates = [
      scope?.user?.id,
      scope?.user?.userId,
      scope?.offer?.user?.id,
      scope?.offer?.user?.userId,
      scope?.data?.user?.id,
      scope?.data?.user?.userId,
      scope?.inventoryData?.userId,
      scope?.inventory?.userId,
      scope?.inventoryData?.tradableItems?.[0]?.userId,
      scope?.inventory?.tradableItems?.[0]?.userId,
      scope?.inventoryData?.tradableItems?.[0]?.user?.id,
      scope?.inventory?.tradableItems?.[0]?.user?.id,
    ];

    for (const candidate of candidates) {
      const value = String(candidate || "");
      if (/^\d+$/.test(value)) return Number(value);
    }

    return null;
  }

  function isMyInventoryPanel(panel) {
    const label = getInventoryPanelLabel(panel).toLowerCase();
    if (label === "your inventory") return true;

    const ownerId = getInventoryPanelOwnerId(panel);
    const selfId = getUserId();
    return Boolean(ownerId && selfId && ownerId === selfId);
  }

  function createPanelState(panel) {
    const isMine = isMyInventoryPanel(panel);
    const ownerId = getInventoryPanelOwnerId(panel) || (isMine ? getUserId() : getTradePartnerUserIdFromUrl());

    return {
      panel,
      panelKey: isMine ? "mine" : "their",
      ownerId,
      isMine,
      viewMode: "main",
      sortMode: "none",
      min: null,
      max: null,
      searchQuery: "",
      pageIndex: 0,
      pageSize: getReactInventoryController(panel) ? REACT_PAGE_SIZE : PAGE_SIZE,
      all: null,
      loadingPromise: null,
      nextFetchAttemptAt: 0,
      computed: [],
      bagComputed: [],
      nftComputed: [],
      groups: null,
      groupMap: new Map(),
      mainGroups: [],
      mainGroupMap: new Map(),
      bagGroups: [],
      bagGroupMap: new Map(),
      nftGroups: [],
      nftGroupMap: new Map(),
      selectedByKey: new Map(),
      autoPickByKey: new Map(),
      instKeyById: new Map(),
      instById: new Map(),
      playerDetails: null,
      playerDetailsOwnerId: null,
      playerDetailsLastError: null,
      nftIconChoiceRequestId: "",
      nftIconChoiceUrl: "",
      nftIconChoicePoolKey: "",
      nftIconImageByRequestKey: new Map(),
      nftIconThumbnailFetchKey: "",
      nftIconThumbnailFetchInFlight: false,
      thumbnailPreloadFetchKey: "",
      thumbnailPreloadFetchInFlight: false,
      thumbnailPreloadFetchPromise: null,
      thumbnailApplyHoldSignature: "",
      thumbnailApplyHoldToken: 0,
      offerObs: null,
      offerObsRoot: null,
    };
  }

  function getThumbnailRequestsForGroups(groups, panelState) {
    const seen = new Set();
    const requests = [];
    (Array.isArray(groups) ? groups : []).forEach((group) => {
      const request = getThumbnailRequestForGroup(group, panelState);
      if (!request || seen.has(request.requestId)) return;
      seen.add(request.requestId);
      requests.push(request);
    });
    return requests;
  }

  function getRememberedThumbnailUrlForRequest(request) {
    const requestId = String(request?.requestId || "");
    const requestCached = normalizeRenderedRobloxThumbnailUrl(cache.thumbnailUrlByRequestKey.get(requestId));
    if (requestCached) return requestCached;

    const memoryKey = getThumbnailMemoryKey(request?.type, request?.targetId);
    const remembered = getRememberedThumbnailUrl(memoryKey);
    if (remembered) {
      if (requestId) cache.thumbnailUrlByRequestKey.set(requestId, remembered);
      return remembered;
    }

    const knownUrl = normalizeRenderedRobloxThumbnailUrl(request?.knownUrl);
    return knownUrl || "";
  }

  function rememberThumbnailUrlsForRequests(panelState, requests, thumbnails) {
    if (!Array.isArray(requests) || !requests.length) return false;
    const rows = thumbnails && typeof thumbnails === "object" ? thumbnails : {};
    let changed = false;

    requests.forEach((request) => {
      const requestId = String(request?.requestId || "");
      const memoryKey = getThumbnailMemoryKey(request?.type, request?.targetId);
      if (!requestId || !memoryKey) return;

      const fetchedUrl = normalizeRenderedRobloxThumbnailUrl(rows[requestId]);
      const cachedUrl = normalizeRenderedRobloxThumbnailUrl(cache.thumbnailUrlByRequestKey.get(requestId));
      const knownUrl = normalizeRenderedRobloxThumbnailUrl(request?.knownUrl);
      const url = fetchedUrl || cachedUrl || knownUrl;
      if (!url) return;

      const existingRequestUrl = normalizeRenderedRobloxThumbnailUrl(cache.thumbnailUrlByRequestKey.get(requestId));
      if (existingRequestUrl !== url) {
        cache.thumbnailUrlByRequestKey.set(requestId, url);
        changed = true;
      }
      if (rememberThumbnailUrl(memoryKey, url, panelState)) changed = true;
    });

    return changed;
  }

  function getThumbnailPreloadWindow(panelState, pageGroups = []) {
    const computed = getActiveComputed(panelState);
    const pageSize = panelState?.pageSize || PAGE_SIZE;
    const start = Math.max(0, (panelState?.pageIndex || 0) * pageSize);
    const end = Math.min(computed.length, start + (pageSize * 3));
    const out = [];
    const seen = new Set();

    pageGroups.forEach((group) => {
      const key = String(group?.key || "");
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(group);
    });

    computed.slice(start, end).forEach((group) => {
      const key = String(group?.key || "");
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(group);
    });

    return out;
  }

  function pageGroupsNeedThumbnailWarmup(panelState, pageGroups) {
    return getThumbnailRequestsForGroups(pageGroups, panelState)
      .some((request) => !getRememberedThumbnailUrlForRequest(request));
  }

  function preloadThumbnailsForGroups(panelState, groups, reason = "unknown") {
    if (!panelState) return null;
    const requests = getThumbnailRequestsForGroups(groups, panelState);
    if (!requests.length) return null;

    rememberThumbnailUrlsForRequests(panelState, requests, {});

    const missing = requests.filter((request) => !getRememberedThumbnailUrlForRequest(request));
    if (!missing.length) return null;

    const key = missing.map((request) => request.requestId).sort().join(",");
    if (panelState.thumbnailPreloadFetchInFlight && panelState.thumbnailPreloadFetchKey === key) {
      return panelState.thumbnailPreloadFetchPromise || null;
    }

    panelState.thumbnailPreloadFetchKey = key;
    panelState.thumbnailPreloadFetchInFlight = true;
    debug("preload thumbnails", { reason, count: missing.length, panelKey: panelState.panelKey });

    const promise = fetchRobloxThumbnailRequests(missing)
      .then((thumbnails) => {
        rememberThumbnailUrlsForRequests(panelState, missing, thumbnails);
        const livePanel = getLivePanel(panelState);
        if (livePanel) syncThumbnailMemoryForPanel(livePanel, panelState);
        return thumbnails;
      })
      .catch((err) => {
        debug("thumbnail preload failed", reason, String(err?.message || err));
        return {};
      })
      .finally(() => {
        panelState.thumbnailPreloadFetchInFlight = false;
        panelState.thumbnailPreloadFetchPromise = null;
      });

    panelState.thumbnailPreloadFetchPromise = promise;
    return promise;
  }

  function getPanelState(panel) {
    if (!panel) return null;

    let panelState = cache.panelStates.get(panel);
    if (panelState) {
      panelState.panel = panel;
      return panelState;
    }

    const nextPanelKey = isMyInventoryPanel(panel) ? "mine" : "their";
    panelState = cache.panelStatesByKey.get(nextPanelKey);
    if (panelState) {
      panelState.panel = panel;
      cache.panelStates.set(panel, panelState);
      return panelState;
    }

    panelState = createPanelState(panel);
    cache.panelStates.set(panel, panelState);
    cache.panelStatesByKey.set(panelState.panelKey, panelState);
    cache.panelStateList.push(panelState);
    return panelState;
  }

  function getPanelStateByKey(panelKey) {
    return cache.panelStatesByKey.get(String(panelKey || "")) || null;
  }

  function getPrimaryMyPanelState() {
    return cache.panelStateList.find((panelState) => panelState.isMine) || null;
  }

  function resolvePanelOwnerId(panelState) {
    if (!panelState) return null;
    if (panelState.ownerId) return panelState.ownerId;

    const livePanel = getLivePanel(panelState) || panelState.panel;
    panelState.ownerId = getInventoryPanelOwnerId(livePanel) || (panelState.isMine ? getUserId() : getTradePartnerUserIdFromUrl());
    return panelState.ownerId;
  }

  function getLivePanel(panelState) {
    if (!panelState) return null;
    if (panelState.panel?.isConnected) return panelState.panel;

    const livePanel = getInventoryPanels().find((candidate) => {
      return getPanelState(candidate)?.panelKey === panelState.panelKey;
    }) || null;

    if (livePanel) panelState.panel = livePanel;
    return livePanel;
  }

  function getRoliLookupId(inst) {
    const targetId = inst?.itemTarget?.targetId;
    if (targetId && /^\d+$/.test(String(targetId))) return String(targetId);

    const collectibleItemId = inst?.collectibleItemId;
    if (collectibleItemId && /^\d+$/.test(String(collectibleItemId))) {
      return String(collectibleItemId);
    }

    return null;
  }

  function getCollectibleItemInstanceId(inst) {
    const candidates = [
      inst?.collectibleItemInstanceId,
      inst?.details?.collectibleItemInstanceId,
      inst?.itemDetails?.collectibleItemInstanceId,
      inst?.collectibleItemDetails?.collectibleItemInstanceId,
      inst?.id,
    ];

    for (const candidate of candidates) {
      const value = String(candidate || "");
      if (value && value !== "undefined" && value !== "null") return value;
    }

    return null;
  }

  function getSerialTooltipLine(inst) {
    const serial = Number(inst?.serialNumber);
    if (!Number.isFinite(serial) || serial <= 0) return null;

    const stock = Number(inst?.assetStock ?? inst?.layoutOptions?.assetStock ?? 0);
    if (Number.isFinite(stock) && stock > 0) return `#${serial}/${stock}`;
    return `#${serial}`;
  }

  function normalizeRoliName(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function buildRoliNameMaps() {
    const exact = new Map();
    const normalized = new Map();

    for (const info of Object.values(cache.roli || {})) {
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

    cache.roliExactNameMap = exact;
    cache.roliNormalizedNameMap = normalized;
  }

  function ensureRoliNameMaps() {
    if (!cache.roliExactNameMap || !cache.roliNormalizedNameMap) {
      buildRoliNameMaps();
    }
  }

  function getRoliInfoByName(name) {
    const rawName = String(name || "").trim();
    if (!rawName || !cache.roli) return null;

    ensureRoliNameMaps();

    const exact = cache.roliExactNameMap.get(rawName);
    if (exact) return exact;

    const normalizedName = normalizeRoliName(rawName);
    if (!normalizedName) return null;

    return cache.roliNormalizedNameMap.get(normalizedName) || null;
  }

  function getRoliInfoForInst(inst) {
    const lookupId = getRoliLookupId(inst);
    if (lookupId) {
      const info = cache.roli?.[lookupId];
      if (info) return info;
    }

    if (inst?.itemTarget?.itemType === "Bundle") {
      const info = getRoliInfoByName(inst?.itemName);
      if (info) return info;
    }

    return null;
  }

  function roliValueForInst(inst) {
    const info = getRoliInfoForInst(inst);
    if (!info) return null;

    const value = Number(info.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function offerValueForInst(inst) {
    const rap = Number(inst?.recentAveragePrice ?? 0) || 0;
    const v = roliValueForInst(inst); // note: NOT the "effective" one
    return (v !== null) ? v : rap; // same rule as item row: fallback to rap if unvalued
  }

function publishOfferTotal() {
    const myPanelState = getPrimaryMyPanelState();
    if (!myPanelState?.all) return;

    const offerIds = Array.from(getOfferInstanceIdsFromDOM(myPanelState)).map(String).sort();
    let total = 0;

    for (const id of offerIds) {
      const inst = myPanelState.instById.get(String(id));
      if (!inst) continue;
      total += offerValueForInst(inst);
    }

  const signature = `${offerIds.join(",")}:${total}`;
  if (signature === cache.lastOfferTotalSignature) return;
  cache.lastOfferTotalSignature = signature;
  window.postMessage({ type: "TIS_OFFER_TOTAL_VALUE", total }, "*");
}


function effectiveValueForInst(inst) {
  const rap = Number(inst?.recentAveragePrice ?? 0) || 0;
  const v = roliValueForInst(inst);
  return (v !== null) ? v : rap;
}

function getAssetIdForGroup(group) {
  const rep = group?.rep || group?.instances?.[0] || null;
  const fromInst = getAssetIdForInst(rep);
  if (fromInst) return fromInst;

  const candidates = [
    rep?.itemTarget?.targetId,
    rep?.assetId,
    rep?.asset?.id,
    rep?.details?.assetId,
    rep?.collectibleItemDetails?.assetId,
    rep?.itemDetails?.assetId,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "");
    if (/^\d+$/.test(value)) return value;
  }

  const keyMatch = String(group?.key || "").match(/^Asset:(\d+)$/);
  return keyMatch ? keyMatch[1] : null;
}

function getGroupSearchText(group) {
  const rep = group?.rep || {};
  const assetId = getAssetIdForGroup(group) || "";
  const roliName = assetId ? String(cache.roli?.[assetId]?.name || "") : "";
  return [
    rep.itemName,
    rep.name,
    roliName,
    assetId,
    group?.key,
  ].filter(Boolean).join(" ").toLowerCase();
}

function groupMatchesSearch(group, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  return getGroupSearchText(group).includes(q);
}

function isWishlistPriorityGroup(panelState, group) {
  const assetId = getAssetIdForGroup(group);
  if (!assetId) return false;

  const counterparty = getCounterpartyPanelState(panelState);
  let details = getRolimonsPlayerDetailsForPanelState(counterparty);

  if (!details && panelState?.isMine) {
    const receiverId = getTradePartnerUserIdFromUrl();
    details = receiverId ? cache.rolimonsPlayerByOwnerId.get(String(receiverId)) : null;
  }

  return Boolean(details?.wishlistAssetIds?.has(assetId));
}

function sortGroupsForPanel(panelState, groups) {
  const out = groups.slice();
  if (panelState?.sortMode === "asc") {
    out.sort((a,b)=> effectiveValueForInst(a.rep) - effectiveValueForInst(b.rep));
  } else if (panelState?.sortMode === "desc") {
    out.sort((a,b)=> effectiveValueForInst(b.rep) - effectiveValueForInst(a.rep));
  }
  return out;
}

function computeList(panelState) {
  const base = getActiveGroups(panelState).slice();
  const pinned = [];
  let out = [];

  base.forEach((group) => {
    if (isWishlistPriorityGroup(panelState, group)) {
      pinned.push(group);
      return;
    }

    const value = effectiveValueForInst(group.rep);
    if (panelState?.min !== null && Number.isFinite(panelState?.min) && value < panelState.min) return;
    if (panelState?.max !== null && Number.isFinite(panelState?.max) && value > panelState.max) return;
    if (!groupMatchesSearch(group, panelState?.searchQuery)) return;

    out.push(group);
  });

  out = sortGroupsForPanel(panelState, out);
  const priority = sortGroupsForPanel(panelState, pinned);
  out = priority.concat(out);

  setActiveComputed(panelState, out);
  return out;
}


  function totalPages(panelState) {
    const n = getActiveComputed(panelState).length;
    return Math.max(1, Math.ceil(n / (panelState?.pageSize || PAGE_SIZE)));
  }

  function clampPageIndex(panelState) {
    if (!panelState) return;
    const tp = totalPages(panelState);
    if (panelState.pageIndex < 0) panelState.pageIndex = 0;
    if (panelState.pageIndex > tp - 1) panelState.pageIndex = tp - 1;
  }

  function sliceForPage(panelState) {
    clampPageIndex(panelState);
    const start = panelState.pageIndex * panelState.pageSize;
    const end = start + panelState.pageSize;
    return getActiveComputed(panelState).slice(start, end);
  }

  function getReactNativeInventoryList(panel) {
    return Array.from(panel?.querySelectorAll?.("ul.item-cards") || [])
      .find((list) => !list.classList.contains("tis-react-item-cards")) || null;
  }

  function getReactPagerParts(panel) {
    const pager = panel?.querySelector?.(".trade-inventory-pager");
    if (!pager) return { pager: null, previous: null, next: null, label: null };
    return {
      pager,
      previous: pager.querySelector('button[aria-label="Back"]'),
      next: pager.querySelector('button[aria-label="Next"]'),
      label: pager.querySelector(".trade-inventory-pager-label"),
    };
  }

  function syncReactSelections(panelState) {
    const panel = getLivePanel(panelState) || panelState?.panel;
    const controller = getReactInventoryController(panel);
    if (!panelState?.all || !controller) return controller;

    const selectedByKey = new Map();
    for (const inst of panelState.all) {
      let selected = false;
      try { selected = Boolean(controller.isItemInOffers(inst)); } catch {}
      if (!selected) continue;
      const key = getGroupKeyForInst(inst);
      let ids = selectedByKey.get(key);
      if (!ids) {
        ids = new Set();
        selectedByKey.set(key, ids);
      }
      ids.add(String(inst.id || inst.collectibleItemInstanceId || ""));
    }
    panelState.selectedByKey = selectedByKey;
    return controller;
  }

  function scheduleReactInventoryRefresh(panelState) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const panel = getLivePanel(panelState);
      if (!panel) return;
      syncReactSelections(panelState);
      applyToAngular(panel, panelState, { skipThumbnailWarmupHold: true });
      publishOfferTotal();
    }));
  }

  function dispatchReactInventoryClick(panel, inst) {
    const controller = getReactInventoryController(panel);
    if (!controller?.onItemClick || !inst) return false;

    const nativeCard = getReactNativeInventoryList(panel)?.querySelector(".trade-inventory-card");
    const propsKey = nativeCard && Object.keys(nativeCard).find((key) => key.startsWith("__reactProps$"));
    const currentProps = propsKey ? nativeCard[propsKey] : null;
    if (!nativeCard || !propsKey || typeof currentProps?.onClickCapture !== "function") {
      controller.onItemClick(inst);
      return true;
    }

    nativeCard[propsKey] = {
      ...currentProps,
      onClickCapture(event) {
        event.preventDefault();
        event.stopPropagation();
        controller.onItemClick(inst);
      },
    };
    try {
      const target = nativeCard.querySelector(".item-card-thumb-container") || nativeCard;
      target.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
    } finally {
      nativeCard[propsKey] = currentProps;
    }
    return true;
  }

  function toggleReactInstance(panelState, inst, sourceElement) {
    const panel = getLivePanel(panelState) || sourceElement?.closest?.(".trade-inventory-panel");
    const controller = getReactInventoryController(panel);
    if (!controller?.onItemClick || !inst || inst.__tisNotForTrade) return false;
    let selected = false;
    try { selected = Boolean(controller.isItemInOffers(inst)); } catch {}
    if (!selected) {
      try {
        if (inst.isOnHold || controller.isItemUnavailable?.(inst)) return false;
      } catch {}
    }
    dispatchReactInventoryClick(panel, inst);
    scheduleReactInventoryRefresh(panelState);
    return true;
  }

  function openReactMultiDropdown(panelState, group, button) {
    if (!panelState || !group?.instances?.length || !button) return;
    if (cache.openDD?.anchor === button) {
      closeMultiDD();
      return;
    }
    closeMultiDD();

    const controller = syncReactSelections(panelState);
    if (!controller) return;
    const dd = document.createElement("div");
    dd.className = "tis-multi-dd";
    dd.addEventListener("mousedown", (event) => event.stopPropagation());

    for (const inst of group.instances) {
      const id = String(inst.id || inst.collectibleItemInstanceId || "");
      const row = document.createElement("label");
      row.className = "tis-multi-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.tisId = id;
      try { checkbox.checked = Boolean(controller.isItemInOffers(inst)); } catch {}
      const text = document.createElement("div");
      const name = document.createElement("div");
      name.textContent = String(inst.itemName || "item");
      const code = document.createElement("code");
      code.textContent = inst.serialNumber != null ? `#${inst.serialNumber} (${id})` : id;
      text.append(name, code);
      row.append(checkbox, text);
      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleReactInstance(panelState, inst, button);
        setTimeout(() => {
          try { checkbox.checked = Boolean(getReactInventoryController(getLivePanel(panelState))?.isItemInOffers(inst)); } catch {}
        }, 0);
      });
      dd.appendChild(row);
    }

    document.body.appendChild(dd);
    const rect = button.getBoundingClientRect();
    const pageWidth = Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0, window.innerWidth);
    dd.style.left = `${Math.min(pageWidth - 260, Math.max(8, window.scrollX + rect.left))}px`;
    dd.style.top = `${Math.max(8, window.scrollY + rect.bottom + 6)}px`;

    const onDown = (event) => {
      if (dd.contains(event.target) || button.contains(event.target)) return;
      closeMultiDD();
    };
    cache.openDD = { el: dd, anchor: button, key: `${panelState.panelKey}:${group.key}`, onDown };
    document.addEventListener("mousedown", onDown, true);
  }

  function createReactInventoryTemplate() {
    const item = document.createElement("li");
    item.className = "list-item item-card trade-item-card";
    item.innerHTML = `
      <div class="trade-inventory-card" role="button" tabindex="0" aria-pressed="false">
        <div class="list-item item-card grid-item-container"><div class="item-card-container">
          <a href="#" target="_self" class="item-card-link"><div class="item-card-link">
            <div class="item-card-thumb-container"><div class="item-card-thumb-container-inner">
              <span class="thumbnail-2d-container"></span>
              <span class="limited-icon-container"><span class="icon-shop-limited"></span><span class="limited-hover-target" aria-hidden="true"></span></span>
            </div></div>
          </div><div class="item-card-caption">
            <div class="item-card-name-link"><div class="item-card-name"></div></div>
            <div class="text-overflow item-card-price font-header-2 text-subheader margin-top-none"><span class="icon-robux-16x16"></span><span class="text-robux-tile"></span></div>
          </div></a>
        </div></div>
      </div>`;
    return item;
  }

  function createReactInventoryCard(panelState, group, template) {
    const item = (template || createReactInventoryTemplate()).cloneNode(true);
    const rep = group?.rep || group?.instances?.[0];
    if (!rep) return item;
    const controller = getReactInventoryController(getLivePanel(panelState) || panelState.panel);
    const instanceId = String(rep.id || rep.collectibleItemInstanceId || "");
    const assetId = String(getAssetIdForGroup(group) || "");
    const itemType = String(rep.itemTarget?.itemType || "Asset");

    item.classList.add("tis-react-inventory-card");
    item.dataset.tisKey = group.key;
    item.dataset.tisPanelKey = panelState.panelKey;
    item.dataset.collectibleiteminstanceid = instanceId;
    const interactive = item.querySelector(".trade-inventory-card") || item;
    const container = item.querySelector(".item-card-container");
    if (container) container.dataset.collectibleiteminstanceid = instanceId;
    const link = item.querySelector("a.item-card-link");
    if (link && assetId) {
      link.href = itemType.toLowerCase().includes("bundle")
        ? `https://www.roblox.com/bundles/${assetId}`
        : `https://www.roblox.com/catalog/${assetId}`;
    }
    const name = item.querySelector(".item-card-name");
    if (name) {
      name.textContent = String(rep.itemName || `Item ${assetId}`);
      name.title = name.textContent;
    }
    const rap = item.querySelector(".text-robux-tile, .item-card-price .text-robux");
    if (rap) rap.textContent = (Number(rep.recentAveragePrice) || 0).toLocaleString();

    const thumbHost = item.querySelector(".thumbnail-2d-container");
    const thumbUrl = getRememberedThumbnailUrlForRequest(getThumbnailRequestForGroup(group, panelState)) ||
      getKnownThumbnailUrlForGroup(group);
    if (thumbHost) {
      thumbHost.classList.remove("shimmer", "icon-broken");
      thumbHost.replaceChildren();
      if (thumbUrl) {
        const image = document.createElement("img");
        image.className = "tis-react-card-image";
        image.alt = String(rep.itemName || "");
        image.decoding = "async";
        image.src = thumbUrl;
        thumbHost.appendChild(image);
      }
    }

    let selected = false;
    let unavailable = Boolean(rep.isOnHold || rep.__tisNotForTrade);
    try {
      selected = Boolean(controller?.isItemInOffers(rep));
      unavailable = unavailable || Boolean(controller?.isItemUnavailable(rep) && !selected);
    } catch {}
    interactive.setAttribute("aria-pressed", String(selected));
    interactive.setAttribute("aria-disabled", String(unavailable));
    item.classList.toggle("tis-react-selected", selected);
    item.classList.toggle("tis-react-unavailable", unavailable);
    item.classList.toggle("tis-wishlist-match-card", isWishlistPriorityGroup(panelState, group));
    syncWishlistNameDecoration(name, isWishlistPriorityGroup(panelState, group), String(rep.itemName || "wishlist match"));

    const limited = item.querySelector(".limited-icon-container");
    if (group.count > 1 && limited) {
      limited.replaceChildren();
      const countButton = document.createElement("button");
      countButton.type = "button";
      countButton.className = "tis-multi-btn";
      countButton.textContent = panelState.viewMode === "bag" ? `x${group.count}` : `x${group.count} ▾`;
      countButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (panelState.viewMode !== "bag") openReactMultiDropdown(panelState, group, countButton);
      });
      limited.appendChild(countButton);

      if (panelState.viewMode === "main") {
        const plus = document.createElement("button");
        plus.type = "button";
        plus.className = "tis-multi-plus tis-multi-plus-float";
        plus.textContent = "+";
        plus.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const liveController = syncReactSelections(panelState);
          const available = group.instances.filter((inst) => {
            try { return !inst.isOnHold && !liveController?.isItemInOffers(inst) && !liveController?.isItemUnavailable(inst); } catch { return !inst.isOnHold; }
          });
          const pick = available[Math.floor(Math.random() * available.length)];
          if (pick) toggleReactInstance(panelState, pick, plus);
        });
        item.querySelector(".item-card-thumb-container")?.appendChild(plus);
      }
    } else if (limited) {
      const serial = Number(rep.serialNumber);
      if (Number.isFinite(serial) && serial > 0) {
        limited.innerHTML = '<span class="limited-number-container"><span class="font-caption-header">#</span><span class="limited-number"></span></span>';
        formatLimitedSerialBubble(limited, { serial });
      }
      const serialLine = getSerialTooltipLine(rep);
      bindLimitedInfoTooltip(limited, {
        enabled: Boolean(instanceId),
        lines: serialLine ? [serialLine, instanceId] : [instanceId],
        copyValue: instanceId,
        copyLineIndex: serialLine ? 1 : 0,
      });
    }

    const activate = (event) => {
      if (event.target?.closest?.(".tis-multi-btn, .tis-multi-plus")) return;
      event.preventDefault();
      if (panelState.viewMode === "nft") return;
      const liveController = syncReactSelections(panelState);
      if (!liveController) return;
      if (group.count > 1) {
        const selectedInstances = group.instances.filter((inst) => {
          try { return liveController.isItemInOffers(inst); } catch { return false; }
        });
        if (selectedInstances.length) selectedInstances.forEach((inst) => toggleReactInstance(panelState, inst, interactive));
        else {
          const available = group.instances.filter((inst) => {
            try { return !inst.isOnHold && !liveController.isItemUnavailable(inst); } catch { return !inst.isOnHold; }
          });
          const pick = available[Math.floor(Math.random() * available.length)];
          if (pick) toggleReactInstance(panelState, pick, interactive);
        }
      } else {
        toggleReactInstance(panelState, rep, interactive);
      }
    };
    interactive.addEventListener("click", activate, true);
    interactive.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    }, true);
    return item;
  }

  function renderReactInventory(panel, panelState, pageGroups) {
    const nativeList = getReactNativeInventoryList(panel);
    if (!nativeList) return false;
    const template = nativeList.querySelector(":scope > li, :scope > .list-item") || createReactInventoryTemplate();
    nativeList.style.display = "none";
    nativeList.setAttribute("aria-hidden", "true");

    let list = panel.querySelector("ul.tis-react-item-cards");
    if (!list) {
      list = document.createElement("ul");
      list.className = `${nativeList.className} tis-react-item-cards`;
      nativeList.insertAdjacentElement("afterend", list);
    }
    list.replaceChildren(...pageGroups.map((group) => createReactInventoryCard(panelState, group, template)));
    syncInventoryLabel(panel, panelState);
    return true;
  }

function applyToAngular(panel, panelState = getPanelState(panel), options = {}) {
  if (!panelState) return;
  const scope = findAngularInventoryScope(panel);
  const reactController = getReactInventoryController(panel);
  if (!scope && !reactController) {
    console.warn(`${TAG} couldnt find angular inventory scope yet`);
    return;
  }

  computeList(panelState);

  const pageGroups = isActive(panelState)
    ? sliceForPage(panelState)
    : getActiveComputed(panelState).slice(0, panelState.pageSize);

  const preloadGroups = getThumbnailPreloadWindow(panelState, pageGroups);
  const thumbnailPreloadPromise = preloadThumbnailsForGroups(panelState, preloadGroups, "apply-angular");
  const needsThumbnailWarmup = pageGroupsNeedThumbnailWarmup(panelState, pageGroups);
  const thumbnailHoldSignature = `${panelState.viewMode}:${panelState.pageIndex}:${pageGroups.map((group) => group?.key || "").join("|")}`;
  if (
    !options.skipThumbnailWarmupHold &&
    pageGroups.length &&
    needsThumbnailWarmup &&
    thumbnailPreloadPromise?.then &&
    panelState.thumbnailApplyHoldSignature !== thumbnailHoldSignature
  ) {
    panelState.thumbnailApplyHoldSignature = thumbnailHoldSignature;
    const token = ++panelState.thumbnailApplyHoldToken;
    let released = false;
    const release = () => {
      if (released || panelState.thumbnailApplyHoldToken !== token) return;
      released = true;
      panelState.thumbnailApplyHoldSignature = "";
      const livePanel = getLivePanel(panelState) || panel;
      if (livePanel?.isConnected) {
        applyToAngular(livePanel, panelState, { skipThumbnailWarmupHold: true });
      }
    };
    thumbnailPreloadPromise.then(release, release);
    setTimeout(release, 180);
    return;
  }
  if (!needsThumbnailWarmup) panelState.thumbnailApplyHoldSignature = "";

  debug("applyToAngular", {
    viewMode: panelState.viewMode,
    pageIndex: panelState.pageIndex,
    totalGroups: getActiveComputed(panelState).length,
    pageGroups: pageGroups.length
  });

  // Both renderers use stable representative clones so selecting one copy does
  // not mutate the real collectible instance IDs kept in the group.
  const pageSlice = pageGroups.map(g => {
  // IMPORTANT: use a stable clone for display so we never mutate real instance ids
  if (!g.viewRep) g.viewRep = { ...g.rep };

  const rep = g.viewRep;

  rep.__tisKey = g.key;
  rep.__tisCount = g.count;
  rep.__tisViewMode = panelState.viewMode;
  rep.__tisWishlistMatch = isWishlistPriorityGroup(panelState, g);
  rep.__tisNotForTrade = panelState.viewMode === "nft" || Boolean(g.rep?.__tisNotForTrade);

  const rememberedThumbnailUrl =
    getRememberedThumbnailUrlForRequest(getThumbnailRequestForGroup(g, panelState)) ||
    getRememberedThumbnailUrl(getThumbnailMemoryKeyForInst(rep));
  if (rememberedThumbnailUrl) rep.thumbnailUrl = rememberedThumbnailUrl;

  return rep;
  });

  if (reactController) {
    renderReactInventory(panel, panelState, pageGroups);
    updatePagerDisabled(panel, panelState);
    updatePagerLabel(panel, panelState);
    setTimeout(() => {
      try { renderBagOfHoldingCard(panel, panelState); } catch {}
    }, 0);
    return;
  }


  scope.$applyAsync(() => {
    if (scope.inventoryData?.tradableItems) {
      scope.inventoryData.tradableItems = pageSlice;
    } else if (scope.inventory?.tradableItems) {
      scope.inventory.tradableItems = pageSlice;
    }
  });

  updatePagerDisabled(panel, panelState);
  updatePagerLabel(panel, panelState);

  // decorate after angular renders
  setTimeout(() => {
    try { syncThumbnailMemoryForPanel(panel, panelState); } catch (e) {}
    try { decorateMultiCopyUI(panel, panelState); } catch (e) {}
    try { renderBagOfHoldingCard(panel, panelState); } catch (e) {}
  }, 0);
}
function closeMultiDD() {
  const od = cache.openDD;
  if (!od) return;

  if (od.onDown) {document.removeEventListener("mousedown", od.onDown, true);}
  try { od.el.remove(); } catch {}
  cache.openDD = null;
}


function syncRepSelection(panelState, key, sc) {
    const g = getActiveGroupMap(panelState).get(key);
    if (!g) return;

    // prefer the angular-facing clone
    const rep = g.viewRep || g.rep;
    if (!rep) return;

    // stash original ids once (on the clone)
    if (!rep.__tisOrigId) rep.__tisOrigId = rep.id;
    if (!rep.__tisOrigIid) rep.__tisOrigIid = rep.collectibleItemInstanceId;

    const sel = panelState.selectedByKey.get(key);

    if (sel && sel.size) {
    const firstId = sel.values().next().value;
    rep.id = firstId;
    rep.collectibleItemInstanceId = firstId;
    } else {
    rep.id = rep.__tisOrigId;
    rep.collectibleItemInstanceId = rep.__tisOrigIid;
    }


    // kick angular so the overlay updates
    if (sc && typeof sc.$applyAsync === "function") sc.$applyAsync(() => {});
}

function syncWishlistNameDecoration(nameEl, isMatch, title) {
  if (!nameEl) return;

  const existing = nameEl.querySelector(":scope > .tis-wishlist-text");
  const text = String(existing?.textContent || nameEl.textContent || "").trim();

  nameEl.classList.toggle("tis-wishlist-match-name", isMatch);

  if (!isMatch) {
    if (existing) nameEl.textContent = existing.textContent;
    return;
  }

  nameEl.title = nameEl.title || title || text || "wishlist match";

  let wrap = existing;
  if (!wrap || nameEl.childNodes.length !== 1) {
    nameEl.textContent = "";
    wrap = document.createElement("span");
    wrap.className = "tis-wishlist-text";
    nameEl.appendChild(wrap);
  }

  wrap.textContent = text;
  wrap.dataset.tisText = text;
}


function decorateWishlistCard(thumb, tradableItem) {
  const cardRoot =
    thumb?.closest?.(".item-card-container") ||
    thumb?.closest?.(".item-card") ||
    thumb?.closest?.("li") ||
    thumb?.parentElement ||
    null;
  const isMatch = Boolean(tradableItem?.__tisWishlistMatch);

  cardRoot?.classList?.toggle("tis-wishlist-match-card", isMatch);
  const nameEl = cardRoot?.querySelector?.(".item-card-caption .item-card-name");
  syncWishlistNameDecoration(nameEl, isMatch, String(tradableItem?.itemName || "wishlist match"));
}

function decorateMultiCopyUI(panel, panelState = getPanelState(panel)) {
  if (!panelState || !window.angular?.element) return;

  const thumbs = panel.querySelectorAll(
    '.item-card-thumb-container[ng-click*="root.onItemCardClick"]'
  );

  thumbs.forEach((thumb) => {
    const ng = window.angular.element(thumb);
    const sc = ng.scope?.() || ng.isolateScope?.();
    const ti = sc?.tradableItem;
    syncThumbnailMemoryForThumb(thumb, panelState, ti);
    decorateWishlistCard(thumb, ti);

    const key = ti?.__tisKey;
    const cardRoot =
      thumb.closest(".item-card-container") ||
      thumb.closest(".item-card") ||
      thumb.closest("li") ||
      thumb.parentElement;

    if (key && cardRoot) {
      cardRoot.setAttribute("data-tis-key", key);
      cardRoot.setAttribute("data-tis-panel-key", panelState.panelKey);
    }

    if (thumb.__tisDecorated) return;

    const count = ti?.__tisCount ?? 1;

    if (!key) {
      thumb.__tisDecorated = true;
      return;
    }

    // single-copy serial replace
    if (count <= 1) {
      const lic = thumb.querySelector(".limited-icon-container");
      const collectibleAssetId = getCollectibleItemInstanceId(ti);
      const serialLine = getSerialTooltipLine(ti);
      const serial = ti?.serialNumber;
      if (lic && serial !== null && serial !== undefined) {
        formatLimitedSerialBubble(lic, { serial });
      }

      if (lic) {
        bindLimitedInfoTooltip(lic, {
          enabled: Boolean(collectibleAssetId),
          lines: serialLine ? [serialLine, collectibleAssetId] : [collectibleAssetId],
          copyValue: collectibleAssetId || "",
          copyLineIndex: serialLine ? 1 : 0,
        });
      }

      thumb.__tisDecorated = true;
      return;
    }


    const group = getActiveGroupMap(panelState).get(key);
    if (!group) {
    thumb.__tisDecorated = true;
    return;
    }

    // IMPORTANT: only the rendered "rep" got angular's layoutOptions.
    // clone/stamp it onto the other instances so roblox accepts them.
    const repLayout = ti.layoutOptions;
    if (repLayout) {
    for (const inst of group.instances) {
        if (!inst.layoutOptions) inst.layoutOptions = repLayout;
    }
    }


    const lic = thumb.querySelector(".limited-icon-container");
    if (lic) {
        [
          "uib-tooltip",
          "tooltip-placement",
          "tooltip-append-to-body",
          "tooltip-class",
          "title",
          "aria-label",
          "data-original-title",
        ].forEach((attr) => lic.removeAttribute(attr));
        bindLimitedInfoTooltip(lic, { enabled: false });
    }
    const icon = thumb.querySelector(".limited-icon-container .icon-shop-limited");
    if (!icon) return;
    if (icon && !icon.__tisReplaced) {
    icon.__tisReplaced = true;

    // create the dropdown button (you accidentally deleted this)
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tis-multi-btn";
    btn.textContent = `x${count} ▾`;

    btn.setAttribute("title", "");
    btn.setAttribute("aria-label", "");
    btn.setAttribute("data-original-title", "");
    btn.addEventListener("mouseover", (event) => event.stopPropagation());
    btn.addEventListener("mouseenter", (event) => event.stopPropagation());
    icon.replaceWith(btn);

    if (panelState.viewMode === "bag") {
        btn.textContent = `x${count}`;
        thumb.__tisDecorated = true;
        return;
    }

    // floating + button on the opposite side
    if (!thumb.__tisPlusAdded) {
        thumb.__tisPlusAdded = true;

        thumb.style.position = "relative";

        const plus = document.createElement("button");
        plus.type = "button";
        plus.className = "tis-multi-plus tis-multi-plus-float";
        plus.textContent = "+";

        plus.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        let sel = panelState.selectedByKey.get(key);
        if (!sel) {
            sel = new Set();
            panelState.selectedByKey.set(key, sel);
        }

        const root = sc?.root;

        const pick = pickRandomAvailable(group, root);
        if (!pick) return;

        const pid = pick.id || pick.collectibleItemInstanceId;

        window.tisAddToOfferVanilla(pick, thumb);

        setTimeout(() => {
        const added = root ? inOffers(root, pick) : true;
        if (added) sel.add(pid);

        // if dropdown open for this key, reflect
        if (cache.openDD?.key === `${panelState.panelKey}:${key}`) {
            const cb = cache.openDD.el.querySelector(`input[data-tis-id="${pid}"]`);
            if (cb) cb.checked = true;
        }

        syncRepSelection(panelState, key, sc);
        }, 0);

        });

        thumb.appendChild(plus);
    }

    // dropdown toggle
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (cache.openDD?.anchor === btn) {
        closeMultiDD();
        return;
        }
        closeMultiDD();

        let sel = panelState.selectedByKey.get(key);
        if (!sel) {
        sel = new Set();
        panelState.selectedByKey.set(key, sel);
        }

        const dd = document.createElement("div");
        dd.className = "tis-multi-dd";
        dd.addEventListener("mousedown", (ev) => ev.stopPropagation());

        const mkLabel = (inst) => {
        const id = inst.id || inst.collectibleItemInstanceId || "unknown";
        const serial = inst.serialNumber;
        if (serial !== null && serial !== undefined) return `#${serial} (${id})`;
        return `${id}`;
        };

        for (const inst of group.instances) {
        const id = inst.id || inst.collectibleItemInstanceId;

        const row = document.createElement("label");
        row.className = "tis-multi-row";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.setAttribute("data-tis-id", id);
        cb.checked = sel.has(id);

        const text = document.createElement("div");
        text.innerHTML = `<div>${inst.itemName || ""}</div><code>${mkLabel(inst)}</code>`;

        row.appendChild(cb);
        row.appendChild(text);
        dd.appendChild(row);

        row.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            cb.checked = !cb.checked;

            window.tisAddToOfferVanilla(inst, thumb);

            setTimeout(() => {
            const inOffer = sc?.root ? inOffers(sc.root, inst) : cb.checked;


            cb.checked = !!inOffer;
            if (inOffer) sel.add(id);
            else sel.delete(id);

            syncRepSelection(panelState, key, sc);
            }, 0);
        });
        }

        document.body.appendChild(dd);

        const r = btn.getBoundingClientRect();
        const pageWidth = Math.max(
          document.documentElement?.scrollWidth || 0,
          document.body?.scrollWidth || 0,
          window.innerWidth
        );
        const x = Math.min(pageWidth - 260, Math.max(8, window.scrollX + r.left));
        const y = Math.max(8, window.scrollY + r.bottom + 6);
        dd.style.left = `${x}px`;
        dd.style.top = `${y}px`;

        const onDown = (ev) => {
        const od = cache.openDD;
        if (!od) return;
        if (od.el.contains(ev.target) || od.anchor.contains(ev.target)) return;
        closeMultiDD();
        };

        cache.openDD = { el: dd, anchor: btn, key: `${panelState.panelKey}:${key}`, onDown };
        document.addEventListener("mousedown", onDown, true);
            });
            }
            thumb.__tisDecorated = true;
        });
        }


  async function fetchAllTradableInstances(panelState = null) {
    if (!panelState) throw new Error("missing inventory panel state");
    if (panelState.all) return panelState.all;
    if (panelState.loadingPromise) return panelState.loadingPromise;
    if (Date.now() < Number(panelState.nextFetchAttemptAt || 0)) {
      throw new Error("tradable items request is cooling down");
    }

    panelState.loadingPromise = (async () => {
      const uid = resolvePanelOwnerId(panelState) || getUserId();
      if (!uid) throw new Error("couldnt detect inventory userId");

      const all = [];
      const seenInstIds = new Set(); // dedupe across pages / retries
      let cursor = "";
      const seen = new Set();

      while (true) {
        const url =
          `https://trades.roblox.com/v2/users/${uid}/tradableitems` +
          `?sortBy=CreationTime&cursor=${encodeURIComponent(cursor)}` +
          `&limit=50&sortOrder=Desc`;

        const nativePages = cache.nativeTradablePagesByOwnerId.get(String(uid));
        const nativeData = nativePages?.get(cursor) || (
          cursor === "" ? await waitForNativeTradableItems(uid, cursor) : null
        );
        const data = nativeData || await fetchTradableItemsPage(url);

        const items = Array.isArray(data.items) ? data.items : [];
        for (const it of items) {
            const insts = Array.isArray(it.instances) && it.instances.length ? it.instances : [it];

            for (const inst of insts) {
                const iid = inst.collectibleItemInstanceId || inst.id;
                if (!iid) continue;

                // dedupe so counts don't get multiplied by 50 (or worse)
                if (seenInstIds.has(iid)) continue;
                seenInstIds.add(iid);

                all.push({
                ...inst,

                // roblox trade UI expects these:
                userId: data.userId,                // owner of the inventory
                id: iid,                            // roblox code uses t.id

                // parent-level id (handy / sometimes expected by other helpers)
                collectibleItemId: it.collectibleItemId,
                collectibleItemInstanceId: iid,

                // normalize / ensure these exist on the instance object:
                itemTarget: inst.itemTarget ?? it.itemTarget,
                itemName: inst.itemName ?? it.itemName,
                recentAveragePrice: inst.recentAveragePrice ?? it.recentAveragePrice,
                originalPrice: inst.originalPrice ?? it.originalPrice,
                assetStock: inst.assetStock ?? it.assetStock,
                thumbnailUrl:
                  inst.thumbnailUrl ??
                  it.thumbnailUrl ??
                  inst.imageUrl ??
                  it.imageUrl ??
                  inst.thumbnail?.imageUrl ??
                  it.thumbnail?.imageUrl ??
                  null
                });
            }
        }


        const next = data.nextPageCursor || null;

        if (!next) break;
        if (seen.has(next)) break;
        seen.add(next);
        cursor = next;

        // Roblox's React page already makes its own inventory requests. Give
        // the endpoint room before following a cursor for the full sort view.
        await sleep(2000);
      }

      hydratePanelStateFromAll(panelState, all);
      return panelState.all;
    })().catch(err => {
      panelState.loadingPromise = null;
      panelState.nextFetchAttemptAt = Date.now() + (/429|cooldown/i.test(String(err?.message || err)) ? 30000 : 5000);
      console.error(`${TAG} failed fetching tradable items:`, err);
      throw err;
    });

    return panelState.loadingPromise;
  }

function hookGlobalMultiCardClicks() {
  if (cache.__tisGlobalCardClickHooked) return;
  cache.__tisGlobalCardClickHooked = true;

  document.addEventListener("click", (e) => {
    // ignore our controls + open dropdown
    if (e.target?.closest?.(".tis-multi-dd, .tis-multi-btn, .tis-multi-plus")) return;

    const card = e.target?.closest?.("[data-tis-key]");
    if (!card) return;

    const panelKey = card.getAttribute("data-tis-panel-key");
    const panelState = getPanelStateByKey(panelKey);
    if (!panelState) return;
    if (panelState.viewMode === "bag") return;

    const key = card.getAttribute("data-tis-key");
    const group = getActiveGroupMap(panelState).get(key);
    if (!group || !group.instances?.length) return;

    // borrow the thumb scope (roblox is angular, so we play their stupid games)
    const thumb = card.querySelector('.item-card-thumb-container[ng-click*="root.onItemCardClick"]');
    if (!thumb) return;

    const ng = window.angular?.element?.(thumb);
    const sc = ng?.scope?.() || ng?.isolateScope?.();
    const root = sc?.root;

    // only hijack when it's truly a multi-copy item
    const rep = sc?.tradableItem;
    const count = rep?.__tisCount ?? group.instances.length;
    if (count <= 1) return;

    // kill every other click handler (including angular)
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    let sel = panelState.selectedByKey.get(key);
    if (!sel) {
      sel = new Set();
      panelState.selectedByKey.set(key, sel);
    }

    // if any selected -> remove them all (clean slate)
    if (sel.size) {
      for (const id of Array.from(sel)) {
        const inst = group.instances.find(x => (x.id || x.collectibleItemInstanceId) === id);
        if (!inst) continue;

        if (typeof root?.isItemInOffers === "function") {
          if (root.isItemInOffers(inst)) window.tisAddToOfferVanilla(inst, thumb);
        } else {
          window.tisAddToOfferVanilla(inst, thumb);
        }
      }

      sel.clear();
      panelState.autoPickByKey.delete(key);

      setTimeout(() => {
        syncRepSelection(panelState, key, sc);
      }, 0);
      return;
    }

    // else toggle ONE stable random copy
    let pickId = panelState.autoPickByKey.get(key);

    const getInstById = (id) => group.instances.find(x => idFromInst(x) === String(id));

    // if we had a previous pick but it's not in the offer anymore, forget it
    if (pickId && root) {
    const prevInst = getInstById(pickId);
    if (prevInst && !inOffers(root, prevInst)) pickId = null;
    }

    // pick a new stable one if needed (prefer not-on-hold)
    if (!pickId) {
    const pool = group.instances.filter(x => !x.isOnHold);
    const pick = (pool.length ? pool : group.instances)[Math.floor(Math.random() * (pool.length ? pool.length : group.instances.length))];
    pickId = idFromInst(pick);
    panelState.autoPickByKey.set(key, pickId);
    }

    const inst = getInstById(pickId);
    if (!inst) return;


    window.tisAddToOfferVanilla(inst, thumb);

    setTimeout(() => {
      const inOffer = typeof root?.isItemInOffers === "function" ? root.isItemInOffers(inst) : !sel.has(pickId);
      if (inOffer) sel.add(pickId);
      else sel.delete(pickId);

      syncRepSelection(panelState, key, sc);
    }, 0);

  }, true); // capture
}


  function hookPager(panel, panelState = getPanelState(panel)) {
    const reactPager = getReactPagerParts(panel);
    const prevBtn = panel.querySelector(".pager-prev button") || reactPager.previous;
    const nextBtn = panel.querySelector(".pager-next button") || reactPager.next;

    if (!panelState || !prevBtn || !nextBtn) return;
    if (prevBtn.__tisPagerHooked && nextBtn.__tisPagerHooked) return;

    const onPrev = (e) => {
    if (!isActive(panelState)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    panelState.pageIndex -= 1;
    applyToAngular(panel, panelState);
    };

    const onNext = (e) => {
    if (!isActive(panelState)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    panelState.pageIndex += 1;
    applyToAngular(panel, panelState);
    };


    // capture=true so we beat angular’s click handler
    prevBtn.addEventListener("click", onPrev, true);
    nextBtn.addEventListener("click", onNext, true);

    prevBtn.__tisPagerHooked = true;
    nextBtn.__tisPagerHooked = true;
  }

  function updatePagerDisabled(panel, panelState = getPanelState(panel)) {
    const reactPager = getReactPagerParts(panel);
    const prevBtn = panel.querySelector(".pager-prev button") || reactPager.previous;
    const nextBtn = panel.querySelector(".pager-next button") || reactPager.next;
    if (!panelState || !prevBtn || !nextBtn) return;

    if (!isActive(panelState)) {
      // dont mess with their UI when we're inactive
      prevBtn.disabled = false;
      nextBtn.disabled = false;
      return;
    }

    clampPageIndex(panelState);
    const tp = totalPages(panelState);
    prevBtn.disabled = panelState.pageIndex <= 0;
    nextBtn.disabled = panelState.pageIndex >= tp - 1;
  }

  function buildControls(panel, panelState = getPanelState(panel)) {
    if (!panelState || panel.querySelector(".tis-controls")) return;

    const header =
      panel.querySelector("h2.inventory-label") ||
      panel.querySelector(".inventory-header h2") ||
      panel.querySelector("h2");
    if (!header) return;

    const wrap = document.createElement("div");
    wrap.className = "tis-controls";

    const resetBtn = document.createElement("button");
    resetBtn.className = "tis-btn tis-btn-reset";
    resetBtn.textContent = "reset";

    const hiBtn = document.createElement("button");
    hiBtn.className = "tis-btn tis-btn-primary";
    hiBtn.textContent = "high to low";

    const loBtn = document.createElement("button");
    loBtn.className = "tis-btn tis-btn-primary";
    loBtn.textContent = "low to high";

    const minInput = document.createElement("input");
    minInput.className = "tis-input";
    minInput.dataset.tisFilter = "min";
    minInput.type = "number";
    minInput.inputMode = "numeric";
    minInput.placeholder = "min";
    minInput.min = "0";

    const maxInput = document.createElement("input");
    maxInput.className = "tis-input";
    maxInput.dataset.tisFilter = "max";
    maxInput.type = "number";
    maxInput.inputMode = "numeric";
    maxInput.placeholder = "max";
    maxInput.min = "0";

    const searchInput = document.createElement("input");
    searchInput.className = "tis-input tis-search-input";
    searchInput.dataset.tisFilter = "search";
    searchInput.type = "search";
    searchInput.placeholder = "search";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;

    wrap.appendChild(resetBtn);
    wrap.appendChild(hiBtn);
    wrap.appendChild(loBtn);
    wrap.appendChild(minInput);
    wrap.appendChild(maxInput);
    wrap.appendChild(searchInput);

    // insert right under header
    header.insertAdjacentElement("afterend", wrap);
    syncControlValues(panel, panelState);

    let debounce = null;
    const scheduleApply = () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        try {
          if (!panelState.all) await fetchAllTradableInstances(panelState);
          panelState.pageIndex = 0;
          applyToAngular(panel, panelState);
        } catch (err) {
          console.error(`${TAG} apply failed:`, err);
        }
      }, 150);
    };

    resetBtn.addEventListener("click", async () => {
      panelState.sortMode = "none";
      panelState.min = null;
      panelState.max = null;
      panelState.searchQuery = "";
      panelState.pageIndex = 0;

      minInput.value = "";
      maxInput.value = "";
      searchInput.value = "";

      try {
        if (!panelState.all) await fetchAllTradableInstances(panelState);
        applyToAngular(panel, panelState);
      } catch (err) {
        console.error(`${TAG} reset failed:`, err);
      }
    });

    hiBtn.addEventListener("click", async () => {
      panelState.sortMode = "desc";
      scheduleApply();
    });

    loBtn.addEventListener("click", async () => {
      panelState.sortMode = "asc";
      scheduleApply();
    });

    minInput.addEventListener("input", () => {
      const v = minInput.value.trim();
      panelState.min = v === "" ? null : Number(v);
      scheduleApply();
    });

    maxInput.addEventListener("input", () => {
      const v = maxInput.value.trim();
      panelState.max = v === "" ? null : Number(v);
      scheduleApply();
    });

    searchInput.addEventListener("input", () => {
      panelState.searchQuery = searchInput.value.trim();
      scheduleApply();
    });
  }

function ensurePagerLabel(panel, panelState = getPanelState(panel)) {
  // find the pager container
  const pager = panel.querySelector(".pager, .trade-pager, .inventory-pager, .trade-inventory-pager");
  if (!pager) return null;

  // this is the exact roblox "Page 1" span you pasted
  const robloxPageSpan =
    pager.querySelector("span[ng-bind*='Label.CurrentPage']") ||
    pager.querySelector(".trade-inventory-pager-label") ||
    Array.from(pager.querySelectorAll("span.ng-binding")).find(el =>
      /^page\s+\d+/i.test((el.textContent || "").trim())
    );

  // if our label already exists, keep it
  let tisLabel = pager.querySelector(".tis-pager-label");

  // if roblox span exists, hide it (but keep it so we can read it when inactive)
  if (robloxPageSpan && !robloxPageSpan.__tisHidden) {
    robloxPageSpan.__tisHidden = true;
    robloxPageSpan.style.display = "none";
  }

  // when we're inactive, roblox changes this span. mirror those changes into our label.
    if (robloxPageSpan && !robloxPageSpan.__tisMirrorObs) {
    robloxPageSpan.__tisMirrorObs = true;

    const obs = new MutationObserver(() => {
        // only mirror roblox paging when we're inactive
        if (!isActive(panelState)) updatePagerLabel(panel, panelState);
    });

    obs.observe(robloxPageSpan, {
        childList: true,
        characterData: true,
        subtree: true
    });
    }


  // if we don't have our label yet, create it and put it where roblox span lived
  if (!tisLabel) {
    tisLabel = document.createElement("span");
    tisLabel.className = "tis-pager-label";
    tisLabel.textContent = "page 1/1";

    if (robloxPageSpan && robloxPageSpan.parentNode) {
      // insert right after the hidden roblox span so it's in the same spot
      robloxPageSpan.insertAdjacentElement("afterend", tisLabel);
    } else {
      // fallback: shove it before next button
      const nextBtnWrap =
        pager.querySelector(".pager-next") ||
        pager.querySelector(".next") ||
        pager.lastElementChild;

      if (nextBtnWrap?.parentNode) nextBtnWrap.parentNode.insertBefore(tisLabel, nextBtnWrap);
      else pager.appendChild(tisLabel);
    }
  }

  return tisLabel;
}

function updatePagerLabel(panel, panelState = getPanelState(panel)) {
  const label = ensurePagerLabel(panel, panelState);
  if (!panelState || !label) return;

  if (isActive(panelState)) {
    // our paging
    clampPageIndex(panelState);
    label.textContent = `page ${panelState.pageIndex + 1}/${totalPages(panelState)}`;
    return;
  }

  // inactive: roblox paging. mirror what their hidden span says (so it stays accurate)
  const pager = panel.querySelector(".pager, .trade-pager, .inventory-pager, .trade-inventory-pager");
  const robloxPageSpan =
    pager?.querySelector("span[ng-bind*='Label.CurrentPage']") ||
    pager?.querySelector(".trade-inventory-pager-label") ||
    Array.from(pager?.querySelectorAll("span.ng-binding") || []).find(el =>
      /^page\s+\d+/i.test((el.textContent || "").trim())
    );

  const t = (robloxPageSpan?.textContent || "").trim();
  label.textContent = t ? t.toLowerCase() : "page ?";
}

function getOfferRootForPanelState(panelState = null) {
  const offerHeaders = Array.from(document.querySelectorAll(".trade-request-window-offer h2"));
  const heading = panelState?.isMine ? "your offer" : "your request";
  const offerHeader = offerHeaders.find(h => (h.textContent || "").trim().toLowerCase() === heading);
  return offerHeader?.closest(".trade-request-window-offer") || null;
}

function getOfferInstanceIdsFromDOM(panelState = null) {
  const offerRoot = getOfferRootForPanelState(panelState);
  if (!offerRoot) return new Set();

  const nodes = offerRoot.querySelectorAll(".trade-request-item:not(.blank-item), .item-card-container[data-collectibleiteminstanceid]");
  const ids = new Set();
  nodes.forEach(n => {
    const item = getReactTradeItem(n);
    const v = n.getAttribute("data-collectibleiteminstanceid") || item?.collectibleItemInstanceId || item?.id;
    if (v) ids.add(v);
  });
  return ids;
}


function reconcileSelectionsFromOfferDOM(panel, panelState = getPanelState(panel)) {
  if (!panelState?.all) return;

  const offerIds = getOfferInstanceIdsFromDOM(panelState);

  // rebuild selectedByKey from scratch based on what roblox is *actually* showing in the offer
  const nextSelected = new Map(); // key -> Set(ids)

  for (const id of offerIds) {
    const key = panelState.instKeyById.get(id);
    if (!key) continue;
    let set = nextSelected.get(key);
    if (!set) {
      set = new Set();
      nextSelected.set(key, set);
    }
    set.add(id);
  }

  panelState.selectedByKey = nextSelected;

  // keep autoPick sane: if the picked id isn't in offer anymore, forget it
  for (const [key, pickId] of panelState.autoPickByKey.entries()) {
    if (!offerIds.has(pickId)) panelState.autoPickByKey.delete(key);
  }
  // update overlays on currently rendered cards
  if (getReactInventoryController(panel)) {
    try { applyToAngular(panel, panelState, { skipThumbnailWarmupHold: true }); } catch {}
  } else {
    try { decorateMultiCopyUI(panel, panelState); } catch {}
  }
  publishOfferTotal();
}

function hookOfferReconcile(panel, panelState = getPanelState(panel)) {
  if (!panelState) return;

  const offerRoot = getOfferRootForPanelState(panelState);
  if (!offerRoot) return; // try again next initOnceReady tick
  if (panelState.offerObsRoot === offerRoot) return;

  try { panelState.offerObs?.disconnect(); } catch {}
  panelState.offerObs = null;
  panelState.offerObsRoot = offerRoot;

  let t = null;
  const schedule = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      reconcileSelectionsFromOfferDOM(panel, panelState);
    }, 50);
  };

  const obs = new MutationObserver(schedule);
  obs.observe(offerRoot, { childList: true, subtree: true });
  panelState.offerObs = obs;

  schedule();
  publishOfferTotal();
}

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;

  const msg = ev?.data;
  if (msg?.type !== "TIS_ROLI_ITEMDETAILS" || !msg.data || typeof msg.data !== "object") {
    return;
  }

  cache.roli = msg.data;
  cache.roliExactNameMap = null;
  cache.roliNormalizedNameMap = null;

  for (const panel of getInventoryPanels()) {
    const panelState = getPanelState(panel);
    if (panelState?.playerDetails) {
      rebuildNotForTradeGroups(panelState);
      ensureNotForTradeThumbnailsLoaded(panelState, "roli-itemdetails-message");
    }
    if (!panelState?.all) continue;

    try {
      if (
        panelState.sortMode !== "none" ||
        panelState.min !== null ||
        panelState.max !== null ||
        panelState.searchQuery ||
        panelState.viewMode === "nft"
      ) {
        applyToAngular(panel, panelState);
      }
    } catch (err) {
      console.warn(`${TAG} failed to apply rolimons data:`, err);
    }
  }
  renderAllBagOfHoldingCards();
  publishOfferTotal();
});



  async function initOnceReady() {
    // basic roblox SPA protection
    if (!isOnTradePage()) return;

    const pageContextKey = getTradePageContextKey();
    const pageContextChanged = cache.pageContextKey !== pageContextKey;
    if (pageContextChanged) {
      cache.pageContextKey = pageContextKey;
      resetInventoryViewState("page-context-change");
    }

    const panels = getInventoryPanels();
    if (!panels.length) return;

    hookGlobalMultiCardClicks();
    installThumbnailMemoryObserver();

    panels.forEach((panel) => {
      const panelState = getPanelState(panel);
      if (!panelState) return;

      const isNewPanel = pageContextChanged || panelState.panel !== panel;
      const needsApply = isNewPanel || !panel.querySelector("[data-tis-key]");
      panelState.panel = panel;
      syncInventoryLabel(panel, panelState);

      removeBuiltInItemTypeDropdown(panel);
      hookOfferReconcile(panel, panelState);
      buildControls(panel, panelState);
      syncControlValues(panel, panelState);
      hookPager(panel, panelState);
      renderBagOfHoldingCard(panel, panelState);
      ensureRolimonsPlayerDetailsForPanel(panelState).catch((err) => {
        noteRolimonsPlayerDetailsError(panelState, err);
      });

      if (panelState.all && needsApply) {
        applyToAngular(panel, panelState);
      }

      if (
        !panelState.all &&
        !panelState.loadingPromise &&
        Date.now() >= Number(panelState.nextFetchAttemptAt || 0)
      ) {
        fetchAllTradableInstances(panelState)
          .then(async () => {
            const livePanel = getLivePanel(panelState);
            if (!livePanel) return;
            computeList(panelState);
            await preloadThumbnailsForGroups(panelState, getThumbnailPreloadWindow(panelState, sliceForPage(panelState)), "inventory-loaded-visible");
            if (panelState.playerDetails) {
              await ensureNotForTradeThumbnailsLoaded(panelState, "inventory-loaded");
            }
            applyToAngular(livePanel, panelState);
            renderBagOfHoldingCard(livePanel, panelState);
            ensureRolimonsPlayerDetailsForPanel(panelState).catch((err) => {
              noteRolimonsPlayerDetailsError(panelState, err);
            });
            publishOfferTotal();
          })
          .catch(() => {
            // errors already logged
          });
      }
    });

    publishOfferTotal();
  }

  function panelNeedsSetup(panel) {
    if (!panel) return false;
    const panelState = getPanelState(panel);
    if (
      panelState &&
      !panelState.all &&
      !panelState.loadingPromise &&
      Date.now() >= Number(panelState.nextFetchAttemptAt || 0)
    ) return true;
    if (!panel.querySelector(".tis-controls")) return true;
    if (panel.querySelector(".inventory-type-dropdown")) return true;
    if (!panel.querySelector(".tis-pager-label")) return true;
    if (isBagOfHoldingEnabled()) {
      if (panelState?.all && !panel.querySelector(".tis-bag-of-holding-card")) return true;
      if (panelState?.all && !panel.querySelector(".tis-not-for-trade-card")) return true;
    } else if (panel.querySelector(".tis-bag-of-holding-card")) {
      return true;
    }
    if (panelState?.all && !panel.querySelector("[data-tis-key]")) return true;
    return false;
  }

  function pageNeedsComposerRepair() {
    if (!isOnTradePage()) return false;
    const panels = getInventoryPanels();
    if (!panels.length) return false;
    return panels.some(panelNeedsSetup);
  }

  let initScheduled = false;

  function scheduleInit(reason = "unknown") {
    if (initScheduled) return;
    initScheduled = true;
    debug("queue init", reason);
    setTimeout(() => {
      initScheduled = false;
      debug("run init", { reason, url: location.href });
      initOnceReady().catch(() => {});
    }, 50);
  }

  // mutation observer: trade pages do route swaps without full reload
  const mo = new MutationObserver((mutations) => {
    if (!mutationBatchNeedsInit(mutations)) return;
    debug("init observer batch", mutations.length);
    scheduleInit("dom-mutation");
  });

  mo.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("TIS_ACTIVATE", () => {
    scheduleInit("activate");
  });

  // Retry while Roblox is still constructing the composer, but stop once our
  // controls are actually wired. The previous loop reran the full setup forty
  // times even after success.
  (async () => {
    for (let i = 0; i < 40; i++) {
      await initOnceReady();

      const panels = getInventoryPanels();
      if (panels.length && !pageNeedsComposerRepair()) break;

      await sleep(250);
    }
  })();

  setInterval(() => {
    if (!pageNeedsComposerRepair()) return;
    scheduleInit("repair-pass");
  }, 1000);
})();
