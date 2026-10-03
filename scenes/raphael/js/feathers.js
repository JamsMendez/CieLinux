// html-wallpaper-demo D6b: copied verbatim from docs/great-sage/background-raphael/js/feathers.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged.

// feathers.js — pure descriptors, motion, and gold-tint math for the translucent white "feather"
// layer (Raphael): quill-shaped (a spine curve with soft vanes) strokes that emit from the core and
// tint from white toward gold near it and/or a golden inclined ray. Loads after config.js and
// math.js; touches no DOM/ctx, so every function here is directly testable through the vm harness.
// js/layers.js's drawFeathers/featherState/featherColor consume these to paint the actual layer.
//
// RAP-10 (user feedback): "las plumas deben tener el mismo efecto que las partículas que salen del
// centro" — motion mirrors js/layers.js's drawStars particle formulas exactly (seeded angle/lane/z,
// the same non-linear outward-distance curve, size growing with z), replacing the earlier
// drift-in-place motion. The one deliberate departure: the alpha envelope below ramps to ~0 at
// both z=0 and z=1 (drawStars' plain `0.08 + z * 0.78` does not), so with feathers' much lower
// density the fract() wrap at z=1 -> z=0 is never visible as a pop.

// RAP-12 (review advisory fix): the ping-pong progress `p` peaks at exactly this value (see
// main.js's animationProgress — pingpong01's own argument scale cancels out, leaving this ratio),
// so a feather whose z-advance/spin complete a whole number of cycles by the time p reaches this
// value returns to its EXACT starting position/orientation at the leg boundary, not just a
// continuous one. Computed from config.js's own constants rather than hardcoded, so it never
// silently drifts out of sync if those are retuned.
const FEATHER_LEG_PROGRESS = ONE_WAY_DURATION / ANIMATION_CYCLE_DURATION;

// The speedVariance that makes featherZ complete exactly `cycles` full [0,1) cycles by p =
// FEATHER_LEG_PROGRESS (see featherZ below: z simply advances by p * speedVariance now — RAP-28
// removed the old extra `* FEATHER_SPEED_MULTIPLIER * FEATHER_FALL_SPEED` multiplication, which
// canceled out algebraically against this function's own denominator and made both constants a
// no-op; FEATHER_FALL_SPEED's effect is now baked into `cycles` itself, by featherCyclesForPeriod
// below, before it ever reaches this function).
function featherSpeedForCycles(cycles) {
  return cycles / FEATHER_LEG_PROGRESS;
}

// The spinSpeed that makes a feather's orientation complete exactly `cycles` full turns (possibly
// negative, possibly zero) by p = FEATHER_LEG_PROGRESS.
function featherSpinForCycles(cycles) {
  return cycles / FEATHER_LEG_PROGRESS;
}

// RAP-23: the general form of featherSpinForCycles above, reused by every new periodic motion term
// (sway/flutter/rock/tumble) below — a rate such that rate * p advances by exactly `cycles`
// full [0,1)-or-TAU cycles over one ping-pong leg (p: 0 -> FEATHER_LEG_PROGRESS), so any sin/cos/
// fract() built from it returns to its EXACT starting value at the leg boundary regardless of the
// additive phase seeded alongside it.
function featherCyclesRate(cycles) {
  return cycles / FEATHER_LEG_PROGRESS;
}

// RAP-28 (user feedback: "el movimiento de las plumas lo veo lento"). Converts a REAL-TIME target
// period (seconds for one full cycle, AT FEATHER_FALL_SPEED=1 — e.g. FEATHER_CROSSING_SECONDS_MIN/
// MAX) into the integer "cycles per ping-pong leg" every featherSpeedForCycles/featherSpinForCycles/
// featherCyclesRate above actually consumes. One leg lasts ONE_WAY_DURATION real seconds (see
// js/main.js's animationProgress: p reaches FEATHER_LEG_PROGRESS exactly when ms/1000 reaches
// ONE_WAY_DURATION), so `ONE_WAY_DURATION * FEATHER_FALL_SPEED` real "fall-speed-scaled" seconds
// happen per leg; dividing by the requested period and rounding gives the nearest whole cycle count
// (clamped to >= 1, so an extreme period never asks for zero cycles) — exact wrap continuity holds
// for ANY FEATHER_FALL_SPEED value, since round() always yields an integer, but the RESULT (unlike
// RAP-27's canceled-out design) now actually reflects both the requested period and FALL_SPEED.
function featherCyclesForPeriod(periodSeconds) {
  return Math.max(1, Math.round((ONE_WAY_DURATION * FEATHER_FALL_SPEED) / periodSeconds));
}

// RAP-19b (parent-confirmed review defect): js/layers.js's featherState used to compute this
// inline as `phase * feather.spinSpeed`, and the continuity test re-derived the same arithmetic by
// hand instead of calling real code — so a bug in the actual spin path would have gone undetected.
// This is now the one real function featherState calls, driven by `p` — the SAME progress variable
// featherZ/featherOffset use for the outward motion — so both z-advance and spin share one source
// of truth. Turns * TAU: continuous (returns to an exact multiple of TAU) at p =
// FEATHER_LEG_PROGRESS because featherSpinForCycles chose spinSpeed as an exact integer number of
// turns over that same span.
function featherSpinAngle(feather, p) {
  return p * TAU * feather.spinSpeed;
}

// RAP-12 follow-up (user reference: plumas.avif — "quiero unos diseños así"). A small seeded
// catalog of feather-shape variants (silhouette proportions/curl/asymmetry/notches), baked once
// into cached sprites (js/sprites.js's paintFeatherVariant); every feather instance below just
// picks one by index, so the actual shape geometry is never rebuilt per frame or per instance.
function createFeatherVariant(index) {
  const random = mulberry32((0x6a11f3c7 + index * 0x9e3779b9) >>> 0);
  const notchCount = FEATHER_VARIANT_NOTCH_MIN + Math.floor(random() * (FEATHER_VARIANT_NOTCH_MAX - FEATHER_VARIANT_NOTCH_MIN + 1));
  return {
    aspect: FEATHER_VARIANT_ASPECT_MIN + random() * (FEATHER_VARIANT_ASPECT_MAX - FEATHER_VARIANT_ASPECT_MIN),
    // Most variants curl gently one direction; the `- 0.35` bias occasionally lets a few curl
    // noticeably more or the other way, like the curled feathers in the reference image.
    curve: (random() - 0.35) * FEATHER_VARIANT_CURVE_RANGE,
    // >1 = the top vane reads wider than the bottom one, <1 = the reverse (never symmetric).
    vaneBias: 0.65 + random() * 0.7,
    notchCount,
    // Small edge "splits" sit along the tapering mid-to-tip zone, never right at the base or tip.
    notchPositions: Array.from({ length: notchCount }, () => 0.25 + random() * 0.55),
    // Small angular jitter per barb (fine diagonal strokes) and wisp (downy afterfeather hair),
    // pre-seeded here so js/sprites.js's paint functions never call mulberry32 themselves.
    barbAngles: Array.from({ length: FEATHER_VARIANT_BARB_COUNT }, () => (random() - 0.5) * 0.6),
    wispAngles: Array.from({ length: FEATHER_VARIANT_WISP_COUNT }, () => (random() - 0.5) * TAU),
  };
}

const FEATHER_VARIANTS = Array.from({ length: FEATHER_VARIANT_COUNT }, (_, index) => createFeatherVariant(index));

function createFeathers(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('Feather count must be a non-negative integer.');
  }
  return Array.from({ length: count }, (_, index) => {
    const random = mulberry32((0x2f8a1c3d + index * 0x9e3779b9) >>> 0);
    // RAP-28: every one of these is now a real-time period (seconds, at FEATHER_FALL_SPEED=1),
    // seeded within its configured range and converted to an exact integer cycle count by
    // featherCyclesForPeriod — see its own comment for why this makes FEATHER_FALL_SPEED (and the
    // requested period) actually change the speed, while continuity stays exact regardless.
    const crossingSeconds = FEATHER_CROSSING_SECONDS_MIN + random() * (FEATHER_CROSSING_SECONDS_MAX - FEATHER_CROSSING_SECONDS_MIN);
    const speedCycles = featherCyclesForPeriod(crossingSeconds);
    const spinSign = random() < 0.5 ? -1 : 1;
    const spinSeconds = FEATHER_SPIN_SECONDS_MIN + random() * (FEATHER_SPIN_SECONDS_MAX - FEATHER_SPIN_SECONDS_MIN);
    const spinCycles = spinSign * featherCyclesForPeriod(spinSeconds);
    const blurred = random() < FEATHER_BLUR_FRACTION;
    return {
      angle: random() * TAU,
      // Same distribution as background stars' `lane` (scene-data.js's seededStar): per-particle
      // elongation of the outward reach, so feathers spread unevenly like a real particle stream.
      lane: 0.16 + random() * 1.34,
      z: random(), // initial emission phase, like a star's initial z
      // Integer cycle tiers (see featherSpeedForCycles/featherSpinForCycles above), not a
      // continuous random range: guarantees exact continuity at the ping-pong leg boundary.
      speedVariance: featherSpeedForCycles(speedCycles),
      // Small seeded tilt off the pure radial direction, plus a slow seeded integer-turn spin, so
      // each feather reads as an oriented feather riding outward, not a rigid radial streak.
      tiltSeed: (random() - 0.5) * 0.6,
      spinSpeed: featherSpinForCycles(spinCycles),
      length: FEATHER_LENGTH_MIN + random() * (FEATHER_LENGTH_MAX - FEATHER_LENGTH_MIN),
      // Silhouette shape (including curl) comes from the assigned variant below, not a per-instance
      // curve — every feather sharing a variant shares its exact baked silhouette.
      variantIndex: Math.floor(random() * FEATHER_VARIANT_COUNT),
      blurred,
      alpha: blurred
        ? FEATHER_BLUR_ALPHA_MIN + random() * (FEATHER_BLUR_ALPHA_MAX - FEATHER_BLUR_ALPHA_MIN)
        : FEATHER_ALPHA_MIN + random() * (FEATHER_ALPHA_MAX - FEATHER_ALPHA_MIN),
      // RAP-23 ("se mece, gira, da una pirueta") / RAP-28 (real-time periods): seeded natural-motion
      // fields, every rate an integer number of cycles per ping-pong leg (featherCyclesRate, fed by
      // featherCyclesForPeriod's real-seconds-to-cycles conversion), so nothing is recomputed per
      // frame, every term stays exactly continuous at the leg boundary, AND the seconds now say
      // what the motion actually looks/feels like — "que la tumbación escale con la caída".
      swayAmplitude: FEATHER_SWAY_AMPLITUDE_MIN + random() * (FEATHER_SWAY_AMPLITUDE_MAX - FEATHER_SWAY_AMPLITUDE_MIN),
      swayRate: featherCyclesRate(featherCyclesForPeriod(FEATHER_SWAY_SECONDS_MIN + random() * (FEATHER_SWAY_SECONDS_MAX - FEATHER_SWAY_SECONDS_MIN))),
      swayPhase: random() * TAU,
      flutterAmplitude: FEATHER_FLUTTER_AMPLITUDE_MIN + random() * (FEATHER_FLUTTER_AMPLITUDE_MAX - FEATHER_FLUTTER_AMPLITUDE_MIN),
      flutterRate: featherCyclesRate(featherCyclesForPeriod(FEATHER_FLUTTER_SECONDS_MIN + random() * (FEATHER_FLUTTER_SECONDS_MAX - FEATHER_FLUTTER_SECONDS_MIN))),
      flutterPhase: random() * TAU,
      // RAP-30: rocks IN PHASE with the sway above (same swayRate/swayPhase, no phase of its own) —
      // "como una hoja que se mece al caer" — so a feather's tilt always correlates with which way
      // it's currently swaying, never independently facing the viewer edge-on.
      rockAmplitude: FEATHER_ROCK_AMPLITUDE_MIN + random() * (FEATHER_ROCK_AMPLITUDE_MAX - FEATHER_ROCK_AMPLITUDE_MIN),
      // RAP-31 (restored — user: "dejemos el 3D"): the 3D-flip tumble, independent of (and slower
      // than) flutter, driving featherFlipScaleX's aspect squash.
      tumbleRate: featherCyclesRate(featherCyclesForPeriod(FEATHER_TUMBLE_SECONDS_MIN + random() * (FEATHER_TUMBLE_SECONDS_MAX - FEATHER_TUMBLE_SECONDS_MIN))),
      tumblePhase: random() * TAU,
    };
  });
}

const FEATHER_FIELDS = createFeathers(FEATHER_COUNT);

// The emission phase in [0,1): 0 = just emitted at the core, wraps back to 0 after 1 (fract()), so
// the cycle repeats seamlessly. RAP-28: speedVariance alone already encodes the real-time crossing
// speed (featherCyclesForPeriod, folded in when it was derived — see createFeathers), so no extra
// multiplier is applied here (RAP-27's `* FEATHER_SPEED_MULTIPLIER * FEATHER_FALL_SPEED` canceled
// out against featherSpeedForCycles' own denominator and was a no-op).
function featherZ(feather, p) {
  return fract(feather.z + p * feather.speedVariance);
}

// RAP-27 (user feedback): "como si tomara una [pluma] y la soltara" — quick initial acceleration
// right at emission, then a drag-limited drift as it nears the outer edge, via an ease-out curve
// (1-(1-z)^FEATHER_RADIAL_DRAG_POWER: largest slope at z=0, tapering to ~0 by z=1). Base offset
// (0.018) and max reach (1.18, so the value at z=1 is still exactly 1.198) are unchanged from the
// old pure power>1 curve, so the overall outward reach stays the same — only the SHAPE changes.
function featherRadialFactor(z) {
  return 0.018 + (1 - Math.pow(1 - z, FEATHER_RADIAL_DRAG_POWER)) * 1.18;
}

// Mirrors drawStars' particle size-vs-z growth curve, independently scaled by
// FEATHER_SIZE_MULTIPLIER.
function featherSizeScale(z) {
  return (0.42 + z * 1.38) * FEATHER_SIZE_MULTIPLIER;
}

// Bounded in [0,1] by construction: smoothstep's own range is [0,1], and the product of two such
// factors stays within it. Zero at both z=0 and z=1 (a feather fades in just after emission and
// fades out just before its fract() wrap), peaking near the middle of its outward journey.
function featherAlphaEnvelope(z) {
  return smoothstep(0, FEATHER_FADE_IN, z) * (1 - smoothstep(FEATHER_FADE_OUT, 1, z));
}

// RAP-23 ("se mece" — a falling feather's lateral pendulum sway): a signed displacement along the
// direction perpendicular to the feather's travel angle, in min(width,height)-fraction units.
// Guarded to return exactly 0 when a feather instance has no seeded swayAmplitude (an older/
// synthetic feather object, as several tests above construct directly), so featherOffset below stays
// backward-compatible instead of producing NaN.
function featherSwayOffset(feather, p) {
  const amplitude = feather.swayAmplitude ?? 0;
  if (amplitude === 0) return 0;
  return amplitude * Math.sin(p * TAU * feather.swayRate + feather.swayPhase);
}

// RAP-23 ("gira" — a fast, small-amplitude rotational wobble), layered on top of the existing slow
// spin (featherSpinAngle) rather than replacing it. Same NaN-safe guard as featherSwayOffset.
function featherFlutterAngle(feather, p) {
  const amplitude = feather.flutterAmplitude ?? 0;
  if (amplitude === 0) return 0;
  return amplitude * Math.sin(p * TAU * feather.flutterRate + feather.flutterPhase);
}

// RAP-30 (user feedback): "cámbiala para que sea como las otras, que se mueven hacia los lados" —
// replaces the removed 3D tumble/flip squash. Reuses the SAME rate and phase as featherSwayOffset
// (feather.swayRate/swayPhase — no rate/phase of its own), so this is EXACTLY in phase with the
// lateral sway: "como una hoja que se mece al caer" — a feather's tilt rocks toward whichever side
// it's currently swaying, never independently. Same NaN-safe guard as featherSwayOffset/
// featherFlutterAngle.
function featherRockAngle(feather, p) {
  const amplitude = feather.rockAmplitude ?? 0;
  if (amplitude === 0) return 0;
  return amplitude * Math.sin(p * TAU * feather.swayRate + feather.swayPhase);
}

// RAP-31 (restored — user: "dejemos el 3D"): a continuous "3D flip" angle, independent of (and
// slower than) the flutter wobble above, driving the aspect squash in featherFlipScaleX below.
function featherTumbleAngle(feather, p) {
  const rate = feather.tumbleRate ?? 0;
  const phase = feather.tumblePhase ?? 0;
  if (rate === 0) return phase;
  return p * TAU * rate + phase;
}

// RAP-31 (restored — user feedback): "slight scale/aspect squash simulating 3D flip: scaleX =
// |cos(flipAngle)| clamped >= 0.15" — a feather reads narrower as it tumbles edge-on, never fully
// vanishing.
function featherFlipScaleX(feather, p) {
  return Math.max(FEATHER_FLIP_SCALE_MIN, Math.abs(Math.cos(featherTumbleAngle(feather, p))));
}

// The feather's (dx, dy) offset from its emission center, in CSS pixels, at animation progress
// `p` for the given viewport size — same 0.77/0.91 viewport-fraction reach and per-particle `lane`
// elongation as drawStars' x/y formula, plus RAP-23's lateral sway (perpendicular to the travel
// angle, scaled by how far the feather has already traveled so it grows into the sway rather than
// swaying immediately at emission), returned center-relative so this stays independent of where the
// caller places the actual center (cx, cy).
function featherOffset(feather, p, width, height) {
  const z = featherZ(feather, p);
  const d = featherRadialFactor(z);
  const reference = Math.min(width, height);
  const sway = featherSwayOffset(feather, p) * d * reference;
  const perpAngle = feather.angle + Math.PI / 2;
  return {
    z,
    dx: Math.cos(feather.angle) * width * 0.77 * d * feather.lane + Math.cos(perpAngle) * sway,
    dy: Math.sin(feather.angle) * height * 0.91 * d + Math.sin(perpAngle) * sway,
  };
}

// Gold-tint amount in [0,1]: 1 = fully golden-lit, 0 = plain translucent white. Monotonically
// non-increasing as `distance` (normalized 0..1+ from the core) grows, and monotonically
// non-decreasing in `rayProximity` (0..1, closeness to a currently-visible golden ray) — a
// standard bounded "OR" blend, so neither light source can push the result out of [0,1].
function featherTint(distance, rayProximity) {
  const distanceLight = 1 - smoothstep(FEATHER_TINT_NEAR, FEATHER_TINT_FAR, Math.max(0, distance));
  const rayLight = clamp01(rayProximity) * FEATHER_TINT_RAY_WEIGHT;
  return clamp01(distanceLight + rayLight - distanceLight * rayLight);
}
