// Runs in the MAIN world on chess.com. Owns the board hook and the lockout
// engine. Talks to bridge.js (isolated world) over window.postMessage since
// chrome.storage isn't reachable from MAIN world content scripts.
(function () {
  "use strict";

  const LOG_PREFIX = "[Think First]";

  // TODO(storage bridge): replace with settings synced from the popup via
  // bridge.js. Hardcoded for now so the lock engine can be built and tested
  // independently of the storage plumbing.
  const config = {
    enabled: true,
    waitMs: 10000,
  };

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

  function isApplicablePath() {
    const path = location.pathname;
    if (path.startsWith("/play/computer")) return "computer";
    if (path.startsWith("/game/live") || path.startsWith("/play/online")) return "online";
    return null;
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

  function computeDuration() {
    // Clock-aware bypass/scaling lands in a follow-up PR. For now this is a
    // flat wait whenever the extension is on.
    return config.waitMs;
  }

  function beginLock(game) {
    if (lockState.active) return;
    if (!config.enabled) return;
    if (safeIsGameOver(game)) return;

    const mySide = safeGetPlayingAs(game);
    if (mySide == null) return;
    if (safeGetTurn(game) !== mySide) return; // race guard vs. a stale caller

    const duration = computeDuration();
    if (duration <= 0) return;

    lockState.active = true;
    lockState.prevEnabled = safeGetEnabled(game);
    lockState.durationMs = duration;
    lockState.startTs = performance.now();

    safeSetEnabled(game, false);

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
  }

  function endLock(game) {
    if (!lockState.active) return;

    lockState.active = false;
    clearTimeout(lockState.timer);
    clearInterval(lockState.guardInterval);
    clearTimeout(lockState.watchdogTimer);
    lockState.timer = null;
    lockState.guardInterval = null;
    lockState.watchdogTimer = null;

    if (game) safeSetEnabled(game, lockState.prevEnabled);

    log("lock released");
  }

  // --- turn detection ---------------------------------------------------------

  function onGameLoaded() {
    const game = state.boundGame;
    if (!game) return;
    const mySide = safeGetPlayingAs(game);
    if (mySide == null) {
      log("no seat at this board (spectating/analysis) - ignoring");
      endLock(game);
      return;
    }
    const turn = safeGetTurn(game);
    log("game loaded/reset - playingAs:", mySide, "turn:", turn, "path:", isApplicablePath());

    if (safeIsGameOver(game)) {
      endLock(game);
    } else if (turn === mySide) {
      beginLock(game);
    } else {
      endLock(game);
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
    } else {
      log("opponent moved:", move.san, "- my turn begins");
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
      }
    };
    const onCreateOrLoad = () => {
      try {
        onGameLoaded();
      } catch (err) {
        warn("error handling game load", err);
        endLock(game);
      }
    };
    // Fail-open: nothing about "the game just ended" should leave the board
    // frozen behind it.
    const onGameEnd = () => endLock(game);

    game.on("Move", onMove);
    game.on("CreateGame", onCreateOrLoad);
    game.on("Load", onCreateOrLoad);
    game.on("GameResigned", onGameEnd);
    game.on("ModeChanged", onGameEnd);

    state.unbindGame = () => {
      endLock(game);
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

  function init() {
    log("initializing");
    tryAttach();

    if (window.customElements && customElements.whenDefined) {
      customElements.whenDefined("wc-chess-board").then(tryAttach).catch(() => {});
    }

    const observer = new MutationObserver(debounce(tryAttach, 100));
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Cheap safety net for SPA navigations the observer might miss.
    setInterval(tryAttach, 2000);

    // Fail-open on tab close/navigation so we never leave a real game frozen.
    const unlockOnExit = () => endLock(state.boundGame);
    window.addEventListener("beforeunload", unlockOnExit);
    window.addEventListener("pagehide", unlockOnExit);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
