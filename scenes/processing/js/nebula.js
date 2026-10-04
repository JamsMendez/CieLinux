// html-wallpaper-demo D2: verbatim port of docs/great-sage/backgroud-processing/js/nebula.js (that
// tree is reference-only, excluded from git -- see the feature doc, "Source material"). Not
// restyled: only this header comment was added, the source's own header/body follow unchanged.
// resize() here is the one shared canvas resize the whole scene (and the alert overlay's tile
// layout) reads W/H/canvasScaleX/Y from -- see js/alert-overlay.js.
//
// nebula.js — WebGL background renderer (shaders, GL setup, resize) plus the shared
// canvas resize()/startup sequence. Loads after config.js and math.js. Depends on
// NEBULA_* config, canvas/nebulaCanvas, and W/H/DPR from config.js.
// NEBULA_* tuning constants moved to js/config.js (SPL-2 consolidation).
let nebulaRenderer = null;

const NEBULA_VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const NEBULA_FRAGMENT_SHADER = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_rotation;
uniform float u_drift;
uniform float u_warp;
uniform float u_thickness;
uniform float u_scale;
uniform float u_intensity;
// mini-scene-window T2b: 1.0 in the ?variant=mini corner window, 0.0 otherwise (full scene unchanged).
uniform float u_mini;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(41.71, 289.13))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  local = local * local * (3.0 - 2.0 * local);
  float a = hash(cell);
  float b = hash(cell + vec2(1.0, 0.0));
  float c = hash(cell + vec2(0.0, 1.0));
  float d = hash(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 3; octave++) {
    value += amplitude * noise(p);
    p = p * 2.03 + vec2(19.2, 7.4);
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 p = (2.0 * gl_FragCoord.xy - u_resolution) / min(u_resolution.x, u_resolution.y);
  p /= u_scale;
  float radius = length(p);
  // Rotación rígida y continua: todo el campo gira junto, sin oscilar ni "respirar".
  float angle = atan(p.y, p.x) - u_rotation;
  vec2 circularAngle = vec2(cos(angle), sin(angle));
  // Offset mayor = espirales menos apretadas en el centro.
  float radialLog = log(radius + 0.12);
  // Recorrido circular lento por el espacio de ruido: la deformación cambia sin ir y volver.
  vec2 drift = vec2(cos(u_drift), sin(u_drift)) * 3.0;
  float warp = fbm(circularAngle * 1.6 + vec2(radialLog * 1.9, radialLog * 2.3) + drift);
  float warpDetail = fbm(circularAngle * 3.4 + vec2(radialLog * 3.7, -radialLog * 2.9) - drift * 1.4);
  float bend = ((warp - 0.5) * 5.0 + (warpDetail - 0.5) * 2.4) * u_warp;
  // Ancho variable a lo largo de cada corriente; el factor 0.45 deja huecos negros entre bandas.
  float width = u_thickness * 0.45 * (0.45 + 0.9 * warpDetail);
  float widthSq = width * width + 0.001;
  float primaryWave = abs(sin(angle * 5.0 - radialLog * 8.5 + bend));
  float secondaryWave = abs(sin(angle * 3.0 - radialLog * 5.2 + bend * 0.7 + 1.7));
  // Perfil gaussiano: las corrientes se funden en nubes suaves en vez de dibujar líneas con borde.
  float primaryStream = exp(-(primaryWave * primaryWave) / (widthSq * 1.6));
  float secondaryStream = exp(-(secondaryWave * secondaryWave) / (widthSq * 1.2));
  // Cortes aleatorios de baja frecuencia: abren huecos sin agregar textura de rayas.
  float breaks = smoothstep(0.30, 0.62, warpDetail * 0.75 + warp * 0.25);
  float streams = (primaryStream + secondaryStream * 0.25) * (0.3 + 0.7 * breaks);
  // Brillo difuso amplio alrededor de cada corriente para el aspecto nebuloso del frame de referencia.
  float haze = exp(-(primaryWave * primaryWave) / (widthSq * 6.0)) * (0.4 + 0.6 * breaks);
  // Radio en pantalla (independiente de NEBULA_SCALE): 1.0 = borde superior/inferior del canvas.
  float screenRadius = radius * u_scale;
  // Centro libre: la nebulosa se abre alrededor del núcleo, que queda en negro profundo.
  float clearCenter = smoothstep(0.15, 0.45, screenRadius);
  float edge = 1.0 - smoothstep(0.66, 0.82, radius);
  // Siguiendo los brazos de la espiral, el verde y el azul se meten uno dentro del otro.
  float armMixing = sin(angle * 3.0 - radialLog * 5.2 + bend * 0.7 + 1.7);
  // Frontera verde/azul deformada: el ruido y una ondulación angular la alejan de un anillo perfecto.
  float boundary = screenRadius + (warpDetail - 0.5) * 0.45 + sin(angle * 2.0 + warp * 6.0) * 0.08 + armMixing * 0.12;
  // Espacio negro entre verde y azul; su ancho también varía con el ruido.
  float gapWidth = 0.11 + 0.12 * warp;
  float colorGap = smoothstep(gapWidth * 0.4, gapWidth, abs(boundary - 1.0));
  // El espacio negro solo aparece en algunas zonas y momentos; en el resto los colores se mezclan.
  float gapPresence = smoothstep(0.34, 0.56, fbm(circularAngle * 2.2 + vec2(radialLog * 1.7, -radialLog * 2.1) + drift * 0.8 + vec2(5.3, 1.9)));
  float gapMask = mix(1.0, mix(0.04, 1.0, colorGap), gapPresence);
  // Huecos negros dentro de la zona verde (no en la frontera): ruido estirado a lo largo de los brazos que cambia con el tiempo.
  float greenZone = 1.0 - smoothstep(0.72, 0.88, boundary);
  float innerVoidNoise = fbm(circularAngle * 3.0 + vec2(radialLog * 4.3, -radialLog * 3.1) + drift * 1.1 + vec2(2.7, 8.1));
  float innerVoid = smoothstep(0.46, 0.62, innerVoidNoise) * greenZone;
  float density = (streams * 0.65 + haze * 0.5) * clearCenter * edge * gapMask * (1.0 - 0.92 * innerVoid);
  // Paleta de referencia: verde lima/esmeralda cerca del centro, azul cielo y marino hacia los bordes.
  vec3 limeEmerald = vec3(0.42, 0.86, 0.22);
  vec3 emerald = vec3(0.02, 0.60, 0.25);
  vec3 sky = vec3(0.10, 0.55, 0.78);
  vec3 navy = vec3(0.03, 0.10, 0.36);
  vec3 outerBlue = mix(navy, sky, smoothstep(0.35, 0.70, warp));
  vec3 color = mix(limeEmerald, emerald, smoothstep(0.35, 0.65, screenRadius));
  color = mix(color, outerBlue, smoothstep(0.85, 1.15, boundary));
  color *= mix(1.0, 0.8, smoothstep(1.1, 1.7, screenRadius));
  if (u_mini > 0.5) {
    // Mini: the page is see-through, so the nebula must never reach the window edge (that would
    // reveal the rectangle). Green palette only (the shader's own limeEmerald -> emerald, no blue
    // outer band), premultiplied alpha = density, faded to 0 by 0.9 of the half-side (45% of the side
    // from the center) so every edge and corner pixel is fully transparent.
    vec3 green = mix(limeEmerald, emerald, smoothstep(0.35, 0.65, screenRadius));
    float squareRadius = length(2.0 * gl_FragCoord.xy - u_resolution) / min(u_resolution.x, u_resolution.y);
    float fade = 1.0 - smoothstep(0.5, 0.9, squareRadius);
    float alpha = clamp(density * u_intensity * fade, 0.0, 1.0);
    gl_FragColor = vec4(green * alpha, alpha);
    return;
  }
  gl_FragColor = vec4(color * density * u_intensity, 1.0);
}`;

// Linux diagnostics begin: sole approved reference-copy exception.
// One last detail per fixed stage: bounded storage, repeated failures do not spam frames.
const nebulaFailureDetails = Object.seal({
  'compile-vertex': null, 'compile-fragment': null, link: null,
  initialize: null, render: null, unavailable: null, 'context-lost': null,
});
function reportNebulaFailure(stage, detail) {
  let message;
  try {
    const value = typeof detail === 'function' ? detail() : detail;
    message = value && value.message ? String(value.message) : String(value);
  } catch (error) {
    message = 'Diagnostic detail unavailable: ' + String(error);
  }
  if (nebulaFailureDetails[stage] === message) return;
  nebulaFailureDetails[stage] = message;
  // A broken logger must not turn the reference's nonthrowing fallback into a scene failure.
  try { console.error('[processing-nebula] ' + stage + ': ' + message); } catch (_) {}
}
// Linux diagnostics end.

function compileNebulaShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  // Linux diagnostics begin.
  reportNebulaFailure(type === gl.VERTEX_SHADER ? 'compile-vertex' : 'compile-fragment',
    () => gl.getShaderInfoLog(shader) || 'Shader compilation failed without an info log');
  // Linux diagnostics end.
  gl.deleteShader(shader);
  return null;
}

function initializeNebulaRenderer() {
  // Linux diagnostics begin.
  if (!nebulaCanvas || !window.WebGLRenderingContext)
    reportNebulaFailure('unavailable', !nebulaCanvas ? 'Nebula canvas unavailable' : 'WebGL API unavailable');
  // Linux diagnostics end.
  if (!nebulaCanvas || !window.WebGLRenderingContext) return;
  try {
    const gl = nebulaCanvas.getContext('webgl', {
      // Mini needs a real alpha channel (see-through window); the full page keeps the opaque buffer.
      alpha: isMiniVariant,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    // Linux diagnostics begin.
    if (!gl) reportNebulaFailure('unavailable', 'WebGL context unavailable');
    // Linux diagnostics end.
    if (!gl) return;
    const vertex = compileNebulaShader(gl, gl.VERTEX_SHADER, NEBULA_VERTEX_SHADER);
    const fragment = compileNebulaShader(gl, gl.FRAGMENT_SHADER, NEBULA_FRAGMENT_SHADER);
    if (!vertex || !fragment) return;
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      // Linux diagnostics begin.
      reportNebulaFailure('link', () => gl.getProgramInfoLog(program) || 'Program linking failed without an info log');
      // Linux diagnostics end.
      gl.deleteProgram(program);
      return;
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    nebulaRenderer = {
      gl,
      program,
      buffer,
      position: gl.getAttribLocation(program, 'a_position'),
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      rotation: gl.getUniformLocation(program, 'u_rotation'),
      drift: gl.getUniformLocation(program, 'u_drift'),
      warp: gl.getUniformLocation(program, 'u_warp'),
      thickness: gl.getUniformLocation(program, 'u_thickness'),
      scale: gl.getUniformLocation(program, 'u_scale'),
      intensity: gl.getUniformLocation(program, 'u_intensity'),
      mini: gl.getUniformLocation(program, 'u_mini'),
    };
    resizeNebula();
  } catch (_) {
    nebulaRenderer = null;
    // Linux diagnostics begin.
    reportNebulaFailure('initialize', _);
    // Linux diagnostics end.
  }
}

function resizeNebula() {
  if (!nebulaRenderer || !W || !H) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, NEBULA_DPR_CAP);
  nebulaCanvas.width = Math.max(1, Math.round(W * pixelRatio));
  nebulaCanvas.height = Math.max(1, Math.round(H * pixelRatio));
}

function renderNebula(ms) {
  if (!nebulaRenderer) return;
  try {
    const { gl, program, buffer, position, resolution, rotation, drift, warp, thickness, scale, intensity, mini } = nebulaRenderer;
    gl.viewport(0, 0, nebulaCanvas.width, nebulaCanvas.height);
    gl.clearColor(0, 0, 0, isMiniVariant ? 0 : 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(resolution, nebulaCanvas.width, nebulaCanvas.height);
    // Divide por los 5 brazos de la espiral para conservar la velocidad visual previa; el módulo evita perder precisión.
    const turns = (ms / 1000 / NEBULA_LOOP_DURATION) * (NEBULA_SPEED / 5);
    gl.uniform1f(rotation, (turns % 1) * Math.PI * 2);
    gl.uniform1f(drift, ((ms / 1000 / NEBULA_WARP_PERIOD) % 1) * Math.PI * 2);
    gl.uniform1f(warp, NEBULA_WARP_STRENGTH);
    gl.uniform1f(thickness, NEBULA_THICKNESS);
    gl.uniform1f(scale, NEBULA_SCALE);
    gl.uniform1f(intensity, NEBULA_INTENSITY);
    gl.uniform1f(mini, isMiniVariant ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } catch (_) {
    nebulaRenderer = null;
    // Linux diagnostics begin.
    reportNebulaFailure('render', _);
    // Linux diagnostics end.
  }
}

if (nebulaCanvas) {
  nebulaCanvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    nebulaRenderer = null;
    // Linux diagnostics begin.
    reportNebulaFailure('context-lost', event.statusMessage || 'WebGL context lost');
    // Linux diagnostics end.
  });
  nebulaCanvas.addEventListener('webglcontextrestored', initializeNebulaRenderer);
}

function resize() {
  const bounds = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
  const fallbackWidth = Math.max(1, window.innerWidth || 1);
  const fallbackHeight = Math.max(1, window.innerHeight || 1);
  const cssWidth = Number.isFinite(bounds?.width) && bounds.width > 0 ? bounds.width : fallbackWidth;
  const cssHeight = Number.isFinite(bounds?.height) && bounds.height > 0 ? bounds.height : fallbackHeight;
  const nominalDPR = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(cssWidth * nominalDPR);
  const pixelHeight = Math.round(cssHeight * nominalDPR);
  const effectiveScaleX = pixelWidth / cssWidth;
  const effectiveScaleY = pixelHeight / cssHeight;
  if (W === cssWidth && H === cssHeight && DPR === nominalDPR &&
      canvas.width === pixelWidth && canvas.height === pixelHeight &&
      canvasScaleX === effectiveScaleX && canvasScaleY === effectiveScaleY) {
    return;
  }
  W = cssWidth;
  H = cssHeight;
  DPR = nominalDPR;
  canvasScaleX = effectiveScaleX;
  canvasScaleY = effectiveScaleY;
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  ctx.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0);
  spritesStale = true;
  resizeNebula();
}
window.addEventListener('resize', resize, { passive: true });
document.addEventListener('fullscreenchange', resize);
resize();
// initializeNebulaRenderer() now runs from main.js (right before the first frame): it needs
// isMiniVariant (shared/js/render-loop.js), which loads after this file.
