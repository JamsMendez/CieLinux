# CieLinux scene optimizations and fixes: do they belong in CielWin?

CieLinux started from the CielWin scene pages (CielWin repository: `CielWin.App/Wallpaper/Web/`), then changed them for Linux.
This page lists every change that made the two diverge. For each one it explains why the change was made, and it recommends whether to port it to CielWin.

**Bottom line**

| Change | Port to CielWin? | Why |
|---|---|---|
| NEB-1: nebula shader `highp` | **Yes, cheap insurance** | One line per scene. No effect on Windows today. It prevents the same bug on any GPU or driver that runs `mediump` as fp16. |
| PERF-5: baked glows instead of per-frame `shadowBlur` | **Measure first** | Big win on Linux. On Windows the cost depends on how Skia rasterizes blur masks on D3D. Port it only if CielWin shows the same draw-rate ceiling. |
| O1–O3 / B5: earlier mini and wallpaper optimizations | **Optional** | They were driven by QtWebEngine memory and CPU. Port them only if WebView2 shows the same profile. |
| H1: held warning API (`duration: 0`, `ok id=<n>`, `/v1/alerts/clear`) | **Yes, for API parity** | Callers (the claude-cielinux plugin) use it to keep a warning up while a question waits. Until CielWin has it, they fall back to a timed warning on its `400`. |

## 1. NEB-1: nebula clouds missing (correctness)

**Symptom.** On Linux the nebula showed only thin spiral arms. The clouds and blobs that move with the spiral on Windows were missing (reference screenshots from CosmicWin, kept outside this repository as `Nebulosa-1..3.png`).

**Root cause.** On Mesa radeonsi (Renoir, Mesa 26.2.2, ANGLE→GL), WebGL `mediump` is fp16. `getShaderPrecisionFormat` reports `MEDIUM=10/15` and `HIGH=23/127`. The nebula value-noise hash computes `fract(sin(dot(p, …)) * 43758.5453)`, and that overflows the fp16 range (about 2^15). As a result `noise`/`fbm` collapse, and everything driven by them collapses too: the warp, breaks, gap mask, inner void and gold wisps. Only the analytic spiral term survives.

**Fix.** Both `nebula.js` files now start the fragment shader with `precision highp float;`. Commit `bc66a34`. Test: `tests/nebula-precision.contract.test.mjs`.

**CielWin today.** Both scenes still declare `precision mediump float;`:
- `processing/js/nebula.js:20`
- `raphael/js/nebula.js:22`

WebView2 uses ANGLE→D3D11, which runs `mediump` at fp32, so Windows renders correctly. That is why it looked right in CosmicWin.

**Recommendation: port it.** The change is one line in each of the two files. The only risk is a GPU without fragment `highp`, which is optional in WebGL 1 but present on every desktop GPU. If you want to be strict about that, guard it with `#ifdef GL_FRAGMENT_PRECISION_HIGH`. CielWin's own scene tests and hashes will need re-pinning after the change.

## 2. PERF-5: per-frame `shadowBlur` was the microstutter

**Symptom.** Processing and Raphael shook at both 30 and 60 FPS: Processing drew about 27 times per second and Raphael about 33, with frame gaps up to about 100 ms, at 3440x1440.

**Root cause.** The full wallpaper set a canvas `shadowBlur` 15 times per frame: the rays and spokes, the band outlines, the octagon/hexadecagon, the core discs and the Raphael counter panels. For complex paths, Skia/Ganesh builds blurred masks in software (`GrBlurUtils → SoftwarePathRenderer → GrSWMaskHelper`) on the Chromium GPU thread, and that work was CPU-bound. The measurements:
- **Upper bound:** every blur forced to 0 → both scenes reach the 60 FPS cap.
- **Per-frame `ctx.filter` blur as a replacement → slower,** 5–22 draws/s depending on the variant. Any blur recomputed every frame at full resolution is too expensive on this iGPU.

**Fix.** Each glow is baked once from the original canvas shadow: the shape is drawn off-bitmap and the shadow is brought back with `shadowOffsetX`, so the result is the exact canvas shadow. Each frame stamps that baked glow under the unshadowed shape. Commit `dcc933b`.

| Glow | How it is baked and stamped |
|---|---|
| Rays and spokes | One line-glow bitmap per style, stamped per segment as two end caps plus a stretched middle |
| Band outlines | The same line-glow bitmap, stamped along each outline segment |
| Octagon / hexadecagon | 9 baked pulse levels, rotated with the shape and blended between the two nearest levels |
| Core discs | Baked in 3% blur-to-radius steps |
| Raphael counter panels | One static bake per size |

Caches rebuild on resize. The mini variant is unchanged.

**Result.** Native ABBA at 3440x1440, 60 FPS cap:
- Processing: 26.8 → 60.0 draws/s.
- Raphael: 32.8 → 58.6–59.8 draws/s.
- Worst-case frame gap (p99): about 64–86 ms → about 30 ms.
- Both scenes hold 30.0 draws/s at the 30 FPS cap.
- The user approved the visual result live.

**Known visual differences.** These come from software-rendered captures:
- Mean error is 0.2–0.3 levels.
- Near the core, overlapping ray glows add up instead of merging into one union.
- At the pulse peak, the polygon glow ignores the small stroke wobble.

**CielWin.**
- Both scenes still have the per-frame `shadowBlur` calls: 5 assignments in `processing/js/layers.js` and 8 in `raphael/js/layers.js`.
- On Windows, WebView2's Skia runs on D3D. Software blur masks may be cheaper there, or not used at all. CosmicWin looked smooth to the user, but no draw-rate measurement exists.

**Recommendation: measure before porting.**
- Read the scene's `CADENCE`-style draw rate in CielWin at the user's resolution and at 60 FPS.
- If it is far below the cap, or the Edge/WebView2 GPU process is CPU-bound, port the bake-and-stamp helpers. Copy `scenes/<scene>/js/sprites.js` and `layers.js` from this repository, but only the PERF-5 blocks.
- If CielWin already holds 60, skip it: the port adds code and accepts small visual differences for no gain.

## 3. Earlier Linux-only optimizations (context)

These came before this session. They are documented in the CosmicLinux workspace task logs `mini-scene-optimization.md` (O0–O5) and `cosmiclinux-scenes-app.md` (B5), which live outside this repository.
- **O1–O3:** mini-window CPU and memory work for idle/explorer, processing and raphael:
  - shared earth/rings code;
  - per-frame alpha lookup tables;
  - one fill per folding band;
  - cached gradients;
  - a baked glyph ring.
- **B5:** applies those mini optimizations to the full wallpaper wherever the output is identical. Visual skips stay mini-only.

They exist because QtWebEngine on Linux showed high renderer memory (about 0.8–1 GB) and high CPU in the 240x240 mini window. Port them to CielWin only if WebView2 shows the same profile.

## 4. H1: held warning (HTTP alert API)

**What changed.** CieLinux extends the alert API it shares with CielWin (see the README's *Held warning*):
- `POST /v1/alerts` accepts `"duration": 0` with `warning` only (held until cleared); `duration: 0` with any `failed` answers `400 error: 'duration:0' requires warning only`.
- An accepted alert answers `202 ok id=<n>` (`n` grows per run); an ignored (busy) request still answers plain `202 ok`.
- New route `POST /v1/alerts/clear`, same checks, body at most 64 bytes: `{}` clears the held alert, `{"id": n}` clears that alert; always `202 ok`.
- A failed request preempts a held warning, which resumes afterwards (same id, no second sound); a held request during a timed alert waits for it.
- Safety max `alert-hold-max-seconds` (default 600), counted from the request, not from the start.
- H4: while a held warning shows (not suspended, waiting or covered), its warning sound repeats every 5 s (`AlertDriver::heldWarningRepeatMs`, emitted as `alertRepeated` on the existing tick, restarting from each show or resume); timed alerts still play once. Port it to `AlertDriver.cs` with the H4 driver tests.

**CielWin today.** None of this: `duration: 0` is a `400` (`must be 1..60 seconds`), `/v1/alerts/clear` is a `404`, and replies are exactly `ok`.

**Recommendation: port it** to `AlertCommandParser.cs`, `AlertQueue.cs`, `AlertHttpProtocol.cs`, `LocalHttpCommandServer.cs` and `AlertDriver.cs`, mirroring `src/alerts.cpp` and `src/http-server.cpp` and their H1 contract tests. Check any CielWin caller that compares the reply body to exactly `ok`.

## Porting checklist (if you decide to port)

1. Take the blocks marked `Linux mini optimization` and PERF-5 from `scenes/<scene>/js/`. The CieLinux tests strip those blocks to recover the CielWin bytes, which keeps the scope clear.
2. Re-pin the CielWin scene hashes and tests. Then update the "CielWin reference" pins in `tests/processing.contract.test.mjs` and `tests/raphael.contract.test.mjs`, because those pins describe CielWin.
3. Confirm the look visually on Windows, at both 30 and 60 FPS, and in mini.

## Evidence

- Feature log: `odd/tasks/wallpaper-microstutters.md` (PERF-1…PERF-5, NEB-1).
- Measurements: `/tmp/cielinux-perf3.*`, `/tmp/cielinux-perf4.*`, `/tmp/cielinux-perf5.*`. These are scratch directories and will not survive a reboot.
