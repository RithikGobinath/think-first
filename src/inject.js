// Runs in the MAIN world on chess.com. Owns the board hook and the lockout
// engine. Talks to bridge.js (isolated world) over window.postMessage since
// chrome.storage isn't reachable from MAIN world content scripts.
(function () {
  "use strict";

  const LOG_PREFIX = "[Think First]";

  // Mirrors bridge.js's DEFAULTS. Used until the bridge responds to our
  // initial requestConfig, and to fill in any field a stored config is
  // missing (e.g. after adding a new setting).
  const DEFAULT_CONFIG = {
    enabled: true,
    waitMs: 10000,
    clockMode: "fixed", // 'fixed' | 'scaled'
    bypassBelowSec: 30, // skip the lockout entirely once my clock drops below this
    scaleDivisor: 10, // 'scaled' mode only: wait shrinks toward remaining/scaleDivisor seconds
    showSkipButton: true,
    // Confirmed live (#4): setOptions({enabled:false}) does NOT cancel a
    // premove armed before the lock engages - it executes instantly the
    // moment it's my turn, with no visible freeze at all. The only way to
    // actually prevent that is to disable the board for the opponent's
    // entire turn (see beginPremoveBlock), which also disables premoving
    // entirely - there's no way to allow premoves but only block them
    // "into the lock" specifically. Toggle, not a permanent decision.
    blockPremoveIntoLock: true,
    onComputer: true,
    onOnline: true,
    pieceDimIntensity: 25, // 0-100: 0 = no dimming, 100 = strongest (opacity 0.5, full grayscale)
    skipKey: "Space", // KeyboardEvent.code
  };

  const config = Object.assign({}, DEFAULT_CONFIG);

  const state = {
    boundEl: null, // the <wc-chess-board> element we're currently attached to
    boundGame: null, // boundEl.game, cached because the reference can change
    unbindGame: null, // cleanup fn for the currently bound game's listeners
  };

  const lockState = {
    active: false,
    timer: null,
    guardInterval: null,
    watchdogTimer: null,
    startTs: 0,
    durationMs: 0,
    prevEnabled: true,
    overlayEl: null,
    countdownRAF: null,
    pieceObserver: null,
    anchorEl: null,
    premoveBlockActive: false,
    premoveBlockPrevEnabled: true,
    premoveGuardInterval: null,
  };

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function reportStats(delta) {
    try {
      window.postMessage({ source: "ctf-inject", type: "statsDelta", payload: delta }, "*");
    } catch (err) {
      // best-effort - a dropped stats update should never affect the lock
    }
  }

  // --- safe wrappers around the game API -----------------------------------
  // chess.com's game object is undocumented and can throw or return odd
  // values across page states (analysis, spectating, game-over). Every call
  // into it goes through one of these so a single bad state can't kill the
  // whole content script.

  function safeGetPlayingAs(game) {
    try {
      const side = game.getPlayingAs();
      return side === 1 || side === 2 ? side : null;
    } catch (err) {
      return null;
    }
  }

  function safeGetTurn(game) {
    try {
      return game.getTurn();
    } catch (err) {
      return null;
    }
  }

  function safeIsGameOver(game) {
    try {
      return !!game.isGameOver();
    } catch (err) {
      return false;
    }
  }

  function safeGetEnabled(game) {
    try {
      return game.getOptions().enabled !== false;
    } catch (err) {
      return true;
    }
  }

  function safeSetEnabled(game, value) {
    try {
      game.setOptions({ enabled: value });
    } catch (err) {
      warn("failed to set enabled:", value, err);
    }
  }

  // --- applicability ---------------------------------------------------------
  // Only arm on actual games (vs. the computer or a live opponent), never on
  // analysis boards, puzzles, or lessons, which also use <wc-chess-board>.
  //
  // "online" is a denylist, not an allowlist: chess.com's real live-game URL
  // scheme was never confirmed against an actual account (only /play/computer
  // was ever tested live), so guessing at exact path prefixes like
  // /game/live risked silently never matching a real game - which is exactly
  // what happened. Excluding known non-game surfaces and defaulting the rest
  // to "online" is safe because the real gate against false positives is
  // getPlayingAs() returning a seat, not the URL - see beginLock()/
  // onGameLoaded(), which both bail out on spectating/analysis regardless.

  const NON_GAME_PATH_PREFIXES = [
    "/analysis",
    "/puzzles",
    "/lessons",
    "/explorer",
    "/home",
    "/login",
    "/register",
    "/article",
    "/news",
    "/forum",
    "/clubs",
    "/tv",
    "/videos",
    "/member",
    "/settings",
    "/leaderboard",
  ];

  function isApplicablePath() {
    const path = location.pathname;
    if (path.startsWith("/play/computer")) return "computer";
    if (NON_GAME_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;
    return "online"; // default: assume any other page with a bound, seated game is a real game
  }

  function isApplicable() {
    const kind = isApplicablePath();
    if (kind === "computer") return config.onComputer;
    if (kind === "online") return config.onOnline;
    return false; // analysis, puzzles, lessons, etc.
  }

  // --- clock reading -----------------------------------------------------
  // Confirmed live on a real timed game (#4): game.times/game.timeControl
  // hold no usable remaining-time data - timeControl is just the static
  // {baseTime, increment} config - so readClockFromApi() is effectively
  // dead code that always falls through, harmlessly. The DOM path is the
  // real one and is confirmed working: chess.com renders
  // `<div class="clock-component clock-bottom clock-black ..."><span
  // class="clock-time-monospace">2:58</span></div>`, and the selector/regex
  // below correctly parse it. Kept degrading to `null` ("untimed" - the
  // lockout always applies) on any unexpected shape rather than guessing
  // wrong, since chess.com's markup could still change in the future.

  function extractTimeForSide(obj, side) {
    if (!obj || side == null) return null;
    const candidates = [obj[side], obj[String(side)], side === 1 ? obj.white : obj.black, side === 1 ? obj.w : obj.b];
    for (const c of candidates) {
      if (typeof c === "number" && isFinite(c) && c >= 0) {
        // Heuristic: chess.com clocks are typically tracked in ms internally.
        return c > 1000 ? c / 1000 : c;
      }
    }
    return null;
  }

  function readClockFromApi(game) {
    const mySide = safeGetPlayingAs(game);
    try {
      const val = extractTimeForSide(game.times, mySide);
      if (val != null) return val;
    } catch (err) {
      // fall through to timeControl
    }
    try {
      const tc = game.timeControl;
      const snapshot = tc && typeof tc.get === "function" ? tc.get() : tc;
      const val = extractTimeForSide(snapshot, mySide);
      if (val != null) return val;
    } catch (err) {
      // fall through to DOM
    }
    return null;
  }

  function parseClockText(text) {
    const t = (text || "").trim();
    let m;
    if ((m = /^(\d+):(\d{2}):(\d{2})$/.exec(t))) {
      return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
    if ((m = /^(\d+):(\d{2})(?:\.(\d))?$/.exec(t))) {
      return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
    }
    if ((m = /^(\d+)(?:\.(\d))?$/.exec(t))) {
      return Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0);
    }
    return null;
  }

  function readClockFromDom() {
    try {
      // The board always renders the local player at the bottom.
      const container = document.querySelector("#board-layout-player-bottom");
      if (!container) return null;
      const clockEl = container.querySelector('[class*="clock-component"], [class*="clock"]');
      if (!clockEl) return null;
      return parseClockText(clockEl.textContent);
    } catch (err) {
      return null;
    }
  }

  function readMyClockSeconds(game) {
    const fromApi = readClockFromApi(game);
    if (fromApi != null) return fromApi;
    return readClockFromDom();
  }

  // --- lock engine -------------------------------------------------------
  // Freezes the board by flipping the same `enabled` flag chess.com's own UI
  // uses. Verified live: while `enabled:false`, drag/drop and legal-move
  // hints are fully inert, and the opponent's move still lands normally -
  // the freeze only blocks *our* input, never the game itself.
  //
  // Fail-open is a hard requirement: a stuck lock ruins a real game. Every
  // exit path (turn ends, game over, resign, mode change, tab unload, a
  // thrown error, or the watchdog) routes through endLock().

  // --- overlay -------------------------------------------------------------
  // The board itself is never touched - no darkening, no color/gradient
  // changes - only the pieces dim. Tried a class on <wc-chess-board> plus a
  // plain CSS descendant selector first; confirmed live that chess.com's own
  // piece styling wins that fight even with !important (it has its own
  // JS-driven piece animation engine - "pieceAnimationsEngine": "js-animator"
  // in the board's own options). Setting opacity/filter directly on each
  // .piece element's inline style with 'important' priority does stick, so
  // that's what this does instead, with a MutationObserver re-applying it to
  // any piece chess.com adds during the lock (captures, move animations).
  //
  // The countdown + skip button is a small badge placed next to the
  // player's own clock rather than a full-board overlay. Chess.com's real
  // clock markup on a live timed game was never confirmed (only the
  // untimed /play/computer page was tested), so the anchor search below
  // tries a few reasonable spots and degrades to a fixed corner badge
  // rather than failing to mount at all.

  function pieceDimStyle() {
    const pct = Math.max(0, Math.min(100, Number(config.pieceDimIntensity)));
    // 0 -> opacity 1.0 (no dimming), 100 -> opacity 0.5 (strongest we allow -
    // 0 opacity would make pieces disappear entirely, which isn't "dimmed").
    const opacity = (1 - (pct / 100) * 0.5).toFixed(2);
    return { opacity, filter: `grayscale(${pct}%)` };
  }

  function setPieceDimmed(el, dimmed) {
    if (dimmed) {
      const style = pieceDimStyle();
      el.style.setProperty("opacity", style.opacity, "important");
      el.style.setProperty("filter", style.filter, "important");
    } else {
      el.style.removeProperty("opacity");
      el.style.removeProperty("filter");
    }
  }

  function dimAllPieces(board, dimmed) {
    if (!board) return;
    board.querySelectorAll(".piece").forEach((el) => setPieceDimmed(el, dimmed));
  }

  function startPieceObserver(board) {
    stopPieceObserver();
    if (!board) return;
    lockState.pieceObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.classList && node.classList.contains("piece")) setPieceDimmed(node, true);
          node.querySelectorAll && node.querySelectorAll(".piece").forEach((el) => setPieceDimmed(el, true));
        });
      }
    });
    lockState.pieceObserver.observe(board, { childList: true, subtree: true });
  }

  function stopPieceObserver() {
    if (lockState.pieceObserver) {
      lockState.pieceObserver.disconnect();
      lockState.pieceObserver = null;
    }
  }

  // Confirmed live (two different chess.com layouts - an untimed bot game
  // and a timed page) that #board-layout-player-bottom's internal layout
  // isn't reliable: in one case its row container is display:block, so a
  // plain appendChild() pushed the badge onto a new line below the
  // username instead of sitting beside it. Anchoring by position:absolute
  // sidesteps that entirely - the badge's spot is independent of whatever
  // flex/block layout that container happens to use.
  function unmountOverlay() {
    if (lockState.countdownRAF != null) {
      cancelAnimationFrame(lockState.countdownRAF);
      lockState.countdownRAF = null;
    }
    if (lockState.overlayEl) {
      lockState.overlayEl.remove();
      lockState.overlayEl = null;
    }
    if (lockState.anchorEl) {
      lockState.anchorEl.classList.remove("ctf-anchor");
      lockState.anchorEl = null;
    }
    stopPieceObserver();
    dimAllPieces(state.boundEl, false);
  }

  function mountOverlay(game) {
    unmountOverlay();

    dimAllPieces(state.boundEl, true);
    startPieceObserver(state.boundEl);

    const badge = document.createElement("div");
    badge.className = "ctf-badge";
    badge.innerHTML =
      '<span class="ctf-badge-seconds"></span>' + (config.showSkipButton ? '<button type="button" class="ctf-skip">Skip</button>' : "");

    const container = document.querySelector("#board-layout-player-bottom");
    if (container) {
      // Only force position:relative if it isn't already positioned -
      // don't clobber a layout chess.com already controls.
      if (getComputedStyle(container).position === "static") {
        container.classList.add("ctf-anchor");
        lockState.anchorEl = container;
      }
      // If a clock element exists, clear it so the badge doesn't overlap
      // the digits; otherwise sit flush against the row's right edge.
      const clockEl = container.querySelector('[class*="clock-component"], [class*="clock"]');
      const rightOffset = clockEl ? clockEl.getBoundingClientRect().width + 12 : 8;
      badge.classList.add("ctf-badge-anchored");
      badge.style.right = rightOffset + "px";
      container.appendChild(badge);
    } else {
      // Couldn't find the player row at all - pin to the board's corner
      // rather than not showing anything.
      const boardAnchor = document.querySelector("#board-layout-chessboard") || state.boundEl;
      if (boardAnchor) boardAnchor.appendChild(badge);
      badge.classList.add("ctf-badge-fallback");
    }

    lockState.overlayEl = badge;

    const skipBtn = badge.querySelector(".ctf-skip");
    if (skipBtn) {
      skipBtn.addEventListener("click", () => performSkip(game));
    }

    startCountdownAnimation();
  }

  function performSkip(game) {
    log("skip triggered");
    reportStats({ skips: 1 });
    endLock(game);
  }

  function isEditableTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function onSkipKeyDown(event) {
    if (!lockState.active) return;
    if (!config.skipKey || event.code !== config.skipKey) return;
    if (isEditableTarget(event.target)) return; // don't hijack chat/search input
    event.preventDefault();
    performSkip(state.boundGame);
  }

  function startCountdownAnimation() {
    const badge = lockState.overlayEl;
    if (!badge) return;

    const label = badge.querySelector(".ctf-badge-seconds");

    function tick() {
      if (!lockState.active || lockState.overlayEl !== badge) return;

      const elapsed = performance.now() - lockState.startTs;
      const remainMs = Math.max(0, lockState.durationMs - elapsed);

      if (label) label.textContent = Math.ceil(remainMs / 1000) + "s";

      lockState.countdownRAF = requestAnimationFrame(tick);
    }

    tick();
  }

  function computeDuration(game) {
    const remaining = readMyClockSeconds(game);
    if (remaining == null) return config.waitMs; // untimed - always the full wait

    if (remaining < config.bypassBelowSec) return 0; // flagging risk outweighs the drill

    if (config.clockMode === "scaled") {
      const scaledMs = (remaining / config.scaleDivisor) * 1000;
      return Math.max(0, Math.min(config.waitMs, scaledMs));
    }

    return config.waitMs;
  }

  function beginLock(game) {
    if (lockState.active) return;
    if (!config.enabled) return;
    if (!isApplicable()) return;
    if (safeIsGameOver(game)) return;

    const mySide = safeGetPlayingAs(game);
    if (mySide == null) return;
    if (safeGetTurn(game) !== mySide) return; // race guard vs. a stale caller

    const duration = computeDuration(game);
    if (duration <= 0) return;

    lockState.active = true;
    lockState.prevEnabled = safeGetEnabled(game);
    lockState.durationMs = duration;
    lockState.startTs = performance.now();

    safeSetEnabled(game, false);
    mountOverlay(game);

    // Chess.com never contends for this flag once it's set, but re-assert
    // periodically as cheap insurance against anything that might.
    lockState.guardInterval = setInterval(() => safeSetEnabled(game, false), 250);
    lockState.timer = setTimeout(() => endLock(game), duration);
    lockState.watchdogTimer = setTimeout(() => {
      if (lockState.active) {
        warn("watchdog force-unlock - endLock did not fire in time");
        endLock(game);
      }
    }, duration + 2000);

    log("lock engaged for", duration, "ms");
    reportStats({ locksServed: 1 });
  }

  function endLock(game) {
    if (!lockState.active) return;

    const elapsedMs = Math.round(Math.min(performance.now() - lockState.startTs, lockState.durationMs));

    lockState.active = false;
    clearTimeout(lockState.timer);
    clearInterval(lockState.guardInterval);
    clearTimeout(lockState.watchdogTimer);
    lockState.timer = null;
    lockState.guardInterval = null;
    lockState.watchdogTimer = null;

    if (game) safeSetEnabled(game, lockState.prevEnabled);
    unmountOverlay();

    log("lock released");
    reportStats({ msWaited: elapsedMs });
  }

  // --- premove blocking ----------------------------------------------------
  // Confirmed live (#4): a premove armed during the opponent's turn executes
  // the instant it's my turn, bypassing beginLock() entirely - no visible
  // freeze. Cancelling it after the fact doesn't work, so instead this
  // disables the board for the opponent's whole turn (not just a "tail"),
  // which prevents a premove from ever being armed in the first place. No
  // overlay/badge here - there's nothing to count down, it's just a passive
  // hold. Deliberately unconditional restore on end so it can never leave
  // the board stuck disabled regardless of what beginLock() decides next.

  function beginPremoveBlock(game) {
    if (lockState.premoveBlockActive) return;
    if (!config.enabled || !config.blockPremoveIntoLock) return;
    if (!isApplicable()) return;
    if (safeIsGameOver(game)) return;

    lockState.premoveBlockActive = true;
    lockState.premoveBlockPrevEnabled = safeGetEnabled(game);
    safeSetEnabled(game, false);
    lockState.premoveGuardInterval = setInterval(() => safeSetEnabled(game, false), 250);
  }

  function endPremoveBlock(game) {
    if (!lockState.premoveBlockActive) return;

    lockState.premoveBlockActive = false;
    clearInterval(lockState.premoveGuardInterval);
    lockState.premoveGuardInterval = null;

    if (game) safeSetEnabled(game, lockState.premoveBlockPrevEnabled);
  }

  // --- turn detection ---------------------------------------------------------

  function onGameLoaded() {
    const game = state.boundGame;
    if (!game) return;
    const mySide = safeGetPlayingAs(game);
    if (mySide == null) {
      log("no seat at this board (spectating/analysis) - ignoring");
      endLock(game);
      endPremoveBlock(game);
      return;
    }
    const turn = safeGetTurn(game);
    log("game loaded/reset - playingAs:", mySide, "turn:", turn, "path:", isApplicablePath());

    if (safeIsGameOver(game)) {
      endLock(game);
      endPremoveBlock(game);
    } else if (turn === mySide) {
      endPremoveBlock(game);
      beginLock(game);
    } else {
      endLock(game);
      beginPremoveBlock(game);
    }
  }

  function handleMoveEvent(detail) {
    const game = state.boundGame;
    if (!game) return;
    const move = detail && detail.data && detail.data.move;
    if (!move) return;

    const mySide = safeGetPlayingAs(game);
    if (mySide == null) return;

    if (move.color === mySide) {
      log("I moved:", move.san, "- my turn ends");
      endLock(game);
      beginPremoveBlock(game);
    } else {
      log("opponent moved:", move.san, "- my turn begins");
      endPremoveBlock(game);
      beginLock(game);
    }
  }

  // --- attach / bind ---------------------------------------------------------

  function bindGame(game) {
    if (state.boundGame === game) return;
    if (typeof state.unbindGame === "function") {
      state.unbindGame();
      state.unbindGame = null;
    }

    state.boundGame = game;

    const onMove = (detail) => {
      try {
        handleMoveEvent(detail);
      } catch (err) {
        warn("error handling Move event", err);
        endLock(game);
        endPremoveBlock(game);
      }
    };
    const onCreateOrLoad = () => {
      try {
        onGameLoaded();
      } catch (err) {
        warn("error handling game load", err);
        endLock(game);
        endPremoveBlock(game);
      }
    };
    // Fail-open: nothing about "the game just ended" should leave the board
    // frozen behind it.
    const onGameEnd = () => {
      endLock(game);
      endPremoveBlock(game);
    };

    game.on("Move", onMove);
    game.on("CreateGame", onCreateOrLoad);
    game.on("Load", onCreateOrLoad);
    game.on("GameResigned", onGameEnd);
    game.on("ModeChanged", onGameEnd);

    state.unbindGame = () => {
      endLock(game);
      endPremoveBlock(game);
      try {
        game.off("Move", onMove);
        game.off("CreateGame", onCreateOrLoad);
        game.off("Load", onCreateOrLoad);
        game.off("GameResigned", onGameEnd);
        game.off("ModeChanged", onGameEnd);
      } catch (err) {
        // game instance may already be torn down - nothing to do
      }
    };

    log("bound to game instance");
    onGameLoaded();
  }

  function findBoards() {
    return Array.from(document.querySelectorAll("wc-chess-board"));
  }

  function pickPrimaryBoard() {
    const boards = findBoards();
    return boards.find((b) => b.game) || boards[0] || null;
  }

  async function pollForGame(el, timeoutMs = 10000, intervalMs = 50) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      if (el.game) return el.game;
      await sleep(intervalMs);
    }
    return null;
  }

  let attaching = false;

  async function tryAttach() {
    if (attaching) return;
    const el = pickPrimaryBoard();
    if (!el) return;
    if (el === state.boundEl && el.game === state.boundGame) return;

    attaching = true;
    try {
      let game = el.game;
      if (!game) game = await pollForGame(el);
      if (!game) return;

      state.boundEl = el;
      bindGame(game);
    } finally {
      attaching = false;
    }
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // --- settings bridge -------------------------------------------------
  // chrome.storage isn't reachable from this MAIN-world script, so config
  // comes from bridge.js (isolated world) over window.postMessage. Only
  // messages we posted ourselves matter, so ignore anything not from our
  // own window with the expected source tag - this also naturally excludes
  // postMessage traffic from chess.com's own code.

  function applyConfig(payload) {
    const wasEnabled = config.enabled;
    Object.assign(config, DEFAULT_CONFIG, payload || {});
    log("config updated", config);

    if (!config.enabled) {
      // fail-open: turning the extension off must never leave the board stuck
      if (lockState.active) endLock(state.boundGame);
      if (lockState.premoveBlockActive) endPremoveBlock(state.boundGame);
    }
    if (config.enabled && !wasEnabled && state.boundGame) {
      onGameLoaded(); // re-evaluate now that we're back on, in case it's already my turn
    }
    if (!config.blockPremoveIntoLock && lockState.premoveBlockActive) {
      endPremoveBlock(state.boundGame); // toggled off mid-block - release immediately
    }
  }

  function onWindowMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "ctf-bridge") return;
    if (data.type === "config") applyConfig(data.payload);
  }

  function init() {
    log("initializing");

    window.addEventListener("message", onWindowMessage);
    window.postMessage({ source: "ctf-inject", type: "requestConfig" }, "*");
    window.addEventListener("keydown", onSkipKeyDown);

    tryAttach();

    if (window.customElements && customElements.whenDefined) {
      customElements.whenDefined("wc-chess-board").then(tryAttach).catch(() => {});
    }

    const observer = new MutationObserver(debounce(tryAttach, 100));
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Cheap safety net for SPA navigations the observer might miss.
    setInterval(tryAttach, 2000);

    // Fail-open on tab close/navigation so we never leave a real game frozen.
    const unlockOnExit = () => {
      endLock(state.boundGame);
      endPremoveBlock(state.boundGame);
    };
    window.addEventListener("beforeunload", unlockOnExit);
    window.addEventListener("pagehide", unlockOnExit);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
