// html-wallpaper-demo D2: adapted from docs/great-sage/backgroud-processing/js/config.js (that tree
// is reference-only, excluded from git -- see the feature doc, "Source material"). The scene
// bootstrap and every tuning constant below are an intact port; only the SINGLE-overlay runtime
// state (failureState/failureKind/failureToggleRequested/failureStartMs/scenePausedMs) and the user
// zoom level are dropped here -- CielWin.App/Wallpaper/Web/shared/js/alert-overlay.js owns a
// per-KIND, tile-driven state machine instead (the same external contract
// CielWin.App/Alerts/Web/alert-layer.js exposes), and this wallpaper has no zoom UI to drive
// viewZoom away from 1 (see "Drop what a wallpaper does not need").
//
// D6a: FAILURE_SHAKE_MS/FAILURE_REVEAL_MS/FAILURE_OVERLAY_THEMES/etc. (added here by D2) moved to
// the shared alert-overlay.js -- they are alert-overlay tuning, shared by every scene now, not
// processing scene tuning (see that file's own header remarks).
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
// No zoom UI on the wallpaper (html-wallpaper-demo D2): kept as a constant only because
// layers.js/sprites.js still read it by name (visibleCanvasBounds, perspectiveRayEndpoint, the
// scene's own render() zoom transform, drawFailureBandIntersections' band scale).
const viewZoom = 1;

// Tiempo total (en segundos) que la animación avanza antes de invertirse (ping-pong); el ciclo
// completo dura el doble: ida + regreso. Alargarlo NO hace más lenta la animación: la repite más
// veces a la misma velocidad (con 60 y ANIMATION_CYCLE_DURATION = 30 se repite 2 veces hacia
// adelante y luego se invierte). Debe ser un número mayor que 0; no hace falta que sea múltiplo
// de ANIMATION_CYCLE_DURATION. Solo el pulso del octágono (OCTAGON_PULSE_INTERVAL) es independiente.
const ONE_WAY_DURATION = 60 * 5;
// Duración (en segundos) de UNA repetición base de la animación. Fija la velocidad de todo el
// movimiento (con 30, las bandas dan una vuelta cada 30 s): bájala para que todo vaya más rápido y
// súbela para que vaya más lento. Para alargar la animación usa ONE_WAY_DURATION. Debe ser mayor que 0.
const ANIMATION_CYCLE_DURATION = 30;
// Cada cuántos segundos late (pulsa) el octágono central: 5 = valor actual, 3 = más frecuente.
// Debe ser un número mayor que OCTAGON_PULSE_DURATION. El pulso no depende de ONE_WAY_DURATION.
const OCTAGON_PULSE_INTERVAL = 3;
// Duración en segundos de cada pulso. Debe ser mayor que 0 y menor que OCTAGON_PULSE_INTERVAL.
const OCTAGON_PULSE_DURATION = 1;

// User tuning: signed finite values control speed; zero pauses and negative values reverse motion.
// Velocidad de cada banda blanca plegable, en orden [exterior, media, interior].
// El valor es el número de vueltas por cada tramo de ida (ver ONE_WAY_DURATION):
// 1 = una vuelta, 2 = el doble de rápido, 0.5 = la mitad, 0 = detenida y negativo = gira al revés.
const FOLDING_BAND_SPEEDS = [3, -3, 3]; // [outer, middle, inner]
// Rectángulos por cada anillo que orbita el octágono, en orden [exterior, interior].
// Cada valor debe ser un entero no negativo: 0 oculta ese anillo; [25, 25] conserva los 50 bloques actuales.
const ORBIT_BLOCK_RING_COUNTS = [16, 16]; // [outer, inner]
// Velocidad de cada anillo de rectángulos, en orden [exterior, interior]. Los valores finitos
// admiten decimales: 1 = una vuelta por tramo de ida, 0.5 = media vuelta, 0 = detenido y
// los valores negativos invierten el sentido (-2 = dos vueltas en sentido contrario).
const ORBIT_BLOCK_RING_SPEEDS = [2, -2]; // [outer, inner]
// Velocidad de giro del tetraedro (pirámide triangular) central, en vueltas por tramo de ida.
// 1 = normal, 2 = el doble, 0 = sin girar y negativo = gira al revés. No cambia su
// acercamiento/alejamiento, que es independiente.
const TRIANGULAR_PRISM_ROTATION_SPEED = 12;
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
// User tuning: signed finite values control the shared segmented-sphere assembly cycle.
// Cantidad de piezas de cada figura de la esfera segmentada. Cambia cada número para probar
// combinaciones; deben ser enteros mayores o iguales que 0 y sumar al menos 1 (un 0 oculta esa figura).
// Las figuras se reparten de forma pareja por toda la esfera según su cantidad. Más piezas = más
// carga para el navegador y más solapamiento, porque el tamaño de cada pieza no cambia.
// Cuadrados blancos sólidos:
const SOLID_SQUARE_SPHERE_PIECE_COUNT = 20;
// Rectángulos transparentes con borde blanco:
const OUTLINE_RECTANGLE_SPHERE_PIECE_COUNT = 10;
// Rectángulos cuadriculados (con líneas internas, ver GRIDDED_RECTANGLE_*_LINE_COUNT):
const GRIDDED_RECTANGLE_SPHERE_PIECE_COUNT = 10;
const SPHERE_STYLE_COUNTS = [SOLID_SQUARE_SPHERE_PIECE_COUNT, OUTLINE_RECTANGLE_SPHERE_PIECE_COUNT, GRIDDED_RECTANGLE_SPHERE_PIECE_COUNT];
const SPHERE_STYLE_COUNTS_EQUAL = SPHERE_STYLE_COUNTS.every((count) => count === SPHERE_STYLE_COUNTS[0]);
// The radius/depth comparability check below is a property of the default seeded selection, not an invariant.
const SPHERE_STYLE_COUNTS_DEFAULT = SPHERE_STYLE_COUNTS.every((count) => count === 48);
const TOTAL_SPHERE_PIECE_COUNT = SOLID_SQUARE_SPHERE_PIECE_COUNT + OUTLINE_RECTANGLE_SPHERE_PIECE_COUNT + GRIDDED_RECTANGLE_SPHERE_PIECE_COUNT;
// Velocidad del ciclo armado ↔ explosión de las 144 piezas de la esfera segmentada.
// Es el número de ciclos completos (armada → explotada → armada) por tramo de ida:
// 1 = un ciclo, 2 = dos ciclos (el doble de rápido), 0.5 = medio ciclo y 0 = piezas quietas.
// El signo no cambia el resultado.
const SPHERE_ASSEMBLY_EXPLOSION_SPEED = 10;
// Rounded only across this narrow fraction of either travel endpoint; the remaining travel is linear.
const SPHERE_TURNAROUND_FRACTION = 0.06;
// Velocidad de giro 3D compartido de los cuadrados y rectángulos de la esfera.
// Vueltas por ciclo base: 1 = una vuelta, 0.5 = media vuelta, 0 = detenida y negativo = sentido inverso.
// Subí este valor para acelerar la esfera; 0.40 mantiene un giro visible sin dominar la composición.
const SEGMENTED_SPHERE_ROTATION_SPEED = 0.7;
const SPHERE_EXPLOSION_DISTANCE = 0.23;
const SPHERE_ASSEMBLED_RADIUS = 0.32;

const CAMERA_DISTANCE = 4.8;
const CAMERA_DENOMINATOR_MIN = 1.2;
const TETRAHEDRON_FAR_SCALE = 0.13;
const TETRAHEDRON_NEAR_SCALE = 0.84;
const TETRAHEDRON_CAMERA_FAR = -0.62;
const TETRAHEDRON_CAMERA_NEAR = 0.56;
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
// Prominent core rays and foreground inclined rays share this visual language.
const CENTRAL_RAY_STROKE_COLOR = '236,253,255';
const CENTRAL_RAY_LINE_WIDTH = 1.45;
const CENTRAL_RAY_OPACITY = 0.52;
const CENTRAL_RAY_GLOW_COLOR = 'rgba(145,230,255,0.9)';
const CENTRAL_RAY_GLOW_BLUR = 6;
const CENTRAL_CORE_MINOR_RAY_FACTOR = 2.15;
const CENTRAL_CORE_RADIUS_MIN_SAMPLE_COUNT = 4096;
const SEGMENTED_SPHERE_GLOW_ALPHA = 0.42;
const SEGMENTED_SPHERE_GLOW_BLUR = 6;
const SOLID_SQUARE_SPHERE_ALPHA = 0.82;
const SOLID_SQUARE_SPHERE_STROKE_ALPHA = 0.94;
const OUTLINE_RECTANGLE_SPHERE_STROKE_ALPHA = 0.82;
const GRIDDED_RECTANGLE_SPHERE_FILL_ALPHA = 0.46;
const GRIDDED_RECTANGLE_SPHERE_STROKE_ALPHA = 0.80;
// Número de líneas internas de la cuadrícula de los rectángulos cuadriculados de la esfera:
// líneas verticales y horizontales por rectángulo. Deben ser enteros mayores o iguales que 1;
// más líneas = cuadrícula más densa (los bordes del rectángulo no cuentan).
const GRIDDED_RECTANGLE_VERTICAL_LINE_COUNT = 12;
const GRIDDED_RECTANGLE_HORIZONTAL_LINE_COUNT = 16;
const SEGMENTED_SPHERE_BASE_WIDTH = 0.066;
const SOLID_SQUARE_SIZE_MULTIPLIER = 0.5;
const SPHERE_RECTANGLE_ASPECT_RATIO = 2.2;
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
// mini-scene-window T2l: the structure's radii already follow min(W, H) (bands minD*0.385, orbit blocks
// minD*0.205, octagon minD*0.168, ...), but its stroke widths, glow blurs and orbit block sizes are absolute
// px tuned on the real screen (3440x1440, short side 1440). In the ?variant=mini window those px are ~5x too
// big for the ~5x smaller structure (thick, glowing bands and 7-19px orbit squares). In mini every fixed px
// value goes through structurePx(): scaled by min(W, H) / 1440 with a small floor so hairlines never vanish.
// The full variant returns the value untouched. isMiniVariant comes from shared/js/render-loop.js.
const MINI_STRUCTURE_REFERENCE_SHORT_SIDE = 1440;

function miniStructureScale() {
  return Math.min(W, H) / MINI_STRUCTURE_REFERENCE_SHORT_SIDE;
}

function structurePx(px, floor = 0) {
  return isMiniVariant ? Math.max(floor, px * miniStructureScale()) : px;
}

// T2m: the two white folding bands (the "orbits") are minD*0.025 / 0.023 / 0.018 wide, ~7px at 288, far too thick
// in the small window. Mini multiplies those widths by this factor (2.5px for the widest at 288); the band radii,
// folding and animation are untouched, and the full scene multiplies by exactly 1. It is a factor on the
// proportional widths rather than structurePx, because the widths are minD-relative already (not fixed px).
const MINI_FOLDING_BAND_WIDTH_FACTOR = 0.35;

const ORBIT_BLOCK_RING_COUNT = 2;
const ORBIT_BLOCK_COUNT = ORBIT_BLOCK_RING_COUNTS.reduce((total, count) => total + count, 0);

const ORBIT_BLOCK_RINGS = [
  { radiusX: 1.16, radiusY: 0.64, planeTilt: -0.46 },
  { radiusX: 0.78, radiusY: 1.08, planeTilt: 0.58 },
];

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
const GLOW_BUCKET_BASE = 4;
const GLOW_BUCKET_RATIO = 1.25;
const GLOW_SPRITE_MAX_DIM = 256;
const ORBIT_BLOCK_GLOW_BLUR = 7;
const ORBIT_BLOCK_GLOW_ALPHA = 0.50;
const GLOW_LINE_BASE_WIDTH = 0.5;
