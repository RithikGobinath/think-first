# Think First

[![License: MIT](https://img.shields.io/badge/license-MIT-7fb069.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-7fb069.svg)](manifest.json)

A browser extension that locks the chess.com board for a few seconds at the
start of your turn, so reflex moves become impossible and you're forced to
actually calculate before you move.

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Install](#install)
- [Settings](#settings)
- [Architecture](#architecture)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

## Why

Blitz players (me included) tend to snap-move on autopilot instead of
checking for tactics. This extension removes the ability to move for a
short, configurable window at the start of each of your turns. It never
assists your play — it only takes capability away — and it gets out of your
way once your own clock runs low, so it won't cost you on time in a real
game.

## How it works

Chess.com's board component (`<wc-chess-board>`) exposes a `game` object
with a `setOptions({ enabled: false })` call — the same flag chess.com's own
UI uses to freeze the board. On each of your turns, the extension:

1. Flips that flag off the instant it becomes your move.
2. Dims the pieces (the board's own color and gradient are never touched)
   and shows a small countdown badge with a skip button next to your clock.
3. Flips the flag back on after your configured wait — or immediately if
   your own clock has dropped below a threshold you set, so the drill never
   costs you on time.
4. Flips it back on immediately (fails open) on resign, game over, mode
   change, tab close, or any unexpected error. A stuck lock is treated as a
   bug, not an acceptable tradeoff.

The opponent's move — yours or the engine's — always lands normally
regardless of lock state; only *your* input is ever blocked.

## Install

This extension isn't published to the Chrome Web Store; install it unpacked
from source.

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the repository folder.
5. Open a game on chess.com — `/play/computer` or a live game.
6. Click the toolbar icon to adjust settings.

## Settings

| Setting | Description |
|---|---|
| **Enabled** | Master on/off switch. |
| **Wait before you can move** | How long the board stays frozen at the start of each of your turns, in seconds. |
| **When my clock runs low** | *Skip the wait below threshold* turns the lockout off entirely once your clock drops under the threshold. *Shrink the wait as time drops* scales the wait down proportionally as your clock drains, with the same hard cutoff. |
| **Threshold** | The clock value, in seconds, that triggers the bypass above. |
| **Show a skip-wait button** | Toggles the on-board skip button. |
| **Apply against the computer / Apply in live games** | Scope the lockout to either or both surfaces independently. |
| **Skip-wait shortcut** | Keyboard shortcut to end the current lock early (default `Space`). Click the box and press a key to rebind; ignored while a chat/search box is focused. |
| **Piece grey-out intensity** *(Development)* | 0–100 tuning value for how strongly pieces dim during a lock. `0` disables dimming; `100` is the strongest allowed (still-readable 0.5 opacity). |

Locks served, skips, and total time spent thinking are tracked and displayed
in the popup.

## Architecture

```
manifest.json          MV3, two content scripts on https://www.chess.com/*
src/
  inject.js            world: MAIN  — board hook, lock engine, overlay, keybinding
  bridge.js            world: ISOLATED — chrome.storage <-> inject.js relay
  overlay.css           badge + pulse animation
  popup.html/js/css     settings UI
```

`inject.js` runs in the page's own JS context (`world: "MAIN"`) because
that's the only place `<wc-chess-board>`'s `game` object is reachable.
`chrome.storage` is the opposite — unreachable from a MAIN-world script — so
`bridge.js` runs isolated, owns storage, and the two talk over
`window.postMessage` with a namespaced `source` field.

## Known limitations

- **Clock reading is best-effort.** The extraction logic (`readClockFromApi`
  / `readClockFromDom` in `src/inject.js`) was built without access to a
  live timed game, so the exact shape of chess.com's clock data and DOM
  markup is unconfirmed. It fails closed to "untimed" (always locks) rather
  than misreading a value, but the clock-aware bypass may not fire correctly
  yet on a real timed game.
- **Premove cancellation during a lock is unverified**, for the same reason.

Both are tracked in
[#4](https://github.com/RithikGobinath/think-first/issues/4) — honest gaps,
not silent ones. The code degrades safely rather than guessing, and the
issue documents exactly what needs checking against a real account.

## Contributing

Issues and pull requests are welcome. There's no build step — the extension
is plain JS/HTML/CSS, loadable unpacked as-is. If you're fixing a bug,
include what you tested it against (which page, what you observed) in the
PR description; this project has been burned more than once by
un-verifiable assumptions about chess.com's DOM.

## License

MIT — see [LICENSE](LICENSE).
