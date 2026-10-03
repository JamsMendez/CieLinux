// html-wallpaper-demo D6c: copied verbatim from docs/great-sage/background-idle/js/config.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged, EXCEPT the two
// new canvasScaleX/canvasScaleY globals just below W/H/DPR: the shared alert overlay
// (CielWin.App/Wallpaper/Web/shared/js/alert-overlay.js) reads them to lay out its tile mosaic in
// device pixels, the same technique explorer's/processing's own config.js already declares them
// for -- this scene's own js/main.js (D6c) is what actually computes their value, on resize.

// config.js — canvas/DOM bootstrap, mutable scene state, and every user-tunable constant.
// Loads first: every other file reads names defined here. Depends on nothing.
const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d', { alpha: true });

let W = 0;
let H = 0;
let DPR = 1;
let canvasScaleX = 1;
let canvasScaleY = 1;

const TAU = Math.PI * 2;
const SEED = 0x9e77c0de;

// --- Shared glyph geometry (glyphs.js) ----------------------------------------
// Every procedural "hieroglyph" (glyphs.js's makeHieroglyph) is generated, clamped, and recentered
// to stay within a [-GLYPH_LOCAL_HALF_EXTENT, GLYPH_LOCAL_HALF_EXTENT] local box on both axes — see
// glyphs.js for the generation-time enforcement (IDL-16). Defined here (not in glyphs.js) because
// config.js loads first and OUTER_GLYPH_SIZE_FRACTION_OF_THICKNESS below also needs it.
const GLYPH_LOCAL_HALF_EXTENT = 0.45;

// --- Composition -------------------------------------------------------------
// Center of the ring system (every ring 2-8 is a circle around this point), as a fraction of
// viewport width/height. Corrected from a 100px-gridded overlay of the 1680x939 reference:
// ring center ~= (845, 480) => (0.503, 0.511).
// Full-circle-fit (2026-09-27, maintainer decision): recentered from the measured 0.511 to an exact
// 0.5 so the disc gets an equal top/bottom margin once its radius is fit to the screen (see
// sceneBasis() below) instead of sitting slightly low and clipping the top first. The ORIGINAL
// measured value is kept as MEASURED_RING_CENTER_Y_FRACTION below because EARTH_CENTER_Y_FRACTION
// was pixel-measured relative to THAT value, not to this tunable.
const CENTER_X_FRACTION = 0.503;
const CENTER_Y_FRACTION = 0.5;
// Every radius below is a fraction of sceneBasis(W, H) (see below) so the composition scales with
// the window, fitted to stay fully on screen instead of a plain min(W, H).
const SCENE_SCALE_BASIS = 'min'; // 'min' keeps the ring system fully visible on both axes.

// --- Earth ---------------------------------------------------------------------
// The Earth has its OWN center, offset from the ring center: grid-verified ~= (845, 445), i.e.
// higher than the ring center by (480-445)=35px => 35/939 = 0.0373 of H, same x.
const EARTH_CENTER_X_FRACTION = 0.503;
const EARTH_CENTER_Y_FRACTION = 0.474;
// The ring-center fraction EARTH_CENTER_Y_FRACTION above was actually measured against (0.511, the
// original CENTER_Y_FRACTION before the full-circle-fit recenter above). Kept as its own constant,
// independent of CENTER_Y_FRACTION's current value, so the Earth's measured offset from the ring
// center never drifts just because CENTER_Y_FRACTION itself is retuned later.
const MEASURED_RING_CENTER_Y_FRACTION = 0.511;
// The Earth's position relative to the ring center, in basis units (not H units): scaled by
// sceneBasis() alongside every other radius (see animate.js) so it shrinks/grows with the rest of
// the composition instead of staying pinned to a fixed fraction of H. 0 for x (same center column
// as the rings); ~-0.037 for y (Earth sits slightly above the ring center).
const EARTH_CENTER_X_OFFSET_FRACTION = EARTH_CENTER_X_FRACTION - CENTER_X_FRACTION;
const EARTH_CENTER_Y_OFFSET_FRACTION = EARTH_CENTER_Y_FRACTION - MEASURED_RING_CENTER_Y_FRACTION;
// Reference: Earth radius ~= 210px on a 939px-tall frame => 210/939 = 0.2237 (top limb at
// y~=235, sides at x~=640/1055, dim-but-visible lower edge down to y~=655 — all consistent
// with this center/radius).
const EARTH_RADIUS_FRACTION = 0.2237;
const EARTH_LONGITUDE = 0; // radians; rotate this over time later to spin the globe.
// IDL-12: raised from a fixed 320px (visibly blocky at larger viewports/DPR — see earth.js
// drawEarth) to a generous cost ceiling; the actual per-frame render size now tracks the disc's
// true on-screen diameter at the current DPR (see drawEarth), and only hits this ceiling on a
// very large and/or very-high-DPR display. Profiled (feature doc) at 1680x939 DPR1, 3440x1440
// DPR1, and 1680x939 DPR2 — none reach this ceiling, so all three render at full native density.
const EARTH_TEXTURE_SIZE_MAX = 1024; // offscreen render resolution ceiling (px) before it is scaled onto the scene.
const EARTH_NOISE_SEED = 0x0e57a71a;
const EARTH_LAND_THRESHOLD = 0.50; // fractal-noise cutoff between ocean and land.
const EARTH_CLOUD_THRESHOLD = 0.54; // higher-frequency noise cutoff for cloud cover.
// IDL-6 monochrome: every Earth surface color is now a grayscale value (ocean darkest, land
// mid-grey, clouds near-white) so nothing on the globe carries hue; only the bottom chromatic
// glow (see CHROMATIC_GLOW_COLORS) keeps color.
const EARTH_OCEAN_COLOR_DEEP = [6, 6, 6];
const EARTH_OCEAN_COLOR_SHALLOW = [46, 46, 46];
const EARTH_LAND_COLOR = [70, 70, 70];
const EARTH_CLOUD_COLOR = [238, 238, 238];
const EARTH_TERMINATOR_SOFTNESS = 0.85; // 0..1: how gradual the day/night falloff is (top-lit); lower = steeper.
// IDL-11: raised alongside LIGHT_BOTTOM_FLOOR (below) so the Earth's dark lower hemisphere reads
// consistently with the rings' brighter bottom instead of looking comparatively pitch-black next
// to it; still clearly darker than the lit cap (0.09 -> 0.22, vs EARTH_DAY_BRIGHTNESS=2.6).
const EARTH_NIGHT_FLOOR = 0.22; // minimum brightness multiplier on the dark limb: dim but visible, not pitch black.
const EARTH_DAY_BRIGHTNESS = 2.6; // multiplier on the lit upper cap so clouds/land read clearly bright, not near-black.
const EARTH_RIM_LIGHT_COLOR = 'rgba(235,235,235,0.85)'; // monochrome rim light (was blue-tinted)
const EARTH_FLARE_COLOR = 'rgba(255,255,255,0.95)';
const EARTH_FLARE_SIZE_FRACTION = 0.018; // relative to min(W, H)
const EARTH_FLARE_RAY_LENGTH_FRACTION = 0.075; // long thin horizontal/vertical rays through the flare
// IDL-13: the top-limb flare was a static, unchanging light point — added a smooth, deterministic
// (from elapsed time, no Math.random per frame) fade-off/fade-on loop, threaded through from
// renderFrame's timeSeconds into drawEarth then drawSpark's intensity argument (see earth.js).
// Kept out of the Earth texture cache (earth.js's renderEarthFrame/earthDiscLookup are unaffected
// by these two constants) since the flare is already a separate vector draw call, not baked
// surface pixels.
const EARTH_FLARE_BLINK_PERIOD_SECONDS = 3.5; // one full fade-off-and-back-on cycle
const EARTH_FLARE_BLINK_MIN_INTENSITY = 0; // fully off at the dimmest point of the cycle

// IDL-6 monochrome: every remaining ring color below is grayscale (no hue anywhere except the
// bottom chromatic glow at the very end of this file).

// --- Ring 2: thin circle around Earth -------------------------------------------
// Pixel-measured (radius histogram of bright pixels sampled at many angles around ring center
// 845,480 in the reference, converted with r=hypot(dx,dy) so the sample column's exact x does
// not matter): a clear cluster peaks at r ~= 280/939 = 0.2982.
const INNER_RING_RADIUS_FRACTION = 0.2982;
const INNER_RING_COLOR = 'rgba(210,210,210,0.35)';
const INNER_RING_WIDTH = 1;
const INNER_RING_ROTATION = 0;

// --- Ring 3: constellation ring --------------------------------------------------
// IDL-6: now a dedicated ring with its own inner/outer boundary (thin circular lines), sized so
// every figure is normalized (bounding box computed, then scaled/offset) to sit centered on the
// ring's mid-radius and never cross either boundary. This ring's thickness also sets the target
// radial gap between the alphabet ring and the ruler ring (see ring 6 below).
const CONSTELLATION_RING_INNER_RADIUS_FRACTION = 0.30;
const CONSTELLATION_RING_OUTER_RADIUS_FRACTION = 0.372;
const CONSTELLATION_COUNT = 16;
// IDL-7: shrunk so each figure keeps a ~20-25% margin from both ring boundaries (was 0.85,
// filling nearly the whole ring width with no clearance).
const CONSTELLATION_FIGURE_MARGIN = 0.55; // fraction of the ring's radial thickness each figure's bounding box may fill
// IDL-16: shrunk per user request (5 -> 2.75, mid-point of the requested ~2.5-3 range) so the
// dots read thinner/smaller against the now hand-drawn connecting lines.
const CONSTELLATION_DOT_RADIUS = 2.75;
const CONSTELLATION_LINE_COLOR = 'rgba(235,235,235,0.85)';
const CONSTELLATION_DOT_COLOR = 'rgba(255,255,255,0.98)';
const CONSTELLATION_BOUNDARY_COLOR = 'rgba(235,235,235,0.5)';
const CONSTELLATION_LINE_WIDTH = 2.5; // peak (mid-stroke) width of the brush stroke below, before its taper
const CONSTELLATION_ROTATION = 0;
// IDL-16: connecting lines redrawn as hand-drawn "brush" strokes instead of plain straight lines —
// tapered ends, a gentle organic wobble along the length, slight per-edge width jitter, and a
// couple of faint offset "bristle" strokes alongside the main one. Every parameter here is
// deterministic (drawn from each figure's own seeded mulberry32 stream, see
// makeConstellations in rings.js — no Math.random anywhere), and drawConstellationRing
// only ever runs while baking a ring's content into its offscreen cache (animate.js), so this adds
// no per-frame cost.
const CONSTELLATION_BRUSH_WOBBLE_AMPLITUDE = 0.06; // organic bow, as a fraction of the edge's own length
const CONSTELLATION_BRUSH_WOBBLE_HARMONIC_WEIGHT = 0.35; // 2nd-harmonic weight; breaks the wobble's symmetry
const CONSTELLATION_BRUSH_TAPER_MIN_FRACTION = 0.18; // width at both tips, as a fraction of the peak width (never fully 0)
const CONSTELLATION_BRUSH_WIDTH_JITTER_MIN = 0.75; // per-edge overall width multiplier range
const CONSTELLATION_BRUSH_WIDTH_JITTER_MAX = 1.25;
const CONSTELLATION_BRUSH_SEGMENTS = 10; // subdivisions per edge; higher = smoother taper/wobble curve
const CONSTELLATION_BRUSH_BRISTLE_COUNT = 2; // faint offset strokes drawn alongside each main edge
const CONSTELLATION_BRUSH_BRISTLE_OFFSET_FRACTION = 0.6; // sideways shift, as a fraction of the peak full width
const CONSTELLATION_BRUSH_BRISTLE_WIDTH_SCALE = 0.4; // bristles are thinner than the main stroke
const CONSTELLATION_BRUSH_BRISTLE_ALPHA = 0.35; // bristles are faint (alpha multiplier on the main line color)

// --- Ring 4: hieroglyph band (two thin glyph-text rows, boxed) -------------------
// IDL-6: starts right outside the constellation ring's new outer edge (0.372) and still ends at
// the alphabet ring's inner edge (0.437), so there is no overlap and no gap. Two rows of bold
// small glyphs, each enclosed by a thin circular line (inner/outer band outline), plus short
// radial dividers boxing small groups of glyphs.
const HIEROGLYPH_BAND_INNER_RADIUS_FRACTION = 0.372;
const HIEROGLYPH_BAND_OUTER_RADIUS_FRACTION = 0.437;
const HIEROGLYPH_BAND_ROW_COUNT = 2;
const HIEROGLYPH_GLYPH_COUNT = 170; // glyphs per row, spread around the full circle
const HIEROGLYPH_GLYPH_COLOR = 'rgba(232,232,232,0.92)';
const HIEROGLYPH_DIVIDER_COLOR = 'rgba(232,232,232,0.6)';
const HIEROGLYPH_DIVIDER_EVERY = 6; // draw a short radial divider every N glyphs, boxing a small group
const HIEROGLYPH_ROTATION = 0;

// --- Ring 5: alphabet ring -------------------------------------------------------
// Pixel-measured: the dominant bright-pixel cluster in the whole histogram spans r ~= 410-520
// (0.437-0.554) confirming this band; at the top only the band's lower portion is visible (its
// outer edge is off-screen), irregular white/black cells, bold thick-stroke glyphs. IDL-6: the
// inner/outer border glyph-text rows are removed — each cell shows only its letter.
const ALPHABET_RING_INNER_RADIUS_FRACTION = 0.437;
const ALPHABET_RING_OUTER_RADIUS_FRACTION = 0.554;
const ALPHABET_CELL_COUNT = 30;
const ALPHABET_CELL_GAP_RADIANS = 0.006;
const ALPHABET_WHITE_CELL_COLOR = 'rgba(226,226,226,0.95)';
const ALPHABET_BLACK_CELL_COLOR = 'rgba(6,6,6,0.95)';
// Irregular white/black pattern (not strict alternation) sampled once from a seeded run, see rings.js.
const ALPHABET_LETTER_ON_WHITE_COLOR = 'rgba(10,10,10,0.97)';
const ALPHABET_LETTER_ON_BLACK_COLOR = 'rgba(226,226,226,0.97)';
const ALPHABET_LETTER_FONT = 'serif';
const ALPHABET_LETTER_WEIGHT = '700';
const ALPHABET_LETTER_SIZE_FRACTION = 0.42; // relative to the band's radial thickness (smaller, bolder glyphs)
const ALPHABET_ROTATION = 0;

// --- Ring 6: ruler ring ------------------------------------------------------------
// IDL-7 user addition: the ruler (ticks + labels) moves inward again so it sits centered inside
// the dark gap ring between the alphabet band's outer edge (0.554) and the IDL-6 ruler position
// (0.626) — that gap is 0.072 thick, centered at 0.590; the ruler now spans about half of it
// (0.036, i.e. 0.572-0.608, labels included) instead of sitting at the gap's outer edge. Every
// other ring keeps its IDL-6 position. Still a measuring-ruler pattern: every 5th tick is a major
// tick with a deterministic hieroglyph-numeral label just outside it (oriented tangentially); 4
// minor ticks between labeled majors.
const RULER_RING_RADIUS_FRACTION = 0.572; // base radius the ticks grow outward from
const RULER_TICK_COUNT = 260;
const RULER_TICK_LENGTH_SHORT_FRACTION = 0.007;
const RULER_TICK_LENGTH_LONG_FRACTION = 0.014;
const RULER_LONG_TICK_EVERY = 5;
const RULER_TICK_COLOR = 'rgba(217,217,217,0.85)';
const RULER_TICK_WIDTH = 1.5;
const RULER_LABEL_COLOR = 'rgba(235,235,235,0.95)';
const RULER_LABEL_SIZE_FRACTION = 0.018; // fraction of min(W,H); sized to fit the halved gap span
// IDL-11 fix: RULER_LABEL_GAP_FRACTION is the gap from the tick's outer end to the label's
// CENTER, but drawHieroglyph draws a glyph with a 0.45*size half-extent around that center — the
// old value (0.004) was smaller than that half-extent (0.45*0.018=0.0081), so the label's own near
// edge landed INSIDE the tick's end (a visible overlap the user flagged). Raised so the visual gap
// (tick end to the label's near edge) is ~40% of the label's own size, inside the requested
// 30-50% band: centerGap = desiredVisualGap + 0.45*labelSize = 0.4*0.018 + 0.45*0.018 = 0.0153.
const RULER_LABEL_GAP_FRACTION = 0.0153; // gap between the major tick's outer end and the label's CENTER
const RULER_ROTATION = 0;
// IDL-9: the ring's true visual extent, derived from the same constants drawRulerRing() itself
// uses (tick base radius out to the major-tick label's outer edge, plus half the label's own
// size since drawHieroglyph centers a glyph on its given point) — used to size this ring's
// animation cache/mask annulus so it exactly covers the ring's content without overlapping a
// neighboring ring's cache.
const RULER_CACHE_INNER_RADIUS_FRACTION = RULER_RING_RADIUS_FRACTION;
const RULER_CACHE_OUTER_RADIUS_FRACTION =
  RULER_RING_RADIUS_FRACTION + RULER_TICK_LENGTH_LONG_FRACTION + RULER_LABEL_GAP_FRACTION + RULER_LABEL_SIZE_FRACTION * 0.5;

// --- Ring 7: paragraph ring ---------------------------------------------------------
// Shifted inward with the ruler (see ring 6) by the same amount the gap shrank (0.032), keeping
// its own thickness/row layout otherwise unchanged.
const PARAGRAPH_RING_INNER_RADIUS_FRACTION = 0.655;
const PARAGRAPH_RING_ROW_COUNT = 5;
const PARAGRAPH_ROW_GAP_FRACTION = 0.017;
const PARAGRAPH_GLYPH_COUNT = 300; // glyphs per row
const PARAGRAPH_GLYPH_COLOR = 'rgba(217,217,217,0.55)';
const PARAGRAPH_ROTATION = 0;
// IDL-11: glyphs are generated in a [-0.45, 0.45] local box (see glyphs.js), so their drawn
// radial full-extent at a given glyphSize is 0.9*glyphSize. Each row previously used
// glyphSize = rowGap*0.72, giving a 0.648*rowGap extent inside a rowGap-tall slot — that already
// fit, but with no drawn boundary the ring read as radially uncontained at a glance (the user's
// annotation). Shrink glyphSize so every glyph keeps a visible margin from its row's mid-slot
// (rowGap*0.5) and draw explicit thin boundary lines (like the constellation ring) at the band's
// true inner/outer edge, computed below, so the ring reads as clearly delimited.
const PARAGRAPH_GLYPH_SIZE_FRACTION_OF_ROW_GAP = 0.62; // was implicitly 0.72; margin widened
// Half of one row-gap of margin is reserved on the inner/outer side of the first/last row so the
// boundary lines sit clearly outside the outermost glyphs instead of hugging them.
const PARAGRAPH_BAND_MARGIN_FRACTION_OF_ROW_GAP = 0.62;
const PARAGRAPH_CACHE_INNER_RADIUS_FRACTION =
  PARAGRAPH_RING_INNER_RADIUS_FRACTION - PARAGRAPH_ROW_GAP_FRACTION * PARAGRAPH_BAND_MARGIN_FRACTION_OF_ROW_GAP;
const PARAGRAPH_CACHE_OUTER_RADIUS_FRACTION =
  PARAGRAPH_RING_INNER_RADIUS_FRACTION + PARAGRAPH_ROW_GAP_FRACTION * (PARAGRAPH_RING_ROW_COUNT - 1) +
  PARAGRAPH_ROW_GAP_FRACTION * PARAGRAPH_BAND_MARGIN_FRACTION_OF_ROW_GAP;

// --- Ring 8: outer glyph ring + deep-space starfield -------------------------------
// IDL-6: the old radial-fisheye streak field was too large/busy on ultrawide screens. Replaced
// with one normal glyph ring right outside the paragraph ring, only mildly stretched radially
// (not a fisheye/tunnel effect), then sparse seeded distant stars filling the rest of the
// screen out to the corners (varying size/brightness, static — no streaks).
const OUTER_GLYPH_RING_INNER_RADIUS_FRACTION = 0.74; // unchanged: paragraph ring stays where it is
// IDL-12: grown 0.024 -> 0.036 so the glyphs (below) can keep a real margin from both the ring's
// own inner boundary line and the disc border, which the IDL-11 fix left too tight (~9% margin,
// user wanted 15-20%). Disc border and starfield inner radius (below) move outward with it;
// nothing inward of this ring (paragraph ring and everything else) changes.
const OUTER_GLYPH_RING_THICKNESS_FRACTION = 0.036; // radial thickness of the mildly-stretched glyph band
const OUTER_GLYPH_COUNT = 220; // glyphs around the ring
const OUTER_GLYPH_RADIAL_STRETCH = 1.6; // mild radial stretch (1 = no stretch); far below the old per-ring fisheye growth
const OUTER_GLYPH_COLOR = 'rgba(200,200,200,0.5)';
const OUTER_GLYPH_BOUNDARY_COLOR = 'rgba(200,200,200,0.4)';
const OUTER_GLYPH_ROTATION = 0;
// IDL-11 root-cause fix: glyphs are generated in a [-0.45, 0.45] local box (glyphs.js), so a
// glyph's drawn radial extent at a given local scale is 0.9*scale. drawOuterGlyphRing previously
// picked an unstretched glyphSize (thickness*0.85) and then separately stretched the radial (y)
// axis by OUTER_GLYPH_RADIAL_STRETCH when drawing — 0.9*(thickness*0.85)*1.6 = 1.224*thickness,
// i.e. the glyph's actual radial extent was ~22% TALLER than the band itself, overflowing at
// every angle (worst visible on the darker sides/bottom, where an overflowing glyph reads as a
// stray mark against near-black background instead of blending into the bright dense top mass).
// Fixed by deriving glyphSize from the band thickness with the stretch already factored in, so
// the glyph's true (stretched) radial extent fits inside OUTER_GLYPH_BAND_FILL_FRACTION of the
// band, leaving a visible margin at both edges; the tangential (unstretched) width shrinks
// slightly as a result, which reads as a small, deliberate margin rather than a defect.
// IDL-12: the IDL-11 fill fraction (0.82) left only ~9% margin on each side — the user's follow-up
// screenshot still showed glyphs touching both the inner boundary line and the disc border.
// margin_each_side/thickness = (1-FILL)/2, so FILL=0.64 gives exactly 18% margin on each side
// (mid-point of the requested 15-20% range); combined with the wider band above, the glyphs also
// read slightly larger/more legible than before (13.5px tangential width vs 11.5px), not smaller.
const OUTER_GLYPH_BAND_FILL_FRACTION = 0.64; // fraction of the band's thickness the glyph's radial extent may fill
// IDL-16: two root causes let 1-2 glyphs still touch the boundary line despite the 18% margin
// above. (1) glyphs.js's 'curve' stroke type could generate an arc whose full circle reached a
// local half-extent of 0.65, well past the 0.45 this ring's margin math assumed — fixed at the
// source in glyphs.js (radius clamp), not here. (2) this ring's own extent formula used a bare
// "0.9" (= 2*0.45) full-box-width constant with no allowance for the glyph's own stroke width — a
// straight line ending exactly at the 0.45 edge, drawn with a round cap, visually reaches
// 0.45+halfStrokeWidth beyond it. GLYPH_STROKE_HALF_WIDTH_LOCAL below is the single source of
// truth for that half-width: drawStrokesOnly's local lineWidth (rings.js, `2 *
// GLYPH_STROKE_HALF_WIDTH_LOCAL`) and every stroke type's dot-draw radius (glyphs.js's
// strokesBounds/drawHieroglyph, rings.js's drawStrokesOnly) all read it rather than keeping their
// own hand-copied literal (review finding R3-stroke-halfwidth-duplication on 39db982). The true
// full extent this ring must fit is therefore
// 2*(GLYPH_LOCAL_HALF_EXTENT + GLYPH_STROKE_HALF_WIDTH_LOCAL) = 0.99, not 0.9.
const GLYPH_STROKE_HALF_WIDTH_LOCAL = 0.045; // half the local stroke width every glyph consumer draws with
const GLYPH_MAX_LOCAL_FULL_EXTENT = 2 * (GLYPH_LOCAL_HALF_EXTENT + GLYPH_STROKE_HALF_WIDTH_LOCAL); // 0.99
const OUTER_GLYPH_SIZE_FRACTION_OF_THICKNESS =
  OUTER_GLYPH_BAND_FILL_FRACTION / (GLYPH_MAX_LOCAL_FULL_EXTENT * OUTER_GLYPH_RADIAL_STRETCH);
// True visual extent, now guaranteed <= the band's own inner/outer radius (with margin), used for
// both the boundary lines and this ring's animation cache annulus.
const OUTER_GLYPH_CACHE_INNER_RADIUS_FRACTION = OUTER_GLYPH_RING_INNER_RADIUS_FRACTION;
const OUTER_GLYPH_CACHE_OUTER_RADIUS_FRACTION =
  OUTER_GLYPH_RING_INNER_RADIUS_FRACTION + OUTER_GLYPH_RING_THICKNESS_FRACTION;

// --- Stone disc border: a solid edge line + a slightly lighter rim band, just outside the outer
// glyph ring, so the whole ring system reads as one circular stone disc. Top-lit like every
// other ring; the starfield renders only outside it.
// IDL-12: both radii pushed outward by the same 0.012 the outer glyph ring grew by (thickness
// 0.024 -> 0.036), so the border still starts exactly at the ring's new outer edge with the same
// 0.016 border thickness as before — a pure translation outward, not a resize of the border itself.
const DISC_BORDER_INNER_RADIUS_FRACTION = 0.776; // right at the outer glyph ring's new outer edge
const DISC_BORDER_OUTER_RADIUS_FRACTION = 0.792;
const DISC_BORDER_EDGE_COLOR = 'rgba(220,220,220,0.9)'; // the solid edge line itself
const DISC_BORDER_RIM_COLOR = 'rgba(120,120,120,0.5)'; // the slightly lighter rim band fill

// --- Full-circle fit (2026-09-27, maintainer decision) --------------------------------------
// Every ring/disc radius in this file is a fraction of a single "basis" length. That basis used to
// be plain Math.min(W, H): on a landscape screen (W > H) that puts the disc's outer edge
// (DISC_BORDER_OUTER_RADIUS_FRACTION * H = 0.792*H from a center near H/2) closer to the top/bottom
// edge than DISC_EDGE_MARGIN_PX allows, clipping it. sceneBasis() instead picks the largest basis
// whose disc border still leaves this margin on every side, capped at the historical min(W, H) so a
// tall/narrow viewport never makes the composition bigger than its original design.
const DISC_EDGE_MARGIN_PX = 25;
// Never let a pathologically tiny canvas (e.g. a stray 0x0/10x10 resize event mid-layout) collapse
// the fitted basis into 0 or negative, which would turn every ring fraction into degenerate/
// overlapping geometry.
const SCENE_BASIS_MIN_PX = 10;

function sceneBasis(W, H) {
  const cx = W * CENTER_X_FRACTION;
  const cy = H * CENTER_Y_FRACTION;
  const roomToNearestEdge = Math.min(cy, H - cy, cx, W - cx) - DISC_EDGE_MARGIN_PX;
  const fittedBasis = roomToNearestEdge / DISC_BORDER_OUTER_RADIUS_FRACTION;
  return Math.max(SCENE_BASIS_MIN_PX, Math.min(Math.min(W, H), fittedBasis));
}

// mini-scene-window T2: the `?variant=mini` fit. The corner window is a small square, so the ring is
// centered and its disc border is fitted to min(W, H) with a small margin (the full scene's
// sceneBasis() fits it to a landscape screen instead, off-center by CENTER_X_FRACTION).
// T2c: the disc border's outer radius is this fraction of the short side, kept inside the mini edge
// fade's opaque radius (MINI_EDGE_FADE_INNER = 0.41, shared/js/render-loop.js) so the mask never clips it.
const MINI_RING_RADIUS_FRACTION = 0.40;
// T2i: the occluding base drawn under every mini ring band (see animate.js's drawMiniRingBases): the scene's own
// background #01040a at alpha 0.9, enough that white text behind the topmost window cannot be read through a band.
const MINI_RING_BASE_COLOR = 'rgba(1,4,10,0.9)';

// The basis the composition is actually drawn with: the mini fit in the mini variant, else the full one.
// (isMiniVariant comes from shared/js/render-loop.js, resolved at call time.)
function activeSceneBasis() {
  return isMiniVariant ? miniSceneBasis(W, H) : sceneBasis(W, H);
}

// The fit rule itself lives in shared/js/render-loop.js (miniRingBasis), shared with the other scene.
function miniSceneBasis(W, H) {
  return miniRingBasis(W, H, MINI_RING_RADIUS_FRACTION, DISC_BORDER_OUTER_RADIUS_FRACTION, SCENE_BASIS_MIN_PX);
}

const STARFIELD_INNER_RADIUS_FRACTION = 0.792; // stars begin just beyond the stone disc border (IDL-12: was 0.78)
const STARFIELD_COUNT = 420; // sparse, deterministic distant stars
// IDL-13: raised noticeably on user request ("stars should read brighter") — size 0.5/1.8 ->
// 0.9/2.6 and alpha 0.15/0.75 -> 0.4/1.0 (a star at its brightest/nearest now reaches full
// opacity instead of topping out at 0.75). See drawStarfield (rings.js) for the accompanying
// floor/glow adjustments so the brighter range actually reads on screen instead of being masked
// by the existing dark-side dimming.
const STARFIELD_MIN_SIZE = 0.9; // px (before DPR scaling), at the FAR end of the depth travel
const STARFIELD_MAX_SIZE = 2.6; // px, at the NEAR end of the depth travel (see STARFIELD_DRIFT_*)
const STARFIELD_MIN_ALPHA = 0.4;
const STARFIELD_MAX_ALPHA = 1.0;
const STARFIELD_COLOR = '255,255,255'; // grayscale-white stars, rgb triplet only (alpha applied per star)
// IDL-11: "travelling through space" depth drift. Deterministic and periodic — no Math.random per
// frame. Each star has a fixed seeded angle and a fixed seeded phase in [0, 1); its position along
// the travel path at time t is radialT = fract(t / STARFIELD_DRIFT_PERIOD_SECONDS * speedJitter +
// phase), i.e. exactly the f((t*speed + phase) mod 1) form requested. radialT=0 means "just beyond
// the disc border, far and dim"; radialT=1 means "off past the screen edge, near and bright" —
// stars are redrawn continuously from radialT=0 as soon as they pass 1, so new ones keep emerging
// while old ones leave the screen, with no per-frame allocation (the same STARFIELD_COUNT points
// are reused forever). Kept subtle/slow per the brief: one full traversal takes several minutes.
// IDL-12: 8x faster per user request (240 -> 30 seconds per full traversal); still fully
// deterministic/periodic (see drawStarfield in rings.js), just a shorter period.
const STARFIELD_DRIFT_PERIOD_SECONDS = 30; // seconds for one star to travel from radialT=0 to 1
const STARFIELD_DRIFT_SPEED_JITTER_MIN = 0.75; // per-star speed multiplier range, seeded (not random per frame)
const STARFIELD_DRIFT_SPEED_JITTER_MAX = 1.25;

// --- Lighting / vignette --------------------------------------------------------
// Fit against pixel-sampled brightness in the reference at several angles around the alphabet
// ring (see math.js): a cosine main lobe plus a small slowly-fading ambient floor, symmetric
// left/right around straight up. Everything below ~140-150deg is effectively black except the
// bottom rainbow glow and the Earth's own dim lower half (lit separately, see earth.js).
// IDL-6: bottom darkening halved on user request (bottom of the rings should read about twice as
// bright as before) while keeping the top the brightest point — done by roughly doubling the
// ambient floor and extending how far it reaches, not by touching the top-lobe weight.
const LIGHT_TOP_BRIGHTNESS = 1.0;
const LIGHT_BOTTOM_BRIGHTNESS = 0.0; // fully black only exactly at the bottom of the ring system
const LIGHT_COSINE_WEIGHT = 0.88; // weight of the main cosine lobe (matches the 0-90deg falloff)
const LIGHT_AMBIENT_FLOOR = 0.24; // residual brightness past the main lobe (was 0.12; doubled for IDL-6)
const LIGHT_AMBIENT_FADE_ANGLE = (170 * Math.PI) / 180; // the ambient floor fades to 0 by this angle (was 150deg)
// IDL-11: the top-through-side falloff above (0-90deg) is kept exactly as measured/fit in earlier
// rounds — only the far side/bottom region was too dark to read. LIGHT_BOTTOM_FLOOR is a hard
// floor the brightness asymptotically approaches as the angle reaches straight-down (180deg from
// top): verticalLightBrightness takes max(oldCurve, LIGHT_BOTTOM_FLOOR * distanceFromTop/PI), so
// anywhere the old curve is already above this ramp (the whole top/side region) is untouched, and
// only the region where the old curve had already faded toward 0 gets lifted, smoothly, toward
// this floor. 0.45 puts true-bottom brightness at 45% of top, inside the requested 40-50% band;
// the conic gradient mask (animate.js) and Earth's own lighting (earth.js, EARTH_NIGHT_FLOOR/
// EARTH_TERMINATOR_SOFTNESS) are unrelated code paths and were not touched, per the user's request
// that only the rings' floor move — Earth's own dim-but-visible lower half was already tuned
// separately in IDL-4/5 and stays as-is.
const LIGHT_BOTTOM_FLOOR = 0.45;
// IDL-6 monochrome: neutral near-black background (was navy-tinted #01040a).
const BACKGROUND_COLOR = '#020202';
const VIGNETTE_INNER_STOP = 0.50;
const VIGNETTE_OUTER_ALPHA = 0.90;

// IDL-11: the old persistent below-Earth star (fixed position/size/intensity) is removed — it
// never moved, so it read as a static prop once the rest of the scene was animated. Its warm
// white color is kept and reused below for the rising glow sparks, drawn with the shared,
// reusable drawSpark(x, y, size, intensity, color) (see rings.js).
const GLOW_SPARK_COLOR = 'rgba(255,250,235,0.95)';

// The ONLY color left in the whole scene per the IDL-6 monochrome request: a faint warm-to-green
// chromatic glow rising from the bottom edge; no flat grey ellipse shape. IDL-8: animated by
// drawChromaticGlowAnimated(context, cx, earthCy, timeSeconds) in animate.js — several stacked
// soft round glows whose brightness slowly undulates over time, plus rising drawSpark light
// points that spawn near the glow, brighten, then fade before reaching earthCy (the Earth's
// horizontal middle line). See GLOW_SPARK_* below for the particle schedule.
const CHROMATIC_GLOW_Y_FRACTION = 1.0;
const CHROMATIC_GLOW_RADIUS_FRACTION = 0.075; // fraction of min(W,H) per stacked glow
// IDL-13: the old CHROMATIC_GLOW_HEIGHT_FRACTION (a fixed 0.20 of H) is removed — the user asked
// for the column to rise until its top touches the Earth's bottom limb, which only holds at one
// specific aspect ratio/resolution with a magic fraction. drawChromaticGlowAnimated (animate.js)
// now derives the column height at runtime from the actual Earth geometry it is passed
// (baseY - (earthCy + earthRadius)), so it stays correct at any resolution.
const CHROMATIC_GLOW_COLORS = ['rgba(255,150,120,0.10)', 'rgba(255,210,120,0.09)', 'rgba(140,255,170,0.08)', 'rgba(120,200,255,0.05)'];
// IDL-14: with the taller IDL-13 column, the 4 stacked glows sat too far apart (gaps darker than
// the glows) and each was too faint to read. The column is now sampled as CHROMATIC_GLOW_SAMPLE_COUNT
// overlapping glows whose color is interpolated between the CHROMATIC_GLOW_COLORS stops, so it
// reads as one continuous gradient; CHROMATIC_GLOW_INTENSITY scales every stop's alpha on top.
const CHROMATIC_GLOW_SAMPLE_COUNT = 16; // overlapping glows along the column (spacing well under one radius)
const CHROMATIC_GLOW_INTENSITY = 2.2; // alpha multiplier applied to every interpolated color stop
// IDL-16: the column read as a straight vertical bar (every stacked glow the same radius). Widened
// into a fan/inverted cone: drawChromaticGlowAnimated (animate.js) now draws each sample as an
// ellipse (radial gradient under a horizontal-only context.scale), radius multiplier 1 at the tip
// touching the Earth's bottom limb (unchanged from before) growing to this value at the bottom
// (screen edge) sample. Only the x-radius grows — the y-radius (and therefore the existing sample
// spacing/vertical continuity) is untouched, so this only needs "horizontal widening" as requested,
// not a taller column or more samples.
// 2026-09-27: doubled (3.5 -> 7) per the maintainer, the fan base still read too thin after the
// chroma-width fix; the tip is unchanged, so the fan keeps thinning toward the Earth.
const CHROMATIC_GLOW_BASE_WIDTH_SCALE = 7; // ellipse x-radius multiplier at the bottom sample (t=0)
// mini-scene-window T2b: alpha multiplier on the fan in the mini variant. The fan is additive ('lighter')
// and faint by design (it glows against black); on a see-through window there is no dark backdrop to
// build contrast against, so the mini fan is boosted to read on its own. Never used by the full scene.
const MINI_CHROMATIC_GLOW_GAIN = 4;

// --- IDL-8 animation tunables ----------------------------------------------------------------
// Every speed/direction below is user-tunable; defaults are deliberately slow (this is a desktop
// wallpaper, not a video). Angles are in radians/second unless noted otherwise; positive spins
// counter-clockwise (standard canvas angle convention used everywhere else in this scene).

// Earth: degrees per second the surface rotates about its vertical axis (longitude advances).
// 360/86400 would be one real day; this is deliberately much slower/simpler for a wallpaper.
// IDL-11: doubled (0.6 -> 1.2). IDL-12: doubled again (1.2 -> 2.4). IDL-13: doubled again
// (2.4 -> 4.8) per user request; direction (sign) unchanged every time.
const EARTH_ROTATION_DEGREES_PER_SECOND = 4.8;

// One angular speed (radians/second) per rotating ring, alternating direction by convention
// (odd-indexed rings spin the opposite way) so neighboring rings visibly counter-rotate. The
// stone border and starfield are not in this list — they stay fixed (starfield: see
// STARFIELD_TWINKLE_* below for its only permitted motion, plus the IDL-11 depth drift below).
// IDL-11: every speed doubled. IDL-12: doubled again. IDL-13: doubled again per user request;
// signs (directions) unchanged every time. Note: STARFIELD_DRIFT_PERIOD_SECONDS (a drift, not a
// rotation) is deliberately NOT touched by this repeated doubling — see its own comment below.
const CONSTELLATION_ROTATION_SPEED = 0.080; // rad/s
const HIEROGLYPH_ROTATION_SPEED = -0.056; // rad/s
const ALPHABET_ROTATION_SPEED = 0.040; // rad/s
const RULER_ROTATION_SPEED = -0.112; // rad/s
const PARAGRAPH_ROTATION_SPEED = 0.064; // rad/s
const OUTER_GLYPH_ROTATION_SPEED = -0.032; // rad/s

// Ring content cache: each rotating ring is pre-rendered once (at full brightness, no lighting)
// into an offscreen canvas covering its full bounding box; per frame it is drawn rotated, then
// the screen-fixed lighting mask (also cached, rebuilt only on resize) is composited on top so
// lighting stays fixed to the screen while the ring content turns underneath it. A little
// resolution headroom keeps rotated content from softening too much.
const RING_CACHE_OVERSAMPLE = 1.25;
// Number of color stops sampled from verticalLightBrightness to build each ring's lighting mask
// as a native createConicGradient (continuous, no seams — replaced an earlier discrete-wedge
// approach that showed visible brightness-step seams). More stops track sharp curve changes
// (e.g. near the bright-to-ambient transition) more closely; 720 is 2 stops per degree, well
// past what the eye can resolve as a step.
const LIGHTING_MASK_GRADIENT_STOPS = 720;

// Chromatic glow flow: slow per-channel brightness undulation, one period (seconds) per color
// stop, offset so they do not all peak together.
const CHROMATIC_GLOW_FLOW_PERIOD_SECONDS = 9;

// Rising spark particles spawned near the chromatic glow: deterministic seeded schedule (spawn
// times/positions/lifetimes computed once from a seed, keyed off elapsed time — no per-frame
// Math.random). A handful alive at once; each rises slowly, brightens, then fades before
// reaching the Earth's horizontal middle line (EARTH_CENTER_Y_FRACTION).
const GLOW_SPARK_SEED = 0x9a5a1e5f;
// IDL-16: doubled (4 -> 8) alongside the halved spawn interval below, per user request for
// roughly twice as many sparks visible at once (~2 fading while another ~2 rise, doubled to ~4/4).
const GLOW_SPARK_MAX_ALIVE = 8;
// IDL-13: sparks now rise the full distance from the glow's base (baseY = H, see
// CHROMATIC_GLOW_Y_FRACTION) to the Earth's horizontal middle line (earthCy) — see
// drawChromaticGlowAnimated (animate.js), which derives the actual rise distance at runtime as
// (baseY - earthCy) instead of the old fixed GLOW_SPARK_RISE_FRACTION (0.16 of H). That derived
// distance is (1 - EARTH_CENTER_Y_FRACTION) = 0.526 of H, i.e. GLOW_SPARK_RISE_DISTANCE_GROWTH =
// 0.526/0.16 = ~3.29x farther than before.
const GLOW_SPARK_RISE_DISTANCE_GROWTH = (1 - EARTH_CENTER_Y_FRACTION) / 0.16;
// IDL-16: the spawn-interval base multiplier is halved (1.0 -> 0.5) so the expected alive count
// (Little's law: lifetime/interval) doubles from ~3.6 to ~7.2, matching the user's "roughly double"
// request (mean ~6-7, capped by GLOW_SPARK_MAX_ALIVE above at 8). GLOW_SPARK_LIFETIME_SECONDS is
// deliberately left scaled by the same GLOW_SPARK_RISE_DISTANCE_GROWTH as before (not touched by
// this halving) so the rise SPEED (distance/lifetime) is unchanged — only the spawn rate doubled.
const GLOW_SPARK_SPAWN_INTERVAL_SECONDS = 0.5 * GLOW_SPARK_RISE_DISTANCE_GROWTH; // average seconds between spawns (~1.65s)
const GLOW_SPARK_LIFETIME_SECONDS = 3.6 * GLOW_SPARK_RISE_DISTANCE_GROWTH; // how long each spark takes to rise and fully fade (~11.84s), unchanged
// IDL-13: doubled per user request (0.006 -> 0.012) so sparks read more visibly.
const GLOW_SPARK_SIZE_FRACTION = 0.012; // fraction of min(W,H)
const GLOW_SPARK_MAX_INTENSITY = 0.8;
const GLOW_SPARK_HORIZONTAL_JITTER_FRACTION = 0.05; // fraction of min(W,H), seeded per spark
// IDL-9: the spawn schedule is periodic (wraps every GLOW_SPARK_SCHEDULE_ENTRIES spawns, i.e.
// every ~GLOW_SPARK_SCHEDULE_ENTRIES*GLOW_SPARK_SPAWN_INTERVAL_SECONDS seconds) instead of a long
// but finite list, so sparks keep spawning indefinitely for a wallpaper that runs for hours or
// days. IDL-16: the spawn interval above halved, so 512 entries now gives a repeat period of
// roughly 14 minutes (was ~28 at the pre-IDL-16 interval) — still long enough that the repetition
// is not obviously noticeable during ordinary wallpaper viewing — while the precomputed table
// itself stays tiny (well under what could ever matter for load time or memory).
const GLOW_SPARK_SCHEDULE_ENTRIES = 512;

// Starfield: stays static by default; a very subtle twinkle is optional and off unless a
// non-zero amplitude is set (kept minimal so it costs almost nothing per frame).
const STARFIELD_TWINKLE_AMPLITUDE = 0.15; // 0 disables twinkle entirely; else +-this fraction of each star's alpha
const STARFIELD_TWINKLE_PERIOD_SECONDS = 6; // one full brighten/dim cycle, offset per star
