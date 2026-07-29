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

  // Falls back to an in-memory store when previewed outside the extension
  // (no chrome.storage there) so the UI is still exercisable during dev.
  const hasStorage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync;
  const memoryStore = Object.assign({}, DEFAULTS);

  function storageGet(defaults, cb) {
    if (hasStorage) {
      chrome.storage.sync.get(defaults, cb);
      return;
    }
    cb(Object.assign({}, defaults, memoryStore));
  }

  function storageSet(patch) {
    if (hasStorage) {
      chrome.storage.sync.set(patch);
      return;
    }
    Object.assign(memoryStore, patch);
  }

  const els = {
    enabled: document.getElementById("enabled"),
    waitMs: document.getElementById("waitMs"),
    waitMsValue: document.getElementById("waitMsValue"),
    clockModeInputs: document.querySelectorAll('input[name="clockMode"]'),
    bypassBelowSec: document.getElementById("bypassBelowSec"),
    scaleDivisor: document.getElementById("scaleDivisor"),
    scaleDivisorRow: document.getElementById("scaleDivisorRow"),
    showSkipButton: document.getElementById("showSkipButton"),
    onComputer: document.getElementById("onComputer"),
    onOnline: document.getElementById("onOnline"),
    statLocks: document.getElementById("statLocks"),
    statSkips: document.getElementById("statSkips"),
    statWaited: document.getElementById("statWaited"),
  };

  function formatWait(ms) {
    return Math.round(ms / 1000) + "s";
  }

  function formatWaited(ms) {
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return totalSec + "s";
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min + "m " + sec + "s";
  }

  function updateScaleDivisorVisibility(mode) {
    els.scaleDivisorRow.style.display = mode === "scaled" ? "flex" : "none";
  }

  function render(cfg) {
    els.enabled.checked = cfg.enabled;
    els.waitMs.value = cfg.waitMs;
    els.waitMsValue.textContent = formatWait(cfg.waitMs);
    els.clockModeInputs.forEach((input) => {
      input.checked = input.value === cfg.clockMode;
    });
    els.bypassBelowSec.value = cfg.bypassBelowSec;
    els.scaleDivisor.value = cfg.scaleDivisor;
    els.showSkipButton.checked = cfg.showSkipButton;
    els.onComputer.checked = cfg.onComputer;
    els.onOnline.checked = cfg.onOnline;
    updateScaleDivisorVisibility(cfg.clockMode);

    const stats = cfg.stats || DEFAULTS.stats;
    els.statLocks.textContent = stats.locksServed || 0;
    els.statSkips.textContent = stats.skips || 0;
    els.statWaited.textContent = formatWaited(stats.msWaited || 0);
  }

  function load() {
    storageGet(DEFAULTS, render);
  }

  els.enabled.addEventListener("change", () => storageSet({ enabled: els.enabled.checked }));

  els.waitMs.addEventListener("input", () => {
    els.waitMsValue.textContent = formatWait(Number(els.waitMs.value));
  });
  els.waitMs.addEventListener("change", () => storageSet({ waitMs: Number(els.waitMs.value) }));

  els.clockModeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      updateScaleDivisorVisibility(input.value);
      storageSet({ clockMode: input.value });
    });
  });

  els.bypassBelowSec.addEventListener("change", () => storageSet({ bypassBelowSec: Number(els.bypassBelowSec.value) }));
  els.scaleDivisor.addEventListener("change", () => storageSet({ scaleDivisor: Number(els.scaleDivisor.value) }));
  els.showSkipButton.addEventListener("change", () => storageSet({ showSkipButton: els.showSkipButton.checked }));
  els.onComputer.addEventListener("change", () => storageSet({ onComputer: els.onComputer.checked }));
  els.onOnline.addEventListener("change", () => storageSet({ onOnline: els.onOnline.checked }));

  if (hasStorage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      load();
    });
  }

  load();
})();
