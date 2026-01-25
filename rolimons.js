(() => {
  const TAG = "[tis-rolimons]";
  if (window.__TIS_ROLIMONS__) return;
  window.__TIS_ROLIMONS__ = true;

  const state = {
    data: null, // { [assetId]: { value:number|null, projected:boolean } }
    icon: {
      roli: null,
      proj: null,
    },
    scheduled: false,
  };

  const fmt = (n) => {
    if (n === null || n === undefined) return "-";
    const num = Number(n);
    if (!Number.isFinite(num) || num <= 0) return "-";
    return num.toLocaleString();
  };

  function ensureStyles() {
    if (document.getElementById("tis-roli-style")) return;
    const s = document.createElement("style");
    s.id = "tis-roli-style";
    s.textContent = `
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

      .tis-roli-row{
        display:flex;
        align-items:center;
        gap:0; /* your span already has margin-right:6px */
        margin-top:2px;
        padding-bottom:40px;
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
    /* stop the "stackable" overlap behavior */
    .trade-inventory-panel .hlist.item-cards-stackable{
    row-gap: 18px !important;          /* space between rows */
    }

    /* roblox often sets weird margins/positioning on list items for stacking */
    .trade-inventory-panel .hlist.item-cards-stackable > li,
    .trade-inventory-panel .hlist.item-cards-stackable > .list-item{
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
    .trade-inventory-panel .item-card-container .item-card-caption{
    height: auto !important;
    overflow: visible !important;
    }

    /* keep your pager safety padding (tweak number if needed) */
    .trade-inventory-panel .hlist.item-cards-stackable{
    padding-bottom: 1px !important;
    }

    `;
    document.head.appendChild(s);
  }
  function getYourOfferPanel() {
    const hs = Array.from(document.querySelectorAll(".trade-request-window-offer h2"));
    const h = hs.find(x => (x.textContent || "").trim().toLowerCase() === "your offer");
    return h?.closest(".trade-request-window-offer") || null;
  }

  function renderOfferTotal(total) {
    const panel = getYourOfferPanel();
    if (!panel) return;

    const lines = Array.from(panel.querySelectorAll(".robux-line"));
    const totalLine = lines.find(l =>
      (l.querySelector(".text-lead")?.textContent || "").toLowerCase().includes("total value")
    );
    if (!totalLine) return;

    let row = panel.querySelector(".tis-roli-offer-total");
    if (!row) {
      row = document.createElement("div");
      row.className = "robux-line tis-roli-offer-total";
      totalLine.insertAdjacentElement("afterend", row);
    }

    row.textContent = "";

    const lead = document.createElement("span");
    lead.className = "text-lead";
    lead.textContent = "Rolimons:";
    row.appendChild(lead);

    const amt = document.createElement("span");
    amt.className = "robux-line-amount";

    const icon = document.createElement("span");
    icon.className = "icon icon-rolimons";
    icon.style.backgroundImage = `url("${chrome.runtime.getURL("icons/rolimons.svg")}")`;
    amt.appendChild(icon);

    const v = document.createElement("span");
    v.className = "text-robux-lg robux-line-value tis-roli-total-value";
    v.textContent = (Number(total) || 0).toLocaleString();
    amt.appendChild(v);

    row.appendChild(amt);
  }

  async function loadIcon(name) {
    // avoid web_accessible_resources for now by using a blob url
    const url = chrome.runtime.getURL(name);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`icon fetch failed (${name})`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
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
    const u = location.href;
    return (
      (u.startsWith("https://www.roblox.com/users/") && u.includes("/trade")) ||
      (u.startsWith("https://www.roblox.com/trades/") && u.includes("/counter"))
    );
  }

  function getAssetIdFromCard(card) {
    // best: angular scope already knows the targetId
    const thumb = card.querySelector('.item-card-thumb-container[ng-click*="root.onItemCardClick"]');
    if (thumb && window.angular?.element) {
      const ng = window.angular.element(thumb);
      const sc = ng.scope?.() || ng.isolateScope?.();
      const tid = sc?.tradableItem?.itemTarget?.targetId;
      if (tid && /^\d+$/.test(String(tid))) return String(tid);
    }

    // fallback: thumbnail-target-id
    const t = card.querySelector(".thumbnail-2d-container[thumbnail-target-id]");
    const id1 = t?.getAttribute("thumbnail-target-id");
    if (id1 && /^\d+$/.test(id1)) return id1;

    // fallback: catalog link
    const a = card.querySelector('a[href*="/catalog/"]');
    const href = a?.getAttribute("href") || "";
    const m = href.match(/\/catalog\/(\d+)\//);
    if (m) return m[1];

    return null;
  }

  function decorateCard(card) {
    if (!state.data) return;

    const assetId = getAssetIdFromCard(card);
    if (!assetId) return;

    const info = state.data[assetId];
    if (!info) return;

    const priceRow = card.querySelector(".item-card-caption .item-card-price");
    if (!priceRow) return;

    let row = card.querySelector(":scope .tis-roli-row");
    if (!row) {
      row = document.createElement("div");
      row.className = "tis-roli-row text-overflow item-card-price";
      priceRow.insertAdjacentElement("afterend", row);
    }

    row.textContent = "";

    const roli = document.createElement("span");
    roli.className = "icon icon-rolimons";
    roli.style.backgroundImage = `url("${chrome.runtime.getURL("icons/rolimons.svg")}")`;
    roli.style.display = "inline-block";
    roli.style.backgroundSize = "cover";
    roli.style.width = "19px";
    roli.style.height = "19px";
    roli.style.marginTop = "0px";
    roli.style.marginRight = "6px";
    roli.style.marginLeft = "0px";
    roli.style.transform = "translateY(1px)";
    roli.style.backgroundColor = "transparent";
    row.appendChild(roli);


    const val = document.createElement("span");
    val.className = "tis-roli-value";
    // fallback: if roli has no value, show roblox RAP again (blue)
    const rapText =
    priceRow.querySelector(".text-robux")?.textContent?.trim() ||
    priceRow.textContent?.trim() ||
    "-";

    const roliText = fmt(info.value);
    val.textContent = (roliText === "-" ? rapText : roliText);

    row.appendChild(val);

    const thumb = card.querySelector(".item-card-thumb-container");
    if (thumb) {
    if (!thumb.style.position) thumb.style.position = "relative";

    let p = thumb.querySelector(":scope .tis-proj-icon");
    if (info.projected) {
        if (!p) {
        p = document.createElement("img");
        p.className = "tis-proj-icon";
        p.alt = "";
        p.src = chrome.runtime.getURL("icons/projected.png");
        thumb.appendChild(p);
        }
    } else {
        p?.remove();
    }
    }
  }

  function decorateAllNow() {
    if (!state.data) return;
    ensureStyles();
    const cards = document.querySelectorAll(".item-card-container");
    cards.forEach(decorateCard);
  }

  function scheduleDecorate() {
    if (state.scheduled) return;
    state.scheduled = true;
    setTimeout(() => {
      state.scheduled = false;
      decorateAllNow();
    }, 50);
  }

  async function fetchRolimonsItemDetails() {
    const resp = await chrome.runtime.sendMessage({ type: "TIS_ROLIMONS_GET_ITEMDETAILS" });
    if (!resp?.ok) throw new Error(resp?.error || "rolimons fetch failed");
    return resp.data;
  }

  async function init() {
    if (!isTradePage()) return;

    console.log(TAG, "init on:", location.href);

    await ensureIcons();

    try {
      state.data = await fetchRolimonsItemDetails();
      window.postMessage({ type: "TIS_ROLI_ITEMDETAILS", data: state.data }, "*");
      console.log(TAG, "rolimons loaded:", Object.keys(state.data || {}).length);
      decorateAllNow();
    } catch (e) {
      console.warn(TAG, "rolimons fetch failed:", e);
      return;
    }

    const mo = new MutationObserver(scheduleDecorate);
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  // roblox SPA: try a few times
  let tries = 0;
  window.addEventListener("message", (ev) => {
    const msg = ev?.data;
    if (msg?.type === "TIS_OFFER_TOTAL_VALUE") renderOfferTotal(msg.total);
  });

  const t = setInterval(() => {
    tries++;
    if (isTradePage()) {
      clearInterval(t);
      init();
    }
    if (tries > 40) clearInterval(t);
  }, 250);
})();
