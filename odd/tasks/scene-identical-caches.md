# Scene identical gradient caches

## Objective
Lower per-frame cost of the Processing and Explorer wallpapers without changing their look or frame rate, starting with pixel-identical caches (group 1).

## Problem and why
Measured 2026-10-10 at 60 FPS (RTX 3060, 3440x1440): total CPU idle 94%, raphael 146%, explorer 152%, processing 161% of one core; all ~60 draws/s. Processing and Explorer rebuild gradients every frame that are constant or only differ by position/rotation; idle/explorer already cache their vignette.

## Scope and constraints
- In scope: `scenes/processing/js/layers.js` vignette cache and radial-streak gradients; `scenes/explorer/js/animate.js` chromatic glow radial gradients; matching contract tests in `tests/`.
- Out of scope: stars, orbit bands, film grain, explorer blue layer, sparks (group 2, need user visual approval); nebula resolution; CielWin copies; host C++.
- Preserve resolution/DPR, FPS/timing, RNG, draw order and visual output. Linux-only. No commits (OS workspace policy).
- User hard constraint (2026-10-10): no quality or smoothness loss; every element keeps its current look, explicitly the nebula (nebula.js untouched). Non-identical changes are reverted, not approximated.
- Prior evidence: caching gradients saves allocations, not full-area repaint, so gains may be modest; mocks do not prove pixels.

## Tasks
- [x] T1 — Processing: cache the vignette gradient per canvas size (`layers.js` ~1481). Route: delegated (writer, 2+ non-trivial files with tests).
  - Approach: `cachedVignetteGradient()` keyed by (ctx, W, H) inside a removable `// Linux mini optimization begin (SIC1)` block; `drawVignette` early-returns through it, the CielWin body stays below for the strip contract. W/H are CSS px and the gradient is user-space, so a DPR-only resize correctly keeps it.
  - Evidence: RED `processing wallpaper: vignette gradient is created once per canvas size, not per frame` (4 gradients vs 1 expected); GREEN after the change. Re-pinned `layers` hash in `tests/processing.contract.test.mjs` (was 580e69b2…, now cb30b3f8…); strip-to-CielWin hash test still passes.
  - Pixel check (headless Chromium, shipped function text vs original text, 5 frames each at 1920x1080@1, 3440x1440@1, 1280x720@2, 853.5x479.25@1.5, 240x240@1, software and GPU-flag runs): max channel diff 0, differing pixels 0.
- [ ] T2 — Processing: replace per-streak linear gradients with a cached unit gradient aligned by transform (`layers.js` ~674). Route: delegated (same writer). STOPPED, not implemented (not exactly expressible).
  - Why: CanvasGradient has no own transform, so a cached unit gradient needs translate/rotate/scale active at stroke time, which also changes how Skia strokes the line. Real-canvas check of that approach: max channel diff 6–10 (software) and 15–19 (GPU flags), 400–4300 px per size. Isolated with a solid colour (no gradient involved): stroking under translate·rotate·uniform-scale with compensated lineWidth alone differs by up to 9/255. Stops are invariant, but the stroke geometry is not reproducible under the transform. Building the path once and stroking 3 layers is identical (0/0) but saves no gradient.
- [ ] T3 — Explorer: cache the 16 chromatic glow radial gradients as unit gradients placed by transform (`animate.js` ~491). Route: delegated (same writer). STOPPED, not implemented (not exactly expressible).
  - Why: the centre stop alpha changes every frame (flow). Moving it to globalAlpha with a cached alpha-1 unit gradient differs by max 5–6/255 over up to ~1.3M px per size (isolated: globalAlpha substitution alone 5–6/255; unit radius + transform with the alpha kept in the stop only 1/255 over ≤33 px, but that still builds a gradient per frame).
  - Exact alternative, needs a decision (not done): cache gradients in the original geometry keyed by (ctx, W, H, sample index, alpha string). Output is identical by construction, but the cache only warms after one 9 s flow period and holds ~772 gradients (full) / ~2993 (mini, gain 4) — memory for a modest CPU saving.
- [ ] T4 — Pixel check old vs new for T1–T3 in a real browser canvas, reinstall, and re-measure Processing and Explorer at 60 FPS against the baseline.

- [ ] T5 — Investigate why Explorer's host main thread uses ~41% vs idle ~21% at 60 FPS (no visual impact). Read-only profiling first; fix only with user approval. Route: delegated (investigator).
  - Result: root cause found, no zero-visual fix in CieLinux. gdb sampling (40 samples): busy time is Qt WebEngine 6.11.2 compositor calling `glDeleteTextures(1, &tex)` once per frame, spin-waiting in libnvidia-eglcore (driver 610.57) until the GPU finishes; explorer's heavier GPU load lengthens the wait (~3.3 ms/frame). Qt Quick renders on the main thread (no QSGRenderThread). No explorer-specific host code or per-frame IPC/logging.
  - Tried: `__GL_YIELD=USLEEP` 39% vs 41% (moves to sys, no saving); `QSG_RENDER_LOOP=threaded` moves cost to render thread (no saving); `QSG_RHI_BACKEND=vulkan` saved ~31 pts on explorer but idle crashed with vkWaitForFences device loss — rejected. Only lever: lower explorer GPU load, which is blocked by the identical-output rule. Service verified active, single instance, no env overrides, settings cmp OK.

## Acceptance criteria
- Contract tests prove each gradient is created once per size/config, not per frame.
- Real-canvas pixel comparison old vs new: identical, or max channel diff reported and ≤1/255.
- Full suite passes serially (`node --test --test-concurrency=1 tests/*.test.mjs`).
- Re-measured CPU/GPU per scene recorded; no regression in draws/s.

## Progress
T1 done and verified (contract RED/GREEN, pixel diff 0). T2 and T3 stopped under the identical-output rule; originals untouched (no transform-based change shipped). Scratch harnesses live only in the session scratchpad.

T4 measurement (2026-10-10, Processing only; Explorer unchanged). Reinstalled with `./install.sh --no-hypr-binds --build-dir <scratch>` (rc 0; prior binary/unit/settings backed up to the scratchpad). Scenes are qrc-embedded (zstd): decompressing the installed binary yields `processing/js/layers.js` sha256 cb30b3f8… (= repo file); the previous binary held 580e69b2… (HEAD). Same method as the baseline (processing@60, 3440x1440, RTX 3060, 15 s warmup, 30 s per-thread CPU over the process tree, nvidia-smi every 2 s, CADENCE over 40 s), two windows after separate restarts:

| Metric | Baseline | T4 run 1 | T4 run 2 |
|---|---|---|---|
| Total CPU (% of one core) | 161.3 | 161.9 | 161.8 |
| Host GPU thread (Chrome_InProcGp) | 68.3 | 68.8 | 69.1 |
| Renderer JS (QtWebEngineProc) | 64.1 | 64.7 | 64.1 |
| Host main (cielinux) | 17.1 | 16.8 | 17.0 |
| NVIDIA util / power | 37.9% / 30.9 W | 37.7% / 30.8 W | 37.7% / 30.6 W |
| Draws/s | 59.9 | 59.8 | 59.9 |
| JS work ≤8 ms / 8–17 ms / 17–33 ms | 21.0 / 76.2 / 2.8% | 18.7 / 78.6 / 2.7% | 21.9 / 75.3 / 2.8% |
| maxgap | 67 ms | 83 ms | 67 ms |

Result: within noise. Every difference (≤0.8 pt CPU per thread, ≤0.2 W) is smaller than the run-to-run spread, and the ≤8 ms work bucket varies 18.7–21.9% between runs alone. The T1 vignette cache saves one gradient allocation per frame and does not show up in CPU, GPU or cadence; no regression in draws/s. The service was left active with the original settings (`cmp` equal).

## Status
**Closed 2026-10-10 by user.** T1 shipped and installed (identical, no measurable saving). T2/T3 stopped (not pixel-exact). T4 re-measure done (within noise). T5 root cause: NVIDIA glDeleteTextures spin inside Qt WebEngine, no safe zero-visual fix. T3 keyed-alpha cache not pursued.

## Learnings
- Pixel-identical caching cannot reduce cost here: the cost is rasterization (Processing stars and orbit bands, Explorer full-screen `color`-blend blue layer).
- Transform-placed unit gradients and globalAlpha substitution are not pixel-exact in Chromium (up to 19/255 and 6/255).
- Explorer's extra host main-thread CPU is a driver wait that scales with GPU load; Vulkan RHI crashed the idle scene.

## Next step
None. Reopen only if the user accepts near-identical changes approved by side-by-side comparison.
