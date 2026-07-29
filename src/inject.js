// Runs in the MAIN world on chess.com. Owns the board hook and the lockout
// engine. Talks to bridge.js (isolated world) over window.postMessage since
// chrome.storage isn't reachable from MAIN world content scripts.
(function () {
  "use strict";

  const LOG_PREFIX = "[Think First]";

  const state = {
    boundEl: null, // the <wc-chess-board> element we're currently attached to
    boundGame: null, // boundEl.game, cached because the reference can change
    unbindGame: null, // cleanup fn for the currently bound game's listeners
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

  // --- applicability ---------------------------------------------------------
  // Only arm on actual games (vs. the computer or a live opponent), never on
  // analysis boards, puzzles, or lessons, which also use <wc-chess-board>.

  function isApplicablePath() {
    const path = location.pathname;
    if (path.startsWith("/play/computer")) return "computer";
    if (path.startsWith("/game/live") || path.startsWith("/play/online")) return "online";
    return null;
  }

  // --- turn detection ---------------------------------------------------------

  function onGameLoaded() {
    const game = state.boundGame;
    if (!game) return;
    const mySide = safeGetPlayingAs(game);
    if (mySide == null) {
      log("no seat at this board (spectating/analysis) - ignoring");
      return;
    }
    const turn = safeGetTurn(game);
    log("game loaded/reset - playingAs:", mySide, "turn:", turn, "path:", isApplicablePath());
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
    } else {
      log("opponent moved:", move.san, "- my turn begins");
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
      }
    };
    const onCreateOrLoad = () => {
      try {
        onGameLoaded();
      } catch (err) {
        warn("error handling game load", err);
      }
    };

    game.on("Move", onMove);
    game.on("CreateGame", onCreateOrLoad);
    game.on("Load", onCreateOrLoad);

    state.unbindGame = () => {
      try {
        game.off("Move", onMove);
        game.off("CreateGame", onCreateOrLoad);
        game.off("Load", onCreateOrLoad);
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
