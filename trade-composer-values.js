(() => {
  const TAG = "[tis-rolimons]";
  if (window.__TIS_TRADE_COMPOSER_VALUES__) return;
  window.__TIS_TRADE_COMPOSER_VALUES__ = true;
  const shared = window.TIS_GENERIC || {};
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
  const buildTradeDeltaMarkup = shared.buildTradeDeltaMarkup || ((rapDiff, valueDiff) => ({ rowStateClass: "", markup: "" }));
  const bridgeRequest = shared.bridgeRequest || (async () => { throw new Error("bridge unavailable"); });
  const getReactTradeItem = shared.getReactTradeItem || (() => null);

  const state = {
    data: null, // { [assetId]: { name:string|null, value:number|null, projected:boolean } }
    icon: {
      roli: null,
      proj: null,
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
    tradeRowRenderTimer: null,
    tradeListScrollerRefreshTimer: null,
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
      el.classList?.contains("tis-bag-of-holding-card") ||
      el.classList?.contains("tis-wishlist-match-name") ||
      el.classList?.contains("tis-roli-offer-total") ||
      el.classList?.contains("tis-trade-delta") ||
      el.classList?.contains("tis-trade-row-values") ||
      el.closest?.(".tis-roli-row, .tis-bag-of-holding-card, .tis-roli-offer-total, .tis-trade-delta, .tis-proj-icon, .tis-trade-row-values")
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
      .tis-offer-totals-group{
        margin-top:20px;
      }
      .tis-roli-offer-total .tis-roli-total-value{
        color:#05bce4 !important;
        font-weight:600;
        text-shadow:0 1px 1px rgba(0,0,0,.55);
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
    .trade-request-item .item-value .text-robux,
    .trade-request-item .tis-roli-value,
    .trades-list-detail .item-card-price .text-robux,
    .trades-list-detail .tis-roli-value{
    line-height:1 !important;
    }

    .trade-inventory-panel .item-card-caption .item-card-price .icon-robux-16x16,
    .trade-request-item .item-value .icon-robux-16x16,
    .trades-list-detail .item-card-caption .item-card-price .icon-robux-16x16{
    transform:translateX(-4px) !important;
    }

    .trade-request-item .item-value,
    .trade-request-item .tis-roli-row{
    display:flex !important;
    align-items:center !important;
    gap:0 !important;
    min-height:17px !important;
    overflow:visible !important;
    }

    .trade-request-item{
    min-height:0 !important;
    height:auto !important;
    padding-bottom:8px;
    }

    .trade-request-item.blank-item,
    .trade-request-item.draggable-border{
    min-height:70px !important;
    height:auto !important;
    padding-bottom:0 !important;
    }

    .trade-request-item.draggable-border{
    border-style:solid !important;
    border-color:transparent !important;
    box-shadow:none !important;
    }

    .trade-request-item .item-value{
    flex-wrap:wrap !important;
    column-gap:0 !important;
    row-gap:4px !important;
    }

    .trade-request-item .tis-offer-inline-value{
    display:inline-flex !important;
    align-items:center !important;
    margin-left:10px !important;
    }

    .trade-request-item .tis-offer-instance-id{
    display:block !important;
    width:100% !important;
    margin-top:2px !important;
    font-size:11px !important;
    line-height:1.2 !important;
    color:#aeb7c2 !important;
    word-break:break-word !important;
    user-select:text !important;
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
    const roots = Array.from(document.querySelectorAll(".trades-list-detail > div[ng-if], .trades-list-detail > .ng-scope"));
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

  function getNativeRapTotal(panel) {
    const totalLine = getNativeTotalLine(panel);
    if (!totalLine) return 0;

    return parseNum(
      totalLine.querySelector(".robux-line-value")?.textContent ||
      totalLine.querySelector(".text-robux-lg")?.textContent ||
      totalLine.querySelector(".robux-line-amount")?.textContent ||
      totalLine.textContent ||
      "0"
    );
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

  function getCollectibleItemInstanceIdFromOfferItem(item) {
    const itemData = getTradeItemDataFromElement(item);
    const candidates = [
      itemData?.collectibleItemInstanceId,
      itemData?.details?.collectibleItemInstanceId,
      itemData?.itemDetails?.collectibleItemInstanceId,
      itemData?.collectibleItemDetails?.collectibleItemInstanceId,
      item.getAttribute("data-collectibleiteminstanceid"),
    ];

    for (const candidate of candidates) {
      const value = String(candidate || "").trim();
      if (value && value !== "undefined" && value !== "null") return value;
    }

    return "";
  }

  function getSerialPrefixFromOfferItem(item) {
    const itemData = getTradeItemDataFromElement(item);
    const serial = Number(itemData?.serialNumber);
    if (!Number.isFinite(serial) || serial <= 0) return "";
    return `(#${serial}) `;
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
    const robux = getRobuxFromPanel(panel);

    // On the current React trade detail page the old collectible wrapper
    // selectors can be absent even though our per-item blue values rendered
    // correctly. Use the UI values we already resolved as the primary source.
    const renderedValueNodes = Array.from(
      panel.querySelectorAll(".tis-roli-value")
    ).filter((node) => !node.closest(".tis-roli-offer-total"));

    if (renderedValueNodes.length) {
      const value = robux + renderedValueNodes.reduce(
        (sum, node) => sum + parseNum(node.textContent || "0"),
        0
      );
      const nativeRap = getNativeRapTotal(panel);
      return { rap: nativeRap > 0 ? nativeRap : robux, value };
    }

    // Older Angular layouts still expose concrete offer-item elements.
    const tradeItems = Array.from(
      panel.querySelectorAll(".trade-request-item:not(.blank-item)")
    );
    const items = tradeItems.length
      ? tradeItems
      : Array.from(panel.querySelectorAll(".item-card-container[data-collectibleiteminstanceid]"));

    let rap = robux;
    let value = robux;
    const seenInstanceIds = new Set();

    items.forEach((item) => {
      const instanceId = getCollectibleItemInstanceIdFromOfferItem(item);
      if (instanceId && seenInstanceIds.has(instanceId)) return;
      if (instanceId) seenInstanceIds.add(instanceId);

      rap += getOfferRapFromItem(item);
      value += getOfferValueFromItem(item);
    });

    const nativeRap = getNativeRapTotal(panel);
    if (nativeRap > 0) rap = nativeRap;
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

  function resolveSummaryTradeForContext(context, summaries, summaryMap) {
    const indexedTrade = summaries?.[context?.index ?? -1] || null;
    if (indexedTrade) {
      return indexedTrade;
    }

    if (context?.tradeId) {
      const exactMatch = summaryMap.get(context.tradeId);
      if (exactMatch) return exactMatch;
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
    if (hasVisibleTradeRowCards()) renderTradeRowValuesNow(`trade-detail-${source}`);
    else scheduleTradeRowValuesRender(`trade-detail-${source}`, 20);
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

  function getTradesListTab() {
    if (location.origin !== "https://www.roblox.com" || location.pathname !== "/trades") return null;

    const tab = new URLSearchParams(location.search).get("tab");
    const normalized = String(tab || "").trim().toLowerCase();
    if (["inbound", "outbound", "completed", "inactive"].includes(normalized)) return normalized;

    const dropdownLabel =
      document.querySelector(".trade-row-list .trade-list-dropdown .rbx-selection-label")?.getAttribute("title") ||
      document.querySelector(".trade-row-list .trade-list-dropdown .rbx-selection-label")?.textContent ||
      "";
    const dropdownNormalized = String(dropdownLabel || "").trim().toLowerCase();
    if (["inbound", "outbound", "completed", "inactive"].includes(dropdownNormalized)) {
      return dropdownNormalized;
    }

    if (document.querySelector(".trade-row-list .trade-row-container")) {
      return "inbound";
    }

    return null;
  }

  function isTradesListPage() {
    return Boolean(getTradesListTab());
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
    scheduleTradeRowListScrollerRefresh("clear-trade-row-values");
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
      renderTradeRowValues();
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
    renderTradeRowValues();
  }

  function hasVisibleTradeRowCards() {
    return Boolean(document.querySelector(".trade-row-container .trade-sent-date"));
  }

  async function fetchTradeSummaries(status, count) {
    debug("fetch trade summaries:start", { status, count });
    const resp = await bridgeRequest("runtimeSendMessage", { type: "TIS_FETCH_TRADE_SUMMARIES", status, count });
    if (!resp?.ok) throw new Error(resp?.error || "trade summary fetch failed");
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

  async function fetchTradeDetailWithBackground(tradeId) {
    debug("background trade detail fetch:start", tradeId);
    const resp = await bridgeRequest("runtimeSendMessage", { type: "TIS_FETCH_TRADE_DETAILS", tradeId });
    if (!resp?.ok) throw new Error(resp?.error || "trade detail fetch failed");

    const trade = normalizeTradeDetail(resp.trade);
    debug("background trade detail fetch:done", tradeId, {
      hasOffers: Array.isArray(trade?.offers),
      offerCount: Array.isArray(trade?.offers) ? trade.offers.length : 0,
      cached: resp.cached === true,
    });
    return trade;
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
      backgroundStarted: false,
    });
    window.postMessage({ type: "TIS_REQUEST_TRADE_DETAILS", tradeId: id }, "*");

    setTimeout(() => {
      const requestState = state.tradeDetailRequests.get(id);
      if (!requestState || requestState.backgroundStarted || state.tradeDetailCache.has(id)) return;

      requestState.backgroundStarted = true;
      state.tradeDetailRequests.set(id, requestState);

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
    }, 300);

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

    if (cacheCoversVisibleTrades || (!visibleTradeIds.length && cached.length >= contexts.length)) {
      debug("trade summaries already loaded", { status, count: cached.length });
      return false;
    }

    if (visibleTradeIds.length && cached.length) {
      state.tradeSummaryCache.delete(status);
      debug("drop stale trade summaries", {
        status,
        cachedCount: cached.length,
        visibleCount: visibleTradeIds.length,
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

  function renderTradeRowValues() {
    if (!isTradesListPage()) {
      clearTradeRowValues();
      return;
    }

    ensureStyles();

    const status = getTradesListTab();
    debug("render trade row values:start", {
      href: location.href,
      tab: status,
    });

    const contexts = collectTradeRowContexts();
    if (!contexts.length) {
      debug("render trade row values:no contexts");
      scheduleTradeRowValuesRender("waiting-for-rows", 250);
      return;
    }

    if (ensureTradeSummariesLoaded(status, contexts)) {
      debug("render trade row values:waiting for summary data");
      return;
    }

    const summaries = state.tradeSummaryCache.get(status)?.items || [];
    const summaryMap = buildTradeSummaryMap(summaries);
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

    contexts.forEach((context) => {
      const { row, trade, host, dateEl, tradeId } = context;
      const summaryTrade = resolveSummaryTradeForContext(context, summaries, summaryMap);
      const resolvedTradeId = getTradeId(summaryTrade) || tradeId;
      const legacyPanel = row.querySelector(":scope > .tis-trade-row-values");
      legacyPanel?.remove();
      let panel = dateEl?.querySelector(":scope > .tis-trade-row-values") || null;
      const detailTrade = resolvedTradeId ? state.tradeDetailCache.get(resolvedTradeId) || null : null;

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

      debug("render trade row values:rendered", {
        tradeId: resolvedTradeId,
        giving: totals.giving,
        receiving: totals.receiving,
        difference: totals.difference,
      });
    });

    scheduleTradeRowListScrollerRefresh("render-trade-row-values");
  }

  function renderOfferTotal(panel, total) {
    if (!panel) return;
    ensureStyles();

    const totalLine = renameNativeRapLabel(panel);
    if (!totalLine) return;

    let totalsGroup = panel.querySelector(".tis-offer-totals-group");
    if (!totalsGroup) {
      totalsGroup = document.createElement("div");
      totalsGroup.className = "tis-offer-totals-group";
      totalLine.insertAdjacentElement("beforebegin", totalsGroup);
    }
    if (totalLine.parentElement !== totalsGroup) {
      totalsGroup.appendChild(totalLine);
    }

    let row = totalsGroup.querySelector(".tis-roli-offer-total");
    if (!row) {
      row = document.createElement("div");
      row.className = "robux-line tis-roli-offer-total";
      totalsGroup.appendChild(row);
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
    const giveOfferBlock = detailOffers[0] || null;
    const giveValueLine = giveOfferBlock?.querySelector(".tis-roli-offer-total");
    if (giveValueLine?.parentElement) {
      return {
        anchor: giveValueLine,
        position: "afterend",
        scope: giveValueLine.parentElement,
        variant: "detail",
      };
    }

    const composerRoot = getActiveComposerRoot();
    const composerOffers = Array.from(composerRoot?.querySelectorAll(".trade-request-window-offer") || []);
    const giveComposerBlock = composerOffers[0] || null;
    const giveComposerValueLine = giveComposerBlock?.querySelector(".tis-roli-offer-total");
    if (giveComposerValueLine?.parentElement) {
      return {
        anchor: giveComposerValueLine,
        position: "afterend",
        scope: giveComposerValueLine.parentElement,
        variant: "composer",
      };
    }

    // Fallbacks for a momentary render where the injected total-value line
    // has not appeared yet. Anchor to the first offer's native RAP total.
    const giveNativeTotal = getNativeTotalLine(giveOfferBlock);
    if (giveNativeTotal?.parentElement) {
      return {
        anchor: giveNativeTotal,
        position: "afterend",
        scope: giveNativeTotal.parentElement,
        variant: "detail",
      };
    }

    const giveComposerNativeTotal = getNativeTotalLine(giveComposerBlock);
    if (giveComposerNativeTotal?.parentElement) {
      return {
        anchor: giveComposerNativeTotal,
        position: "afterend",
        scope: giveComposerNativeTotal.parentElement,
        variant: "composer",
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

    let row = findDirectChildByClass(target.scope, "tis-trade-delta");
    if (!row) {
      row = document.createElement("div");
      row.className = "tis-trade-delta";
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

    } catch (e) {
      console.warn(TAG, "icon load failed (fine for now):", e);
    }
  }

  function isTradePage() {
    const { origin, pathname } = location;
    return (
      (origin === "https://www.roblox.com" && /^\/users\/[^/]+\/trade/.test(pathname)) ||
      (origin === "https://www.roblox.com" && /^\/trades\/[^/]+\/counter/.test(pathname))
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
    if (card?.classList?.contains("tis-bag-of-holding-card")) return;

    const info = getRoliInfoFromCard(card);

    // fallback: if roli has no value, show roblox RAP again (blue)
    const rapText =
    card.querySelector(".item-card-caption .item-card-price .text-robux")?.textContent?.trim() ||
    card.querySelector(".item-card-caption .item-card-price .text-robux-tile")?.textContent?.trim() ||
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

  function decorateOfferItem(item) {
    if (!state.data || !item) return;

    const valueRow = item.querySelector(":scope > .item-value");
    if (!valueRow) return;

    const info = getRoliInfoFromOfferItem(item);
    const rapText =
      valueRow.querySelector(".text-robux")?.textContent?.trim() ||
      valueRow.textContent?.trim() ||
      "-";
    const roliText = fmt(info?.value);

    let row = valueRow.querySelector(":scope > .tis-offer-inline-value");
    if (!row) {
      row = document.createElement("span");
      row.className = "tis-roli-row tis-offer-inline-value";
      valueRow.appendChild(row);
    }

    let roliIcon = row.querySelector(":scope .icon-rolimons");
    if (!roliIcon) {
      roliIcon = document.createElement("span");
      roliIcon.className = "icon icon-rolimons";
      row.appendChild(roliIcon);
    }

    let valueEl = row.querySelector(":scope .tis-roli-value");
    if (!valueEl) {
      valueEl = document.createElement("span");
      valueEl.className = "tis-roli-value";
      row.appendChild(valueEl);
    }

    applyRoliIconStyles(roliIcon, state.icon.roli || getExtensionAssetUrl("icons/rolimons.svg"));
    applyRoliValueStyles(valueEl);
    setTextIfChanged(valueEl, roliText === "-" ? rapText : roliText);

    let instanceRow = item.querySelector(":scope > .tis-offer-instance-id");
    if (!instanceRow) {
      instanceRow = document.createElement("div");
      instanceRow.className = "tis-offer-instance-id";
      valueRow.insertAdjacentElement("afterend", instanceRow);
    }
    setTextIfChanged(
      instanceRow,
      `${getSerialPrefixFromOfferItem(item)}${getCollectibleItemInstanceIdFromOfferItem(item)}`
    );
  }

  function decorateAllNow() {
    if (!state.data || !isTradePage()) return;
    ensureStyles();
    const cards = document.querySelectorAll(".item-card-container");
    const offerItems = document.querySelectorAll(".trade-request-item:not(.blank-item)");
    debug("decorate pass", { cards: cards.length, url: location.href });
    cards.forEach(decorateCard);
    offerItems.forEach(decorateOfferItem);
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
      const status = String(msg.status || "").trim().toLowerCase();
      const items = Array.isArray(msg.payload?.data) ? msg.payload.data : [];
      if (!["inbound", "outbound", "completed", "inactive"].includes(status) || !items.length) {
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
      if (hasVisibleTradeRowCards()) renderTradeRowValuesNow("page-trades-list-data");
      else scheduleTradeRowValuesRender("page-trades-list-data", 20);
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
    if (ev.target?.closest?.(".trade-row, .trade-list-dropdown, .group-dropdown.trade-list-dropdown")) {
      scheduleOfferTotalsRefresh("trade-list-click");
      setTimeout(() => scheduleOfferTotalsRefresh("trade-list-click-post"), 80);
      setTimeout(() => scheduleOfferTotalsRefresh("trade-list-click-late"), 220);
      setTimeout(() => scheduleOfferTotalsRefresh("trade-list-click-later"), 500);
      setTimeout(() => scheduleOfferTotalsRefresh("trade-list-click-latest"), 1000);
    }
  }, true);

  setInterval(() => {
    if (!state.data || !isTradePage()) return;
    renderTradeRowValues();
  }, 30000);

  const t = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      observeOfferPanels();
      if (!isTradePage()) return;
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

