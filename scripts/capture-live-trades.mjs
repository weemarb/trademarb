import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cookieHeader = process.env.TIS_ROBLOX_COOKIE;
if (!cookieHeader) throw new Error("TIS_ROBLOX_COOKIE is required");
const captureUrl = process.env.TIS_CAPTURE_URL || "https://www.roblox.com/trades";
const extensionPath = process.env.TIS_EXTENSION_PATH;
const cookies = cookieHeader.split(";").flatMap((part) => {
  const separator = part.indexOf("=");
  if (separator <= 0) return [];
  return [{
    name: part.slice(0, separator).trim(),
    value: part.slice(separator + 1).trim(),
    domain: ".roblox.com",
    path: "/",
    secure: true,
  }];
});

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const chrome = chromeCandidates.find(existsSync);
if (!chrome) throw new Error("Chrome/Edge was not found");

const profile = await mkdtemp(join(tmpdir(), "trademarb-live-"));
const output = join(tmpdir(), "trademarb-live-trades.html");
const chromeArgs = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
];
if (extensionPath) {
  chromeArgs.push(`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`);
}
chromeArgs.push("about:blank");
const child = spawn(chrome, chromeArgs, { stdio: "ignore", windowsHide: true });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(path, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

let socket;
const pending = new Map();
const listeners = new Map();
let nextId = 1;

function onEvent(method, listener) {
  const existing = listeners.get(method) || new Set();
  existing.add(listener);
  listeners.set(method, existing);
  return () => existing.delete(listener);
}

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function evaluate(expression, sessionId) {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "evaluation failed");
  return response.result?.value;
}

try {
  const activePortFile = join(profile, "DevToolsActivePort");
  await waitForFile(activePortFile);
  const [port] = (await readFile(activePortFile, "utf8")).trim().split(/\r?\n/);
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.json());

  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result || {});
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message);
  });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  await send("Performance.enable", {}, sessionId);
  await send("Network.setCookies", { cookies }, sessionId);

  if (extensionPath) {
    if (process.env.TIS_MOCK_BRIDGE) {
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `addEventListener("message", (event) => {
          const message = event?.data;
          if (event.source !== window || message?.type !== "TIS_BRIDGE_REQUEST") return;
          const requestId = String(message.requestId || "");
          const payload = message.payload || {};
          const respond = (result) => window.postMessage({
            type: "TIS_BRIDGE_RESPONSE",
            requestId,
            ok: true,
            result,
          }, "*");
          const fail = (error) => window.postMessage({
            type: "TIS_BRIDGE_RESPONSE",
            requestId,
            ok: false,
            error: String(error?.message || error),
          }, "*");
          (async () => {
            if (payload.type === "TIS_ROLIMONS_GET_ITEMDETAILS") {
              respond({ ok: true, data: {} });
              return;
            }
            if (payload.type === "TIS_FETCH_ROLIMONS_PLAYER_BADGES") {
              respond({ ok: true, verified: false });
              return;
            }
            if (payload.type === "TIS_FETCH_TRADE_DETAILS") {
              const response = await fetch("https://trades.roblox.com/v2/trades/" + payload.tradeId, { credentials: "include" });
              if (!response.ok) throw new Error("trade detail http " + response.status);
              respond({ ok: true, trade: await response.json(), cached: false });
              return;
            }
            if (payload.type === "TIS_FETCH_TRADE_SUMMARIES") {
              const status = String(payload.status || "inbound");
              const limit = Math.min(100, Math.max(1, Number(payload.count) || 25));
              const response = await fetch("https://trades.roblox.com/v1/trades/" + status + "?cursor=&limit=" + limit + "&sortOrder=Desc", { credentials: "include" });
              if (!response.ok) throw new Error("trade summaries http " + response.status);
              const page = await response.json();
              const items = Array.isArray(page?.data) ? page.data : [];
              respond({ ok: true, items, totalFetched: items.length, hasMore: Boolean(page?.nextPageCursor), cached: false });
              return;
            }
            respond({ ok: false, error: "unsupported live-test bridge message: " + (payload.type || "unknown") });
          })().catch(fail);
        });`,
      }, sessionId);
    }
    const sources = await Promise.all([
      "genericfunctions.js",
      "trade-composer.js",
      "trade-composer-values.js",
      "trades-list.js",
      "creatormode.js",
    ].map((file) => readFile(join(extensionPath, file), "utf8")));
    for (const source of sources) {
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
          const run = () => {\n${source}\n};
          if (document.documentElement) {
            run();
            return;
          }
          const observer = new MutationObserver(() => {
            if (!document.documentElement) return;
            observer.disconnect();
            run();
          });
          observer.observe(document, { childList: true });
        })();`,
      }, sessionId);
    }
  }

  const networkResponses = [];
  const pendingTradableResponses = new Map();
  const tradableResponseShapes = [];
  const runtimeExceptions = [];
  onEvent("Runtime.exceptionThrown", (event) => {
    if (event.sessionId !== sessionId) return;
    const details = event.params?.exceptionDetails;
    const stack = (details?.stackTrace?.callFrames || [])
      .slice(0, 5)
      .map((frame) => `${frame.functionName || "<anonymous>"}@${frame.url || "<injected>"}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`)
      .join(" <- ");
    runtimeExceptions.push(`${details?.exception?.description || details?.text || "unknown runtime exception"}${stack ? ` (${stack})` : ""}`);
  });
  onEvent("Network.responseReceived", (event) => {
    if (event.sessionId !== sessionId) return;
    const { response } = event.params;
    if (/roblox\.com/i.test(response.url)) {
      networkResponses.push({ status: response.status, url: response.url });
    }
    if (/trades\.roblox\.com\/v2\/users\/[^/]+\/tradableitems/i.test(response.url) && response.status >= 200 && response.status < 300) {
      pendingTradableResponses.set(event.params.requestId, response.url);
    }
  });
  onEvent("Network.loadingFinished", (event) => {
    if (event.sessionId !== sessionId) return;
    const url = pendingTradableResponses.get(event.params.requestId);
    if (!url) return;
    pendingTradableResponses.delete(event.params.requestId);
    send("Network.getResponseBody", { requestId: event.params.requestId }, sessionId)
      .then(({ body }) => {
        const payload = JSON.parse(body || "null");
        const collection = Array.isArray(payload?.items)
          ? payload.items
          : Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload)
              ? payload
              : [];
        tradableResponseShapes.push({
          pathname: new URL(url).pathname,
          keys: payload && typeof payload === "object" ? Object.keys(payload) : [],
          collectionLength: collection.length,
          firstItemKeys: collection[0] && typeof collection[0] === "object" ? Object.keys(collection[0]) : [],
        });
      })
      .catch(() => {});
  });

  const loaded = new Promise((resolve) => {
    const off = onEvent("Page.loadEventFired", (event) => {
      if (event.sessionId !== sessionId) return;
      off();
      resolve();
    });
  });
  await send("Page.navigate", { url: captureUrl }, sessionId);
  await loaded;

  const started = Date.now();
  while (Date.now() - started < 25_000) {
    const state = await evaluate(`(() => ({
      ready: document.readyState,
      rootChildren: document.querySelector('#trades-web-app')?.childElementCount || 0,
      textLength: document.querySelector('#trades-web-app')?.textContent?.length || 0,
      loading: Boolean(document.querySelector('#trades-web-app .foundation-web-progress-circle'))
    }))()`, sessionId);
    const extensionReady = !extensionPath || Boolean(await evaluate(`(() => {
      if (!window.__TIS_LOADED__) return false;
      const isComposer = /^\\/users\\/\\d+\\/trade|^\\/trades\\/\\d+\\/counter/i.test(location.pathname);
      return !isComposer || Boolean(document.querySelector('.tis-controls') && document.querySelector('.tis-react-item-cards'));
    })()`, sessionId));
    if (Date.now() - started > 2_000 && state.rootChildren > 0 && state.textLength > 20 && !state.loading && extensionReady) break;
    await delay(250);
  }

  let seededDuplicateResult = null;
  if (process.env.TIS_SEED_DELTA_DUPLICATES) {
    const seeded = await evaluate(`(() => {
      const host = document.querySelector('.trades-list-detail .trade-buttons');
      if (!host) return { available: false, before: 0, seeded: 0 };
      const before = document.querySelectorAll('.tis-trade-delta').length;
      for (let index = 0; index < 5; index += 1) {
        const duplicate = document.createElement('div');
        duplicate.className = 'tis-trade-delta tis-seeded-duplicate';
        host.prepend(duplicate);
      }
      window.postMessage({ type: 'TIS_OFFER_TOTAL_VALUE' }, '*');
      return { available: true, before, seeded: document.querySelectorAll('.tis-trade-delta').length };
    })()`, sessionId);
    await delay(500);
    const after = await evaluate("document.querySelectorAll('.tis-trade-delta').length", sessionId);
    seededDuplicateResult = {
      ...seeded,
      after,
      pass: seeded.available && seeded.seeded >= 5 && after === 1,
    };
  }

  const soakMs = Math.max(0, Number(process.env.TIS_SOAK_MS) || 0);
  const soakSamples = [];
  let soakAssertions = null;
  let soakSummary = null;
  if (soakMs > 0) {
    await evaluate(`(() => {
      window.__TIS_SOAK_STATS__ = { records: 0, added: 0, removed: 0 };
      window.__TIS_SOAK_OBSERVER__?.disconnect?.();
      window.__TIS_SOAK_OBSERVER__ = new MutationObserver((mutations) => {
        window.__TIS_SOAK_STATS__.records += mutations.length;
        for (const mutation of mutations) {
          window.__TIS_SOAK_STATS__.added += mutation.addedNodes.length;
          window.__TIS_SOAK_STATS__.removed += mutation.removedNodes.length;
        }
      });
      window.__TIS_SOAK_OBSERVER__.observe(document.documentElement, { childList: true, subtree: true });
    })()`, sessionId);

    const soakStarted = Date.now();
    while (true) {
      const dom = await evaluate(`(() => {
        const rows = [...document.querySelectorAll('.trade-row-container')];
        const details = [...document.querySelectorAll('.trades-list-detail')];
        const count = (selector) => document.querySelectorAll(selector).length;
        const maxPerRow = (selector) => Math.max(0, ...rows.map((row) => row.querySelectorAll(selector).length));
        return {
          nodes: document.querySelectorAll('*').length,
          rows: rows.length,
          values: count('.tis-trade-row-values'),
          dateTexts: count('.tis-trade-row-date-text'),
          badges: count('.tis-roli-verified-badge'),
          roliRows: count('.tis-roli-row'),
          completedToggles: count('.tis-completed-trade-toggle'),
          deltas: count('.tis-trade-delta'),
          maxValuesPerRow: maxPerRow('.tis-trade-row-values'),
          maxDateTextsPerRow: maxPerRow('.tis-trade-row-date-text'),
          maxBadgesPerRow: maxPerRow('.tis-roli-verified-badge'),
          maxDeltasPerDetail: Math.max(0, ...details.map((detail) => detail.querySelectorAll('.tis-trade-delta').length)),
          mutations: { ...(window.__TIS_SOAK_STATS__ || {}) },
          scrollHeight: document.documentElement.scrollHeight,
        };
      })()`, sessionId);
      const performanceMetrics = await send('Performance.getMetrics', {}, sessionId).catch(() => ({ metrics: [] }));
      const metricMap = Object.fromEntries((performanceMetrics.metrics || []).map(({ name, value }) => [name, value]));
      soakSamples.push({
        ...dom,
        elapsedMs: Date.now() - soakStarted,
        jsHeapUsed: metricMap.JSHeapUsedSize || 0,
        taskDuration: metricMap.TaskDuration || 0,
      });
      if (Date.now() - soakStarted >= soakMs) break;
      await delay(Math.min(1000, soakMs - (Date.now() - soakStarted)));
    }
    await evaluate("window.__TIS_SOAK_OBSERVER__?.disconnect?.()", sessionId);
    const tail = soakSamples.slice(-5);
    const range = (key) => tail.length
      ? Math.max(...tail.map((sample) => Number(sample[key]) || 0)) - Math.min(...tail.map((sample) => Number(sample[key]) || 0))
      : 0;
    soakAssertions = {
      oneValuePanelPerRow: soakSamples.every((sample) => sample.maxValuesPerRow <= 1),
      oneDateLabelPerRow: soakSamples.every((sample) => sample.maxDateTextsPerRow <= 1),
      oneBadgePerRow: soakSamples.every((sample) => sample.maxBadgesPerRow <= 1),
      oneDeltaPerDetail: soakSamples.every((sample) => sample.maxDeltasPerDetail <= 1 && sample.deltas <= 1),
      stableTailNodeCount: range("nodes") <= 20,
      stableTailInjectedCounts: range("values") === 0 && range("dateTexts") === 0 && range("deltas") === 0,
    };
    soakAssertions.pass = Object.values(soakAssertions).every(Boolean);
    soakSummary = {
      sampleCount: soakSamples.length,
      elapsedMs: soakSamples.at(-1)?.elapsedMs || 0,
      first: soakSamples[0] || null,
      last: soakSamples.at(-1) || null,
      maxima: {
        nodes: Math.max(0, ...soakSamples.map((sample) => sample.nodes)),
        values: Math.max(0, ...soakSamples.map((sample) => sample.values)),
        dateTexts: Math.max(0, ...soakSamples.map((sample) => sample.dateTexts)),
        badges: Math.max(0, ...soakSamples.map((sample) => sample.badges)),
        deltas: Math.max(0, ...soakSamples.map((sample) => sample.deltas)),
        maxValuesPerRow: Math.max(0, ...soakSamples.map((sample) => sample.maxValuesPerRow)),
        maxDateTextsPerRow: Math.max(0, ...soakSamples.map((sample) => sample.maxDateTextsPerRow)),
        maxBadgesPerRow: Math.max(0, ...soakSamples.map((sample) => sample.maxBadgesPerRow)),
        maxDeltasPerDetail: Math.max(0, ...soakSamples.map((sample) => sample.maxDeltasPerDetail)),
      },
    };
  }

  const html = await evaluate("document.documentElement.outerHTML", sessionId);
  await writeFile(output, html, "utf8");
  let interactionTest = null;
  if (process.env.TIS_TEST_TOGGLE) {
    interactionTest = await evaluate(`(() => {
      const useNativeCard = ${Boolean(process.env.TIS_TEST_NATIVE_TOGGLE)};
      const panel = document.querySelectorAll('.trade-inventory-panel')[1];
      const card = useNativeCard
        ? panel?.querySelector('ul:not(.tis-react-item-cards) .trade-inventory-card .item-card-thumb-container')
        : document.querySelector('.tis-react-inventory-card:not(.tis-react-unavailable) .trade-inventory-card');
      const getOfferCount = () => document.querySelectorAll(
        '.trade-request-item:not(.blank-item):not(.draggable-border)',
      ).length;
      const getOfferStateCounts = () => [...document.querySelectorAll('.trade-request-window-offer')].map((node) => {
        let fiber = Object.entries(node).find(([key]) => key.startsWith('__reactFiber$'))?.[1] || null;
        for (let depth = 0; fiber && depth < 20; depth += 1, fiber = fiber.return) {
          const offer = fiber.memoizedProps?.offer;
          if (Array.isArray(offer?.items)) return {
            items: offer.items.length,
            slots: Array.isArray(offer.slots) ? offer.slots.map((slot) => slot?.type || null) : [],
          };
        }
        return null;
      });
      const before = getOfferCount();
      if (!card) return { before, clicked: false };
      const instanceId = card.closest('.tis-react-inventory-card')?.dataset.collectibleiteminstanceid || '';
      card.click();
      return new Promise((resolve) => setTimeout(() => resolve({
        before,
        after: getOfferCount(),
        offerStateCounts: getOfferStateCounts(),
        clicked: true,
        selected: useNativeCard
          ? card.closest('.trade-inventory-card')?.getAttribute('aria-pressed') === 'true'
          : [...document.querySelectorAll('.tis-react-inventory-card')]
            .some((node) => node.dataset.collectibleiteminstanceid === instanceId && node.classList.contains('tis-react-selected')),
      }), 250));
    })()`, sessionId);
  }
  const summary = await evaluate(`(() => {
    const root = document.querySelector('#trades-web-app');
    const nodes = [...(root?.querySelectorAll('*') || [])];
    const describeValue = (value) => {
      if (value == null) return value;
      if (typeof value === 'function') return { type: 'function', source: String(value).slice(0, 500) };
      if (Array.isArray(value)) return { type: 'array', length: value.length };
      if (typeof value === 'object') return { type: 'object', keys: Object.keys(value).slice(0, 80) };
      return { type: typeof value, value: String(value).slice(0, 160) };
    };
    const describeReactNode = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const reactKeys = Object.keys(node).filter((key) => key.startsWith('__react'));
      const result = { selector, reactKeys, entries: {} };
      for (const key of reactKeys) {
        const value = node[key];
        if (key.startsWith('__reactProps')) {
          result.entries[key] = Object.fromEntries(Object.entries(value || {}).map(([name, entry]) => [name, describeValue(entry)]));
          continue;
        }
        const chain = [];
        let fiber = value;
        for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
          chain.push({
            tag: fiber.tag,
            key: fiber.key,
            elementType: typeof fiber.elementType === 'function' ? (fiber.elementType.name || 'anonymous') : String(fiber.elementType || ''),
            memoizedProps: fiber.memoizedProps && typeof fiber.memoizedProps === 'object'
              ? Object.fromEntries(Object.entries(fiber.memoizedProps).map(([name, entry]) => [name, describeValue(entry)]))
              : describeValue(fiber.memoizedProps),
          });
        }
        result.entries[key] = chain;
      }
      return result;
    };
    const counts = {};
    for (const node of nodes) {
      for (const className of node.classList || []) counts[className] = (counts[className] || 0) + 1;
    }
    return {
      url: location.href,
      title: document.title,
      rootChildren: root?.childElementCount || 0,
      nodeCount: nodes.length,
      tags: [...new Set(nodes.map((node) => node.tagName.toLowerCase()))].sort(),
      classes: Object.entries(counts).sort((a, b) => b[1] - a[1]),
      dataAttributes: [...new Set(nodes.flatMap((node) => [...node.attributes]
        .map((attribute) => attribute.name)
        .filter((name) => name.startsWith('data-'))))].sort(),
      buttons: nodes.filter((node) => node.matches('button,[role="button"]')).map((node) => ({
        tag: node.tagName.toLowerCase(),
        className: node.className,
        ariaLabel: node.getAttribute('aria-label'),
        title: node.getAttribute('title'),
      })),
      links: nodes.filter((node) => node.matches('a[href]')).map((node) => ({
        className: node.className,
        href: node.getAttribute('href'),
      })),
      reactInternals: [
        describeReactNode('.trade-inventory-card'),
        describeReactNode('.trade-row'),
        describeReactNode('.item-card-container'),
      ].filter(Boolean),
    };
  })()`, sessionId);
  const result = {
    output,
    ...summary,
    soakSamples,
    soakAssertions,
    seededDuplicateResult,
    networkResponses: networkResponses.filter(({ url, status }) =>
      status >= 400 || /trades\.roblox\.com|users\.roblox\.com/.test(url)),
    runtimeExceptions,
  };
  if (process.env.TIS_SUMMARY_ONLY) {
    console.log(JSON.stringify({
      output,
      url: summary.url,
      title: summary.title,
      nodeCount: summary.nodeCount,
      tisClasses: Object.fromEntries(summary.classes.filter(([name]) => name.startsWith("tis-"))),
      dataAttributes: summary.dataAttributes,
      runtimeExceptions,
      interactionTest,
      tradableResponseShapes,
      soakSummary,
      soakAssertions,
      seededDuplicateResult,
      tradeResponses: networkResponses.filter(({ url, status }) =>
        status >= 400 || /trades\.roblox\.com|users\.roblox\.com/.test(url)),
    }, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (process.env.TIS_ASSERT_STABLE && soakAssertions && !soakAssertions.pass) {
    process.exitCode = 1;
  }
  if (process.env.TIS_SEED_DELTA_DUPLICATES && !seededDuplicateResult?.pass) {
    process.exitCode = 1;
  }
} finally {
  try { socket?.close(); } catch {}
  try {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await Promise.race([exited, delay(5_000)]);
    }
  } catch {}
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) console.error(`Could not remove temporary browser profile: ${error.message}`);
      else await delay(200);
    }
  }
}
