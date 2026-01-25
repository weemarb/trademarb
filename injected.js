(() => {
  const TAG = "[tis-injected]";

  if (window.__TIS_LOADED__) return;
  window.__TIS_LOADED__ = true;

  console.log(`${TAG} injected loaded on:`, location.href);

  const state = {
    sortMode: "none", // "none" | "asc" | "desc"
    min: null,
    max: null,
    pageIndex: 0,
    pageSize: 10
  };

  const cache = {
    // flattened instances
    all: null,
    // promise so we don't spam fetch
    loadingPromise: null,
    // last computed list for current state
    computed: [],
    // hook status
    hookedPager: false,
    hookedItemClicks: false,
    // groups (one card per asset/bundle, with instances[])
    groups: null,             // [{ key, rep, instances, count }]
    groupMap: new Map(),      // key -> group
    selectedByKey: new Map(), // key -> Set(instanceId)
    openDD: null,              // { el, anchor }
    autoPickByKey: new Map(), // key -> instanceId (the “random” one we toggle on card click)
    instKeyById: new Map(),
    roli: null,
    instById: new Map(),

  };

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
  if (!window.angular?.element) {
    console.warn("[tis] angular not available");
    return false;
  }
window.addEventListener("message", (ev) => {
  const msg = ev?.data;
  if (msg?.type === "TIS_ROLI_ITEMDETAILS") {
    cache.roli = msg.data || null;
    // optional: re-apply once roli arrives
    const panel = getYourInventoryPanel?.();
    if (panel && cache.all) applyToAngular(panel);
  }
});

function roliValueForInst(inst) {
  const tid = inst?.itemTarget?.targetId;
  if (!cache.roli || !tid) return null;

  const info = cache.roli[String(tid)];
  const v = Number(info?.value);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function effectiveValueForInst(inst) {
  const rap = Number(inst?.recentAveragePrice ?? 0) || 0;
  const v = roliValueForInst(inst);
  return (v !== null && v > rap) ? v : rap;
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
    .tis-serial-text{
      display:inline-block;
      color:#fff;
      font-weight:700;
      font-size:11px;
      text-shadow:0 1px 1px rgba(0,0,0,.6);
      line-height:1;
    }
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
      position:fixed;
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
  `;
  document.head.appendChild(s);
})();

  const isOnTradePage = () => {
    const u = location.href;
    return (
      u.startsWith("https://www.roblox.com/users/") && u.includes("/trade")
    ) || (
      u.startsWith("https://www.roblox.com/trades/") && u.includes("/counter")
    );
  };

  const isActive = () => {
  // once we have the full list, tis owns pagination even in "none" mode
    return cache.all !== null;
  };


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

  function getYourInventoryPanel() {
    // find the header "Your Inventory" then take closest panel
    const headers = Array.from(document.querySelectorAll("h2.inventory-label"));
    const h = headers.find(x => (x.textContent || "").trim().toLowerCase() === "your inventory");
    if (!h) return null;
    return h.closest(".trade-inventory-panel") || null;
  }

  function removeBuiltInItemTypeDropdown(panel) {
  // this is the annoying "All" dropdown thing
  const btns = panel.querySelectorAll('button.input-dropdown-btn[data-toggle="dropdown"]');
  if (!btns.length) return;

  btns.forEach((btn) => {
    const kill =
      btn.closest(".input-group-btn") ||
      btn.closest(".input-group") ||
      btn.parentElement;

    if (kill) {
      kill.remove();
      console.log(`${TAG} removed built-in item type dropdown`);
    }
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
  function offerValueForInst(inst) {
    const rap = Number(inst?.recentAveragePrice ?? 0) || 0;
    const v = roliValueForInst(inst); // note: NOT the "effective" one
    return (v !== null) ? v : rap; // same rule as item row: fallback to rap if unvalued
  }

  function publishOfferTotal() {
    if (!cache.all) return;

    const offerIds = getMyOfferInstanceIdsFromDOM();
    let total = 0;

    for (const id of offerIds) {
      const inst = cache.instById.get(String(id));
      if (!inst) continue;
      total += offerValueForInst(inst);
    }

  window.postMessage({ type: "TIS_OFFER_TOTAL_VALUE", total }, "*");
}

  function computeList() {
  const base = cache.groups ? cache.groups.slice() : [];
  let out = base;

  if (state.min !== null && Number.isFinite(state.min)) {
    out = out.filter(g => (effectiveValueForInst(g.rep)) >= state.min);
  }
  if (state.max !== null && Number.isFinite(state.max)) {
    out = out.filter(g => (effectiveValueForInst(g.rep)) <= state.max);
  }

  if (state.sortMode === "asc") {
    out.sort((a,b)=> effectiveValueForInst(a.rep) - effectiveValueForInst(b.rep));
  } else if (state.sortMode === "desc") {
    out.sort((a,b)=> effectiveValueForInst(b.rep) - effectiveValueForInst(a.rep));
  }

  cache.computed = out; // now it's groups
  return out;
}


  function totalPages() {
    const n = cache.computed?.length ?? 0;
    return Math.max(1, Math.ceil(n / state.pageSize));
  }

  function clampPageIndex() {
    const tp = totalPages();
    if (state.pageIndex < 0) state.pageIndex = 0;
    if (state.pageIndex > tp - 1) state.pageIndex = tp - 1;
  }

  function sliceForPage() {
    clampPageIndex();
    const start = state.pageIndex * state.pageSize;
    const end = start + state.pageSize;
    return cache.computed.slice(start, end);
  }

function applyToAngular(panel) {
  const scope = findAngularInventoryScope(panel);
  if (!scope) {
    console.warn(`${TAG} couldnt find angular inventory scope yet`);
    return;
  }

  computeList();

  const pageGroups = isActive()
    ? sliceForPage()
    : (cache.computed ? cache.computed.slice(0, state.pageSize) : []);

  // angular expects tradableItem objects, so give it the representative instance
  const pageSlice = pageGroups.map(g => {
  // IMPORTANT: use a stable clone for display so we never mutate real instance ids
  if (!g.viewRep) g.viewRep = { ...g.rep };

  const rep = g.viewRep;

  rep.__tisKey = g.key;
  rep.__tisCount = g.count;

  return rep;
  });


  scope.$applyAsync(() => {
    if (scope.inventoryData?.tradableItems) {
      scope.inventoryData.tradableItems = pageSlice;
    } else if (scope.inventory?.tradableItems) {
      scope.inventory.tradableItems = pageSlice;
    }
  });

  updatePagerDisabled(panel);
  updatePagerLabel(panel);

  // decorate after angular renders
  setTimeout(() => {
    try { decorateMultiCopyUI(panel); } catch (e) {}
  }, 0);
}
function closeMultiDD() {
  const od = cache.openDD;
  if (!od) return;

  if (od.onDown) {document.removeEventListener("mousedown", od.onDown, true);}
  try { od.el.remove(); } catch {}
  cache.openDD = null;
}


function syncRepSelection(key, sc) {
    const g = cache.groupMap.get(key);
    if (!g) return;

    // prefer the angular-facing clone
    const rep = g.viewRep || g.rep;
    if (!rep) return;

    // stash original ids once (on the clone)
    if (!rep.__tisOrigId) rep.__tisOrigId = rep.id;
    if (!rep.__tisOrigIid) rep.__tisOrigIid = rep.collectibleItemInstanceId;

    const sel = cache.selectedByKey.get(key);

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


function decorateMultiCopyUI(panel) {
  if (!window.angular?.element) return;

  const thumbs = panel.querySelectorAll(
    '.item-card-thumb-container[ng-click*="root.onItemCardClick"]'
  );

  thumbs.forEach((thumb) => {
    if (thumb.__tisDecorated) return;

    const ng = window.angular.element(thumb);
    const sc = ng.scope?.() || ng.isolateScope?.();
    const ti = sc?.tradableItem;
    const key = ti?.__tisKey;
    const count = ti?.__tisCount ?? 1;

    if (!key) {
      thumb.__tisDecorated = true;
      return;
    }

    // single-copy serial replace
    if (count <= 1) {
      const serial = ti?.serialNumber;
      if (serial !== null && serial !== undefined) {
        const lic = thumb.querySelector(".limited-icon-container");
        const icon = lic?.querySelector(".icon-shop-limited");
        if (lic && icon && !lic.__tisSerialDone) {
          lic.__tisSerialDone = true;

          const t = document.createElement("span");
          t.className = "tis-serial-text";
          t.textContent = `#${serial}`;

          icon.replaceWith(t);
        }
      }

      thumb.__tisDecorated = true;
      return;
    }


    const group = cache.groupMap.get(key);
    if (!group) {
    thumb.__tisDecorated = true;
    return;
    }
    const cardRoot = thumb.closest(".item-card-container") ||thumb.closest(".item-card") ||thumb.closest("li") ||thumb.parentElement;

    if (cardRoot) {cardRoot.setAttribute("data-tis-key", key);}


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
        lic.removeAttribute("uib-tooltip");
        lic.removeAttribute("tooltip-placement");
        lic.removeAttribute("tooltip-append-to-body");
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

    icon.replaceWith(btn);

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

        let sel = cache.selectedByKey.get(key);
        if (!sel) {
            sel = new Set();
            cache.selectedByKey.set(key, sel);
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
        if (cache.openDD?.key === key) {
            const cb = cache.openDD.el.querySelector(`input[data-tis-id="${pid}"]`);
            if (cb) cb.checked = true;
        }

        syncRepSelection(key, sc);
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

        let sel = cache.selectedByKey.get(key);
        if (!sel) {
        sel = new Set();
        cache.selectedByKey.set(key, sel);
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

            syncRepSelection(key, sc);
            }, 0);
        });
        }

        document.body.appendChild(dd);

        const r = btn.getBoundingClientRect();
        const x = Math.min(window.innerWidth - 260, Math.max(8, r.left));
        const y = Math.min(window.innerHeight - 280, Math.max(8, r.bottom + 6));
        dd.style.left = `${x}px`;
        dd.style.top = `${y}px`;

        const onDown = (ev) => {
        const od = cache.openDD;
        if (!od) return;
        if (od.el.contains(ev.target) || od.anchor.contains(ev.target)) return;
        closeMultiDD();
        };

        cache.openDD = { el: dd, anchor: btn, key, onDown };
        document.addEventListener("mousedown", onDown, true);
            });
            }
            thumb.__tisDecorated = true;
        });
        }


  async function fetchAllTradableInstances() {
    if (cache.all) return cache.all;

    if (cache.loadingPromise) return cache.loadingPromise;

    cache.loadingPromise = (async () => {
      const uid = getUserId();
      if (!uid) throw new Error("couldnt detect logged-in userId");

      console.log(`${TAG} fetching tradable items for userId=${uid}`);

      const all = [];
      const seenInstIds = new Set(); // dedupe across pages / retries
      let cursor = "";
      const seen = new Set();

      while (true) {
        const url =
          `https://trades.roblox.com/v2/users/${uid}/tradableitems` +
          `?sortBy=CreationTime&cursor=${encodeURIComponent(cursor)}` +
          `&limit=50&sortOrder=Desc`;

        const res = await fetch(url, { credentials: "include" });

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(`http ${res.status} from trades api: ${txt.slice(0, 200)}`);
        }

        const data = await res.json();

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
                assetStock: inst.assetStock ?? it.assetStock
                });
            }
        }


        const next = data.nextPageCursor || null;

        if (!next) break;
        if (seen.has(next)) break;
        seen.add(next);
        cursor = next;

        // tiny delay so we don't look like a bot (because roblox is twitchy)
        await sleep(80);
      }

      cache.all = all;
      cache.loadingPromise = null;
      cache.instById = new Map();
      for (const inst of all) {
        const id = String(inst.id || inst.collectibleItemInstanceId || "");
        if (id) cache.instById.set(id, inst);
      }

        // build groups: one card per targetId, with many instances
        // build groupMap (key -> group)
        cache.groupMap = new Map();
        for (const inst of all) {
        const type = inst?.itemTarget?.itemType || "Asset";
        const tid  = inst?.itemTarget?.targetId || "0";
        const key = `${type}:${tid}`;

        let g = cache.groupMap.get(key);
        if (!g) {
            g = { key, instances: [], rep: null, count: 0, viewRep: null };
            cache.groupMap.set(key, g);
        }
        g.instances.push(inst);
        }

        // instId -> key map (for offer reconcile)
        cache.instKeyById = new Map();
        for (const inst of all) {
        const id = String(inst.id || inst.collectibleItemInstanceId || "");
        if (!id) continue;

        const type = inst?.itemTarget?.itemType || "Asset";
        const tid  = inst?.itemTarget?.targetId || "0";
        cache.instKeyById.set(id, `${type}:${tid}`);
        }

        // finalize groups list
        cache.groups = Array.from(cache.groupMap.values()).map(g => {
        g.count = g.instances.length;
        g.rep = g.instances.find(x => !x.isOnHold) || g.instances[0];
        return g;
        });
      console.log(`${TAG} loaded ${all.length} tradable instances`);
      return all;
    })().catch(err => {
      cache.loadingPromise = null;
      console.error(`${TAG} failed fetching tradable items:`, err);
      throw err;
    });

    return cache.loadingPromise;
  }

function hookGlobalMultiCardClicks(panel) {
  if (cache.__tisGlobalCardClickHooked) return;
  cache.__tisGlobalCardClickHooked = true;

  panel.addEventListener("click", (e) => {
    // ignore our controls + open dropdown
    if (e.target?.closest?.(".tis-multi-dd, .tis-multi-btn, .tis-multi-plus")) return;

    const card = e.target?.closest?.("[data-tis-key]");
    if (!card) return;

    const key = card.getAttribute("data-tis-key");
    const group = cache.groupMap.get(key);
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

    let sel = cache.selectedByKey.get(key);
    if (!sel) {
      sel = new Set();
      cache.selectedByKey.set(key, sel);
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
      cache.autoPickByKey.delete(key);

      setTimeout(() => syncRepSelection(key, sc), 0);
      return;
    }

    // else toggle ONE stable random copy
    let pickId = cache.autoPickByKey.get(key);

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
    cache.autoPickByKey.set(key, pickId);
    }

    const inst = getInstById(pickId);
    if (!inst) return;


    window.tisAddToOfferVanilla(inst, thumb);

    setTimeout(() => {
      const inOffer = typeof root?.isItemInOffers === "function" ? root.isItemInOffers(inst) : !sel.has(pickId);
      if (inOffer) sel.add(pickId);
      else sel.delete(pickId);

      syncRepSelection(key, sc);
    }, 0);

  }, true); // capture
}


  function hookPager(panel) {
    if (cache.hookedPager) return;

    const prevBtn = panel.querySelector(".pager-prev button");
    const nextBtn = panel.querySelector(".pager-next button");

    if (!prevBtn || !nextBtn) return;

    const onPrev = (e) => {
    if (!isActive()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    state.pageIndex -= 1;
    applyToAngular(panel); // this now also updates pager label + disabled
    };

    const onNext = (e) => {
    if (!isActive()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    state.pageIndex += 1;
    applyToAngular(panel);
    };


    // capture=true so we beat angular’s click handler
    prevBtn.addEventListener("click", onPrev, true);
    nextBtn.addEventListener("click", onNext, true);

    cache.hookedPager = true;
  }

  function updatePagerDisabled(panel) {
    const prevBtn = panel.querySelector(".pager-prev button");
    const nextBtn = panel.querySelector(".pager-next button");
    if (!prevBtn || !nextBtn) return;

    if (!isActive()) {
      // dont mess with their UI when we're inactive
      prevBtn.disabled = false;
      nextBtn.disabled = false;
      return;
    }

    clampPageIndex();
    const tp = totalPages();
    prevBtn.disabled = state.pageIndex <= 0;
    nextBtn.disabled = state.pageIndex >= tp - 1;
  }

  function buildControls(panel) {
    if (panel.querySelector(".tis-controls")) return;

    const header = panel.querySelector("h2.inventory-label");
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
    minInput.type = "number";
    minInput.inputMode = "numeric";
    minInput.placeholder = "min";
    minInput.min = "0";

    const maxInput = document.createElement("input");
    maxInput.className = "tis-input";
    maxInput.type = "number";
    maxInput.inputMode = "numeric";
    maxInput.placeholder = "max";
    maxInput.min = "0";

    wrap.appendChild(resetBtn);
    wrap.appendChild(hiBtn);
    wrap.appendChild(loBtn);
    wrap.appendChild(minInput);
    wrap.appendChild(maxInput);

    // insert right under header
    header.insertAdjacentElement("afterend", wrap);

    let debounce = null;
    const scheduleApply = () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        try {
          if (!cache.all) await fetchAllTradableInstances();
          state.pageIndex = 0;
          applyToAngular(panel);
          console.log(`${TAG} state updated:`, {...state});
        } catch (err) {
          console.error(`${TAG} apply failed:`, err);
        }
      }, 150);
    };

    resetBtn.addEventListener("click", async () => {
      state.sortMode = "none";
      state.min = null;
      state.max = null;
      state.pageIndex = 0;

      minInput.value = "";
      maxInput.value = "";

      try {
        if (!cache.all) await fetchAllTradableInstances();
        applyToAngular(panel);
        console.log(`${TAG} state updated:`, { sortMode: state.sortMode, min: state.min, max: state.max });
      } catch (err) {
        console.error(`${TAG} reset failed:`, err);
      }
    });

    hiBtn.addEventListener("click", async () => {
      state.sortMode = "desc";
      scheduleApply();
    });

    loBtn.addEventListener("click", async () => {
      state.sortMode = "asc";
      scheduleApply();
    });

    minInput.addEventListener("input", () => {
      const v = minInput.value.trim();
      state.min = v === "" ? null : Number(v);
      scheduleApply();
    });

    maxInput.addEventListener("input", () => {
      const v = maxInput.value.trim();
      state.max = v === "" ? null : Number(v);
      scheduleApply();
    });
  }

  function ensurePagerLabel(panel) {
  // find the pager container
  const pager = panel.querySelector(".pager, .trade-pager, .inventory-pager");
  if (!pager) return null;

  // this is the exact roblox "Page 1" span you pasted
  const robloxPageSpan =
    pager.querySelector("span[ng-bind*='Label.CurrentPage']") ||
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
        if (!isActive()) updatePagerLabel(panel);
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

function updatePagerLabel(panel) {
  const label = ensurePagerLabel(panel);
  if (!label) return;

  if (isActive()) {
    // our paging
    clampPageIndex();
    label.textContent = `page ${state.pageIndex + 1}/${totalPages()}`;
    return;
  }

  // inactive: roblox paging. mirror what their hidden span says (so it stays accurate)
  const pager = panel.querySelector(".pager, .trade-pager, .inventory-pager");
  const robloxPageSpan =
    pager?.querySelector("span[ng-bind*='Label.CurrentPage']") ||
    Array.from(pager?.querySelectorAll("span.ng-binding") || []).find(el =>
      /^page\s+\d+/i.test((el.textContent || "").trim())
    );

  const t = (robloxPageSpan?.textContent || "").trim();
  label.textContent = t ? t.toLowerCase() : "page ?";
}

function getYourOfferRoot() {
  const offerHeaders = Array.from(document.querySelectorAll(".trade-request-window-offer h2"));
  const yourOfferHeader = offerHeaders.find(h => (h.textContent || "").trim().toLowerCase() === "your offer");
  return yourOfferHeader?.closest(".trade-request-window-offer") || null;
}

function getMyOfferInstanceIdsFromDOM() {
  const offerRoot = getYourOfferRoot();
  if (!offerRoot) return new Set();

  const nodes = offerRoot.querySelectorAll(".trade-request-item[data-collectibleiteminstanceid]");
  const ids = new Set();
  nodes.forEach(n => {
    const v = n.getAttribute("data-collectibleiteminstanceid");
    if (v) ids.add(v);
  });
  return ids;
}


function reconcileSelectionsFromOfferDOM(panel) {
  if (!cache.all) return;

  const offerIds = getMyOfferInstanceIdsFromDOM();

  // rebuild selectedByKey from scratch based on what roblox is *actually* showing in the offer
  const nextSelected = new Map(); // key -> Set(ids)

  for (const id of offerIds) {
    const key = cache.instKeyById.get(id);
    if (!key) continue;
    let set = nextSelected.get(key);
    if (!set) {
      set = new Set();
      nextSelected.set(key, set);
    }
    set.add(id);
  }

  cache.selectedByKey = nextSelected;

  // keep autoPick sane: if the picked id isn't in offer anymore, forget it
  for (const [key, pickId] of cache.autoPickByKey.entries()) {
    if (!offerIds.has(pickId)) cache.autoPickByKey.delete(key);
  }
  // update overlays on currently rendered cards
  try { decorateMultiCopyUI(panel); } catch {}
}

function hookOfferReconcile(panel) {
  if (cache.__tisOfferObs) return;

  const offerRoot = getYourOfferRoot();
  if (!offerRoot) return; // try again next initOnceReady tick

  cache.__tisOfferObs = true;

  let t = null;
  const schedule = () => {
    clearTimeout(t);
    t = setTimeout(() => reconcileSelectionsFromOfferDOM(panel), 50);
  };

  const obs = new MutationObserver(schedule);
  obs.observe(offerRoot, { childList: true, subtree: true });

  schedule();
  publishOfferTotal();
}



  async function initOnceReady() {
    // basic “roblox is a SPA” protection
    if (!isOnTradePage()) return;

    const panel = getYourInventoryPanel();
    if (!panel) return;
    removeBuiltInItemTypeDropdown(panel);

    hookOfferReconcile(panel);
    hookGlobalMultiCardClicks(panel);

    buildControls(panel);
    hookPager(panel);

    // load cache in background-ish (not actually background, just async)
    // so first click feels instant
    if (!cache.all && !cache.loadingPromise) {
      fetchAllTradableInstances()
        .then(() => {
          // update status immediately once loaded
          computeList();
          applyToAngular(panel);
          publishOfferTotal();
        })
        .catch(() => {
          // errors already logged
        });
    }
  }

  // mutation observer: trade pages do route swaps without full reload
  const mo = new MutationObserver(() => {
    initOnceReady().catch(() => {});
  });

  mo.observe(document.documentElement, { childList: true, subtree: true });

  // also run a few times early
  (async () => {
    for (let i = 0; i < 40; i++) {
      await initOnceReady();
      await sleep(250);
    }
  })();
})();
