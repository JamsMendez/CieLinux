# Alert title reach

## Objective
WARNING/FAILED alert letters reach each scene's reference ring as far as possible without touching it
and without stretching the glyphs vertically.

## Targets (user, 2026-10-06)
| Scene | Mini | Wallpaper |
|---|---|---|
| raphael | gold glyph ring (outer edge 1.55r incl. border) | hexadecagon |
| processing | octagon | octagon |
| explorer / idle | hieroglyph band between Greek ring and constellation ring (outer edge 0.437B) | same |

A small margin keeps letters off the target. If the full glyph cannot reach in mini, the mini window may
be widened (letters size from the tile width).

## Constraints
- No glyph stretching: the font size still comes from the frame width; only the reveal depth changes.
- Mosaic (more than one tile) keeps the reference reveal.
- No commits (user preference for ~/Documents/OS).

## Tasks
- [x] T1 Overlay: per-scene `sceneAlertTitleLimits(W, H)` hook; reveal depth clamped to the glyph ascent;
      clip bands follow the depth. Route: inline (one non-trivial file + small hooks).
- [x] T2 Scene hooks for raphael, processing, explorer, idle (mini + wallpaper).
- [x] T3 Verify renders (mini 240 and wallpaper 3440x1440) and contract tests.
- [ ] T4 Mini width decision if the full glyph cannot reach (pending user).

## Progress
- Headless CDP renders (scratchpad shot.mjs) used for visual checks.
- T1/T2 done: alert-overlay.js failureTitleLayout + sceneAlertTitleLimits hooks in each see-through-hook.js.
- Wallpaper 3440x1440: all four scenes reach their limit exactly (letters inner edge == limit), not touching.
- Mini 240: every target is deeper than the full glyph, so letters show whole and stop short. Width
  needed for WARNING (worst) to reach: raphael 361, processing 548, explorer/idle 423 (FAILED: 263/399/308).
- Changes are additive `// Linux port begin (R1)` blocks (overlay: helpers, drawFailureTitle branch, top-level
  W4 band wrapper; one block per see-through hook), never nested inside W1/W4 blocks (their lazy strip
  regexes would end at the inner end marker). Static cache key unchanged: limits are a pure function of W/H.
- Tests: new tests/alert-title-reach.contract.test.mjs; alerts block count 12 -> 15; stripW4 also strips R1;
  processing hook hash strips R1. Full suite: 363 pass, 0 fail (earth/sparks perf tests flake under load only).
- Committed on user request as e19b3c8 (feat/alert-title-reach), merged --no-ff into local `integration`
  with chore/output-loss-monitoring; both source branches deleted. RDD 4-lens review approved and
  acknowledged (advisory: no reveal floor, hooks not executed in tests, processing constants duplicated).
- Installed from `integration` (2026-10-06); cielinux + outputwatch services restarted and active.
- Bug (user, raphael only): the see-through ring under the letters used glyphs.js stroke glyphs, smaller and
  shaped differently from the real gold ring (outline-glyph sprites). Pre-existing, made visible by the deeper
  reach. Fixed with an R1 block in raphael/js/see-through-hook.js that stamps sprites.outlineGlyphsGold with
  drawOutlineGlyphRing geometry (fallback to strokes until baked) + test. Suite 364/0; reinstalled. RDD
  1-lens review approved and acknowledged. Uncommitted on `integration`.

## Next step
T4 mini width decision after the user tries the wallpaper live.
