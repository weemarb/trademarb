(() => {
  const SETTINGS_DEFAULTS = {
    deleteUselessFooter: true,
    bagOfHolding: false,
  };
  const HIDE_TRADES_FOOTER_CLASS = "tis-delete-useless-footer";
  const HIDE_TRADES_FOOTER_STYLE_ID = "tis-delete-useless-footer-style";

  let settings = { ...SETTINGS_DEFAULTS };

  const isInjectableTradePage = () => {
    const { origin, pathname } = location;
    return (
      origin === "https://www.roblox.com" &&
      (
        /^\/users\/[^/]+\/trade/.test(pathname) ||
        /^\/trades\/[^/]+\/counter/.test(pathname) ||
        pathname === "/trades"
      )
    );
  };

  const isComposerPage = () => {
    const { origin, pathname } = location;
    return (
      origin === "https://www.roblox.com" &&
      (
        /^\/users\/[^/]+\/trade/.test(pathname) ||
        /^\/trades\/[^/]+\/counter/.test(pathname)
      )
    );
  };

  const isTradesListPage = () => {
    return location.origin === "https://www.roblox.com" && location.pathname === "/trades";
  };

  const ensureCss = () => {
    if (document.getElementById("tis-content-css")) return;

    const link = document.createElement("link");
    link.id = "tis-content-css";
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("content.css");
    (document.head || document.documentElement).appendChild(link);
  };

  const ensureTradesFooterStyle = () => {
    if (document.getElementById(HIDE_TRADES_FOOTER_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = HIDE_TRADES_FOOTER_STYLE_ID;
    style.textContent = `
      html.${HIDE_TRADES_FOOTER_CLASS} #footer-container,
      html.${HIDE_TRADES_FOOTER_CLASS} footer.container-footer {
        display: none !important;
      }

      html.${HIDE_TRADES_FOOTER_CLASS},
      html.${HIDE_TRADES_FOOTER_CLASS} body {
        overflow-y: auto !important;
      }

      html.${HIDE_TRADES_FOOTER_CLASS} #container-main,
      html.${HIDE_TRADES_FOOTER_CLASS} #content,
      html.${HIDE_TRADES_FOOTER_CLASS} .content,
      html.${HIDE_TRADES_FOOTER_CLASS} #trades-web-app,
      html.${HIDE_TRADES_FOOTER_CLASS} .trades-container,
      html.${HIDE_TRADES_FOOTER_CLASS} main {
        padding-bottom: 0 !important;
        margin-bottom: 0 !important;
        min-height: 0 !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  };

  const applySettingsToPage = () => {
    const root = document.documentElement;
    if (!root) return;

    root.dataset.tisExtensionBase = chrome.runtime.getURL("");
    root.dataset.tisBagOfHolding = settings.bagOfHolding ? "true" : "false";
    ensureTradesFooterStyle();

    if (!isInjectableTradePage()) {
      root.classList.remove(HIDE_TRADES_FOOTER_CLASS);
      return;
    }

    if (isComposerPage()) ensureCss();

    root.classList.toggle(
      HIDE_TRADES_FOOTER_CLASS,
      Boolean(settings.deleteUselessFooter) && isTradesListPage()
    );

    window.dispatchEvent(new CustomEvent("TIS_ACTIVATE"));
  };

  const syncSettingsFromStorage = () => {
    chrome.storage.local.get(SETTINGS_DEFAULTS, (stored) => {
      settings = { ...SETTINGS_DEFAULTS, ...stored };
      applySettingsToPage();
    });
  };

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    let changed = false;
    Object.keys(SETTINGS_DEFAULTS).forEach((key) => {
      if (!(key in changes)) return;
      settings[key] = changes[key].newValue;
      changed = true;
    });

    if (changed) applySettingsToPage();
  });

  let lastUrl = location.href;
  applySettingsToPage();
  syncSettingsFromStorage();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    const msg = event?.data;
    if (msg?.type !== "TIS_BRIDGE_REQUEST") return;

    const requestId = String(msg.requestId || "");
    const action = String(msg.action || "");
    const payload = msg.payload;

    const respond = (ok, resultOrError) => {
      window.postMessage({
        type: "TIS_BRIDGE_RESPONSE",
        requestId,
        ok,
        ...(ok ? { result: resultOrError } : { error: String(resultOrError || "bridge failure") }),
      }, "*");
    };

  if (!requestId || action !== "runtimeSendMessage") return;

  try {
    if (!chrome?.runtime?.id) {
      respond(false, "extension context invalidated; reload the page");
      return;
    }

    let settled = false;
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      respond(ok, value);
    };

    const maybePromise = chrome.runtime.sendMessage(payload, (result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        finish(false, lastError.message || lastError);
        return;
      }
      finish(true, result);
    });

    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise
        .then((result) => finish(true, result))
        .catch((err) => finish(false, err?.message || err));
    }
  } catch (err) {
    respond(false, err?.message || err);
  }
  });

  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    applySettingsToPage();
  }, 250);
})();
