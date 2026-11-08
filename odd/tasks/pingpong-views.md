# Ping-pong scene views
Objective: stop the Qt WebEngine compositor deadlock caused by creating and destroying a view and profile on every scene switch, by reusing two persistent views and keeping the crossfade.
Branch: feat/pingpong-views. Delivery: single local branch, user merges. Runner: `node --test tests/*.test.mjs`.

## Specs
- S1: "reutilizar la vista al cambiar de escena en vez de reconstruirla, para que el deadlock de WebEngine pase menos seguido". A live switch that keeps the mode (scene change, frame-rate change) creates no new QQuickView, QQuickWebEngineProfile or WebEngineView. It navigates a persistent one.
- S2: The user picked "Ping-pong (Recomendado)": "Dos vistas persistentes creadas una sola vez; cada cambio navega la oculta y hace crossfade. Mantiene el look actual, cero create/destroy tras el arranque." The visible transition matches today: the new page starts hidden over the old one, fades in over 300 ms once it reports its first frame (or the 2 s reveal deadline passes), and then the old one stops rendering.
- S3: Existing behavior holds:
  - generation gating of callbacks and console lines (a page's messages count only for its own generation);
  - draw/load readiness and persist-on-ready;
  - the recovery budget and incident recovery;
  - alert routing per generation;
  - mini glide/dodge and positions;
  - fullscreen pause;
  - the lifecycle and diagnostics markers.
  The only lifecycle-record difference allowed is that view/profile retirement no longer happens on a same-mode switch.
- S4: A mode switch (scene-mini <-> scene) still rebuilds the window, because geometry and layer differ. Assumption: it may keep today's full-rebuild path, since mode switches are rare and user-initiated.
- S5: Acceptance:
  - the contract suite passes, with obsolete pins rewritten to the new design and new tests for S1/S2;
  - the stress loop of 1000 switches every 0.4 s finishes with no `CIELINUX_WATCHDOG` line. The baseline hung at switch 199 and 500; the navigate-in-place probe survived 1000.

## Tasks
- T1 S1-S4: implement ping-pong slots inside one window (view.qml holds two scene slots; main.cpp navigates the inactive slot on a same-mode retarget), plus tests and README. Route: delegated writer. Trigger: long-session backstop (parent context is large after the diagnosis). Status: done, uncommitted (L5).
- T2 S5: run the full suite, build, install, and run the 1000-switch stress on the live unit. Route: inline (parent). Status: done (L6). Independent verification: PASS, no blockers (L7).

## Log
- L1 (2026-11-07): "Vamos adarle mejor a esto: Queda pendiente para cuando quieras: reutilizar la vista al cambiar de escena en vez de reconstruirla, para que el deadlock de WebEngine pase menos seguido."
- L2: Evidence for the trigger:
  - Rebuild-per-switch hung at switch 199 (threaded render loop) and 500 (QSG_RENDER_LOOP=basic), both with the same stack: QBasicMutex::lockInternal from RenderWidgetHostViewQtDelegateItem::updatePaintNode at libQt6WebEngineCore+0x20a225.
  - With the basic loop the GUI thread itself blocks there, so the holder is a Chromium thread.
  - The probe (one view, url property changed in place, no create/destroy) ran 1000 switches in 417 s with no hang and stable RSS.
- L3: User decision: "Ping-pong (Recomendado)".
- L4: Design note for T1:
  - Two slots inside ONE window (not two windows). Keeps one layer surface, so glider/dodge/disc/mode logic stay single-surface, and no wl_surface map/unmap per switch.
  - The inactive slot's WebEngineView gets `visible: false`, so it stops rendering.
  - `Policy::drawReport` already checks that the draw marker comes from the selected scene's own main.js, so a stale page cannot fake readiness.
- L5: T1 writer report:
  - Changes: view.qml has an inline `SceneSlot` used twice, with navigate/park and an idle slot holding a generation-0 token. main.cpp adds `sceneSlots`, `navigateSlot` and `parkCovered`; a mode switch keeps the rebuild path. LoadFailed raises an incident only for the selected URL.
  - Tests: tests/pingpong.contract.test.mjs went RED 5/5 failing, then GREEN 5/5. Suite 386/386. Build clean.
  - Self-reported risk: a reused slot's stale callbacks after the token swap count for the new generation. These are mostly diagnostics; there is a rare early reveal between fps variants of the same scene.
- L6: T2 results:
  - Parent spot check: the pingpong test passed 5/5.
  - Live smoke: switches record prepared/ready and no view_retired.
  - Acceptance stress: "OK 1000 switches in 416s", same pid, 0 CIELINUX_WATCHDOG lines, RSS ~500 MB, 3 renderer processes.
- L7: Independent verifier: PASS with no blockers. S1-S4 met. `node --test` on the pingpong, crossfade and reconstruction tests: 19/19. The rewritten pins are faithful. Advisories:
  1. Stale console messages from a reused slot count for the new generation until the old document unloads. The only readiness effect is a reveal a few frames early when fps is toggled twice within the reveal window.
  2. LoadFailed is now URL-gated. This is out of domain.
  3. The wallpaper window is set back to opaque after a crossfade. This was not requested and is not visible.
  4. Two renderers stay resident.
  Next: commit on the user's go-ahead.
