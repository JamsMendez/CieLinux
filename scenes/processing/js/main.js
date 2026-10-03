// Processing scene's reference layer order and progress, with the CielWin alert stage (A4).
var reportRenderError = createRenderStageReporter("[processing-scene]");

// Synthetic one-shot transport probes, not GPU failures or a readiness handshake.
// A missing/throwing console must not interrupt scene initialization.
try { console.info("CIELINUX_DIAGNOSTICS_JS_INFO synthetic transport probe"); } catch (_) {}
try { console.warn("CIELINUX_DIAGNOSTICS_JS_WARN synthetic transport probe"); } catch (_) {}
try { console.error("CIELINUX_DIAGNOSTICS_JS_ERROR synthetic transport probe"); } catch (_) {}

// Fixed storage, cumulative observational metrics; no scheduling authority.
function createCadence(scene) {
    const bounds = [8, 17, 34, 50, 100, 250, Infinity];
    const dt = [0, 0, 0, 0, 0, 0, 0], work = dt.slice();
    let raf = 0, eligible = 0, draw = 0, err = 0, workN = 0;
    let origin = null, last = null, latest = null, maxgap = 0;
    let boundary = 10000, periodic = 0, final = false;
    const valid = value => Number.isFinite(value) && value >= 0;
    function sample(bins, value) {
        if (valid(value)) bins[bounds.findIndex(bound => value <= bound)]++;
    }
    function now() {
        try { return performance.now(); } catch (_) { return NaN; }
    }
    function emit(kind) {
        if (origin === null || latest === null) return;
        const elapsed = Math.min(latest - origin, Number.MAX_SAFE_INTEGER);
        try {
            console.info(`CADENCE scene=${scene} kind=${kind} elapsed_ms=${Math.round(elapsed)} raf=${raf} eligible=${eligible} draw=${draw} err=${err} dt=[${dt}] work=[${work}] work_n=${workN} maxgap_ms=${Math.round(maxgap)}`);
        } catch (_) { /* Observation must not change rendering. */ }
    }
    const api = {
        entry(ms) {
            raf++;
            if (valid(ms) && (latest === null || ms >= latest)) {
                if (origin === null) origin = ms;
                latest = ms;
            }
        },
        begin() { eligible++; return now(); },
        error() { err++; },
        complete(ms) {
            draw++;
            if (valid(ms) && (last === null || ms >= last)) {
                if (last !== null) {
                    const gap = ms - last;
                    sample(dt, gap);
                    maxgap = Math.min(Math.max(maxgap, gap), Number.MAX_SAFE_INTEGER);
                }
                last = ms;
            }
        },
        end(start) {
            const end = now();
            if (valid(start) && valid(end) && end >= start) {
                sample(work, end - start); workN++;
            }
            if (!final && origin !== null && latest - origin >= boundary && periodic < 12) {
                periodic++;
                const elapsed = latest - origin;
                boundary = (Math.floor(elapsed / 10000) + 1) * 10000;
                if (boundary <= elapsed) boundary = Infinity;
                emit('periodic');
            }
        },
        finish() { if (!final) { final = true; emit('final'); } }
    };
    try {
        window.addEventListener('pagehide', api.finish);
        window.addEventListener('beforeunload', api.finish);
    } catch { /* Native shutdown need not deliver either event. */ }
    return api;
}
var cadence = createCadence('processing');
// Forward the native receiver/arguments/ID and callback receiver/arguments unchanged.
var nativeRequestAnimationFrame = window.requestAnimationFrame;
window.requestAnimationFrame = function (callback, ...args) {
  if (typeof callback !== 'function') {
    return Function.prototype.apply.call(nativeRequestAnimationFrame, this, arguments);
  }
  return Function.prototype.apply.call(nativeRequestAnimationFrame, this, [function (...callbackArgs) {
    cadence.entry(callbackArgs[0]);
    return Function.prototype.apply.call(callback, this, callbackArgs);
  }, ...args]);
};

function octagonPulse(ms) {
  const duration = OCTAGON_PULSE_DURATION * 1000;
  const elapsed = ms % (OCTAGON_PULSE_INTERVAL * 1000);
  if (elapsed <= 0 || elapsed >= duration) return 0;
  return Math.sin(Math.PI * elapsed / duration);
}

function animationProgress(ms) {
  return pingpong01((ms / 1000) / ONE_WAY_DURATION) * (ONE_WAY_DURATION / ANIMATION_CYCLE_DURATION);
}

var drawReadyAttempted = false;
function render(ms) {
  var cx = W * 0.505;
  var cy = H * 0.515;
  var workStart = cadence.begin();
  // Linux port begin (A4): the value the alert overlay's see-through hook needs (CielWin's `p = 0`).
  var alertSceneTime = 0;
  // Linux port end.
  try {
    // A4: shared/js/alert-overlay.js's alertSceneMs freezes the scene clock while a FAILED tile
    // shakes; otherwise it returns the rAF timestamp (minus earlier shakes). CielWin parity.
    const sceneMs = alertSceneMs(ms);
    renderNebula(sceneMs);
    const p = animationProgress(sceneMs);
    alertSceneTime = p;
    const phase = p * TAU;
    const pulse = octagonPulse(sceneMs);
    ensureSprites();
    ctx.clearRect(0, 0, W, H);
    const zoom = viewZoom;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom);
    ctx.translate(-cx, -cy);
    if (!isMiniVariant) {
      drawSoftOvalFields(cx, cy, phase);
      drawStars(cx, cy, p, phase);
      drawRadialStreaks(cx, cy, p);
      drawLensFlares(cx, cy, phase);
      drawChromaticSideLoops(phase);
    }
    drawSegmentedSphere(cx, cy, p);
    drawAtomicOrbits(cx, cy, p);
    drawOrbitBlocks(cx, cy, phase);
    drawCentralOctagon(cx, cy, p, pulse);
    drawTriangularPrism(cx, cy, p);
    drawPerspectiveRays(cx, cy, phase);
    drawCentralCore(cx, cy, phase);
    ctx.restore();
    if (!isMiniVariant) {
      drawFilmGrain(phase);
      drawVignette();
    } else {
      drawMiniSceneBase(ctx, cx, cy, Math.min(W, H) * 0.32, Math.min(W, H) * 0.40);
      applyMiniEdgeFade(ctx, W, H);
    }
    if (!drawReadyAttempted && W > 0 && H > 0) {
      drawReadyAttempted = true; // Attempt once even if the console throws.
      try { console.log('CIELINUX_SCENE_DRAW_READY_V1 processing'); } catch (_) {}
    }
    cadence.complete(ms);
  } catch (error) {
    cadence.error();
    resetCanvasStateForFrame();
    reportRenderError("scene", error);
  } finally {
    cadence.end(workStart);
  }
  // Linux port begin (A4): the shared alert overlay draws last, over the finished (edge-faded) scene,
  // in its own try so a failing overlay never stops the scene (CielWin parity). It gets the real
  // timestamp; the scene above drew with alertSceneMs's frozen clock while a FAILED tile shakes.
  try {
    renderAlertOverlay(ms, W, H, alertSceneTime);
  } catch (error) {
    resetCanvasStateForFrame();
    reportRenderError("alert-overlay", error);
  }
  // Linux port end.
  scheduleFrame(render);
}

initializeNebulaRenderer();
scheduleFrame(render);
