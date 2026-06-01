# Hero GIF source

`../pi-gateway-hero.gif` (the README hero) is rendered from [`index.html`](index.html) — a
self-contained [hyperframes](https://hyperframes.heygen.com) composition. The dark theme uses the
[`@vllnt/ui`](https://www.npmjs.com/package/@vllnt/ui) monochrome design tokens
(`--background`/`--card`/`--border`/`--foreground`/`--ring`, `.dark` variant).

`index.html` is the single source — no build step, no npm deps (GSAP loads from a CDN and is inlined
by the renderer at render time). Edit it, then regenerate.

## Regenerate

Requirements: Node.js >= 22 and FFmpeg. The hyperframes CLI is invoked via `npx` (downloads a
headless Chrome shell on first run).

```bash
# from this directory (assets/hero/)
npx hyperframes lint                      # must be 0 errors, 0 warnings
npx hyperframes render -o final.mp4 -q high -f 30

# MP4 -> palette-optimized 1200x675 looping GIF (20 fps for smooth data-flow packets)
ffmpeg -i final.mp4 \
  -vf "fps=20,scale=1200:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" \
  -y palette.png
ffmpeg -i final.mp4 -i palette.png \
  -lavfi "fps=20,scale=1200:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 -y ../pi-gateway-hero.gif
```

## Composition notes

- 1920x1080 design, 9.2s, fades from/to black for a seamless loop.
- Animated request flow: glowing packets travel client -> gateway -> pi.dev, then the provider grid
  ripples as pi.dev dispatches; directional arrowheads mark each hop. Packet motion is plain GSAP
  `x`/`y` tweens (the only renderer-supported transform props), looped as explicit positioned tweens
  (no `repeat`/`yoyo`) so every frame seeks deterministically.
- Every timed element carries `class="clip"` + `data-start`/`data-duration`/`data-track-index`; the
  GSAP timeline is paused and registered on `window.__timelines["main"]` (the hyperframes contract).
- Deterministic only — no clock/random/network — so the renderer can seek frame-by-frame.
