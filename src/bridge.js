// Runs in the isolated world on chess.com. Owns chrome.storage access and
// relays settings to inject.js (MAIN world) over window.postMessage, since
// chrome.storage isn't reachable from a MAIN-world content script.
(function () {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    waitMs: 10000,
    clockMode: "fixed",
    bypassBelowSec: 30,
    scaleDivisor: 10,
    showSkipButton: true,
    blockPremoveIntoLock: true,
    onComputer: true,
    onOnline: true,
    stats: { locksServed: 0, skips: 0, msWaited: 0 },
  };

  function loadConfig(cb) {
    chrome.storage.sync.get(DEFAULTS, cb);
  }

  function sendConfig(cfg) {
    window.postMessage({ source: "ctf-bridge", type: "config", payload: cfg }, "*");
  }

  loadConfig(sendConfig);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    loadConfig(sendConfig);
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "ctf-inject") return;

    if (data.type === "requestConfig") {
      loadConfig(sendConfig);
      return;
    }

    if (data.type === "statsDelta") {
      const delta = data.payload || {};
      chrome.storage.sync.get({ stats: DEFAULTS.stats }, ({ stats }) => {
        const next = {
          locksServed: (stats.locksServed || 0) + (delta.locksServed || 0),
          skips: (stats.skips || 0) + (delta.skips || 0),
          msWaited: (stats.msWaited || 0) + (delta.msWaited || 0),
        };
        chrome.storage.sync.set({ stats: next });
      });
    }
  });
})();
