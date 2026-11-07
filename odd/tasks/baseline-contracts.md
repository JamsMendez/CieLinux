# Baseline contracts
Objective: fix the 10 contract tests that already failed before the 87dfae5 bump.
Branch: fix/baseline-contracts. Delivery: single local branch, user pushes. Runner: `node --test --test-reporter=tap tests/`.

## Specs
- S1: "Arregla los 10 tests que fallaban". Targets:
  - explorer and idle byte-identical render files;
  - raphael scene render files and config B6/T3;
  - raphael-optimization 3, 8 and 12;
  - wallpaper-optimization W1 plus idle/explorer constellation scaling.
- S2: Each fix follows the upstream change that broke it: re-pin intended content, rewrite obsolete assertions, or report a real scene regression.

## Tasks
- T1 S1,S2: map each failure to the CielScenes bump that broke it. Route: inline bisect over the CieLinux bump commits. Status: done (L2).
- T2 S1: idle/explorer constellation scaling. Route: inline. Status: done. HIEROGLYPH_STROKE_PX was removed by d63351e (blackletter script) and the glyph-stroke checks were dropped.
- T3 S1,S2: the remaining failures. Route: inline. Status: done (L3).

## Log
- L1 (2026-11-07): "Arregla los 10 tests que fallaban"
- L2: bisect shows all 10 broke at CieLinux b9d20c5 (CielScenes 44eeee1..9df032d, blackletter script).
- L3: Fixes:
  - explorer/idle: re-pinned config, glyphs and rings.
  - W1: re-pinned stripped rings.js (W1 blocks unchanged upstream).
  - raphael: re-pinned 6 render files; the B6/T3 regex keeps the upstream MINI_STAR_MAX_BASE_RADIUS block, and the undone hash was re-pinned.
  - raphael-optimization:
    - the reference drawOutlineGlyphRing uses glyphRingSpriteAngle (1383eed);
    - mini stamps are pinned to one per script glyph (92 at 240 px, was >= 150);
    - re-pinned the O3-stripped layers/sprites hashes.
  - No scene regressions found: every change traces to an intended upstream feature.
  - Check: `node --test tests/` gives 412/412.
