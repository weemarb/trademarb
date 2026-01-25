(() => {
  const TAG = "[tis]";

  console.log(`${TAG} content script loaded on:`, location.href);

  // inject injected.js into the MAIN world so it can access angular + page stuff
  const inject = () => {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("injected.js");
    s.type = "text/javascript";
    s.dataset.tis = "1";
    (document.documentElement || document.head).appendChild(s);
  };

  inject();
})();
