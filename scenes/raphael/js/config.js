// html-wallpaper-demo D6b: adapted from docs/great-sage/background-raphael/js/config.js (that tree
// is reference-only, excluded from git -- see the feature doc, "Source material"). The scene
// bootstrap and every tuning constant below are an intact port; only the SINGLE-overlay runtime
// state (failureState/failureKind/failureToggleRequested/failureStartMs/scenePausedMs) and the user
// zoom level are dropped here -- CielWin.App/Wallpaper/Web/shared/js/alert-overlay.js owns a
// per-KIND, tile-driven state machine instead (the same external contract
// CielWin.App/Alerts/Web/alert-layer.js exposes), and this wallpaper has no zoom UI to drive
// viewZoom away from 1 (see "Drop what a wallpaper does not need" -- same precedent as
// CielWin.App/Wallpaper/Web/processing/js/config.js's own D2 remarks). The FAILURE_SHAKE_MS/
// FAILURE_REVEAL_MS/FAILURE_OVERLAY_THEMES/etc. block the source declared here is dropped entirely
// (not merely moved, unlike processing's own D2->D6a history): the shared alert-overlay.js already
// declares those exact top-level `const` names, and this page loads both scripts, so keeping a second
// copy here would be a SyntaxError (duplicate top-level `const` declaration), not just redundant.
//
// Unlike CielWin.App/Wallpaper/Web/explorer/js/config.js (D6a), NOTHING needed to be ADDED here:
// this source already declares and computes canvasScaleX/canvasScaleY itself (see js/nebula.js's own
// resize(), copied verbatim below), which the shared alert overlay reads to lay out its tile mosaic in
// device pixels.
// config.js — canvas/DOM bootstrap, mutable scene state, and every user-tunable constant.
// Loads first: every other file reads names defined here. Depends on nothing.
const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d', { alpha: true });
const nebulaCanvas = document.getElementById('nebula');
// D6d: scheduleFrame moved to the shared ../shared/js/render-loop.js (the fps-cap throttle), loaded
// later but still before this scene's own js/main.js ever calls it -- see that file's own remarks.

let W = 0;
let H = 0;
let DPR = 1;
let canvasScaleX = 1;
let canvasScaleY = 1;
let spritesStale = true;
let sprites = null;
// No zoom UI on the wallpaper (html-wallpaper-demo D6b): kept as a constant only because
// layers.js/sprites.js still read it by name (visibleCanvasBounds, perspectiveRayEndpoint, the
// scene's own render() zoom transform).
const viewZoom = 1;
// mini-scene-window T2: the mini variant magnifies the composition about its center so the gold ring
// fills most of the small square window (the full scene's own geometry is sized for a landscape
// screen, where the ring is only ~65% of the short side).
// B6 (CieLinux): was 1.2, which left the blue outer ring at (120 - 50) * 1.2 = 84 px in the 240 px mini,
// 12.5% smaller than idle/explorer's 0.40 * 240 = 96 px ring. The exact 96 px does not fit: the scene
// centre (W*0.505, H*0.515) sits hypot(1.2, 3.6) = 3.79 px off the window centre, so the far edge would
// pass the 0.41 * 240 = 98.4 px opaque edge-fade radius (render-loop.js MINI_EDGE_FADE_INNER). The
// largest zoom that stays inside is (98.4 - 3.79) / 70 = 1.3515; 1.3507 keeps ~0.06 px of margin and gives
// a 94.55 px ring (tests/disc.contract.test.mjs B6). src/view.qml discFor uses the same value.
const MINI_SCENE_ZOOM = 1.3507;
// mini-scene-window T2e: the mini nebula's alpha fade, in half-side units from the window center
// (1.0 = the middle of an edge). Wider than processing's (0.5..0.9) so the gold cloud reaches out toward
// the edges, but it is 0 at 0.98, so every edge and corner pixel stays fully transparent.
const MINI_NEBULA_FADE_START = 0.75;
const MINI_NEBULA_FADE_END = 0.98;
// T2k: the mini nebula alpha is boosted (about 1.4x its previous density); the fade above still reaches 0 at the edge.
// The nebula is DELIBERATELY subtle in mini: it sits under the 0.9-alpha dark base (drawMiniSceneBase), so only
// about a tenth of it shows through. This gain is part of the look the maintainer approved on 2026-09-29, not a
// leftover: rendering the mini scene with gain 1.0 changes about 51k of the 288x288 pixels (T8.31 measurement),
// so do not remove or retune it without a new visual approval.
const MINI_NEBULA_GAIN = 1.4;

// Tiempo total (en segundos) que la animación avanza antes de invertirse (ping-pong); el ciclo
// completo dura el doble: ida + regreso. Alargarlo NO hace más lenta la animación: la repite más
// veces a la misma velocidad (con 60 y ANIMATION_CYCLE_DURATION = 30 se repite 2 veces hacia
// adelante y luego se invierte). Debe ser un número mayor que 0; no hace falta que sea múltiplo
// de ANIMATION_CYCLE_DURATION. Solo el pulso del hexadecágono (HEXADECAGON_PULSE_INTERVAL) es independiente.
const ONE_WAY_DURATION = 60 * 5;
// Duración (en segundos) de UNA repetición base de la animación. Fija la velocidad de todo el
// movimiento (con 30, las bandas dan una vuelta cada 30 s): bájala para que todo vaya más rápido y
// súbela para que vaya más lento. Para alargar la animación usa ONE_WAY_DURATION. Debe ser mayor que 0.
const ANIMATION_CYCLE_DURATION = 30;
// --- Golden hexadecagon core (Raphael) --------------------------------------
// Raphael replaces the inherited octagon with a 16-sided ring (see js/hexadecagon.js for the pure
// vertex/pulse math; js/layers.js draws it). Same footprint as the octagon it replaces.
const HEXADECAGON_SIDES = 16;
// RAP-15 (user feedback): "Aumenta el tamaño del círculo en general, casi debe tocar el top y
// bottom, déjale un margin de unos 50px." The hexadecagon's radius is no longer a fixed proportion
// of min(W,H) — see coreRadius() in js/hexadecagon.js, which derives it by working backward from
// GLYPH_SYSTEM_OUTER_MARGIN_PX (below) through the outermost glyph ring's own outer factor, so the
// whole concentric system (hexadecagon + all four glyph rings) scales together and the outermost
// ring's outer edge lands exactly that many CSS pixels short of the viewport's shorter half.
const GLYPH_SYSTEM_OUTER_MARGIN_PX = 50;
// RAP-19c (parent-confirmed review defect): at min(W,H) <= 2*GLYPH_SYSTEM_OUTER_MARGIN_PX (100),
// the margin-based radius above goes non-positive. coreRadius() falls back to this — the original
// pre-RAP-15 proportional factor — for tiny viewports, so the composition always stays positive
// and sane instead of collapsing or going negative.
const HEXADECAGON_FALLBACK_RADIUS_FACTOR = 0.168;
// Cada cuántos segundos late (pulsa) el hexadecágono: más frecuente que el octágono heredado (3s).
// Debe ser un número mayor que HEXADECAGON_PULSE_DURATION. El pulso no depende de ONE_WAY_DURATION.
const HEXADECAGON_PULSE_INTERVAL = 2;
// Duración en segundos de cada pulso. Debe ser mayor que 0 y menor que HEXADECAGON_PULSE_INTERVAL.
const HEXADECAGON_PULSE_DURATION = 0.85;
// Multiplica el aumento de grosor del trazo durante el pulso: más intenso que el 0.72 heredado.
const HEXADECAGON_PULSE_STROKE_FACTOR = 1.35;
// Blur (px) del resplandor del anillo en reposo y el rango extra que añade el pulso.
const HEXADECAGON_PULSE_BLUR_BASE = 26;
const HEXADECAGON_PULSE_BLUR_RANGE = 30;
// Grosor base del anillo antes del multiplicador de pulso, como fracción de su propio radio r (no
// píxeles absolutos): scaling with r keeps the drawn extent budget below in proportion at any
// viewport size. Multiplied by 1.3 for the main ring stroke, same as before (see layers.js).
const HEXADECAGON_STROKE_WIDTH_FACTOR = 0.012;
// Desplazamiento de las copias cromáticas (aberración), como fracción de r.
const HEXADECAGON_CHROMATIC_OFFSET_FACTOR = 0.005;
// RAP-9 (user feedback): the hexadecagon must stay a true regular 16-gon with straight sides — no
// per-vertex wobble. The pulse now scales every vertex's radius by the exact same factor (uniform,
// so the polygon is always regular), intensely: at peak pulse the radius grows by this fraction.
// RAP-9 follow-up (user feedback): "la figura crece mucho, no debe salirse de su propio anillo".
// Reduced from 0.16 so the hexadecagon's full drawn extent (vertex radius + half stroke width +
// chromatic offset — see hexadecagonDrawnExtent in this file below) stays strictly inside the
// clear ring just outside it (js/glyph-rings.js's GLYPH_RING_CLEAR_INNER_FACTOR) at peak pulse;
// intensity now comes mainly from brightness/glow/stroke width, not outline size.
const HEXADECAGON_PULSE_RADIUS_SCALE = 0.018;
// Anillo blanco-caliente en el núcleo hacia dorado brillante en el resplandor.
const HEXADECAGON_RING_CORE_COLOR = 'rgba(255,250,232,0.98)';
const HEXADECAGON_RING_GLOW_COLOR = 'rgba(255,196,64,0.95)';
const HEXADECAGON_CHROMATIC_COLORS = ['rgba(255,214,110,0.24)', 'rgba(255,140,20,0.20)'];

// User tuning: signed finite values control speed; zero pauses and negative values reverse motion.
// FOLDING_BAND_SPEEDS: [outer, middle, inner] turns per outbound leg (see ONE_WAY_DURATION) for
// the folding-band geometry. RAP-2b removed the visible "atomic orbit" bands (and orbit blocks
// entirely — user: no sphere, bands or orbits in Raphael); this constant stays only because the
// Ctrl+E/Ctrl+A failure overlay's band-intersection clip (js/failure-overlay.js) still reads the
// same foldingBandParameters()/foldingBandGeometry() this speed feeds.
const FOLDING_BAND_SPEEDS = [3, -3, 3]; // [outer, middle, inner]
// RAP-8: the center prism/tetrahedron's rotation speed constant was removed with the prism itself
// — user: "hay que quitar el prisma del centro".
// User tuning for the seeded background particle layer.
// Multiplicador de la velocidad de las partículas (estrellas) del fondo.
// 1 = velocidad base, 2 = el doble (valor actual), 0.5 = la mitad, 0 = partículas quietas y
// negativo = viajan hacia el lado contrario.
const BACKGROUND_PARTICLE_SPEED_MULTIPLIER = 24;
// Multiplicador del tamaño de las partículas pequeñas (estrellas) del fondo.
// 1 = tamaño base, 1.18 = valor actual, 2 = el doble, 0.5 = la mitad. Debe ser un número mayor que 0.
const BACKGROUND_PARTICLE_SIZE_MULTIPLIER = 0.75;
// Cantidad de partículas pequeñas (estrellas) del fondo. 1280 = valor actual: súbelo para un fondo
// más denso, bájalo para uno más despejado (0 = sin partículas). Debe ser un entero mayor o igual
// que 0. Más partículas = más carga para el navegador.
const BACKGROUND_PARTICLE_COUNT = 750;
// RAP-2b: the segmented-sphere piece counts/speeds/radii and every sphere-only tuning constant
// below them were removed with the sphere itself — user: no sphere, bands or orbits in Raphael.

const VIEW_ZOOM_MIN = 0.5;
const VIEW_ZOOM_MAX = 3;
const VIEW_ZOOM_STEP = 1.1;

const TAU = Math.PI * 2;
// User tuning: 24 is the default number of prominent central rays. Keep this separate from the
// minor layer so changing it never silently changes the visible prominent-ray count.
const CENTRAL_CORE_PROMINENT_RAY_COUNT = 9;
const CENTRAL_CORE_MINOR_RAY_COUNT = 9;
// Higher values make each prominent ray complete more grow/retract cycles during the master motion.
const CENTRAL_CORE_PROMINENT_RAY_PULSE_SPEED = 4;
// These factors set the desired center-to-edge reach; the viewport-safe cap below prevents clipping.
const CENTRAL_CORE_PROMINENT_MIN_REACH_FACTOR = 5.8;
const CENTRAL_CORE_PROMINENT_MAX_REACH_FACTOR = 20;
const CENTRAL_CORE_PROMINENT_SAFE_REACH = 0.94;
const CENTRAL_CORE_RAY_INNER_RADIUS_FACTOR = 0.20;
// Prominent core rays and foreground inclined rays share this visual language. Raphael: gold,
// matching the hexadecagon ring above, instead of the inherited cyan-white.
const CENTRAL_RAY_STROKE_COLOR = '255,196,86';
const CENTRAL_RAY_LINE_WIDTH = 1.45;
const CENTRAL_RAY_OPACITY = 0.52;
const CENTRAL_RAY_GLOW_COLOR = 'rgba(255,208,110,0.92)';
const CENTRAL_RAY_GLOW_BLUR = 6;
const CENTRAL_CORE_MINOR_RAY_FACTOR = 2.15;
const CENTRAL_CORE_RADIUS_MIN_SAMPLE_COUNT = 4096;
// RAP-14 (user feedback): "el centro ya no es luz blanca, debe ser dorada" — the central core's
// glow gradient and inner disc are warm gold/amber, not white/cyan. Anchors match the user's own
// reference stops: #fff3c4 (near-white-hot only at the very center) -> #ffc94a (gold) -> amber.
const CENTRAL_CORE_GLOW_COLOR_INNER = '255,243,196'; // #fff3c4
const CENTRAL_CORE_GLOW_COLOR_MID = '255,201,74'; // #ffc94a
const CENTRAL_CORE_GLOW_COLOR_OUTER = '255,150,20'; // amber, fading to alpha 0
const CENTRAL_CORE_DISC_COLOR = '255,247,214'; // the very center: warm white-hot at most
const CENTRAL_CORE_DISC_GLOW_COLOR = '255,201,74'; // amber shadow glow around the inner disc

// RAP-24 (user feedback): "La luz del centro: dale más efecto de luz, se ve como un círculo
// amarillo" — the old flat opaque disc (radius 0.88r) read as a flat yellow circle, not a light
// source. Redesign: a very small hot core (radius factor far below the old 0.88), a strong soft
// multi-layer bloom (js/central-core.js's CENTRAL_CORE_*_STOPS, additive 'lighter' compositing so
// layers combine into a smooth glow with no hard edge), faint slowly-rotating starburst/glare
// streaks, and a subtle pulse-synced flare boost.
// RAP-25 (user feedback): "La luz del centro está bien pero le redujiste el tamaño, duplícalo." —
// every size factor below is exactly 2x its RAP-24 value (0.22/1.7/5.2/3.4), same proportions/look.
const CENTRAL_CORE_HOT_RADIUS_FACTOR = 0.44; // was 0.88 pre-RAP-24 (flat disc) — still small vs that
const CENTRAL_CORE_BLOOM_INNER_RADIUS_FACTOR = 3.4;
const CENTRAL_CORE_BLOOM_OUTER_RADIUS_FACTOR = 10.4;
const CENTRAL_CORE_GLARE_STREAK_COUNT = 8; // within the requested 6-12
const CENTRAL_CORE_GLARE_STREAK_LENGTH_FACTOR = 6.8; // relative to r
const CENTRAL_CORE_GLARE_STREAK_WIDTH = 0.9;
const CENTRAL_CORE_GLARE_STREAK_ALPHA = 0.22; // faint, per the user's own "faint" request
const CENTRAL_CORE_GLARE_ROTATION_SPEED = 0.06; // slow — much slower than the prominent core rays
const CENTRAL_CORE_GLARE_COLOR = '255,214,140';
// The bloom/glare alpha boost at full pulse (pulse=1); 1 = no boost at pulse=0.
const CENTRAL_CORE_PULSE_FLARE_FACTOR = 0.35;

const CHROMATIC_LOOP_COUNT = 3;
const CHROMATIC_SELF_ROTATION = 0.14;
// Cantidad de círculos/óvalos verdes y azules del fondo. Debe ser un entero no negativo:
// 0 los oculta; hasta 12 usa el prefijo original y valores mayores agregan óvalos deterministas.
const SOFT_OVAL_FIELD_COUNT = 20;
// User tuning: multiplies every soft oval blur radius (1 keeps the 43-50px source values).
// Multiplicador del desenfoque (blur) de los círculos/óvalos verdes y azules configurados del fondo.
// 1 = blur original (43-50 px), 0.5 = la mitad (valor actual), 0.25 = bordes mucho más nítidos,
// 2 = más difusos. Debe ser un número mayor que 0. El blur base de cada óvalo está en el campo
// `blur` de SOFT_OVAL_FIELDS; este factor los escala a todos por igual.
const SOFT_OVAL_BLUR_FACTOR = 0.15;
// Multiplicador del tamaño de los círculos/óvalos verdes y azules configurados del fondo.
// 1 = tamaño original (valor actual), 0.5 = la mitad, 2 = el doble. Solo cambia el tamaño: su
// posición y su movimiento no cambian. Debe ser un número mayor que 0. Los óvalos más grandes se
// ven más difusos y cubren más pantalla; combínalo con SOFT_OVAL_BLUR_FACTOR.
const SOFT_OVAL_SIZE_FACTOR = 0.25;
// Caps viewport-only oval-axis stretching without changing each field's intentional rx/ry shape.
// 1 keeps the viewport contribution circular; larger values allow up to that horizontal:vertical
// (or vertical:horizontal) stretch before capping. Must be a finite number greater than or equal to 1.
const SOFT_OVAL_VIEWPORT_AXIS_STRETCH_CAP = 1.35;
// Multiplicador del movimiento de los círculos/óvalos verdes y azules configurados: cuánto se alejan al girar
// alrededor de su posición y cuánto se inclinan. 1 = movimiento original (casi imperceptible),
// 4 = valor actual, 8 = recorridos muy amplios, 0 = quietos. Debe ser un número mayor o igual que 0.
const SOFT_OVAL_MOTION_FACTOR = 12;
// Multiplicador de cuánto se expanden y se contraen esos círculos/óvalos. 1 = variación original
// (de 0.84x a 1.14x su tamaño), 2.3 = valor actual (de 0.64x a 1.34x), 0 = tamaño fijo. Debe ser un
// número mayor o igual que 0.
const SOFT_OVAL_BREATH_FACTOR = 2.3;
const SOFT_OVAL_VISIBLE_ALPHA_MULTIPLIER = 2.35;
const SOFT_OVAL_VISIBLE_ALPHA_CAP = 0.34;
// --- Circular oval field (Raphael) -------------------------------------------
// A new, additional field of soft ovals: smaller and more circular than SOFT_OVAL_FIELDS above,
// and more numerous. Generated the same way SOFT_OVAL_FIELDS' extra (beyond-the-original-12)
// entries are: a low-discrepancy position plus an isolated per-index seed, never the shared rnd().
const CIRCULAR_OVAL_FIELD_COUNT = 36;
// Máxima diferencia permitida entre rx/ry y 1 (0 = círculo perfecto). Debe ser un número >= 0.
const CIRCULAR_OVAL_ASPECT_TOLERANCE = 0.05;
const CIRCULAR_OVAL_SIZE_FACTOR = 0.05;
const CIRCULAR_OVAL_BLUR_FACTOR = 0.10;
const CIRCULAR_OVAL_MOTION_FACTOR = 6;
const CIRCULAR_OVAL_BREATH_FACTOR = 1.4;
const CIRCULAR_OVAL_VISIBLE_ALPHA_MULTIPLIER = 2.0;
const CIRCULAR_OVAL_VISIBLE_ALPHA_CAP = 0.30;

// --- Translucent feathers (Raphael) -------------------------------------------
// Seeded feathers that emit from the core (js/feathers.js's featherOffset, mirroring drawStars'
// particle motion) and tint from translucent white toward gold as they near the core and/or a
// golden ray (js/feathers.js's featherTint; js/layers.js's drawFeathers paints them as FILLED
// leaf/quill silhouettes, not stroked spines — RAP-12 user feedback: "que sean blancas con un
// poco de alfa" — they must read as white, with the gold tint kept subtle at most).
// RAP-23 (user feedback): "Duplica el número" — exactly double the RAP-12 baseline (60).
const FEATHER_COUNT = 120;
// RAP-28 (regression fix — user: "el movimiento de las plumas lo veo lento"). RAP-27's
// FEATHER_SPEED_MULTIPLIER and FEATHER_FALL_SPEED canceled out algebraically: featherSpeedForCycles
// divided a cycle count by (LEG_PROGRESS * SPEED_MULTIPLIER * FALL_SPEED), then featherZ multiplied
// by those SAME two constants again — so the true speed was set entirely by the old 1..4 cycle tier
// (FEATHER_SPEED_CYCLE_MAX), i.e. one full outward crossing every 75-300 REAL seconds. Retired
// FEATHER_SPEED_MULTIPLIER (it never had any real effect); speed is now defined directly in real
// seconds per full outward crossing, AT FEATHER_FALL_SPEED=1 — see FEATHER_CROSSING_SECONDS_MIN/MAX
// below, converted to an exact integer cycle count by feathers.js's featherCyclesForPeriod, so this
// dial actually changes the speed (any positive value now works — no longer needs to be an integer,
// since round()+clamp keeps the per-leg cycle count exact regardless of FALL_SPEED's value).
const FEATHER_FALL_SPEED = 0.45;
// Una pluma viaja del centro al borde de la pantalla en unos 3-6s (a FEATHER_FALL_SPEED=1); súbelo
// para que caiga más rápido. featherCyclesForPeriod (feathers.js) convierte esto en un número entero de
// ciclos por tramo (continuidad exacta en el wrap), así que FEATHER_FALL_SPEED sí cambia la velocidad.
const FEATHER_CROSSING_SECONDS_MIN = 3;
const FEATHER_CROSSING_SECONDS_MAX = 6;
// Un giro lento completo tarda unos 2-6s (a FEATHER_FALL_SPEED=1) — "gira" al caer, más lento que el
// aleteo (flutter) de abajo.
const FEATHER_SPIN_SECONDS_MIN = 2;
const FEATHER_SPIN_SECONDS_MAX = 6;
// "quick initial acceleration from the core then drag-limited drift" (RAP-27): the exponent of the
// ease-out curve 1-(1-z)^p used by featherRadialFactor below. Must be > 1 so the curve's slope is
// largest right at emission (z=0) and tapers toward 0 approaching z=1 (drag-limited drift), the
// opposite shape from the old pure power>1 accelerating curve (near-zero initial slope).
const FEATHER_RADIAL_DRAG_POWER = 1.7;
// Multiplies the size-vs-z growth curve, same role as BACKGROUND_PARTICLE_SIZE_MULTIPLIER.
const FEATHER_SIZE_MULTIPLIER = 1.2;
// z-fraction over which the alpha envelope ramps up from 0 (near the core) and back down to 0
// (near the wrap), so the fract() reset from z=1 to z=0 lands on an already-invisible feather.
const FEATHER_FADE_IN = 0.08;
const FEATHER_FADE_OUT = 0.92;
// RAP-12 (review advisory): "feathers still jump at the 30 s p-wrap". Each feather's z-advance and
// spin speed are exact integer multiples of full cycles over one ping-pong leg (see
// FEATHER_LEG_PROGRESS/featherSpeedForCycles in feathers.js — RAP-28's featherCyclesForPeriod now
// derives that integer from FEATHER_CROSSING_SECONDS_MIN/MAX and FEATHER_SPIN_SECONDS_MIN/MAX
// above, rather than a hand-picked tier), so featherOffset/spin return to their exact starting
// value at the leg boundary — not just continuous, but pixel-identical, matching this codebase's
// established "meet exactly at ping-pong endpoints" pattern (e.g. the segmented sphere's former
// travel invariants).
const FEATHER_LENGTH_MIN = 0.055;
const FEATHER_LENGTH_MAX = 0.12;
// RAP-12 follow-up (user reference: plumas.avif — "quiero unos diseños así"). A small seeded
// catalog of feather-shape VARIANTS, each baked once into cached offscreen sprites (js/sprites.js's
// paintFeatherVariant) and stamped per frame with rotation/scale/alpha — no per-frame path
// building. Each feather instance (js/feathers.js's createFeathers) picks one variant by index.
const FEATHER_VARIANT_COUNT = 7;
// Silhouette aspect ratio (length / max width): elongated blade, per the reference.
const FEATHER_VARIANT_ASPECT_MIN = 3.5;
const FEATHER_VARIANT_ASPECT_MAX = 5.0;
// Curl amount, as a fraction of length the shaft bows sideways at its midpoint: most variants curl
// gently one way, a few curl noticeably more (like the curled feathers in the reference).
const FEATHER_VARIANT_CURVE_RANGE = 0.22;
// 2-4 small notches/splits along the vane edges where barbs appear to separate.
const FEATHER_VARIANT_NOTCH_MIN = 2;
const FEATHER_VARIANT_NOTCH_MAX = 4;
// Barb (fine diagonal strokes) and downy wisp (fluffy afterfeather near the base) counts.
const FEATHER_VARIANT_BARB_COUNT = 10;
const FEATHER_VARIANT_WISP_COUNT = 6;
// Reference length (local units) each variant is baked at; stamped at unit = actualLength/this.
const FEATHER_SPRITE_REFERENCE_LENGTH = 160;
// Fraction of feather instances rendered from the blurred sprite bake (soft out-of-focus depth
// cue), and their own, dimmer alpha range — the rest use the sharp bake and FEATHER_ALPHA_MIN/MAX.
const FEATHER_BLUR_FRACTION = 0.28;
const FEATHER_BLUR_RADIUS_FACTOR = 0.05; // blur sigma, as a fraction of the sprite's own length
const FEATHER_BLUR_ALPHA_MIN = 0.15;
const FEATHER_BLUR_ALPHA_MAX = 0.25;
// Modesto pero visible, "blancas con un poco de alfa" (antes 0.35-0.6) — sharp (non-blurred) feathers.
const FEATHER_ALPHA_MIN = 0.3;
const FEATHER_ALPHA_MAX = 0.5;
// Distancia normalizada (0 = núcleo, 1 = borde de HEXADECAGON-scale) donde el tinte por cercanía
// empieza (NEAR) y termina (FAR) de decaer. Debe cumplir 0 <= NEAR < FAR.
const FEATHER_TINT_NEAR = 0.15;
const FEATHER_TINT_FAR = 1.6;
// Cuánto pesa la cercanía a un rayo dorado en el tinte total (0..1).
const FEATHER_TINT_RAY_WEIGHT = 0.85;
// Ventana angular (radianes) dentro de la cual una pluma se considera "sobre" un rayo.
const FEATHER_RAY_ANGLE_WINDOW = 0.12;
// RAP-12: the gold tint must stay subtle at most — feathers read as white. Scales featherTint's
// [0,1] output into the alpha of a second, gold-tinted sprite pass stamped over the white one
// (sharp feathers only — blurred/background feathers skip the tint pass, staying plain and soft).
const FEATHER_TINT_DISPLAY_SCALE = 0.3;
const FEATHER_COLOR = '255,255,255';
const FEATHER_EDGE_COLOR = '214,218,226'; // slightly grey toward the vane edges
const FEATHER_GOLD_COLOR = '255,206,112';

// RAP-23 (user feedback): "Las plumas deben moverse más rápido y tener un movimiento natural, no
// solo recto: como cuando sueltas una pluma y se mece, gira, da una pirueta." Natural falling-feather
// motion layered on top of the existing radial emission + slow spin: lateral sway (a pendulum
// perpendicular to travel), flutter (a fast small-amplitude rotation wobble), a rocking tilt in
// phase with the sway (RAP-30), and a continuous 3D-flip squash (RAP-31, restored — see its own
// comment below; the occasional pirouette RAP-23 also added was later removed, same request).
// RAP-28 (user: "el movimiento de las plumas lo veo lento") converted every one of these
// from an abstract "cycles per ping-pong leg" tier (which read as imperceptibly slow — see
// FEATHER_FALL_SPEED's comment) to a real-time period in seconds, at FEATHER_FALL_SPEED=1;
// feathers.js's featherCyclesForPeriod converts each back into an exact integer number of cycles
// per leg, so every term still returns to its EXACT starting value at the animation's leg boundary
// (continuity), while the seconds now say what the motion actually looks/feels like, and scale
// together with FEATHER_FALL_SPEED ("que la tumbación escale con la caída").
// Un balanceo lateral completo tarda 0.8-1.5s (a FEATHER_FALL_SPEED=1) — rápido y visible.
const FEATHER_SWAY_SECONDS_MIN = 0.8;
const FEATHER_SWAY_SECONDS_MAX = 1.5;
// RAP-27 (user feedback): "movimiento natural... con un balanceo lateral más fuerte, con período
// ligado a la velocidad" — stronger than the RAP-23 baseline (0.015/0.05).
const FEATHER_SWAY_AMPLITUDE_MIN = 0.02; // fraction of min(width,height), scaled further by travel distance
const FEATHER_SWAY_AMPLITUDE_MAX = 0.08;
// El aleteo (temblor rápido, no el giro lento) completa un ciclo en 0.15-0.35s.
const FEATHER_FLUTTER_SECONDS_MIN = 0.15;
const FEATHER_FLUTTER_SECONDS_MAX = 0.35;
const FEATHER_FLUTTER_AMPLITUDE_MIN = 0.08; // radians
const FEATHER_FLUTTER_AMPLITUDE_MAX = 0.22;
// RAP-30 (user feedback): "En la caída de las plumas hay una que parece como si yo la viera desde
// abajo mirando hacia arriba. Cámbiala para que sea como las otras, que se mueven hacia los lados"
// — the user chose "el 3D" (the tumble/flip squash: scaleX = |cos(tumbleAngle)|) as the culprit: at
// some point in its cycle a feather read as edge-on/"viewed from below" instead of drifting side to
// side like the others. Removed entirely (no more FEATHER_TUMBLE_*/FEATHER_FLIP_SCALE_MIN, no more
// non-uniform scale in drawFeather). Replaced with a rocking tilt — an ANGLE oscillation reusing the
// SAME rate/phase as the lateral sway (feathers.js's featherRockAngle), so a feather's tilt rocks
// exactly in step with its own side-to-side sway, "como una hoja que se mece al caer".
const FEATHER_ROCK_AMPLITUDE_MIN = 0.12; // radians
const FEATHER_ROCK_AMPLITUDE_MAX = 0.3;
// RAP-31 (user feedback): "Saquemos la pirueta y dejemos el 3D" — the pirouette (an occasional full
// 360° turn) is removed entirely; the 3D tumble/flip squash RAP-30 had removed is restored, now
// coexisting with the RAP-30 rocking tilt above (angle vs. scale — no conflict).
// Un volteo 3D (borde-a-borde-a-borde) completo tarda 1.5-3s.
const FEATHER_TUMBLE_SECONDS_MIN = 1.5;
const FEATHER_TUMBLE_SECONDS_MAX = 3;
// scaleX = |cos(tumbleAngle)|, clamped to this floor so a "3D flip" never reads as a zero-width line.
const FEATHER_FLIP_SCALE_MIN = 0.15;

// --- Glyph rings (Raphael) -----------------------------------------------------
// Four concentric annuli outward from the hexadecagon core (js/glyph-rings.js computes their pure
// geometry; js/glyphs.js — copied from background-idle — generates the procedural "hieroglyph"
// script; js/layers.js draws both). Radii are factors of the hexadecagon's own radius
// (coreRadius(min(W,H)), js/hexadecagon.js — RAP-15), so the rings always sit just outside it and
// scale with it.
// Every consumer of a procedural hieroglyph (glyphs.js's makeHieroglyph/strokesBounds) assumes a
// glyph's own ink stays inside a [-GLYPH_LOCAL_HALF_EXTENT, GLYPH_LOCAL_HALF_EXTENT] local box.
const GLYPH_LOCAL_HALF_EXTENT = 0.45;
const GLYPH_STROKE_HALF_WIDTH_LOCAL = 0.045;
const GLYPH_MAX_LOCAL_FULL_EXTENT = 2 * (GLYPH_LOCAL_HALF_EXTENT + GLYPH_STROKE_HALF_WIDTH_LOCAL); // 0.99

// Ring (a): empty/transparent, just outside the hexadecagon ring.
const GLYPH_RING_CLEAR_INNER_FACTOR = 1.05;
const GLYPH_RING_CLEAR_OUTER_FACTOR = 1.25;
// Ring (b): thick, bold gold glyphs.
const GLYPH_RING_GOLD_OUTER_FACTOR = 1.55;
// Ring (c): empty again — the green/gold nebula (rendered on the WebGL canvas behind #scene)
// shows straight through, so this annulus draws nothing of its own.
const GLYPH_RING_NEBULA_OUTER_FACTOR = 1.85;
// Ring (d): the same glyphs, larger and translucent blue.
const GLYPH_RING_BLUE_OUTER_FACTOR = 2.35;

// RAP-26 (user feedback, verbatim — "como un objeto manipulado por mis manos"): "hacer que los
// caracteres tengan la mitad del tamaño que el grueso de su anillo. Luego tomar cada carácter de su
// base inferior y superior y alargarlos hasta que casi toquen el borde de su respectivo anillo,
// unos 10px de margin; visualmente todos los caracteres van a tener el mismo ancho al estar
// estirados y los puedes ir acomodando uno al lado del otro hasta llenar el anillo, dejando su
// espacio entre ellos, unos 20px tal vez." Replaces the RAP-20/20b aspect+fill-fraction sizing
// entirely with an explicit px-based model (js/glyph-rings.js's glyphRingFitScale/
// glyphRingCountForRing; js/glyphs.js's transformStrokesForRing applies the fit to PATH
// COORDINATES, never ctx.scale, so stroke width is never distorted by the stretch):
// 1. base width w = <ring>'s own base-size fraction * annulus thickness.
// 2. every glyph is normalized to that SAME width w, fit to its own real stroke bounds.
// 3. then stretched, radially only, so its real ink height exactly fills
//    thickness - 2*GLYPH_RING_EDGE_MARGIN_PX (a ~10px margin at both inner and outer edges).
// 4. count = floor(circumference_at_mid_radius / (w + GLYPH_RING_GAP_PX)), reduced if needed so
//    ink never touches at the (tighter) inner radius either.
// RAP-29 (user feedback, blue ring only): "Agrega más caracteres azules en el anillo; por lo que
// debes hacer más delgados los caracteres, estilizándolos pero sin truncarlos." Splits the single
// shared base-size fraction into a per-ring constant so blue can go slimmer (more count, since
// count is derived from w) while gold stays exactly as it was.
const GLYPH_RING_GOLD_BASE_SIZE_FRACTION = 0.5;
// RAP-35: 0.3 -> 0.25 so the blue ring can hold more glyphs. Its no-contact ceiling is
// floor(2*PI*innerRadius / width), which does not depend on the core radius: about 77 glyphs at 0.3
// and 92 at 0.25. The maintainer compared both on screen and chose 92 (slimmer, fuller glyphs).
const GLYPH_RING_BLUE_BASE_SIZE_FRACTION = 0.25;
const GLYPH_RING_EDGE_MARGIN_PX = 10;
const GLYPH_RING_GAP_PX = 20;
// mini-scene-window T2d: the two px values above (10px edge margin, 20px gap) are absolute, so at the
// 288px mini window they ate the whole ring (blue glyph hh/hw 0.40, gold 0.33 -> short dashes). Mini
// scales both with the composition (glyph-rings.js's glyphRingMiniScale), which keeps the full scene's
// stretched proportions for the blue ring.
//
// T11: the GOLD ring is the same in every variant (the maintainer liked the mini one): GLYPH_RING_GOLD_COUNT_FACTOR
// x the glyphs the standard rule gives (GLYPH_RING_GOLD_BASE_SIZE_FRACTION-wide glyphs, the ring's gap), drawn as
// thin tall strokes GLYPH_RING_GOLD_SLIM_SIZE_FRACTION of the ring thickness wide, never closer than
// GLYPH_RING_GOLD_MIN_GAP_FRACTION of that width. If the tripled count does not fit at that gap, the largest
// count that does is used instead. The gold glyphs have no glow.
const GLYPH_RING_GOLD_SLIM_SIZE_FRACTION = 0.2;
const GLYPH_RING_GOLD_COUNT_FACTOR = 3;
const GLYPH_RING_GOLD_MIN_GAP_FRACTION = 0.3;
// RAP-35 (user feedback, blue ring only): "agrégale 10 caracteres más (del catálogo existente) ...
// quiero ver si se ve más lleno el anillo aprovechando el espacio entre caracteres que sobra."
// Extra glyphs beyond the blue ring's derived count, drawn from the same RING_GLYPH_POOL; the gap
// between neighbours shrinks to fit them, and extras that would make ink touch at the ring's inner
// radius are dropped (glyphRingCountWithExtra, js/glyph-rings.js). Gold stays at its derived count.
// Follow-ups after seeing it on screen: "Agrégale otros 10" (10 -> 20), then "otros 10 más" (20 -> 30),
// then 40, which the 0.3-wide glyphs could not fit (their no-contact ceiling is 77, reached at 30).
// So the glyphs were narrowed to 0.25 (see GLYPH_RING_BLUE_BASE_SIZE_FRACTION) and 50 extras now ask
// for more than fits: glyphRingCountWithExtra caps the ring at its no-contact maximum, 92, filling it
// as far as it goes (raphael-scene.tests.js pins that 92).
const GLYPH_RING_BLUE_EXTRA_COUNT = 50;
// RAP-13/21 (user feedback): "Caracteres azules deben tener más weight ... una 'fuente' gruesa,
// donde los bordes no tienen alfa pero su centro sí tiene alfa" (blue), then "A los caracteres
// dorados también agrégales contorno" (gold too) — both rings are an outline font: each glyph
// stroke is drawn as a 3-pass sequence (js/glyph-rings.js's outlineGlyphOps, applied by
// js/sprites.js's paintOutlineGlyph, cached per glyph) — a wide OPAQUE border pass, a
// destination-out punch, then a narrower TRANSLUCENT interior refill.
// RAP-26: stroke body width is now proportional to w (not the annulus thickness T), per the
// coordinator's explicit instruction, so it scales with the glyph's own (now fixed) width.
const GLYPH_RING_STROKE_WIDTH_FRACTION_GOLD = 0.13;
const GLYPH_RING_STROKE_WIDTH_FRACTION_BLUE = 0.14; // "much heavier" than gold, per RAP-13
const GLYPH_RING_BORDER_FRACTION = 0.2; // border rim as a fraction of the (derived) body width, each side
// RAP-29 ("sin truncarlos... una fuente delgada... necesita un piso legible"): at
// GLYPH_RING_BLUE_BASE_SIZE_FRACTION=0.3, the fraction-based body/border width can get thin enough
// to read as a hairline or vanish; these floors keep a visibly readable outline-font stroke (an
// opaque border plus a real, positive translucent interior) even on the slimmest glyphs.
const GLYPH_RING_BODY_WIDTH_FLOOR_PX = 2;
const GLYPH_RING_BORDER_WIDTH_FLOOR_PX = 1;

// RAP-26b (regression fix — parent headless check, real render measured with PIL): RAP-26's fit
// math was correct (verified: well-formed glyphs' rendered ink matched their target width/height
// within 1px), but the SHARED glyph pool (GLYPH_TEXT_POOL) includes glyphs whose strokes are
// dot-only or otherwise collapse to a near-single-point bounding box once recentered — a scale
// factor, however large, cannot move a point that already sits at the origin, so those glyphs
// rendered as a tiny fixed-radius dot pinned at the center of an otherwise-empty, correctly-sized
// box (matching the parent's report: many tiny marks not spanning the ring, wildly inconsistent
// widths). Ring glyphs now come from their OWN pool (js/glyphs.js's makeRingHieroglyph/
// RING_GLYPH_POOL), rejecting and regenerating from the seed until each glyph has real spread.
const GLYPH_RING_MIN_SPAN_FRACTION = 0.7; // a qualifying stroke must span >= 70% of the local box height
const GLYPH_RING_MAX_DOT_STROKES = 1; // dots are accents only, never the glyph's main content
const GLYPH_RING_GENERATOR_MAX_ATTEMPTS = 50;
const GLYPH_RING_GOLD_BORDER_COLOR = 'rgba(255,205,90,0.97)'; // opaque-ish gold border
const GLYPH_RING_GOLD_INTERIOR_COLOR = 'rgba(255,205,90,0.24)'; // translucent gold interior
const GLYPH_RING_BLUE_BORDER_COLOR = 'rgba(150,200,255,0.96)'; // opaque-ish border
const GLYPH_RING_BLUE_INTERIOR_COLOR = 'rgba(150,200,255,0.22)'; // translucent interior
const GLYPH_RING_DELIMITER_COLOR = 'rgba(255,205,90,0.55)';
// RAP-33 (user feedback): "los bordes de los anillos color naranja agrégales efecto de luz y
// hazlos un poco más gruesos" — ~2x the previous width (1), plus a soft additive glow.
const GLYPH_RING_DELIMITER_WIDTH = 2;
const GLYPH_RING_DELIMITER_GLOW_BLUR = 10; // shadowBlur px
const GLYPH_RING_DELIMITER_GLOW_COLOR = 'rgba(255,205,90,0.85)';
// Vueltas por tramo de ida (ver ONE_WAY_DURATION) de cada anillo de glifos. Signos opuestos = giran
// en sentidos contrarios, tal como en el frame de referencia.
// RAP-17 (user feedback): "Y más velocidad al giro de los anillos, x4." (was 0.12 / -0.08).
const GLYPH_RING_GOLD_ROTATION_SPEED = 0.48;
const GLYPH_RING_BLUE_ROTATION_SPEED = -0.32;

// --- Glyph-style edge counters (Raphael) --------------------------------------
// Two persistent vertical counters on the left/right edges, laid out like the Ctrl+E/Ctrl+A error
// layer's bit-counter modules (js/failure-overlay.js's drawFailureModules) but always visible (no
// overlay), and rendered with procedural stroke "digit" glyphs (js/digits.js) instead of a
// monospace font, so they read as the same script as the glyph rings.
const DIGIT_GLYPH_SEED = 0x7c3a9e21;
const GLYPH_COUNTER_STEP_MS = 100; // first group's tick cadence
// RAP-11 (user feedback): "¿dónde están los contadores? ... también agrégale el background." The
// counters were too small/gold to notice; they now live on a dedicated dark panel per edge, sized
// off the panel itself rather than a fraction of the whole viewport.
// Second group's tick cadence: deliberately different from GLYPH_COUNTER_STEP_MS so the two groups
// read as two independent counters, like the reference frame.
const GLYPH_COUNTER_STEP_MS_B = 137;
// Digits per group; two groups + one separator = GLYPH_COUNTER_GROUP_DIGIT_COUNT*2+1 characters
// per panel (15 with the default 7 -> inside the reference's observed 14-16 range).
const GLYPH_COUNTER_GROUP_DIGIT_COUNT = 7;
const GLYPH_COUNTER_LINE_WIDTH = 2.6; // bold, thick strokes per the reference
// Pale cream/off-white (~#f4ecd8), not gold, per the reference.
const GLYPH_COUNTER_GLYPH_COLOR = '244,236,216';
// Subtle chromatic fringe either side of the main cream glyph (faint red / faint cyan-gold), like
// the hexadecagon's own chromatic offset copies.
const GLYPH_COUNTER_CHROMATIC_RED = 'rgba(255,70,70,0.32)';
const GLYPH_COUNTER_CHROMATIC_CYAN = 'rgba(130,225,255,0.28)';
const GLYPH_COUNTER_CHROMATIC_OFFSET = 1; // px

// --- Edge counter panel (RAP-11) ----------------------------------------------
// One tall vertical near-opaque black panel per edge, hugging the screen edge, matching the
// reference frame's cropped proportions (1000x563): left spans x 2%-4.5% of width, right mirrors
// it at 95.5%-98%; both span y 28%-71% of height (vertically centered).
const GLYPH_COUNTER_PANEL_LEFT_X_MIN_FRACTION = 0.02;
const GLYPH_COUNTER_PANEL_LEFT_X_MAX_FRACTION = 0.045;
const GLYPH_COUNTER_PANEL_RIGHT_X_MIN_FRACTION = 0.955;
const GLYPH_COUNTER_PANEL_RIGHT_X_MAX_FRACTION = 0.98;
const GLYPH_COUNTER_PANEL_Y_MIN_FRACTION = 0.28;
const GLYPH_COUNTER_PANEL_Y_MAX_FRACTION = 0.71;
const GLYPH_COUNTER_PANEL_CORNER_RADIUS = 8; // px
const GLYPH_COUNTER_PANEL_COLOR = 'rgba(0,0,0,0.88)';
const GLYPH_COUNTER_PANEL_SHADOW_COLOR = 'rgba(0,0,0,0.6)';
const GLYPH_COUNTER_PANEL_SHADOW_BLUR = 10;
// Fraction of the panel's own width each glyph's full local extent may fill: "almost fill the
// panel width" per the reference, with a small margin (< 1) so strokes never touch the panel edge.
const GLYPH_COUNTER_PANEL_GLYPH_FILL_FRACTION = 0.90;

const SPECTRAL_FLARE_COUNT = 2;
// Cantidad de rayos inclinados independientes delante del núcleo. Debe ser un entero no negativo:
// 0 los oculta, 1 conserva un único rayo válido y valores mayores aumentan la densidad/carga.
const FOREGROUND_INCLINED_RAY_COUNT = 48;
// Signed finite multiplier for foreground inclined-ray angular motion: 0 pauses at each deterministic
// offset, 0.5 is half speed, 1 preserves the current speed, 2 doubles it, and negative values reverse all rays.
const FOREGROUND_INCLINED_RAY_SPEED = 5;
// Máxima cantidad de segmentos por trazo luminoso compartido. Mantenerlo positivo limita el trabajo
// de sombra por lote sin conectar rayos independientes entre sí.
const FOREGROUND_INCLINED_RAY_BATCH_SIZE = 128;

// --- Nebula (WebGL background) tuning ---------------------------------------
// Consolidated from js/nebula.js: pure tuning literals with no runtime-state
// dependency. The shaders and renderer that consume them stay in nebula.js.
// Vueltas completas que da el flujo durante cada loop. Usá enteros para conservar un cierre perfecto.
const NEBULA_SPEED = 16;
// Grosor de las corrientes espirales: un valor mayor ensancha las bandas verdes y reduce los cortes negros.
const NEBULA_THICKNESS = 1.5;
// Tamaño general del vórtice: valores mayores lo expanden y recortan más sus bordes fuera del canvas.
const NEBULA_SCALE = 10;
// Brillo y presencia de la nube: valores mayores hacen que se vea menos tenue sin modificar su geometría.
const NEBULA_INTENSITY = 0.56;
// Duración base en segundos. El cierre sigue siendo exacto cuando NEBULA_SPEED contiene vueltas enteras.
const NEBULA_LOOP_DURATION = 30;
// Límite de resolución interna: valores mayores dan más detalle, pero aumentan el trabajo de la GPU.
const NEBULA_DPR_CAP = 0.45;
// Cuánto se doblan y deforman las corrientes: 0 = espiral perfecta, valores mayores = trazos más irregulares.
const NEBULA_WARP_STRENGTH = 0.75;
// Segundos que tarda la deformación aleatoria en recorrer su ciclo: valores mayores cambian la forma más lento.
const NEBULA_WARP_PERIOD = 24;
// --- Golden nebula band (Raphael) --------------------------------------------
// A narrow gold highlight painted along the existing green/blue `boundary` transition inside the
// fragment shader (js/nebula.js), keeping the nebula itself blue/green. Same units as `boundary`
// (roughly normalized screen radius), so this stays comparable to the shader's own gapWidth (0.11-0.23).
// RAP-16 (user feedback): "A la nebulosa agrégale más dorado" — widened and brightened from the
// original 0.16/0.55.
// Cuán ancha es la franja dorada a cada lado de la frontera verde/azul. Debe ser mayor que 0 y, para
// seguir leyéndose como una franja (no un lavado general), como mucho 0.5.
const NEBULA_GOLD_BAND_WIDTH = 0.24;
// Intensidad de la franja dorada: 0 = invisible, 1 = reemplaza por completo el color verde/azul en
// el centro de la franja. Debe estar entre 0 y 1.
const NEBULA_GOLD_BAND_INTENSITY = 0.75;
// RAP-16: gold wisps mixed into the green zone itself (not just the boundary band), using the
// shader's own noise field so they read as part of the nebula's texture. Threshold is the noise
// cutoff below which no gold shows (lower = more wisps); intensity is the maximum gold mix at the
// brightest wisp peaks. Threshold must stay in [0,1); intensity in (0,1].
const NEBULA_GOLD_WISP_THRESHOLD = 0.58;
const NEBULA_GOLD_WISP_INTENSITY = 0.45;
// RAP-32 (user feedback): "Agrega nebulosa dorada que abarque el anillo del centro" — un resplandor
// dorado suave y nuboso (con fbm, no un degradado plano) que cubre el área desde el hexadecágono
// hasta el anillo de glifos dorado, atado a coreRadius (px) para que escale con toda la composición.
// Extensión del borde exterior, como múltiplo de coreRadius (>1 para llegar más allá del anillo dorado).
const NEBULA_GOLD_ZONE_EXTENT_FACTOR = 1.6;
// Intensidad general del resplandor: 0 = invisible, 1 = tan fuerte como el oro puro.
const NEBULA_GOLD_ZONE_INTENSITY = 0.55;
// Frecuencia del ruido fbm que le da textura nubosa (más alto = detalle más pequeño/nuboso).
const NEBULA_GOLD_ZONE_NOISE_SCALE = 2.2;

// --- Background particle / streak tuning ------------------------------------
// Consolidated from js/scene-data.js: pure tuning literals with no runtime-state
// dependency. The seeded arrays that consume them stay in scene-data.js so the
// shared rnd() call order is untouched.
// Cantidad de partículas pequeñas (estrellas) del fondo. 1280 = valor actual: súbelo para un fondo
// más denso, bájalo para uno más despejado (0 = sin partículas). Debe ser un entero mayor o igual
// que 0. Más partículas = más carga para el navegador.
const BASE_STAR_COUNT = 1280;
// Grosor de los rayitos de luz del fondo: multiplica el ancho base de cada uno.
const RADIAL_STREAK_WIDTH_MULTIPLIER = 2.2;
// Colores a lo largo de cada rayito, de la punta (0) al centro (0.5); la otra mitad se refleja.
const RADIAL_STREAK_GRADIENT = [
  [0, '255,60,80'],
  [0.17, '255,225,90'],
  [0.33, '110,255,150'],
  [0.5, '80,170,255'],
];
// Capas del difuminado: [ancho relativo, opacidad]. Las más anchas y tenues suavizan el borde redondeado.
const RADIAL_STREAK_SOFT_LAYERS = [
  [3.2, 0.12],
  [1.9, 0.30],
  [1, 0.85],
];

// --- Sprite / glow baking tuning ---------------------------------------------
// Consolidated from js/sprites.js: pure tuning literals with no runtime-state
// dependency. The baking/caching functions that consume them stay in sprites.js.
const SPRITE_MAX_DIM = 384;
const RING_SPRITE_MAX_DIM = 512;
const HALO_SPRITE_RADIUS = 192;
const HALO_REFERENCE_WIDTH_FACTOR = 0.18;
const CHROMATIC_RING_DIFFUSION = 8 + 11 * (0.26 / 0.46); // diffusion at unit ellipse scale
const FLARE_BODY_BLUR = 4;
const FLARE_RING_DIFFUSION = 10;
const FLARE_RING_WIDTH = 1.15;
// RAP-8: the line-glow bucketing constants (GLOW_BUCKET_RATIO/GLOW_SPRITE_MAX_DIM/
// GLOW_LINE_BASE_WIDTH) only ever backed the center prism's edges; removed with it. The rect-glow
// apparatus they used to sit alongside was already removed in RAP-2b (sphere/orbit-block only).
