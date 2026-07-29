// Runs in the MAIN world on chess.com. Owns the board hook and the lockout
// engine. Talks to bridge.js (isolated world) over window.postMessage since
// chrome.storage isn't reachable from MAIN world content scripts.
(function () {
  "use strict";

  console.log("[Think First] inject.js loaded");
})();
