// html-wallpaper-demo D6c: adapted from docs/great-sage/background-idle/js/main.js (reference-only,
// excluded from git -- see the feature doc, "Source material"). resize()'s device-pixel-ratio
// bootstrap is an intact port, extended to also compute canvasScaleX/canvasScaleY (device-pixel
// scale, see js/config.js's own D6c remarks) the same way
// CielWin.App/Wallpaper/Web/explorer/js/main.js's own resize() does (D6a) --
// CielWin.App/Wallpaper/Web/shared/js/alert-overlay.js (the shared alert layer) reads these two
// globals to lay out its tile mosaic in device pixels. Dropped entirely, per "Drop what a wallpaper
// does not need" (mirroring explorer's/processing's own D6a/D2 main.js precedent): the Ctrl+F
// fullscreen toggle, its keydown listener, the 'fullscreenchange' resize hook, and the
// matchMedia-based DPR-change watch (a display's DPR does not change while this page is running as a
// fixed-size wallpaper).
//
// Loads last, after every other file.

function resize() {
  const cssWidth = Math.max(1, window.innerWidth || 1);
  const cssHeight = Math.max(1, window.innerHeight || 1);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(cssWidth * dpr);
  const pixelHeight = Math.round(cssHeight * dpr);
  W = cssWidth;
  H = cssHeight;
  DPR = dpr;
  canvasScaleX = pixelWidth / cssWidth;
  canvasScaleY = pixelHeight / cssHeight;
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  ctx.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0);
  // Ring/Earth caches are keyed by pixel size AND DPR (see animate.js/earth.js); resizing the
  // backing store invalidates them, and the next renderFrame() call rebuilds them before drawing.
}

window.addEventListener('resize', resize, { passive: true });

resize();
startAnimation();
