"use strict";

// Local adapter for CielWin shared render-loop.js. The alert API and bridge live in
// ../shared/js/alert-overlay.js; this adapter only resets the shake after a failed frame (A4).
function resetCanvasStateForFrame() {
  // Linux port begin (A4): CielWin's reset also clears the failure shake transform.
  try { if (typeof applyFailureShake === "function") applyFailureShake(null); } catch (_) { /* ctx/canvas gone */ }
  // Linux port end.
  for (var i = 0; i < 16; i++) {
    try { ctx.restore(); } catch (_) { /* Empty stack or lost context. */ }
  }
  try { ctx.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0); } catch (_) {}
  try { ctx.globalAlpha = 1; } catch (_) {}
  try { ctx.globalCompositeOperation = "source-over"; } catch (_) {}
}

function createRenderStageReporter(logPrefix) {
  var lastMessageByStage = {};
  return function (stage, error) {
    var message = stage + ": " + (error && error.message ? error.message : String(error));
    if (lastMessageByStage[stage] === message) return;
    lastMessageByStage[stage] = message;
    console.error(logPrefix + " render frame failed (" + stage + ")", error);
  };
}

function readWallpaperFpsFromUrl() {
  try {
    return Number(new URLSearchParams(location.search).get("fps")) === 30 ? 30 : 60;
  } catch (_) { return 60; }
}

function readSceneVariantFromUrl() {
  try {
    var raw = String(location.search || "").replace(/^[#?]/, "") + "&" +
      String(location.hash || "").replace(/^[#?]/, "");
    return new URLSearchParams(raw).get("variant") === "mini" ? "mini" : "full";
  } catch (_) { return "full"; }
}

function miniRingBasis(W, H, ringRadiusFraction, discOuterRadiusFraction, minBasisPx) {
  const room = Math.min(W, H) * ringRadiusFraction;
  return Math.max(minBasisPx, room / discOuterRadiusFraction);
}

var wallpaperFrameIntervalMs = 1000 / readWallpaperFpsFromUrl();
var sceneVariant = readSceneVariantFromUrl();
var isMiniVariant = sceneVariant === "mini";
var MINI_EDGE_FADE_INNER = 0.41;
var MINI_EDGE_FADE_OUTER = 0.48;
var MINI_POLYGON_STROKE_PX = 0.75;
var MINI_SCENE_BASE_RGB = "1,4,10";
var MINI_SCENE_BASE_ALPHA = 0.9;

// Linux mini optimization begin (O1): both mask gradients are cached per (context, geometry) instead of
// being rebuilt every frame. A CanvasGradient is resolved in user space at fill time, and every caller
// fills it under the same per-frame base transform, so reusing it paints the same pixels.
var miniEdgeFadeCache = { context: null, width: -1, height: -1, gradient: null };
var miniSceneBaseCache = { context: null, cx: NaN, cy: NaN, solidRadius: NaN, falloffRadius: NaN, gradient: null };

function miniEdgeFadeGradient(context, width, height) {
  var cache = miniEdgeFadeCache;
  if (cache.context === context && cache.width === width && cache.height === height) return cache.gradient;
  var side = Math.min(width, height);
  var outerRadius = side * MINI_EDGE_FADE_OUTER;
  var cx = width / 2;
  var cy = height / 2;
  var mask = context.createRadialGradient(cx, cy, 0, cx, cy, outerRadius);
  var innerStop = MINI_EDGE_FADE_INNER / MINI_EDGE_FADE_OUTER;
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(innerStop, "rgba(0,0,0,1)");
  [[0.25, 0.84], [0.5, 0.5], [0.75, 0.16]].forEach(function (step) {
    mask.addColorStop(innerStop + (1 - innerStop) * step[0], "rgba(0,0,0," + step[1] + ")");
  });
  mask.addColorStop(1, "rgba(0,0,0,0)");
  miniEdgeFadeCache = { context: context, width: width, height: height, gradient: mask };
  return mask;
}

function miniSceneBaseGradient(context, cx, cy, solidRadius, falloffRadius) {
  var cache = miniSceneBaseCache;
  if (cache.context === context && cache.cx === cx && cache.cy === cy &&
      cache.solidRadius === solidRadius && cache.falloffRadius === falloffRadius) return cache.gradient;
  var fade = context.createRadialGradient(cx, cy, 0, cx, cy, falloffRadius);
  var solid = "rgba(" + MINI_SCENE_BASE_RGB + "," + MINI_SCENE_BASE_ALPHA + ")";
  fade.addColorStop(0, solid);
  fade.addColorStop(solidRadius / falloffRadius, solid);
  fade.addColorStop(1, "rgba(" + MINI_SCENE_BASE_RGB + ",0)");
  miniSceneBaseCache = { context: context, cx: cx, cy: cy, solidRadius: solidRadius,
    falloffRadius: falloffRadius, gradient: fade };
  return fade;
}

function applyMiniEdgeFade(context, width, height) {
  var mask = miniEdgeFadeGradient(context, width, height);
  context.save();
  context.globalCompositeOperation = "destination-in";
  context.fillStyle = mask;
  context.fillRect(0, 0, width, height);
  context.restore();
}

function drawMiniSceneBase(context, cx, cy, solidRadius, falloffRadius) {
  var fade = miniSceneBaseGradient(context, cx, cy, solidRadius, falloffRadius);
  context.save();
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = fade;
  context.beginPath();
  context.arc(cx, cy, falloffRadius, 0, Math.PI * 2);
  context.fill();
  context.restore();
}
// Linux mini optimization end.

if (isMiniVariant) {
  try { document.documentElement.classList.add("scene-mini"); } catch (_) {}
}

// Reference fixed-deadline scheduler: raw rAF timestamps, no catch-up bursts.
var wallpaperNextDueFrameTimeMs = null;
var WALLPAPER_FRAME_INTERVAL_EPSILON_MS = 1;
// Linux port begin (B2): CielWin's pause-scene-when-covered switch (shared/js/render-loop.js). The
// host posts {type:"pause"} while a fullscreen window covers the wallpaper's output and
// {type:"resume"} when uncovered (alert-overlay.js routes both here). While paused scheduleFrame
// arms no requestAnimationFrame at all and remembers the callbacks; resume re-arms each exactly
// once and resets the fps schedule. Scenes animate from the rAF timestamp, so they simply continue
// at the current time. The mini never pauses (the host never sends it; ignored here as well).
var wallpaperPaused = false;
var wallpaperHeldFrameCallbacks = [];
function holdFrameWhilePaused(callback) {
  if (wallpaperHeldFrameCallbacks.indexOf(callback) < 0) wallpaperHeldFrameCallbacks.push(callback);
}
function setWallpaperPaused(paused) {
  if (isMiniVariant) return;
  paused = paused === true;
  if (paused === wallpaperPaused) return;
  wallpaperPaused = paused;
  if (paused) return;
  wallpaperNextDueFrameTimeMs = null;
  var held = wallpaperHeldFrameCallbacks;
  wallpaperHeldFrameCallbacks = [];
  held.forEach(function (callback) { scheduleFrame(callback); });
}
// Linux port end.
function scheduleFrame(callback) {
  // Linux port begin (B2): see setWallpaperPaused.
  if (wallpaperPaused) {
    holdFrameWhilePaused(callback);
    return;
  }
  // Linux port end.
  window.requestAnimationFrame(function (frameTimeMs) {
    // Linux port begin (B2): the pause arrived while this frame was in flight.
    if (wallpaperPaused) {
      holdFrameWhilePaused(callback);
      return;
    }
    // Linux port end.
    if (wallpaperNextDueFrameTimeMs !== null &&
        frameTimeMs < wallpaperNextDueFrameTimeMs - WALLPAPER_FRAME_INTERVAL_EPSILON_MS) {
      scheduleFrame(callback);
      return;
    }
    if (wallpaperNextDueFrameTimeMs === null ||
        frameTimeMs - wallpaperNextDueFrameTimeMs >= wallpaperFrameIntervalMs) {
      wallpaperNextDueFrameTimeMs = frameTimeMs + wallpaperFrameIntervalMs;
    } else {
      wallpaperNextDueFrameTimeMs += wallpaperFrameIntervalMs;
    }
    callback(frameTimeMs);
  });
}
