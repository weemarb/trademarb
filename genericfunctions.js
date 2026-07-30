(() => {
  if (window.TIS_GENERIC) return;

  let bridgeSeq = 0;
  const bridgePending = new Map();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const parseNum = (text) => {
    const cleaned = String(text || "").replace(/[^\d.-]/g, "");
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : 0;
  };

  const setTextIfChanged = (el, text) => {
    if (el && el.textContent !== text) el.textContent = text;
  };

  const normalizeRoliName = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const getMutationElement = (node) => {
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    return node.parentElement || null;
  };

  const isElementVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const getExtensionAssetUrl = (path) => {
    const normalizedPath = String(path || "").replace(/^\/+/, "");
    try {
      if (globalThis.chrome?.runtime?.getURL) {
        return globalThis.chrome.runtime.getURL(normalizedPath);
      }
    } catch {}

    const base = document.documentElement?.dataset?.tisExtensionBase || "";
    if (!base) return normalizedPath;
    return `${base}${normalizedPath}`;
  };

  const preloadedExtensionAssets = new Set();
  const preloadExtensionAssets = (paths = []) => {
    if (!Array.isArray(paths)) return;

    paths.forEach((path) => {
      const url = getExtensionAssetUrl(path);
      if (!url || preloadedExtensionAssets.has(url)) return;
      preloadedExtensionAssets.add(url);

      try {
        const link = document.createElement("link");
        link.rel = "preload";
        link.as = "image";
        link.href = url;
        (document.head || document.documentElement)?.appendChild(link);
      } catch {}

      try {
        const image = new Image();
        image.decoding = "async";
        image.src = url;
      } catch {}
    });
  };

  preloadExtensionAssets([
    "icons/rolimons.svg",
    "icons/projected.png",
    "icons/bagempty.webp",
    "icons/bagfull.webp",
    "icons/return.jpg",
    "icons/replacementimg.webp",
  ]);

  const upsertStyle = (id, text) => {
    if (!id) return null;

    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement("style");
      style.id = id;
    }

    if (style.textContent !== text) {
      style.textContent = text;
    }

    const mount = document.head || document.documentElement;
    if (mount) {
      mount.appendChild(style);
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        const lateMount = document.head || document.documentElement;
        if (lateMount) lateMount.appendChild(style);
      }, { once: true });
    }

    return style;
  };

  const applyRoliIconStyles = (el, url) => {
    if (!el) return;

    el.style.display = "inline-block";
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundPosition = "center center";
    el.style.backgroundSize = "16px 16px";
    el.style.width = "16px";
    el.style.height = "16px";
    el.style.marginTop = "0px";
    el.style.marginRight = "4px";
    el.style.marginLeft = "-3px";
    el.style.verticalAlign = "middle";
    el.style.transform = "none";
    el.style.flex = "0 0 18px";
    el.style.backgroundColor = "transparent";
    if (url) el.style.backgroundImage = `url("${url}")`;
  };

  const applyRoliValueStyles = (el) => {
    if (!el) return;
    el.style.color = "#05bce4";
    el.style.fontWeight = "600";
    el.style.textShadow = "0 1px 1px rgba(0,0,0,.55)";
  };

  const renderItemCardRoliValueRow = (card, { valueText = "-", iconUrl = "" } = {}) => {
    if (!card) return null;

    const priceRow = card.querySelector(".item-card-caption .item-card-price");
    if (!priceRow) return null;

    let row = card.querySelector(":scope .tis-roli-row");
    if (!row) {
      row = document.createElement("div");
      row.className = "tis-roli-row text-overflow item-card-price";
      priceRow.insertAdjacentElement("afterend", row);
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

    applyRoliIconStyles(roliIcon, iconUrl);
    applyRoliValueStyles(valueEl);
    setTextIfChanged(valueEl, String(valueText || "-"));

    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "0";
    row.style.marginTop = "2px";
    row.style.opacity = ".95";
    row.style.paddingBottom = "0";

    return { priceRow, row, roliIcon, valueEl };
  };

  const copyTextToClipboard = async (text) => {
    const value = String(text || "");
    if (!value) return false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {}

    try {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      return Boolean(ok);
    } catch {
      return false;
    }
  };

  const ensureLimitedInfoTooltipStyle = () => upsertStyle("tis-limited-info-tooltip-style", `
    .tooltip.tis-limited-info-tooltip .tooltip-inner{
      white-space:pre-line;
      text-align:left;
      max-width:240px;
      word-break:break-word;
      font-family:Builder Sans, Helvetica Neue, Helvetica, Arial, sans-serif;
    }
  `);

  const ensureSerialLimitedBubbleStyle = () => upsertStyle("tis-serial-limited-bubble-style", `
    .limited-icon-container.tis-serial-limited-bubble{
      display:flex !important;
      align-items:center !important;
      justify-content:center !important;
      min-width:28px;
      min-height:18px;
      padding:0 3px;
      box-sizing:border-box;
    }

    .limited-icon-container.tis-serial-limited-bubble .limited-number-container{
      display:flex !important;
      align-items:center !important;
      justify-content:center !important;
      gap:1px;
      width:100%;
      min-height:100%;
      margin:0;
      line-height:1;
    }

    .limited-icon-container.tis-serial-limited-bubble .limited-number-container .font-caption-header{
      font-size:14px !important;
      line-height:1 !important;
      font-weight:700 !important;
      text-shadow:0 1px 1px rgba(0,0,0,.6);
    }

    .limited-icon-container.tis-serial-limited-bubble .limited-number-container .limited-number{
      font-size:14px !important;
      line-height:1 !important;
      font-weight:700 !important;
      text-shadow:0 1px 1px rgba(0,0,0,.6);
    }
  `);

  const formatLimitedSerialBubble = (target, { serial } = {}) => {
    if (!target) return false;

    const serialNum = Number(serial);
    if (!Number.isFinite(serialNum) || serialNum <= 0) return false;

    ensureSerialLimitedBubbleStyle();

    target.classList.add("tis-serial-limited-bubble");

    const icon = target.querySelector(".icon-shop-limited");
    icon?.remove();

    const numberContainer = target.querySelector(".limited-number-container");
    if (!numberContainer) return false;

    numberContainer.classList.remove("ng-hide");
    numberContainer.style.display = "flex";

    const numberEl = numberContainer.querySelector(".limited-number");
    if (numberEl) {
      numberEl.classList.remove("ng-hide");
      setTextIfChanged(numberEl, String(serialNum));
    }

    return true;
  };

  const buildLimitedInfoTooltipText = (state) => {
    const lines = Array.isArray(state?.lines) ? state.lines.filter(Boolean) : [];
    if (!lines.length) return "";
    const copyLineIndex = Math.max(0, Number(state?.copyLineIndex ?? Math.max(0, lines.length - 1)));
    return lines.map((line, index) => {
      if (state?.copied && index === copyLineIndex) return "copied!";
      return String(line);
    }).join("\n");
  };

  const limitedInfoTargets = new WeakMap();
  let limitedInfoActiveTarget = null;
  let limitedInfoRuntimeReady = false;
  let limitedInfoObserver = null;

  const isLimitedInfoTooltipPopup = (node) => {
    if (!node || node.nodeType !== 1) return false;
    return node.matches?.('div[uib-tooltip-popup].tooltip, .tooltip[uib-tooltip-popup]');
  };

  const findLatestLimitedInfoTooltipPopup = () => {
    const popups = Array.from(document.querySelectorAll('div[uib-tooltip-popup].tooltip, .tooltip[uib-tooltip-popup]'));
    if (!popups.length) return null;
    return popups[popups.length - 1] || null;
  };

  const renderLimitedInfoTooltipPopup = (target, popup) => {
    const state = limitedInfoTargets.get(target);
    if (!popup || !state?.enabled || !state.lines?.length) return false;

    ensureLimitedInfoTooltipStyle();
    const text = buildLimitedInfoTooltipText(state);
    popup.classList.add("tis-limited-info-tooltip");
    popup.setAttribute("content", text);
    popup.dataset.tisLimitedInfoPopup = "true";
    popup.dataset.tisLimitedInfoTarget = "true";
    const inner = popup.querySelector(".tooltip-inner");
    if (inner) inner.textContent = text;
    return true;
  };

  const syncLimitedInfoTooltipPopup = (target, popup = null) => {
    const state = limitedInfoTargets.get(target);
    if (!state?.enabled || !state.lines?.length) return false;
    if (!popup && limitedInfoActiveTarget !== target) return false;
    return renderLimitedInfoTooltipPopup(target, popup || findLatestLimitedInfoTooltipPopup());
  };

  const queueLimitedInfoTooltipSync = (target) => {
    if (!target) return;
    const runSync = () => {
      if (limitedInfoActiveTarget !== target) return;
      syncLimitedInfoTooltipPopup(target);
    };
    setTimeout(runSync, 0);
    requestAnimationFrame(runSync);
    setTimeout(runSync, 60);
  };

  const ensureLimitedInfoTooltipRuntime = () => {
    if (limitedInfoRuntimeReady) return;
    limitedInfoRuntimeReady = true;

    document.addEventListener("mouseover", (event) => {
      const target = event.target?.closest?.(".limited-icon-container");
      if (!target) return;
      const state = limitedInfoTargets.get(target);
      if (!state?.enabled || !state.lines?.length) return;
      limitedInfoActiveTarget = target;
      queueLimitedInfoTooltipSync(target);
    }, true);

    document.addEventListener("mouseout", (event) => {
      const target = event.target?.closest?.(".limited-icon-container");
      if (!target || limitedInfoActiveTarget !== target) return;
      const related = event.relatedTarget;
      if (related && target.contains?.(related)) return;
      limitedInfoActiveTarget = null;
    }, true);

    limitedInfoObserver = new MutationObserver((mutations) => {
      if (!limitedInfoActiveTarget) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (isLimitedInfoTooltipPopup(node) && renderLimitedInfoTooltipPopup(limitedInfoActiveTarget, node)) {
            return;
          }
          if (node?.nodeType !== 1) continue;
          const popup = node.querySelector?.('div[uib-tooltip-popup].tooltip, .tooltip[uib-tooltip-popup]');
          if (popup && renderLimitedInfoTooltipPopup(limitedInfoActiveTarget, popup)) {
            return;
          }
        }
      }
    });

    limitedInfoObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  };

  const bindLimitedInfoTooltip = (target, options = {}) => {
    if (!target) return null;

    const state = target.__tisLimitedInfoState || {
      enabled: true,
      lines: [],
      copyValue: "",
      copyLineIndex: 0,
      copied: false,
      copiedTimer: null,
    };

    state.enabled = options.enabled !== false;
    state.lines = Array.isArray(options.lines) ? options.lines.filter(Boolean) : [];
    state.copyValue = String(options.copyValue || "");
    state.copyLineIndex = Number(options.copyLineIndex ?? Math.max(0, state.lines.length - 1));
    target.__tisLimitedInfoState = state;
    limitedInfoTargets.set(target, state);
    ensureLimitedInfoTooltipRuntime();

    if (!target.__tisLimitedInfoBound) {
      target.__tisLimitedInfoBound = true;

      target.addEventListener("mouseenter", () => {
        if (!state.enabled || !state.lines?.length) return;
        limitedInfoActiveTarget = target;
        queueLimitedInfoTooltipSync(target);
      });

      target.addEventListener("mouseleave", () => {
        if (limitedInfoActiveTarget === target) {
          limitedInfoActiveTarget = null;
        }
      });

      target.addEventListener("click", async (event) => {
        if (event.detail < 3 || !state.enabled || !state.copyValue) return;
        const copied = await copyTextToClipboard(state.copyValue);
        if (!copied) return;
        state.copied = true;
        clearTimeout(state.copiedTimer);
        syncLimitedInfoTooltipPopup(target);
        state.copiedTimer = setTimeout(() => {
          state.copied = false;
          syncLimitedInfoTooltipPopup(target);
        }, 2000);
      });
    }

    if (!state.enabled || !state.lines?.length) {
      clearTimeout(state.copiedTimer);
      state.copied = false;
      if (limitedInfoActiveTarget === target) {
        limitedInfoActiveTarget = null;
      }
    }

    return state;
  };

  const buildTradeDeltaMarkup = (rapDiff, valueDiff) => {
    if (rapDiff === 0 && valueDiff === 0) {
      return {
        rowStateClass: "tis-trade-delta-even",
        markup: `
          <div class="tis-trade-delta-box tis-trade-delta-box-single">
            <span class="tis-trade-delta-main">this trade is equal.</span>
          </div>
        `,
      };
    }

    const renderMetric = (label, diff) => {
      let className = "tis-trade-delta-even";
      let arrow = "";

      if (diff > 0) {
        className = "tis-trade-delta-gain";
        arrow = "&#8593;";
      } else if (diff < 0) {
        className = "tis-trade-delta-loss";
        arrow = "&#8595;";
      }

      return `
        <div class="tis-trade-delta-box ${className}">
          <span class="tis-trade-delta-label">${label}</span>
          <span class="tis-trade-delta-main">${arrow ? `<span class="tis-trade-delta-arrow">${arrow}</span>` : ""}${Math.abs(diff).toLocaleString()}</span>
        </div>
      `;
    };

    return {
      rowStateClass: "",
      markup: `
        <div class="tis-trade-delta-grid">
          ${renderMetric("RAP", rapDiff)}
          ${renderMetric("VALUE", valueDiff)}
        </div>
      `,
    };
  };

  const bridgeRequest = (action, payload, timeoutMs = 10000) => {
    const requestId = `tis-${Date.now()}-${++bridgeSeq}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        bridgePending.delete(requestId);
        reject(new Error(`bridge timeout for ${action}`));
      }, timeoutMs);

      bridgePending.set(requestId, {
        resolve,
        reject,
        timer,
      });

      window.postMessage({
        type: "TIS_BRIDGE_REQUEST",
        requestId,
        action,
        payload,
      }, "*");
    });
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event?.data;
    if (msg?.type !== "TIS_BRIDGE_RESPONSE") return;

    const requestId = String(msg.requestId || "");
    const pending = bridgePending.get(requestId);
    if (!pending) return;

    bridgePending.delete(requestId);
    clearTimeout(pending.timer);

    if (msg.ok === false) {
      pending.reject(new Error(String(msg.error || "bridge request failed")));
      return;
    }

    pending.resolve(msg.result);
  });

  window.TIS_GENERIC = {
    sleep,
    parseNum,
    setTextIfChanged,
    normalizeRoliName,
    getMutationElement,
    isElementVisible,
    getExtensionAssetUrl,
    preloadExtensionAssets,
    upsertStyle,
    applyRoliIconStyles,
    applyRoliValueStyles,
    renderItemCardRoliValueRow,
    formatLimitedSerialBubble,
    bindLimitedInfoTooltip,
    buildTradeDeltaMarkup,
    bridgeRequest,
  };
})();
