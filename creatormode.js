(() => {
  const TAG = "[tis-creator-mode]";
  if (window.__TIS_CREATOR_MODE__) return;
  window.__TIS_CREATOR_MODE__ = true;

  const shared = window.TIS_GENERIC || {};
  const getReactTradeItem = shared.getReactTradeItem || (() => null);
  const buildTradeDeltaMarkup = shared.buildTradeDeltaMarkup || ((rapDiff, valueDiff) => {
    if (rapDiff === 0 && valueDiff === 0) {
      return {
        rowStateClass: "tis-trade-delta-even",
        markup: '<div class="tis-trade-delta-box tis-trade-delta-box-single"><span class="tis-trade-delta-main">this trade is equal.</span></div>',
      };
    }

    const renderMetric = (label, diff) => {
      const stateClass = diff > 0 ? "tis-trade-delta-gain" : diff < 0 ? "tis-trade-delta-loss" : "tis-trade-delta-even";
      const arrow = diff > 0 ? "&#8593;" : diff < 0 ? "&#8595;" : "";
      return `<div class="tis-trade-delta-box ${stateClass}"><span class="tis-trade-delta-label">${label}</span><span class="tis-trade-delta-main">${arrow ? `<span class="tis-trade-delta-arrow">${arrow}</span>` : ""}${Math.abs(diff).toLocaleString()}</span></div>`;
    };

    return {
      rowStateClass: "",
      markup: `<div class="tis-trade-delta-grid">${renderMetric("RAP", rapDiff)}${renderMetric("VALUE", valueDiff)}</div>`,
    };
  });

  const state = {
    enabled: false,
    keyBuffer: "",
    roliData: null,
    roliExactNameMap: null,
    roliNormalizedNameMap: null,
    roliFetch: null,
    activeItem: null,
    modal: null,
    badge: null,
    observer: null,
    pendingRefresh: 0,
  };

  function isTradesListPage() {
    return location.origin === "https://www.roblox.com" && (
      location.pathname === "/trades" ||
      /^\/trades\/(?:inbound|outbound|completed|inactive)\/?$/i.test(location.pathname)
    );
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || "").toLowerCase();
    return target.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
  }

  function parseNum(text) {
    const num = Number(String(text || "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(num) ? num : 0;
  }

  function fmt(num) {
    const n = Number(num) || 0;
    return n.toLocaleString();
  }

  function normalizeRoliName(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
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
    for (let depth = 0; current && depth < 8; depth += 1, current = current.$parent) {
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
      element.querySelector?.("[ng-click]"),
    ].filter(Boolean);

    for (const candidate of candidates) {
      const itemData = getTradeItemDataFromScope(getAngularScopeFromElement(candidate));
      if (itemData) return itemData;
    }

    return null;
  }

  function firstNumeric(...values) {
    for (const candidate of values) {
      const value = String(candidate || "").trim();
      if (/^\d+$/.test(value)) return value;
    }
    return "";
  }

  function getAssetIdFromItemData(itemData) {
    return firstNumeric(
      itemData?.itemTarget?.targetId,
      itemData?.assetId,
      itemData?.asset?.id,
      itemData?.details?.assetId,
      itemData?.collectibleItemDetails?.assetId,
      itemData?.itemDetails?.assetId
    );
  }

  function getAssetIdFromItem(item) {
    if (!item) return "";

    const overrideId = firstNumeric(item.dataset?.tisCreatorAssetId);
    if (overrideId) return overrideId;

    const scopeId = getAssetIdFromItemData(getTradeItemDataFromElement(item));
    if (scopeId) return scopeId;

    const thumbId = firstNumeric(item.querySelector(".thumbnail-2d-container[thumbnail-target-id]")?.getAttribute("thumbnail-target-id"));
    if (thumbId) return thumbId;

    const href = item.querySelector("a[href]")?.getAttribute("href") || "";
    const match = href.match(/\/(?:catalog|bundles)\/(\d+)(?:\/|$)/);
    return match?.[1] || "";
  }

  function getItemNameFromItemData(itemData) {
    return String(itemData?.itemName || itemData?.name || itemData?.assetName || itemData?.asset?.name || "").trim();
  }

  function getItemNameFromItem(item) {
    return (
      getItemNameFromItemData(getTradeItemDataFromElement(item)) ||
      item.querySelector(".item-name a")?.textContent ||
      item.querySelector(".item-name")?.getAttribute("title") ||
      item.querySelector(".item-name")?.textContent ||
      item.querySelector(".item-card-name-link")?.textContent ||
      item.querySelector(".item-card-name")?.textContent ||
      ""
    ).trim();
  }

  function getRapFromItem(item) {
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

  function getRoliInfo(assetId) {
    const info = state.roliData?.[String(assetId || "")] || null;
    return normalizeRoliInfo(info);
  }

  function normalizeRoliInfo(info) {
    if (!info) return null;

    const rap = Number(info.rap);
    const value = Number(info.value);
    return {
      name: String(info.name || "").trim(),
      rap: Number.isFinite(rap) && rap > 0 ? rap : 0,
      value: Number.isFinite(value) && value > 0 ? value : 0,
      projected: Boolean(info.projected),
    };
  }

  function buildRoliNameMaps() {
    const exact = new Map();
    const normalized = new Map();

    for (const info of Object.values(state.roliData || {})) {
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

  function getRoliInfoByName(name) {
    const rawName = String(name || "").trim();
    if (!rawName || !state.roliData) return null;

    if (!state.roliExactNameMap || !state.roliNormalizedNameMap) {
      buildRoliNameMaps();
    }

    const exact = state.roliExactNameMap.get(rawName);
    if (exact) return normalizeRoliInfo(exact);

    const normalizedName = normalizeRoliName(rawName);
    if (!normalizedName) return null;

    return normalizeRoliInfo(state.roliNormalizedNameMap.get(normalizedName) || null);
  }

  function getRoliInfoFromItem(item) {
    return getRoliInfo(getAssetIdFromItem(item)) || getRoliInfoByName(getItemNameFromItem(item));
  }

  async function ensureRoliData() {
    if (state.roliData) return state.roliData;
    if (state.roliFetch) return state.roliFetch;

    state.roliFetch = fetch("https://api.rolimons.com/items/v2/itemdetails", {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json" },
      cache: "no-store",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`rolimons http ${res.status}`);
        return res.json();
      })
      .then((json) => {
        const slim = Object.create(null);
        const items = json?.items || {};
        for (const [id, arr] of Object.entries(items)) {
          slim[id] = {
            name: typeof arr?.[0] === "string" ? arr[0] : null,
            rap: arr?.[2] === -1 ? null : arr?.[2],
            value: arr?.[3] === -1 ? null : arr?.[3],
            projected: arr?.[7] === 1 || arr?.[7] === "1",
          };
        }
        state.roliData = slim;
        state.roliExactNameMap = null;
        state.roliNormalizedNameMap = null;
        return slim;
      })
      .catch((err) => {
        console.warn(TAG, "rolimons fetch failed", err);
        return null;
      })
      .finally(() => {
        state.roliFetch = null;
      });

    return state.roliFetch;
  }

  function ensureStyles() {
    if (document.getElementById("tis-creator-mode-style")) return;

    const style = document.createElement("style");
    style.id = "tis-creator-mode-style";
    style.textContent = `
      .tis-creator-mode-badge{
        position:fixed;
        right:18px;
        bottom:18px;
        z-index:2147483646;
        padding:7px 11px;
        border:1px solid rgba(255,255,255,.18);
        border-radius:6px;
        background:#101820;
        color:#e8fff7;
        font:700 12px/1.2 Arial,sans-serif;
        box-shadow:0 8px 24px rgba(0,0,0,.3);
        pointer-events:none;
      }
      .tis-creator-mode-backdrop{
        position:fixed;
        inset:0;
        z-index:2147483647;
        display:flex;
        align-items:center;
        justify-content:center;
        background:rgba(0,0,0,.45);
      }
      .tis-creator-mode-dialog{
        width:min(360px, calc(100vw - 32px));
        border:1px solid rgba(255,255,255,.16);
        border-radius:8px;
        background:#191f27;
        color:#f4f7fb;
        box-shadow:0 18px 60px rgba(0,0,0,.45);
        font:14px/1.35 Arial,sans-serif;
      }
      .tis-creator-mode-dialog *{
        box-sizing:border-box;
      }
      .tis-creator-mode-head{
        padding:14px 16px 10px;
        border-bottom:1px solid rgba(255,255,255,.1);
        font-weight:700;
      }
      .tis-creator-mode-body{
        padding:14px 16px 16px;
      }
      .tis-creator-mode-current{
        margin:0 0 10px;
        color:#b8c2ce;
        font-size:12px;
      }
      .tis-creator-mode-label{
        display:block;
        margin:0 0 6px;
        color:#d8dee8;
        font-size:12px;
        font-weight:700;
      }
      .tis-creator-mode-input{
        display:block;
        width:100%;
        height:36px;
        padding:7px 9px;
        background:#0f141b;
        color:#fff;
        outline:none;
      }
      .tis-creator-mode-error{
        min-height:18px;
        margin:8px 0 0;
        color:#ff8d8d;
        font-size:12px;
      }
      .tis-creator-mode-actions{
        display:flex;
        gap:8px;
        justify-content:flex-end;
        padding:12px 16px 16px;
        border-top:1px solid rgba(255,255,255,.1);
      }
      .tis-creator-mode-button{
        min-width:72px;
        min-height:32px;
        border:1px solid #3b4655;
        border-radius:6px;
        background:#253040;
        color:#f8fafc;
        font-weight:700;
        cursor:pointer;
      }
      .tis-creator-mode-button:hover{
        background:#303c4e;
      }
      .tis-creator-mode-save{
        border-color:#168ba3;
        background:#087f99;
      }
      .tis-creator-mode-save:hover{
        background:#0b94b2;
      }
      .tis-creator-mode-remove{
        margin-right:auto;
        border-color:#8f3030;
        background:#7d2424;
      }
      .tis-creator-mode-remove:hover{
        background:#943030;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function setClassPresence(el, className, enabled) {
    if (el?.classList?.contains(className) !== enabled) {
      el.classList.toggle(className, enabled);
    }
  }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setBadgeVisible(visible) {
    ensureStyles();
    if (!visible) {
      state.badge?.remove();
      state.badge = null;
      return;
    }

    if (!state.badge) {
      state.badge = document.createElement("div");
      state.badge.className = "tis-creator-mode-badge";
      state.badge.textContent = "creator mode";
      document.documentElement.appendChild(state.badge);
    }
  }

  function getActiveTradeDetailRoot() {
    const roots = Array.from(document.querySelectorAll(".trades-list-detail > div[ng-if], .trades-list-detail > .ng-scope, .trades-list-detail"));
    return roots.find((root) => root?.querySelector?.(".trade-list-detail-offer") && isElementVisible(root)) || null;
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected || el.classList?.contains("ng-hide")) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
  }

  function getOfferPanels() {
    return Array.from(getActiveTradeDetailRoot()?.querySelectorAll(".trade-list-detail-offer") || []);
  }

  function getOfferItems(panel) {
    return Array.from(panel?.querySelectorAll(".trade-request-item[data-collectibleiteminstanceid], .item-card-container[data-collectibleiteminstanceid], .trade-request-item, .item-card-container") || [])
      .filter((item) => item.isConnected && !item.dataset.tisCreatorRemoved);
  }

  function getRobuxFromPanelScope(panel) {
    const candidatePaths = [
      ["offer", "robux"],
      ["$ctrl", "offer", "robux"],
      ["tradeOffer", "robux"],
      ["data", "offer", "robux"],
      ["inventoryData", "offer", "robux"],
    ];

    let current = getAngularScopeFromElement(panel);
    for (let depth = 0; current && depth < 8; depth += 1, current = current.$parent) {
      for (const path of candidatePaths) {
        const value = parseNum(getValueAtPath(current, path) || "0");
        if (value > 0) return value;
      }
    }

    return 0;
  }

  function computeOfferTotals(panel) {
    let rap = getRobuxFromPanelScope(panel);
    let value = rap;

    getOfferItems(panel).forEach((item) => {
      const info = getRoliInfoFromItem(item);
      const itemRap = info?.rap || getRapFromItem(item);
      const itemValue = info?.value || itemRap;
      rap += itemRap;
      value += itemValue;
    });

    return { rap, value };
  }

  function getNativeTotalLine(panel) {
    const lines = Array.from(panel.querySelectorAll(".robux-line:not(.tis-roli-offer-total)"));
    return lines[lines.length - 1] || null;
  }

  function renderOfferTotal(panel, total) {
    const totalLine = getNativeTotalLine(panel);
    if (!totalLine) return;

    const lead = totalLine.querySelector(".text-lead");
    setText(lead, "total rap:");

    let row = panel.querySelector(".tis-roli-offer-total");
    if (!row) {
      row = document.createElement("div");
      row.className = "robux-line tis-roli-offer-total";
      totalLine.insertAdjacentElement("afterend", row);
    }

    let label = row.querySelector(".text-lead");
    if (!label) {
      label = document.createElement("span");
      label.className = "text-lead";
      row.appendChild(label);
    }
    setText(label, "total value:");

    let amount = row.querySelector(".robux-line-amount");
    if (!amount) {
      amount = document.createElement("span");
      amount.className = "robux-line-amount";
      row.appendChild(amount);
    }

    let valueEl = amount.querySelector(".tis-roli-total-value");
    if (!valueEl) {
      valueEl = document.createElement("span");
      valueEl.className = "text-robux-lg robux-line-value tis-roli-total-value";
      amount.appendChild(valueEl);
    }

    setText(valueEl, fmt(total));
  }

  function findDirectChildByClass(parent, className) {
    return Array.from(parent?.children || []).find((el) => el.classList?.contains(className)) || null;
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
      };
    }

    const tradeButtons = detailRoot?.querySelector(".trade-buttons");
    if (tradeButtons) {
      return {
        anchor: tradeButtons.querySelector("button") || tradeButtons,
        position: "beforebegin",
        scope: tradeButtons.parentElement,
      };
    }

    return null;
  }

  function renderTradeDelta(totals) {
    const target = getTradeDeltaTarget();
    if (!target?.anchor || !Array.isArray(totals) || totals.length < 2) return;

    let row = findDirectChildByClass(target.scope, "tis-trade-delta");
    if (!row) {
      row = document.createElement("div");
      row.className = "tis-trade-delta";
      target.anchor.insertAdjacentElement(target.position, row);
    }

    row.classList.add("tis-trade-delta-detail");
    row.classList.remove("tis-trade-delta-composer");

    const rapDiff = (Number(totals[1]?.rap) || 0) - (Number(totals[0]?.rap) || 0);
    const valueDiff = (Number(totals[1]?.value) || 0) - (Number(totals[0]?.value) || 0);
    const { rowStateClass, markup } = buildTradeDeltaMarkup(rapDiff, valueDiff);

    setClassPresence(row, "tis-trade-delta-gain", rowStateClass === "tis-trade-delta-gain");
    setClassPresence(row, "tis-trade-delta-loss", rowStateClass === "tis-trade-delta-loss");
    setClassPresence(row, "tis-trade-delta-even", rowStateClass === "tis-trade-delta-even");

    if (row.dataset.tisMarkup !== markup) {
      row.innerHTML = markup;
      row.dataset.tisMarkup = markup;
    }
  }

  function refreshTotalsSoon() {
    clearTimeout(state.pendingRefresh);
    state.pendingRefresh = setTimeout(refreshTotalsNow, 30);
  }

  function refreshTotalsNow() {
    if (!state.enabled || !isTradesListPage()) return;
    const totals = getOfferPanels().map((panel) => {
      const total = computeOfferTotals(panel);
      renderOfferTotal(panel, total.value);
      return total;
    });
    renderTradeDelta(totals);
    window.postMessage({ type: "TIS_OFFER_TOTAL_VALUE", source: "creator-mode" }, "*");
  }

  function updateItemData(item, assetId, info) {
    const itemData = getTradeItemDataFromElement(item);
    if (!itemData || typeof itemData !== "object") return;

    const numericAssetId = Number(assetId);
    const nextId = Number.isFinite(numericAssetId) ? numericAssetId : String(assetId);
    const name = info?.name || getItemNameFromItem(item);
    const rap = Number(info?.rap) || getRapFromItem(item);

    if (itemData.itemTarget && typeof itemData.itemTarget === "object") itemData.itemTarget.targetId = nextId;
    if ("assetId" in itemData) itemData.assetId = nextId;
    if (itemData.asset && typeof itemData.asset === "object") itemData.asset.id = nextId;
    if (itemData.details && typeof itemData.details === "object") itemData.details.assetId = nextId;
    if (itemData.collectibleItemDetails && typeof itemData.collectibleItemDetails === "object") itemData.collectibleItemDetails.assetId = nextId;
    if (itemData.itemDetails && typeof itemData.itemDetails === "object") itemData.itemDetails.assetId = nextId;

    if (name) {
      itemData.itemName = name;
      if ("name" in itemData) itemData.name = name;
      if ("assetName" in itemData) itemData.assetName = name;
      if (itemData.asset && typeof itemData.asset === "object") itemData.asset.name = name;
    }

    if (rap > 0 && "recentAveragePrice" in itemData) itemData.recentAveragePrice = rap;
  }

  function updateItemText(item, assetId, info) {
    const name = info?.name || getItemNameFromItem(item) || `Item ${assetId}`;
    const rap = Number(info?.rap) || getRapFromItem(item);
    const value = Number(info?.value) || rap;

    [
      item.querySelector(".item-name a"),
      item.querySelector(".item-name"),
      item.querySelector(".item-card-name-link"),
      item.querySelector(".item-card-name"),
    ].forEach((el) => {
      if (!el) return;
      setText(el, name);
      if (el.hasAttribute("title")) el.setAttribute("title", name);
    });

    const nativePrice = item.querySelector(".item-card-price .text-robux, .item-card-price .text-robux-tile, .item-value .text-robux");
    if (nativePrice && rap > 0) setText(nativePrice, fmt(rap));

    const roliValue = item.querySelector(".tis-roli-value");
    if (roliValue && value > 0) setText(roliValue, fmt(value));

    item.querySelectorAll("a[href]").forEach((link) => {
      link.setAttribute("href", `/catalog/${assetId}`);
      link.setAttribute("title", name);
    });
  }

  async function updateThumbnail(item, assetId) {
    item.querySelectorAll(".thumbnail-2d-container[thumbnail-target-id]").forEach((thumb) => {
      thumb.setAttribute("thumbnail-target-id", assetId);
    });

    try {
      const res = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${encodeURIComponent(assetId)}&size=150x150&format=Png&isCircular=false`, {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = await res.json();
      const imageUrl = json?.data?.[0]?.imageUrl;
      if (!imageUrl) return;
      item.querySelectorAll("img").forEach((img) => {
        img.src = imageUrl;
        img.removeAttribute("srcset");
      });
    } catch (err) {
      console.warn(TAG, "thumbnail update failed", err);
    }
  }

  async function changeItemId(item, assetId) {
    await ensureRoliData();
    const info = getRoliInfo(assetId);

    item.dataset.tisCreatorAssetId = assetId;
    item.classList.add("tis-creator-mode-edited");
    updateItemData(item, assetId, info);
    updateItemText(item, assetId, info);
    await updateThumbnail(item, assetId);
    refreshTotalsNow();
    setTimeout(refreshTotalsNow, 120);
    setTimeout(refreshTotalsNow, 400);
  }

  function removeItem(item) {
    const removable =
      item.closest(".hlist.item-cards-stackable > li, .hlist.item-cards-stackable > .list-item") ||
      item;
    removable.dataset.tisCreatorRemoved = "true";
    removable.remove();
    refreshTotalsNow();
    setTimeout(refreshTotalsNow, 120);
    setTimeout(refreshTotalsNow, 400);
  }

  function closeModal() {
    state.modal?.remove();
    state.modal = null;
    state.activeItem = null;
  }

  function setModalError(text) {
    const error = state.modal?.querySelector(".tis-creator-mode-error");
    if (error) error.textContent = text || "";
  }

  function openModal(item) {
    ensureStyles();
    closeModal();

    state.activeItem = item;
    const currentId = getAssetIdFromItem(item);
    const currentName = getItemNameFromItem(item);

    const backdrop = document.createElement("div");
    backdrop.className = "tis-creator-mode-backdrop";
    backdrop.innerHTML = `
      <div class="tis-creator-mode-dialog" role="dialog" aria-modal="true">
        <div class="tis-creator-mode-head">Creator item edit</div>
        <div class="tis-creator-mode-body">
          <p class="tis-creator-mode-current"></p>
          <label class="tis-creator-mode-label" for="tis-creator-mode-itemid">Item ID</label>
          <input id="tis-creator-mode-itemid" class="tis-creator-mode-input" type="text" inputmode="numeric" autocomplete="off">
          <div class="tis-creator-mode-error"></div>
        </div>
        <div class="tis-creator-mode-actions">
          <button type="button" class="tis-creator-mode-button tis-creator-mode-remove">Remove</button>
          <button type="button" class="tis-creator-mode-button tis-creator-mode-cancel">Cancel</button>
          <button type="button" class="tis-creator-mode-button tis-creator-mode-save">Save</button>
        </div>
      </div>
    `;

    state.modal = backdrop;
    document.documentElement.appendChild(backdrop);

    const input = backdrop.querySelector(".tis-creator-mode-input");
    const current = backdrop.querySelector(".tis-creator-mode-current");
    current.textContent = currentName ? `Current: ${currentId || "unknown"} - ${currentName}` : `Current: ${currentId || "unknown"}`;
    input.value = currentId || "";
    input.select();

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop || event.target.closest(".tis-creator-mode-cancel")) {
        closeModal();
      }
    });

    backdrop.querySelector(".tis-creator-mode-save")?.addEventListener("click", async () => {
      const nextId = String(input.value || "").trim();
      if (!/^\d+$/.test(nextId)) {
        setModalError("Enter a numeric item ID.");
        return;
      }

      setModalError("Loading item...");
      await changeItemId(item, nextId);
      closeModal();
    });

    backdrop.querySelector(".tis-creator-mode-remove")?.addEventListener("click", () => {
      removeItem(item);
      closeModal();
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        backdrop.querySelector(".tis-creator-mode-save")?.click();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
      }
    });
  }

  function findTradeItemFromEventTarget(target) {
    const activeDetail = getActiveTradeDetailRoot();
    const item = target?.closest?.(".item-card-container, .trade-request-item");
    if (!item || !activeDetail?.contains(item)) return null;
    if (!item.closest(".trade-list-detail-offer")) return null;
    return item;
  }

  function installObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(() => {
      if (state.enabled) refreshTotalsSoon();
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function setEnabled(enabled) {
    state.enabled = Boolean(enabled && isTradesListPage());
    setBadgeVisible(state.enabled);

    if (state.enabled) {
      installObserver();
      ensureRoliData();
      refreshTotalsSoon();
    } else {
      closeModal();
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event?.data;
    if (msg?.type === "TIS_ROLI_ITEMDETAILS" && msg.data && typeof msg.data === "object") {
      state.roliData = msg.data;
      state.roliExactNameMap = null;
      state.roliNormalizedNameMap = null;
      if (state.enabled) refreshTotalsSoon();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!isTradesListPage()) return;
    if (event.key === "Escape" && state.modal) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (isTypingTarget(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;

    const key = String(event.key || "").toLowerCase();
    if (!/^[a-z]$/.test(key)) return;

    state.keyBuffer = `${state.keyBuffer}${key}`.slice(-16);
    if (state.keyBuffer.endsWith("creator")) {
      setEnabled(!state.enabled);
      state.keyBuffer = "";
    }
  }, true);

  document.addEventListener("dblclick", (event) => {
    if (!state.enabled || !isTradesListPage()) return;
    const item = findTradeItemFromEventTarget(event.target);
    if (!item) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    openModal(item);
  }, true);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (!isTradesListPage()) setEnabled(false);
    else if (state.enabled) refreshTotalsSoon();
  }, 300);
})();
