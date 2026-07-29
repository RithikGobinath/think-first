# Think First

A browser extension that locks the chess.com board for a few seconds at the
start of your turn, so reflex moves become impossible and you're forced to
actually calculate before you move.

## Why

Blitz players (me included) tend to snap-move on autopilot instead of
checking for tactics. This extension removes the ability to move for a short,
configurable window at the start of each of your turns. It never assists your
play — it only takes capability away — and it gets out of your way once your
own clock runs low, so it won't cost you on time in a real game.

## How it works

Chess.com's board component (`<wc-chess-board>`) exposes a `game` object with
a `setOptions({ enabled: false })` call that's the same flag chess.com's own
UI uses to freeze the board. On each of your turns, the extension:

1. Flips that flag off the instant it becomes your move
2. Shows a countdown overlay with an optional skip button
3. Flips it back on after your configured wait — or immediately if your own
   clock has dropped below a threshold you set, so the drill never costs you
   on time
4. Flips it back on immediately (fails open) on resign, game over, mode
   change, tab close, or any unexpected error — a stuck lock is treated as a
   bug, not an acceptable tradeoff

The opponent's move (yours or the engine's) always lands normally regardless
of lock state; only *your* input is ever blocked.

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions`, enable Developer mode.
3. Click "Load unpacked" and select the repo folder.
4. Open a game on chess.com — `/play/computer` or a live game.
5. Click the extension icon to adjust settings.

## Settings

- **Wait before you can move** — how long the board stays frozen at the start
  of each of your turns (3–30s).
- **When my clock runs low** — either skip the wait entirely below a
  threshold ("fixed"), or shrink it proportionally as your clock drains
  ("scaled"), with a hard cutoff at the same threshold either way.
- **Show a skip-wait button** — an on-board button to end the current lock
  early. Skips are counted, not hidden.
- **Apply against the computer / Apply in live games** — scope the lockout to
  either or both surfaces independently.

Locks served, skips, and total time spent thinking are tracked in the popup.

## Known limitations

- **Clock reading is best-effort.** The extraction logic was built without
  access to a live timed game (no logged-in test account), so the exact shape
  of chess.com's clock data and DOM markup is unconfirmed. It fails closed to
  "untimed" (always locks) rather than misreading a value, but the
  clock-aware bypass may not fire correctly yet on a real timed game. See
  [#4](https://github.com/RithikGobinath/think-first/issues/4).
- **Premove cancellation during a lock is unverified**, for the same reason —
  also tracked in [#4](https://github.com/RithikGobinath/think-first/issues/4).

Both are honest gaps, not silent ones — the code degrades safely rather than
guessing, and the issue documents exactly what needs checking against a real
account.

## License

MIT — see [LICENSE](LICENSE).
