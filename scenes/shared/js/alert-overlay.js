"use strict";

// html-wallpaper-demo D6a: the alert layer, extracted here from
// CielWin.App/Wallpaper/Web/processing/js/alert-overlay.js (D2/D2b) so every scene page can share
// ONE implementation instead of forking it per scene. Re-driven by the SAME external contract
// CielWin.App/Alerts/Web/alert-layer.js exposes to WebViewAlertLayerController.cs: the same hash
// parameters (tiles=/columns=/rows=/gap=/duration=/work=, and the old kind=/duration= form) and the
// same two web messages ({type:"show",...}/{type:"hide"} in, "ready"/"done" out).
//
// Unlike alert-layer.js (a separate, transparent WebView2 page composited ABOVE the video, which can
// only draw a COPY of the band geometry), every scene page loading this file draws directly into the
// SAME canvas/ctx the scene itself uses, from inside the SAME render loop (each scene's own render
// loop calls renderAlertOverlay() last every frame) -- so what shows through the FAILED/WARNING
// letters is that scene's own real animation, not a copy.
//
// The ONE scene-specific piece -- "what draws behind the letters" -- is a HOOK: each scene defines
// its own `sceneSeeThroughLayer(g, sceneW, sceneH, sceneTime)` function (see e.g.
// CielWin.App/Wallpaper/Web/processing/js/see-through-hook.js and
// CielWin.App/Wallpaper/Web/explorer/js/see-through-hook.js), loaded before this file, which draws
// whatever the scene wants seen through the letters for ONE tile into the offscreen context `g` this
// file passes in: `g` is already translated so the scene's own (0,0) origin lands at that tile's own
// position, and the scene's own W/H globals are ALREADY set to sceneW/sceneH for the duration of the
// call (see drawSeeThroughIntersections below) -- the hook only needs to draw in ordinary scene
// coordinates, exactly as the scene's own render loop would. The hook does not need to pick a color:
// this file recolors whatever opaque shape the hook drew to the alert's own color (blue failed
// rgb(0,160,196), violet warning rgb(88,40,196)) via a 'source-in' composite (preserves the hook's
// own alpha shape, replaces its RGB), THEN clips it to the letters via 'destination-in' -- see
// drawSeeThroughIntersections.
//
// Mosaic tiles still size their own wash/letters/modules against THEIR OWN width/height, exactly like
// alert-layer.js's renderTile does (temporarily repurposing the shared W/H globals) -- but the
// see-through hook must NOT use tile-local W/H for anything meant to stay scaled to the whole scene
// (processing's hook restores the scene's true W/H before computing its own band geometry, for
// exactly this reason -- see that file's own remarks). drawSeeThroughIntersections restores the
// scene's W/H just for the hook's own call (see the sceneW/sceneH save/restore below) and translates
// by this tile's own origin offset -- since a scene-wide effect (processing's bands, explorer's
// sparks) is centered/positioned on the whole screen, a tile only shows whichever part of it actually
// crosses that tile, exactly as the feature doc's "Coverage caveat" describes.
//
// FAILURE_SHAKE_MS/FAILURE_REVEAL_MS/FAILURE_OVERLAY_THEMES/etc. below moved here from
// CielWin.App/Wallpaper/Web/processing/js/config.js (D6a): they are alert-overlay tuning, not
// processing scene tuning, and D6a's own decisions ("The alert layer on explorer must use the same
// shake/reveal/modules/wash as processing") mean every scene must share the exact same values, not a
// per-scene copy -- also a JS-syntax requirement, since two scripts in the same page cannot both
// declare the same top-level `const` name.

var FAILURE_TITLE_FONT = '"Archivo Black", "Arial Black", "Helvetica Neue", sans-serif';
// Fetch the title face up front; the canvas falls back to Arial Black until it arrives.
if (typeof document !== "undefined" && document.fonts && document.fonts.load) {
  document.fonts.load("400 64px " + FAILURE_TITLE_FONT).catch(function () {});
}

const FAILURE_SHAKE_MS = 230;
const FAILURE_REVEAL_MS = 700;
const FAILURE_REVEAL_MAX_CELL = 48; // largest pixel block (device px) at the start of the reveal
const FAILURE_COUNTER_STEP_MS = 100; // module counter ticks 0..99, then wraps
const FAILURE_REVEAL_LINE_SHARE = 0.25; // first part of the reveal: the horizontal line spreads across the width
const FAILURE_BACKDROP_CELL = 2.5; // CSS px: slight pixelation of everything seen behind the failed layer

const FAILURE_OVERLAY_BITS = '0100010101010010010100100100111101010010'; // FAILED
const WARNING_OVERLAY_BITS = '01010111010000010101001001001110010010010100111001000111'; // WARNING

// Failed (mosaic "failed" tiles) and warning (mosaic "warning" tiles) share one layer design; only
// these values differ. The warning skips the freeze/shake and never pixelates the animation behind it.
const FAILURE_OVERLAY_THEMES = {
  failed: {
    title: 'FAILED',
    bits: FAILURE_OVERLAY_BITS,
    wash: 'rgba(196,12,30,0.52)',
    letters: 'rgb(112,0,16)',
    intersections: 'rgb(0,160,196)',
    shakeMs: FAILURE_SHAKE_MS,
    pixelateBackdrop: true,
  },
  warning: {
    title: 'WARNING',
    bits: WARNING_OVERLAY_BITS,
    wash: 'rgba(255,200,20,0.58)',
    letters: 'rgb(150,96,0)',
    // Violet is the complement of the amber wash, so the bands stay readable through it.
    intersections: 'rgb(88,40,196)',
    shakeMs: 0,
    pixelateBackdrop: false,
  },
};

// Linux port begin (A4): CieLinux keys the mini window by luminance (src/lumakey.frag: alpha =
// max(r,g,b)), so a dark color becomes see-through instead of dark. The wash keeps working (about
// the same coverage as CielWin's rgba alpha), but the dark letters would key to the same coverage
// as the wash around them and vanish. Under the key the letters keep their CielWin hue at full
// brightness (each channel scaled so the largest is 255): opaque letters over the translucent wash.
// The full-size (unkeyed) page keeps the CielWin letters unchanged.
FAILURE_OVERLAY_THEMES.failed.keyedLetters = 'rgb(255,0,36)'; // rgb(112,0,16) * 255/112
FAILURE_OVERLAY_THEMES.warning.keyedLetters = 'rgb(255,163,0)'; // rgb(150,96,0) * 255/150
function lumaKeyedAlertLetters() {
  // isMiniVariant comes from the scene's render-loop.js, loaded after this file and read per frame.
  return typeof isMiniVariant !== "undefined" && isMiniVariant === true;
}
// Linux port end.

// Offscreen layers, tile-sized (device pixels) except 'backdrop' which is captured ONCE per frame at
// the FULL canvas size (see captureBackdropIfNeeded) -- source's slot numbering (0 letters,
// 1 intersections, 2 full overlay, 3 backdrop pixels, 4 backdrop, 5 overlay pixels) is kept as
// string keys here since a mosaic frame can have a FAILED tile and a WARNING tile revealing at once,
// each needing its own 'overlay'/'overlayPixels' buffer (see renderAlertTile/drawFailureLayer).
var failureLayers = {};

function failureLayer(slot, pixelWidth, pixelHeight, sceneTransform) {
  if (sceneTransform === undefined) sceneTransform = true;
  if (!failureLayers[slot]) {
    var layer = document.createElement("canvas");
    failureLayers[slot] = { canvas: layer, g: layer.getContext("2d") };
  }
  var entry = failureLayers[slot];
  if (entry.canvas.width !== pixelWidth || entry.canvas.height !== pixelHeight) {
    entry.canvas.width = pixelWidth;
    entry.canvas.height = pixelHeight;
  }
  entry.g.setTransform(1, 0, 0, 1, 0, 0);
  entry.g.globalCompositeOperation = "source-over";
  entry.g.globalAlpha = 1;
  entry.g.clearRect(0, 0, pixelWidth, pixelHeight);
  if (sceneTransform) entry.g.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0);
  return entry.g;
}

// ---- Title / wash / modules: tile-local, unchanged from the source overlay ---------------------
// These three read the shared W/H globals directly, exactly like the source page did -- renderAlertTile
// temporarily repurposes W/H to the CURRENT TILE's own CSS size before calling into drawFailureOverlay,
// the same technique alert-layer.js's renderTile already uses for its own mosaic.

function drawFailureTitle(g, frame, title) {
  g.font = "400 100px " + FAILURE_TITLE_FONT;
  var fontSize = 100 * (frame.w * 0.97) / Math.max(1, g.measureText(title).width);
  var capHeight = fontSize * 0.72;
  g.font = "400 " + fontSize + "px " + FAILURE_TITLE_FONT;
  g.textAlign = "center";
  g.textBaseline = "alphabetic";

  g.save();
  g.beginPath();
  g.rect(frame.x, frame.y, frame.w, H * 0.23);
  g.clip();
  g.translate(0, frame.y - capHeight * 0.42);
  g.scale(1, -1);
  g.fillText(title, W * 0.5, 0);
  g.restore();

  g.save();
  g.beginPath();
  g.rect(frame.x, frame.y + frame.h - H * 0.23, frame.w, H * 0.23);
  g.clip();
  g.fillText(title, W * 0.5, frame.y + frame.h + capHeight * 0.42);
  g.restore();
}

function failureRails(frame) {
  var railH = Math.max(6, H * 0.012);
  var rails = [];
  var railYs = [frame.y * 0.72, frame.y + frame.h + (H - frame.y - frame.h) * 0.28];
  var spans = [[0.09, 0.35], [0.65, 0.91]];
  for (var i = 0; i < railYs.length; i++) {
    for (var j = 0; j < spans.length; j++) {
      var from = spans[j][0], to = spans[j][1];
      rails.push([W * from, railYs[i] - railH * 0.5, W * (to - from), railH]);
    }
  }
  return rails;
}

function drawFailureModules(g, frame, counter, overlayBits) {
  var minD = Math.min(W, H);
  var boxW = Math.max(16, W * 0.018);
  var gap = H * 0.012;
  var pad = boxW * 0.35;
  var longestLabel = "00:99 " + overlayBits.slice(0, 8);

  g.font = "700 100px ui-monospace, SFMono-Regular, Consolas, monospace";
  var labelPerPx = g.measureText(longestLabel).width / 100;
  var digitSize = Math.min(boxW * 0.62, (frame.h * 0.92 - gap * 3) / 4 / labelPerPx - pad * 2 / labelPerPx);
  var boxH = labelPerPx * digitSize + pad * 2;
  var stackTop = H * 0.5 - (boxH * 4 + gap * 3) * 0.5;

  g.lineWidth = Math.max(1, minD * 0.0018);
  g.font = "700 " + digitSize + "px ui-monospace, SFMono-Regular, Consolas, monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";

  var columns = [frame.x * 0.62, frame.x + frame.w + (W - frame.x - frame.w) * 0.38];
  for (var column = 0; column < columns.length; column++) {
    var centerX = columns[column];
    for (var box = 0; box < 4; box++) {
      var x = centerX - boxW * 0.5;
      var y = stackTop + box * (boxH + gap);
      g.fillStyle = "rgb(8,10,22)";
      g.fillRect(x, y, boxW, boxH);
      g.strokeStyle = "rgba(170,190,235,0.85)";
      g.strokeRect(x, y, boxW, boxH);
      var bitOffset = (column * 4 + box) * 8;
      var bits = "";
      for (var i = 0; i < 8; i++) {
        bits += overlayBits[(bitOffset + i) % overlayBits.length];
      }
      g.save();
      g.translate(centerX, y + boxH * 0.5);
      g.rotate(column === 0 ? -Math.PI / 2 : Math.PI / 2);
      g.fillStyle = "rgb(210,220,255)";
      g.fillText("00:" + counter + " " + bits, 0, 0);
      g.restore();
    }
  }
}

// ---- See-through layer: SCENE coordinates, not tile-local (html-wallpaper-demo D2, generalized
// D6a) -- tileOffsetX/tileOffsetY is where the scene's own (0,0) origin lands within the CURRENT
// TILE's own device-pixel buffer (== -tile.x, -tile.y in CSS px); sceneW/sceneH are the scene's true
// CSS size, saved by the caller (renderAlertTile) BEFORE it repurposed W/H for this tile's own
// title/wash/modules layout. Delegates the actual drawing to the scene's own
// `sceneSeeThroughLayer(g, sceneW, sceneH, sceneTime)` hook (see this file's own header remarks),
// then recolors whatever opaque shape it drew to `color` via 'source-in' (preserves the hook's own
// alpha shape, replaces its RGB -- the hook does not need to pick a color) and clips the result to
// the letters via 'destination-in'.
function drawSeeThroughIntersections(g, letters, tileOffsetX, tileOffsetY, sceneW, sceneH, sceneTime, color) {
  var tileW = W, tileH = H;
  W = sceneW;
  H = sceneH;
  // D6a fix (R3-hook-throw-leaves-offscreen-save): g.restore() used to be the LAST statement inside
  // the try block, so a throwing hook skipped it, leaving this save() unbalanced on `g`'s own state
  // stack. It now runs in the finally, alongside the W/H restore, so it always pairs with the save()
  // above regardless of whether the hook throws -- the throw itself still propagates to the caller
  // (the scene's own "alert-overlay" render stage is what actually reports it).
  g.save();
  try {
    g.translate(tileOffsetX, tileOffsetY);
    sceneSeeThroughLayer(g, sceneW, sceneH, sceneTime);
  } finally {
    g.restore();
    W = tileW;
    H = tileH;
  }
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = color;
  g.fillRect(0, 0, letters.width, letters.height);
  g.globalCompositeOperation = "destination-in";
  g.drawImage(letters, 0, 0);
  g.restore();
}

function drawFailureOverlay(g, tileOffsetX, tileOffsetY, sceneW, sceneH, sceneTime, counter, theme, tileDeviceW, tileDeviceH) {
  var minD = Math.min(W, H);
  var frame = { x: W * 0.038, y: H * 0.064 };
  frame.w = W - frame.x * 2;
  frame.h = H - frame.y * 2;
  var rails = failureRails(frame);

  g.save();
  g.beginPath();
  g.rect(0, 0, W, H);
  for (var i = 0; i < rails.length; i++) g.rect(rails[i][0], rails[i][1], rails[i][2], rails[i][3]);
  g.fillStyle = theme.wash;
  g.fill("evenodd");
  g.save();
  g.globalCompositeOperation = "difference";
  g.fillStyle = "rgba(255,255,255,0.9)";
  for (var r = 0; r < rails.length; r++) g.fillRect(rails[r][0], rails[r][1], rails[r][2], rails[r][3]);
  g.restore();

  var letters = failureLayer("letters", tileDeviceW, tileDeviceH);
  letters.fillStyle = theme.letters;
  // Linux port begin (A4): see lumaKeyedAlertLetters.
  if (lumaKeyedAlertLetters()) letters.fillStyle = theme.keyedLetters;
  // Linux port end.
  drawFailureTitle(letters, frame, theme.title);
  g.save();
  g.shadowColor = "rgba(0,0,0,0.8)";
  g.shadowBlur = minD * 0.03 * canvasScaleX;
  g.shadowOffsetY = minD * 0.008 * canvasScaleY;
  g.globalAlpha = 0.86;
  g.drawImage(letters.canvas, 0, 0, W, H);
  g.restore();

  var intersections = failureLayer("intersections", tileDeviceW, tileDeviceH);
  drawSeeThroughIntersections(intersections, letters.canvas, tileOffsetX, tileOffsetY, sceneW, sceneH, sceneTime, theme.intersections);
  g.globalAlpha = 0.95;
  g.drawImage(intersections.canvas, 0, 0, W, H);
  g.globalAlpha = 1;

  g.strokeStyle = "rgba(255,255,255,0.9)";
  g.lineWidth = Math.max(2, minD * 0.004);
  g.strokeRect(frame.x, frame.y, frame.w, frame.h);
  drawFailureModules(g, frame, counter, theme.bits);
  g.restore();
}

// Aggressive, decaying shake of the whole canvas -- ported unchanged from the source overlay. This
// wallpaper has no separate video layer to shake (unlike alert-layer.js, which dropped the shake
// entirely because T4 shook the video natively): the canvas IS the wallpaper, so a FAILED alert
// shakes it directly, same as the source page always did. `nebulaCanvas` is optional (D6a): only the
// processing scene declares that global (its own WebGL background layer, config.js); every other
// scene simply has nothing else to shake alongside the main canvas.
function applyFailureShake(elapsed) {
  var transform = "";
  if (elapsed !== null) {
    var decay = 1 - elapsed / FAILURE_SHAKE_MS;
    var amplitude = Math.min(W, H) * (0.5 + 0.5 * decay);
    var t = elapsed / 1000;
    var dx = amplitude * 0.1 * (Math.sin(t * 131) * 0.65 + Math.sin(t * 211 + 1.3) * 0.35);
    var dy = amplitude * 0.04 * (Math.sin(t * 109 + 2.1) * 0.6 + Math.sin(t * 197 + 0.4) * 0.4);
    var angle = 3.5 * decay * Math.sin(t * 89 + 0.7);
    transform = "translate(" + dx.toFixed(2) + "px, " + dy.toFixed(2) + "px) rotate(" + angle.toFixed(3) + "deg) scale(1.18)";
  }
  canvas.style.transform = transform;
  if (typeof nebulaCanvas !== "undefined" && nebulaCanvas) nebulaCanvas.style.transform = transform;
}

// Downscale `source`'s (sourceX, sourceY, sourceW, sourceH) device-pixel region by `cell` and draw it
// back over the tile's own device rect with hard pixel edges. `source` is either the whole-canvas
// backdrop snapshot (cropped to this tile) or this tile's own already-tile-sized overlay buffer.
function drawTilePixelated(source, sourceX, sourceY, sourceW, sourceH, cell, slot, alpha, tileDeviceX, tileDeviceY, tileDeviceW, tileDeviceH) {
  var pixelWidth = Math.max(1, Math.ceil(tileDeviceW / cell));
  var pixelHeight = Math.max(1, Math.ceil(tileDeviceH / cell));
  var pixels = failureLayer(slot, pixelWidth, pixelHeight, false);
  pixels.imageSmoothingEnabled = true;
  pixels.clearRect(0, 0, pixelWidth, pixelHeight);
  pixels.drawImage(source, sourceX, sourceY, sourceW, sourceH, 0, 0, pixelWidth, pixelHeight);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = alpha;
  ctx.drawImage(pixels.canvas, tileDeviceX, tileDeviceY, tileDeviceW, tileDeviceH);
  ctx.restore();
}

// ---- State machine: hidden -> shaking (failed only) -> revealing -> shown, PER KIND -------------
// One small state machine per kind (not per tile instance): every tile of the same kind started at
// the same ms and shares the same theme, so they always report the identical state/counter at any
// given ms -- same design alert-layer.js's mosaic already uses.

var kindState = {
  failed: { state: "hidden", startMs: null },
  warning: { state: "hidden", startMs: null },
};
var scenePausedMs = 0;

function resetKindState() {
  kindState = {
    failed: { state: "hidden", startMs: null },
    warning: { state: "hidden", startMs: null },
  };
}

// Idempotent per ms: every transition is guarded by the CURRENT state, so calling this more than
// once for the same (ms, kind) -- once early from alertSceneMs, once again from renderAlertOverlay's
// own per-tile loop -- never double-applies a transition (see alertSceneMs's own remarks).
function advanceKindState(ms, kind) {
  var entry = kindState[kind];
  var theme = FAILURE_OVERLAY_THEMES[kind];
  if (entry.startMs === null) {
    entry.startMs = ms;
    entry.state = "shaking";
  }
  if (entry.state === "shaking" && ms - entry.startMs >= theme.shakeMs) {
    scenePausedMs += theme.shakeMs;
    entry.state = "revealing";
    if (kind === "failed") applyFailureShake(null);
  }
  if (entry.state === "revealing" && ms - entry.startMs >= theme.shakeMs + FAILURE_REVEAL_MS) {
    entry.state = "shown";
  }
}

// Called FIRST, before the scene renders this frame (each scene's own render loop) -- mirrors the
// source overlay's advanceFailureState: while a FAILED tile is shaking, the scene's own clock (and
// any animation progress derived from it) freezes, and the canvas visibly shakes. Only 'failed' ever
// has a non-zero shakeMs (see FAILURE_OVERLAY_THEMES), so at most one kind actually shakes/pauses at
// a time -- same assumption the source's single-overlay design made.
function alertSceneMs(ms) {
  if (kindState.failed.startMs !== null) advanceKindState(ms, "failed");
  if (kindState.warning.startMs !== null) advanceKindState(ms, "warning");
  if (kindState.failed.state === "shaking") {
    applyFailureShake(ms - kindState.failed.startMs);
    return kindState.failed.startMs - scenePausedMs;
  }
  return ms - scenePausedMs;
}

// ---- Message-driven show/hide API (same contract as alert-layer.js) -----------------------------

var animating = false;
var doneSignaled = false;
var durationMs = 5000;
var showStartMs = null;

var tiles = ["warning"]; // wire kinds ("failed"/"warning"), one per slot
var gridColumns = 1;
var gridRows = 1;
var gapPx = 0; // PHYSICAL pixels, as posted by the host -- converted to CSS pixels below

var workAreaLeft = 0;
var workAreaTop = 0;
var workAreaWidth = 0;
var workAreaHeight = 0;

// The rect (CSS pixels) the N>1 grid is laid out inside: the work area, converted with the same
// devicePixelRatio-derived scale each scene's own resize() already uses, and clamped to the canvas
// -- or the whole canvas when the work area is absent/degenerate. Reads W/H/canvasScaleX/Y at call
// time, which is always the TRUE scene size: renderAlertOverlay always calls this BEFORE repurposing
// W/H per tile.
function gridAreaRect() {
  if (workAreaWidth <= 0 || workAreaHeight <= 0) {
    return { x: 0, y: 0, w: W, h: H };
  }
  var x = Math.max(0, Math.min(W, workAreaLeft / canvasScaleX));
  var y = Math.max(0, Math.min(H, workAreaTop / canvasScaleY));
  var w = Math.max(1, Math.min(W - x, workAreaWidth / canvasScaleX));
  var h = Math.max(1, Math.min(H - y, workAreaHeight / canvasScaleY));
  return { x: x, y: y, w: w, h: h };
}

function tileRects() {
  if (tiles.length <= 1) {
    return [{ x: 0, y: 0, w: W, h: H }];
  }
  var area = gridAreaRect();
  var gapCssX = gapPx / canvasScaleX;
  var gapCssY = gapPx / canvasScaleY;
  var cellW = Math.max(1, (area.w - gapCssX * (gridColumns + 1)) / gridColumns);
  var cellH = Math.max(1, (area.h - gapCssY * (gridRows + 1)) / gridRows);
  var rects = [];
  for (var i = 0; i < tiles.length; i++) {
    var col = i % gridColumns;
    var row = Math.floor(i / gridColumns);
    rects.push({
      x: area.x + gapCssX + col * (cellW + gapCssX),
      y: area.y + gapCssY + row * (cellH + gapCssY),
      w: cellW,
      h: cellH,
    });
  }
  return rects;
}

function postToHost(message) {
  // Linux port begin (A4): the CieLinux host reads exactly two console markers from this file
  // (src/alert-bridge.h); there is no WebView2 bridge, so the branch below never runs here.
  if (message === "ready" || message === "done") {
    try { console.log(message === "ready" ? "CIELINUX_ALERT_READY_V1" : "CIELINUX_ALERT_DONE_V1"); } catch (_) {}
  }
  // Linux port end.
  // Guarded: this same file also opens in a plain browser tab, where window.chrome.webview does
  // not exist -- the manual check the feature doc asks for.
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.postMessage(message);
  }
}

// Unlike alert-layer.js's stopAndClear (which owns a transparent, alert-only canvas and clears it),
// this page's canvas is shared with the scene: stopping the overlay must never clear the canvas --
// the scene's own render loop already clears/redraws it every frame regardless of alert state.
function stopOverlay() {
  animating = false;
  applyFailureShake(null);
}

function hide() {
  stopOverlay();
  showStartMs = null;
  resetKindState();
}

function signalDoneIfElapsed(ms) {
  if (doneSignaled || showStartMs === null || ms - showStartMs < durationMs) {
    return false;
  }
  doneSignaled = true;
  postToHost("done");
  return true;
}

function startShowing(newTiles, columns, rows, gap, duration, workArea) {
  tiles = Array.isArray(newTiles) && newTiles.length > 0
    ? newTiles.map(function (tile) { return tile === "failed" ? "failed" : "warning"; })
    : ["warning"];
  gridColumns = Math.max(1, Math.floor(columns) || 1);
  gridRows = Math.max(1, Math.floor(rows) || 1);
  gapPx = Math.max(0, gap || 0);
  if (workArea && isFinite(workArea.width) && isFinite(workArea.height)
    && workArea.width > 0 && workArea.height > 0) {
    workAreaLeft = Math.max(0, Number(workArea.left) || 0);
    workAreaTop = Math.max(0, Number(workArea.top) || 0);
    workAreaWidth = Math.max(0, Number(workArea.width) || 0);
    workAreaHeight = Math.max(0, Number(workArea.height) || 0);
  } else {
    workAreaLeft = 0;
    workAreaTop = 0;
    workAreaWidth = 0;
    workAreaHeight = 0;
  }
  durationMs = isFinite(duration) && duration > 0 ? duration : 5000;
  showStartMs = null;
  resetKindState();
  doneSignaled = false;
  // No separate render loop to (re)start (unlike alert-layer.js): the scene's own render loop is
  // already running continuously, and picks up renderAlertOverlay() on the next frame purely because
  // `animating` is now true.
  animating = true;
}

function handleHostMessage(event) {
  var data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "show") {
    if (Array.isArray(data.tiles)) {
      startShowing(
        data.tiles, Number(data.columns), Number(data.rows), Number(data.gap), Number(data.duration),
        data.workArea);
    } else {
      startShowing([data.kind === "failed" ? "failed" : "warning"], 1, 1, 0, Number(data.duration));
    }
  } else if (data.type === "hide") {
    hide();
  } else if (data.type === "pause" || data.type === "resume") {
    // pause-scene-when-covered: only the wallpaper scene pages load render-loop.js (which owns the
    // switch); any other page that reuses this handler simply has nothing to pause.
    if (typeof setWallpaperPaused === "function") setWallpaperPaused(data.type === "pause");
  }
}

if (window.chrome && window.chrome.webview) {
  window.chrome.webview.addEventListener("message", handleHostMessage);
}

// Linux port begin (A4): the CieLinux host -> page channel. view.qml runs exactly
// `window.cielinuxAlertCommand(<JSON text as a JS string literal>)`; the text is parsed here as
// data and handed to the same handler as CielWin's web messages (show/hide/pause/resume only).
function cielinuxAlertCommand(text) {
  var data;
  try { data = JSON.parse(String(text)); } catch (_) { return; }
  handleHostMessage({ data: data });
}
// Linux port end.

// ---- Rendering: called once per animation frame from each scene's own render loop, AFTER the scene

// Whole-canvas backdrop snapshot, captured at most once per frame, only when at least one visible
// tile's theme actually pixelates it (only 'failed' does, see FAILURE_OVERLAY_THEMES) -- mirrors the
// source overlay's own per-frame-once capture, generalized to run before the FIRST tile that needs it
// instead of unconditionally (this page draws every frame; alert-layer.js's separate canvas did not).
function captureBackdropIfNeeded() {
  var needed = false;
  for (var i = 0; i < tiles.length; i++) {
    var entry = kindState[tiles[i]];
    if (FAILURE_OVERLAY_THEMES[tiles[i]].pixelateBackdrop && entry.state !== "hidden" && entry.state !== "shaking") {
      needed = true;
      break;
    }
  }
  if (!needed) return null;
  var backdrop = failureLayer("backdrop", canvas.width, canvas.height, false);
  backdrop.drawImage(canvas, 0, 0);
  return backdrop;
}

// Tile-scoped replacement for the source overlay's drawFailureLayer: `tileOffsetX`/`tileOffsetY` is
// where the scene's own (0,0) origin lands within this TILE's own device-pixel rect (see
// drawSeeThroughIntersections above), `sceneW`/`sceneH` are the scene's own true size (untouched by
// any tile), `tileDeviceX/Y/W/H` are this tile's own device-pixel rect within the whole canvas
// (needed only by drawTilePixelated's backdrop crop), and W/H are ALREADY this tile's own CSS size
// (set by the caller, renderAlertTile).
function drawFailureLayer(ms, kind, tileOffsetX, tileOffsetY, sceneW, sceneH, sceneTime, tileDeviceX, tileDeviceY, tileDeviceW, tileDeviceH, backdrop) {
  var entry = kindState[kind];
  if (entry.state === "hidden" || entry.state === "shaking") return;
  var theme = FAILURE_OVERLAY_THEMES[kind];
  var shownMs = Math.max(0, ms - entry.startMs - theme.shakeMs);
  var counter = Math.floor(shownMs / FAILURE_COUNTER_STEP_MS) % 100;
  var backdropCell = Math.max(1, Math.round(FAILURE_BACKDROP_CELL * canvasScaleX));

  if (entry.state === "shown") {
    if (backdrop && theme.pixelateBackdrop) {
      drawTilePixelated(backdrop.canvas, tileDeviceX, tileDeviceY, tileDeviceW, tileDeviceH,
        backdropCell, "backdropPixels", 1, tileDeviceX, tileDeviceY, tileDeviceW, tileDeviceH);
    }
    drawFailureOverlay(ctx, tileOffsetX, tileOffsetY, sceneW, sceneH, sceneTime, counter, theme, tileDeviceW, tileDeviceH);
    return;
  }

  var t = Math.min(1, shownMs / FAILURE_REVEAL_MS);
  var eased = 1 - Math.pow(1 - t, 3);
  var lineT = Math.min(1, t / FAILURE_REVEAL_LINE_SHARE);
  var openT = Math.max(0, (t - FAILURE_REVEAL_LINE_SHARE) / (1 - FAILURE_REVEAL_LINE_SHARE));
  var cell = Math.max(1, Math.round(FAILURE_REVEAL_MAX_CELL * Math.pow(1 - eased, 1.4)));
  var overlay = failureLayer("overlay:" + kind, tileDeviceW, tileDeviceH);
  drawFailureOverlay(overlay, tileOffsetX, tileOffsetY, sceneW, sceneH, sceneTime, counter, theme, tileDeviceW, tileDeviceH);

  var revealW = W * (1 - Math.pow(1 - lineT, 2));
  var revealH = Math.max(H * 0.04, H * (1 - Math.pow(1 - openT, 3)));
  ctx.save();
  ctx.beginPath();
  ctx.rect((W - revealW) * 0.5, (H - revealH) * 0.5, revealW, revealH);
  ctx.clip();
  if (backdrop && theme.pixelateBackdrop) {
    drawTilePixelated(backdrop.canvas, tileDeviceX, tileDeviceY, tileDeviceW, tileDeviceH,
      Math.max(backdropCell, cell), "backdropPixels", 1, tileDeviceX, tileDeviceY, tileDeviceW, tileDeviceH);
  }
  drawTilePixelated(overlay.canvas, 0, 0, tileDeviceW, tileDeviceH,
    cell, "overlayPixels:" + kind, 0.3 + 0.7 * eased, tileDeviceX, tileDeviceY, tileDeviceW, tileDeviceH);
  ctx.restore();
}

// Draws ONE tile: repurposes the shared W/H to this tile's own CSS size (same technique
// alert-layer.js's renderTile uses), clips/translates ctx to the tile's rect so drawFailureOverlay's
// title/wash/modules draw exactly as if this tile were the whole canvas -- then restores W/H so the
// NEXT tile (or the next frame's scene render) sees the true scene size again. `tileOffsetX`/
// `tileOffsetY` (== -rect.x, -rect.y) is where the scene's own (0,0) origin lands within this tile's
// own device-pixel buffer -- computed here, once, since every downstream consumer only ever needs
// this offset, never rect.x/rect.y themselves (D6a: previously this file's own caller passed a
// scene-CENTER-relative offset; the center itself is now the processing scene's own hook's concern,
// see js/see-through-hook.js).
function renderAlertTile(rect, kind, ms, sceneW, sceneH, sceneTime, backdrop) {
  var tileW = W, tileH = H;
  W = rect.w;
  H = rect.h;
  var tileDeviceX = Math.round(rect.x * canvasScaleX);
  var tileDeviceY = Math.round(rect.y * canvasScaleY);
  var tileDeviceW = Math.round(rect.w * canvasScaleX);
  var tileDeviceH = Math.round(rect.h * canvasScaleY);

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.translate(rect.x, rect.y);
  drawFailureLayer(ms, kind, -rect.x, -rect.y, sceneW, sceneH, sceneTime,
    tileDeviceX, tileDeviceY, tileDeviceW, tileDeviceH, backdrop);
  ctx.restore();

  W = tileW;
  H = tileH;
}

// Called once per animation frame from each scene's own render loop, with the SAME sceneTime value
// (progress, elapsed seconds, ...) the scene used to draw itself this frame -- see this file's own
// header remarks and each scene's own js/see-through-hook.js. D6a: dropped the scene-center
// (sceneCx/sceneCy) parameters this file used to take -- only a scene's own hook needs a center
// concept (if any), and it can compute one itself from sceneW/sceneH exactly as its own scene render
// loop always did.
function renderAlertOverlay(ms, sceneW, sceneH, sceneTime) {
  if (!animating) return;
  if (showStartMs === null) showStartMs = ms;
  var rects = tileRects();
  var backdrop = captureBackdropIfNeeded();

  for (var i = 0; i < tiles.length && i < rects.length; i++) {
    advanceKindState(ms, tiles[i]);
    renderAlertTile(rects[i], tiles[i], ms, sceneW, sceneH, sceneTime, backdrop);
  }

  if (signalDoneIfElapsed(ms)) {
    stopOverlay();
  }
}

// ---- Hash API (manual check, same shape as alert-layer.js) ---------------------------------------
// <scene>/index.html#tiles=failed,warning&columns=2&rows=1&gap=8&duration=5000
// Old single-tile form, still supported: <scene>/index.html#kind=failed&duration=5000
// Optional work area (tiles form only): #tiles=...&work=L,T,W,H (physical pixels).
// A preloaded host page (T9c-equivalent, see WebViewAlertLayerController) navigates with NO
// hash/query at all, so this must NOT auto-show: only an explicit tiles/kind/duration param starts
// the layer; otherwise the scene renders alone until a "show" message arrives.

function parseParams() {
  var raw = (location.hash || location.search || "").replace(/^[#?]/, "");
  return new URLSearchParams(raw);
}

function parseWorkAreaParam(params) {
  if (!params.has("work")) return undefined;
  var parts = params.get("work").split(",").map(Number);
  if (parts.length !== 4 || parts.some(function (n) { return !isFinite(n); })) return undefined;
  return { left: parts[0], top: parts[1], width: parts[2], height: parts[3] };
}

var alertOverlayParams = parseParams();
var alertOverlayHasExplicitParams =
  alertOverlayParams.has("kind") || alertOverlayParams.has("duration") || alertOverlayParams.has("tiles");

// Tells the host a live, running script exists on the other end of the bridge -- not just that
// navigation completed -- before it trusts a pending "show" was actually received.
postToHost("ready");

if (alertOverlayHasExplicitParams) {
  var requestedDuration = Number(alertOverlayParams.get("duration"));
  if (alertOverlayParams.has("tiles")) {
    var requestedColumns = Number(alertOverlayParams.get("columns")) || 1;
    var requestedRows = Number(alertOverlayParams.get("rows")) || 1;
    var requestedTiles = alertOverlayParams.get("tiles").split(",")
      .map(function (tile) { return tile.trim(); })
      .filter(function (tile) { return tile === "failed" || tile === "warning"; })
      .slice(0, requestedColumns * requestedRows);
    startShowing(
      requestedTiles,
      requestedColumns,
      requestedRows,
      Number(alertOverlayParams.get("gap")) || 0,
      requestedDuration,
      parseWorkAreaParam(alertOverlayParams));
  } else {
    var requestedKind = alertOverlayParams.get("kind") === "failed" ? "failed" : "warning";
    startShowing([requestedKind], 1, 1, 0, requestedDuration);
  }
}
