# Scenes band-motion contracts
Objective: bump the `scenes` submodule from CielScenes 935cf1b to 87dfae5 and update the CieLinux contract tests so they pass.
Branch: chore/scenes-band-motion. Delivery: single local branch, user pushes. Runner: `node --test --test-reporter=tap tests/`.

## Specs
- S1: "Actualiza los contratos primero y luego commitea": the contract tests that the bump breaks are updated to the new CielScenes content, then the bump and the test changes are committed.
- S2: Baseline: with 935cf1b, 10 tests already fail (explorer/idle/raphael pinned hashes, raphael O3/B5/mini glyph ring, W1, idle/explorer constellation scaling). With 87dfae5, 42 fail. The 32 new failures are this feature's scope. Assumption: the 10 baseline failures are reported, not fixed, unless the new content touches the same assertion.
- S3: The updated contracts still pin the new content (hashes, reference streams, optimization invariants). A test is dropped only when the feature it pins was removed upstream, and the reason is logged.

## Tasks
- T1 S2: map every new failure to its cause and its update (re-pin, rewrite, or obsolete). Route: delegated explorer (mapping trigger, 4k lines of tests). Status: done (L4, L5).
- T2 S1,S3: update the contracts. Route: inline. Status: done. 402/412 pass; the 10 failures are exactly the baseline ones (L7).
- T3 S1: bump commit plus test commit. Route: inline. Status: done (see git log on the branch).

## Log
- L1 (2026-11-07): "Actualiza el repo de CielScenes y actualiza el repo de CieLinux, haz commit y me avisas para hacer push"
- L2 (2026-11-07): "Actualiza los contratos primero y luego commitea"
- L3: CielScenes 935cf1b..87dfae5 changes processing (config, layers, main, scene-data, see-through-hook) and raphael (config, layers, see-through-hook, sprites).
- L4 (T1 done, explorer map): the 32 new failures are 16 in tests/*.mjs plus 16 in tests/native-processing/contract.test.mjs: OCTAGON_RADIUS_FACTOR is undefined and there is a new drawAtomicOrbitsFront stage. Most fixes are re-pins (see-through-hook 655155fe…, config/scene-data/layers), harness stubs, or obsolete references (orbit blocks, 3-band ellipse, wallpaper k scale, PERF-5 band shapes).
- L5: Two upstream scene regressions have no marked block. (1) miniFoldingBandGeometry lost its C1 cached trig: 343 cos per band instead of 85, plus 6 array allocations per point. (2) drawFoldingBandFront fills quads one by one in mini, so O2b is lost. Waiting on the user to decide: restore them in CielScenes, or accept them and rewrite the contracts.
- L6 (2026-11-07): "acepta la perdida y contratos a los numeros nuevos". Accepting the C1/O2b loss. Contracts get rewritten to the new counts.
- L7: Contracts updated:
  - Re-pins: see-through hook (2 files), config/scene-data/layers, and the stripped layers.
  - Native harness: stage drawAtomicOrbitsFront (18 stages, 5700 clock reads, row indices derived from the stage count), plus sceneViewZoom constants.
  - readiness: stub for drawAtomicOrbitsFront.
  - blur-free-glow: the reference skips the band and orbit layers.
  - processing-optimization:
    - removed band/orbit reference streams, the C1 scratch-reference test and the wallpaper k scale;
    - added contracts for the 343 cos/sin geometry cost, scratch reuse, back-pass single fill per band, front-pass fills, and the orbit block stream.
  - Checks: full `node --test tests/` gives 402 pass, 10 fail, all baseline. The native runner builds with -DCIELINUX_NATIVE_PROCESSING=ON.
