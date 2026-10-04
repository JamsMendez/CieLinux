# wallpaper-explorer-idle-cpu

Locator: `CieLinux/odd/tasks/wallpaper-explorer-idle-cpu.md` · Engram mirror: `odd/wallpaper-explorer-idle-cpu/tasks`

## Objective

Cut CPU of the `explorer` (~99% of one core in btop) and `idle` (~70%) scenes in WALLPAPER
mode (3440x1440, scale 1, `frame-rate = 60`) without visible quality or fluidity loss.
Also make alerts (warning/failed) over explorer animate fluidly (user saw a slow warning).

## Constraints

- Wallpaper mode only; mini behaviour must not change.
- Visual parity: prior precedent is ≤1/255 channel error where feasible, otherwise user
  visual acceptance (geometry/halo/edge discrepancies rejected).
- Scene JS is compiled into qrc: every change needs a rebuild. Source hashes are pinned in
  tests; edits require re-pins.
- Known cost model (wallpaper-microstutters PERF-1..5): host CPU is Chromium's in-process
  GPU thread; Skia Ganesh draws AA path fills/strokes through CPU software masks, so many
  small arcs/strokes and blurs cost CPU; drawImage of cached sprites does not.
- No commits (user preference). No install until the user approves visually; the real
  service is restored after every measurement.

## Hotspots (explorer map, not profiled)

Shared: Earth per-pixel JS texture (~394² px) + putImageData every frame; 6 rotated ring
caches (~1.7k² each) + lighting mask drawImage; starfield 420 stars × up to 2 arcs with new
rgba strings; chroma fan 16 radial gradients + drawSpark gradients; vignette gradient +
full-screen fill per frame. Explorer only: drawBlueLayer (two full-screen blend fills,
`color` + `screen` with new radial gradient); rising sparks 360 × (6 strokes + 1 arc) ≈ 2.5k
`lighter` draw calls, no atlas/culling in wallpaper.

## Tasks

- [x] W0 Baseline (delegated measurer): explorer60, idle60, explorer60+warning alert; host/renderer CPU, CADENCE draw/s and gaps; captures.
- [x] W1 Optimize full variant of idle + explorer (delegated writer): sprite/atlas for stars and sparks, cached vignette/blue layer, other cacheable per-frame work; tests + re-pins; Release build.
- [x] W2 After measurement + visual comparison captures (delegated measurer), same protocol.
- [x] W3 Alerts fluidity check over explorer (part of W0/W2) and fix if alert-specific.

- [x] W4 Alerts reach 60 draw/s over explorer in wallpaper (delegated writer + ABAB measure): remaining per-frame overlay work (difference rails, intersections + see-through spark re-pass, failed backdrop copy/shake).

## Checks

- `node --test tests/*.test.mjs` (baseline: 307/311, 4 known hash-pin failures).
- Release build exit 0.
- Same measurement protocol before/after; service restored active.

## Delivery

No commits (user preference). Install only after user visual approval.

## Progress

- Explorer map done (wallpaper architecture, hotspots, build/run, processes, alert overlay).
- W0 baseline (binary f57cc7ec…, harness `scratchpad/wallperf/wallperf.py`, one pass each, noisy: other agents used CPU), % of one core t=10–110 s:
  | run | host | GPU thread | renderer | total | draw/s |
  | explorer@60 | 112.4 | 75.6 | 80.2 | 192.6 | 36.6 (steady 43–49) |
  | idle@60 | 56.0 | 32.9 | 91.6 | 147.6 | 59.1 |
  | explorer@60+alerts | 126.9 | 87.3 | 87.6 | 214.5 | 32.7 |
  Alert windows over explorer: 16–20 draw/s, host GPU thread saturated, renderer falls → overlay raster on host is the alert bottleneck. Idle cost is mostly renderer JS (Earth texture suspected).
- W1 (delegated writer): Earth loop fast path (gray single-channel, no modulo/Math.round, 32-bit writes; V8 18→7 ms/frame, byte-identical), alert overlay caches (wash, titles, pre-blurred 43 px letter shadow cached per size/theme/scale/title width; freed after alert), explorer full-variant spark sprites (two baked trail halves, energy within 0.07%; draw calls 15,064→6,506 over 7 samples; mature sparks only), cached vignette/blue glow gradients. Parity (software raster 3440x1440): idle identical; explorer mean 0.17–0.18 levels, max ≤153 on spark streaks only (sprites slightly softer at 8× zoom). Tests 325/325; Release build sha256 0bf0b4d0…. New tests/wallpaper-optimization.contract.test.mjs (14). Test-first deviation: RED observed after code via baseline copy. Captures: scratchpad/wallopt/.
- W2 ABAB (A=baseline f57cc7ec, B=W1 0bf0b4d0), 2 passes; pass 1 overlapped a node test run (contaminated). Total CPU % (draw/s):
  | run | A1 | B1 | A2 | B2 |
  | explorer | 200.7 (42.4) | 152.8 (58.5) | 250.1 (54.7) | 138.8 (59.8) |
  | idle | 109.3 (52.4) | 85.7 (59.9) | 106.5 (59.8) | 85.5 (59.9) |
  | explorer+alerts | 231.0 (45.3) | 150.7 (56.2) | 212.2 (52.2) | 151.5 (56.7) |
  Alert windows (10 s CADENCE): A 27–36 draw/s → B 44–52 draw/s. Service active after runs. Screenshots: scratchpad/wallperf/results/B1/*/shot-*.png.
- W3: alert fluidity improved (≈+60%) but alert windows still below 60 draw/s; remaining per-frame overlay work (difference rails, intersections with spark re-pass) is the next lever if needed.
- Installed 2026-10-04 at user request: service stopped, ~/.local/bin/cielinux replaced (f57cc7ec → 0bf0b4d0), service active, exe not deleted. Backup of old binary: scratchpad/wallperf/bin/baseline/. Pending: user live visual check; optional next step: alert overlay per-frame rails/intersections.
- W4 (delegated writer): spark layer drawn once and reused by the see-through letters (explorer, full variant), recolour/clip/stamp limited to title bands, side modules cached per 100 ms counter, no full-canvas backdrop copy for fully shown FAILED tiles. Op count explorer+warning 4889→2945, 2 tiles 6978→3039; parity max 3 levels, mean ≤0.0093. Tests 331/331; build-wall4 sha 8dcac5d7.
- W4 ABAB live (A=0bf0b4d0, B=8dcac5d7, 2 passes): explorer+alerts total 150.6/148.9 → 144.3/144.1 %, draw/s 56.4 → 59.6; alert windows 46–51 → 59–60 draw/s; explorer alone unchanged (~139–147 % at 59.8). Installed 2026-10-04 at user request (0bf0b4d0 → 8dcac5d7), service active; W1 binary kept at scratchpad/wallperf/bin/w1/.
