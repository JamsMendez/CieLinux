// html-wallpaper-demo D6b: copied verbatim from docs/great-sage/background-raphael/js/digits.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged.

// digits.js — procedural stroke "digit" glyphs (0-9 plus one separator) in glyphs.js's hieroglyph
// style, for the two persistent glyph-style edge counters (Raphael). Loads after config.js,
// math.js, and glyphs.js (reuses makeHieroglyph/strokesBounds); touches no DOM/ctx.

// Each digit reuses makeHieroglyph exactly as any other pooled glyph does (glyphs.js's
// GLYPH_TEXT_POOL), just with its own seed base (DIGIT_GLYPH_SEED, config.js) so this pool is
// independent of — and never shifts — the glyph-ring pool's indices.
const DIGIT_GLYPHS = Array.from({ length: 10 }, (_, digit) => makeHieroglyph(digit, DIGIT_GLYPH_SEED));
// Index 10 in the same seeded stream: distinct from every digit by construction (mulberry32 is
// reseeded per index), never drawn as a digit itself.
const DIGIT_SEPARATOR_GLYPH = makeHieroglyph(10, DIGIT_GLYPH_SEED);

// Formats `counter` (matching the failure overlay's 0..99, wrapping bit counter) as a "00:NN"
// style readout: two leading zero digits, a separator, then the tens and ones digits of
// `counter % 100`. Returns an array whose entries are either a DIGIT_GLYPHS index (a digit) or the
// string 'separator' (js/layers.js's drawGlyphCounterColumn maps each entry to its strokes).
function formatCounterDigits(counter) {
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error('Counter value must be a non-negative integer.');
  }
  const wrapped = counter % 100;
  const tens = Math.floor(wrapped / 10);
  const ones = wrapped % 10;
  return [0, 0, 'separator', tens, ones];
}

// RAP-11 (user feedback): the reference frame's edge panels show two independently-paced counters
// ("groups") of several digits each, separated by one separator glyph — denser and more visible
// than the earlier 5-character "00:NN" readout. `digitCount` least-significant-first digits of
// `counter` (so the least-significant, fastest-changing digit always renders first).
function formatCounterGroup(counter, digitCount) {
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error('Counter value must be a non-negative integer.');
  }
  if (!Number.isInteger(digitCount) || digitCount < 1) {
    throw new Error('Digit count must be a positive integer.');
  }
  return Array.from({ length: digitCount }, (_, index) => Math.floor(counter / 10 ** index) % 10);
}

// Combines two counter groups with one separator glyph between them, for one edge panel.
function formatPanelDigits(counterA, counterB) {
  return [
    ...formatCounterGroup(counterA, GLYPH_COUNTER_GROUP_DIGIT_COUNT),
    'separator',
    ...formatCounterGroup(counterB, GLYPH_COUNTER_GROUP_DIGIT_COUNT),
  ];
}

// RAP-11: one tall vertical panel rect (CSS pixels) per edge, from the GLYPH_COUNTER_PANEL_*
// viewport fractions in config.js.
function glyphCounterPanelRect(side, width, height) {
  const xMinFraction = side === 'left' ? GLYPH_COUNTER_PANEL_LEFT_X_MIN_FRACTION : GLYPH_COUNTER_PANEL_RIGHT_X_MIN_FRACTION;
  const xMaxFraction = side === 'left' ? GLYPH_COUNTER_PANEL_LEFT_X_MAX_FRACTION : GLYPH_COUNTER_PANEL_RIGHT_X_MAX_FRACTION;
  return {
    x: width * xMinFraction,
    y: height * GLYPH_COUNTER_PANEL_Y_MIN_FRACTION,
    width: width * (xMaxFraction - xMinFraction),
    height: height * (GLYPH_COUNTER_PANEL_Y_MAX_FRACTION - GLYPH_COUNTER_PANEL_Y_MIN_FRACTION),
  };
}

// The uniform glyph size (full local-box width) that fills exactly GLYPH_COUNTER_PANEL_GLYPH_FILL_
// FRACTION of the panel's own width — same "size = fraction * width / GLYPH_MAX_LOCAL_FULL_EXTENT"
// pattern as js/glyph-rings.js's glyphRingGlyphBounds, so this is an exact fit, not a guess.
//
// RAP-18 (review advisory fix): bounding by width alone let a panel with many digits (a short
// column spacing = panelHeight / (digitCount + 1)) pack glyphs closer together than one glyph's
// own length, causing visual overlap. The real size is the SMALLER of the width-fit and the
// spacing-fit, so a glyph never exceeds either budget.
function glyphCounterGlyphSize(panelWidth, panelHeight, digitCount, fraction = GLYPH_COUNTER_PANEL_GLYPH_FILL_FRACTION) {
  const widthFit = (panelWidth * fraction) / GLYPH_MAX_LOCAL_FULL_EXTENT;
  const spacing = panelHeight / (digitCount + 1);
  const spacingFit = (spacing * fraction) / GLYPH_MAX_LOCAL_FULL_EXTENT;
  return Math.min(widthFit, spacingFit);
}
