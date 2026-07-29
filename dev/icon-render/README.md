# Icon regeneration

`icon16.html` / `icon48.html` / `icon128.html` each just size an `<img>` at
`../../icons/icon-source.svg` to fill the page exactly. To regenerate the
PNGs after editing `icons/icon-source.svg`, serve the repo root (e.g.
`python -m http.server 4174`) and run headless Chromium/Edge against each
page at the matching window size:

```bash
EDGE="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
cd icons
"$EDGE" --headless --disable-gpu --hide-scrollbars --window-size=16,16  --screenshot="$(pwd)/icon16.png"  "http://localhost:4174/dev/icon-render/icon16.html"
"$EDGE" --headless --disable-gpu --hide-scrollbars --window-size=48,48  --screenshot="$(pwd)/icon48.png"  "http://localhost:4174/dev/icon-render/icon48.html"
"$EDGE" --headless --disable-gpu --hide-scrollbars --window-size=128,128 --screenshot="$(pwd)/icon128.png" "http://localhost:4174/dev/icon-render/icon128.html"
```

Screenshotting straight to disk avoids passing large base64 image data
through anything else — that path turned out to reliably corrupt PNG bytes
(CRC failures on the `IDAT` chunk) somewhere in transit, even though the
same data verified correctly inside the browser before being extracted.
