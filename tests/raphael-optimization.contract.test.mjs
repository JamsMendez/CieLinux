import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { SRC, source } from './paths.mjs';

// O3 (odd/tasks/mini-scene-optimization.md): raphael mini CPU/memory optimizations. Each change is
// compared against verbatim copies of the pre-optimization CielWin functions (REFERENCE below) on
// recorded Canvas2D call streams. The mocks record API calls; they do not model pixels, so resampling
// differences of baked bitmaps are argued in the feature document, not measured here.

const read = name => readFileSync(source(name), 'utf8');
const sha256 = text => createHash('sha256').update(text).digest('hex');

// Verbatim pre-O3 layers.js/sprites.js functions (CielWin reference). They draw on the module-global
// `ctx`, so they are wrapped in a factory whose `ctx` parameter points them at a recorder instead.
const REFERENCE = String.raw`
function referenceLayers(ctx) {
function stampSprite(sprite, unit, alpha) {
  const w = sprite.hw * 2 * unit;
  const h = sprite.hh * 2 * unit;
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite.canvas, -w / 2, -h / 2, w, h);
}
function drawGlowSegments(segments, width, alpha, blur = 8) {
  if (segments.length === 0) return;
  ctx.save();
  ctx.strokeStyle = ` + '`rgba(${CENTRAL_RAY_STROKE_COLOR},${alpha})`' + String.raw`;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.shadowColor = CENTRAL_RAY_GLOW_COLOR;
  ctx.shadowBlur = blur;
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of segments) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
  ctx.restore();
}
function drawGlyphRingDelimiters(cx, cy, annuli) {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.strokeStyle = GLYPH_RING_DELIMITER_COLOR;
  ctx.lineWidth = GLYPH_RING_DELIMITER_WIDTH;
  ctx.shadowColor = GLYPH_RING_DELIMITER_GLOW_COLOR;
  ctx.shadowBlur = GLYPH_RING_DELIMITER_GLOW_BLUR;
  const radii = [
    annuli[0].innerRadius,
    annuli[0].outerRadius,
    annuli[1].outerRadius,
    annuli[2].outerRadius,
    annuli[3].outerRadius,
  ];
  for (const radius of radii) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.restore();
}
function drawGlyphRings(cx, cy, progress) {
  const r = coreRadius(Math.min(W, H));
  const annuli = glyphRingAnnuli(r);
  drawGlyphRingDelimiters(cx, cy, annuli);
  const gold = goldGlyphRingDrawParams(progress);
  drawOutlineGlyphRing(cx, cy, gold.radius, sprites.outlineGlyphsGold.length, sprites.outlineGlyphsGold, gold.rotation);
  const blue = annuli[3];
  drawOutlineGlyphRing(cx, cy, (blue.innerRadius + blue.outerRadius) / 2, sprites.outlineGlyphs.length, sprites.outlineGlyphs, progress * TAU * GLYPH_RING_BLUE_ROTATION_SPEED);
}
function drawOutlineGlyphRing(cx, cy, radius, count, spriteSet, rotation) {
  for (let i = 0; i < count; i++) {
    const angle = rotation + (i / count) * TAU;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(glyphRingOrientationAngle(angle));
    stampSprite(spriteSet[i], 1, 1);
    ctx.restore();
  }
}
function drawGoldenHexadecagon(cx, cy, progress, pulse) {
  const r = coreRadius(Math.min(W, H));
  const rot = progress * TAU * 0.18;
  const pulseStroke = 1 + pulse * HEXADECAGON_PULSE_STROKE_FACTOR;
  const pulseBlur = HEXADECAGON_PULSE_BLUR_BASE + pulse * HEXADECAGON_PULSE_BLUR_RANGE;
  const vertices = hexadecagonVertices(r, pulse);
  const chromaticStrokeWidth = r * HEXADECAGON_STROKE_WIDTH_FACTOR * pulseStroke;
  const chromaticOffsetPx = r * HEXADECAGON_CHROMATIC_OFFSET_FACTOR;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const chromaticOffsets = [-chromaticOffsetPx, chromaticOffsetPx];
  for (let i = 0; i < chromaticOffsets.length; i++) {
    const offset = chromaticOffsets[i];
    ctx.strokeStyle = HEXADECAGON_CHROMATIC_COLORS[i];
    ctx.lineWidth = chromaticStrokeWidth;
    ctx.beginPath();
    for (let v = 0; v < vertices.length; v++) {
      const x = vertices[v].x + offset;
      const y = vertices[v].y;
      if (v === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  ctx.strokeStyle = HEXADECAGON_RING_CORE_COLOR;
  ctx.lineWidth = chromaticStrokeWidth * 1.3;
  ctx.shadowColor = HEXADECAGON_RING_GLOW_COLOR;
  ctx.shadowBlur = pulseBlur;
  ctx.beginPath();
  for (let v = 0; v < vertices.length; v++) {
    if (v === 0) ctx.moveTo(vertices[v].x, vertices[v].y); else ctx.lineTo(vertices[v].x, vertices[v].y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}
function paintRadialGlowLayer(cx, cy, radius, stops, colorRgb, compositeOperation, shadow) {
  ctx.save();
  ctx.globalCompositeOperation = compositeOperation;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  for (const [offset, alpha] of stops) {
    gradient.addColorStop(offset, ` + '`rgba(${colorRgb},${alpha})`' + String.raw`);
  }
  ctx.fillStyle = gradient;
  if (shadow) {
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = shadow.blur;
  }
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.fill();
  ctx.restore();
}
function drawCoreGlareStreaks(cx, cy, r, phase, flare) {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.lineWidth = CENTRAL_CORE_GLARE_STREAK_WIDTH;
  const length = r * CENTRAL_CORE_GLARE_STREAK_LENGTH_FACTOR;
  for (let i = 0; i < CENTRAL_CORE_GLARE_STREAK_COUNT; i++) {
    const angle = centralCoreGlareStreakAngle(i, CENTRAL_CORE_GLARE_STREAK_COUNT, phase, CENTRAL_CORE_GLARE_ROTATION_SPEED);
    const x1 = cx - Math.cos(angle) * length;
    const y1 = cy - Math.sin(angle) * length;
    const x2 = cx + Math.cos(angle) * length;
    const y2 = cy + Math.sin(angle) * length;
    const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
    for (const [offset, alpha] of CENTRAL_CORE_GLARE_FADE_STOPS) {
      gradient.addColorStop(offset, ` + '`rgba(${CENTRAL_CORE_GLARE_COLOR},${alpha * CENTRAL_CORE_GLARE_STREAK_ALPHA * flare})`' + String.raw`);
    }
    ctx.strokeStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();
}
function drawCentralCore(cx, cy, phase, pulse) {
  const minD = Math.min(W, H);
  const r = minD * normalizedCentralCoreRadius(phase);
  if (CENTRAL_CORE_PROMINENT_RAY_COUNT > 0) {
    const prominentSegments = [];
    for (let i = 0; i < CENTRAL_CORE_PROMINENT_RAY_COUNT; i++) {
      const a = i * TAU / CENTRAL_CORE_PROMINENT_RAY_COUNT + Math.sin(phase) * 0.04;
      const desiredLength = r * mix(
        CENTRAL_CORE_PROMINENT_MIN_REACH_FACTOR,
        CENTRAL_CORE_PROMINENT_MAX_REACH_FACTOR,
        prominentRayGrowthEnvelope(phase, i)
      );
      const l = Math.min(desiredLength, centralCoreRaySafeLength(cx, cy, a));
      prominentSegments.push([
        cx + Math.cos(a) * r * CENTRAL_CORE_RAY_INNER_RADIUS_FACTOR,
        cy + Math.sin(a) * r * CENTRAL_CORE_RAY_INNER_RADIUS_FACTOR,
        cx + Math.cos(a) * l,
        cy + Math.sin(a) * l,
      ]);
    }
    drawGlowSegments(prominentSegments, CENTRAL_RAY_LINE_WIDTH, CENTRAL_RAY_OPACITY, CENTRAL_RAY_GLOW_BLUR);
    const minorSegments = [];
    for (let i = 0; i < CENTRAL_CORE_MINOR_RAY_COUNT; i++) {
      const a = (i + 0.5) * TAU / CENTRAL_CORE_MINOR_RAY_COUNT - Math.sin(phase) * 0.025;
      const l = r * CENTRAL_CORE_MINOR_RAY_FACTOR;
      minorSegments.push([
        cx + Math.cos(a) * r * 0.20,
        cy + Math.sin(a) * r * 0.20,
        cx + Math.cos(a) * l,
        cy + Math.sin(a) * l,
      ]);
    }
    drawGlowSegments(minorSegments, 0.70, 0.22, 5);
  }
  const flare = centralCoreFlareEnvelope(pulse);
  paintRadialGlowLayer(cx, cy, r * CENTRAL_CORE_BLOOM_OUTER_RADIUS_FACTOR * flare, CENTRAL_CORE_BLOOM_OUTER_STOPS, CENTRAL_CORE_GLOW_COLOR_OUTER, 'lighter');
  paintRadialGlowLayer(cx, cy, r * CENTRAL_CORE_BLOOM_INNER_RADIUS_FACTOR * flare, CENTRAL_CORE_BLOOM_INNER_STOPS, CENTRAL_CORE_GLOW_COLOR_MID, 'lighter');
  paintRadialGlowLayer(cx, cy, r * CENTRAL_CORE_HOT_RADIUS_FACTOR * 1.8 * flare, CENTRAL_CORE_HOT_STOPS, CENTRAL_CORE_GLOW_COLOR_INNER, 'lighter');
  drawCoreGlareStreaks(cx, cy, r, phase, flare);
  paintRadialGlowLayer(cx, cy, r * CENTRAL_CORE_HOT_RADIUS_FACTOR, CENTRAL_CORE_HOT_STOPS, CENTRAL_CORE_DISC_COLOR, 'lighter',
    { color: ` + '`rgba(${CENTRAL_CORE_DISC_GLOW_COLOR},0.85)`' + String.raw`, blur: 20 * flare });
}
return { drawGlyphRingDelimiters, drawGlyphRings, drawOutlineGlyphRing, drawGoldenHexadecagon, drawCentralCore };
}
`;

// Recording Canvas2D mock: every method call and property set lands in one ordered stream per context.
function harness({ variant = 'mini', width = 240, height = 240 } = {}) {
    const streams = new Map(), frames = [], events = {}, errors = [], created = [];
    let nextId = 0;
    const makeContext = () => {
        const id = nextId++, ops = [];
        streams.set(id, ops);
        const state = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
        const proxy = new Proxy(state, {
            get(target, name) {
                if (name in target) return target[name];
                if (name === 'measureText') return text => ({ width: String(text).length * 4 });
                return (...args) => {
                    ops.push([name, ...args]);
                    if (String(name).startsWith('create'))
                        return { gradient: name, args, stops: [], addColorStop(stop, color) { this.stops.push([stop, color]); } };
                };
            },
            set(target, name, value) { ops.push([`=${String(name)}`, value]); target[name] = value; return true; }
        });
        return { id, ops, proxy };
    };
    const scene0 = makeContext();
    const bounds = { width, height };
    const canvas = { width: 0, height: 0, getContext: () => scene0.proxy, getBoundingClientRect: () => bounds };
    const nebula = { width: 0, height: 0, getContext: () => null, addEventListener() {} };
    const window = { devicePixelRatio: 1, innerWidth: width, innerHeight: height,
        requestAnimationFrame: fn => frames.push(fn), addEventListener: (name, fn) => { events[name] = fn; } };
    const sandbox = vm.createContext({ window, URLSearchParams, performance: { now: () => 0 },
        location: { search: `?variant=${variant}&fps=30`, hash: '' },
        console: { log() {}, info() {}, warn() {}, error: (...args) => {
            if (!/synthetic transport probe|\[raphael-nebula\] unavailable/.test(String(args[0]))) errors.push(args);
        } },
        document: {
            getElementById: name => name === 'scene' ? canvas : nebula,
            createElement: () => {
                const element = { width: 0, height: 0, contextId: null };
                let c = null;
                element.getContext = () => { if (!c) { c = makeContext(); element.contextId = c.id; } return c.proxy; };
                created.push(element);
                return element;
            },
            documentElement: { classList: { add() {} } },
            addEventListener: (name, fn) => { events[name] = fn; } } });
    const html = read('raphael/index.html');
    for (const [, script] of html.matchAll(/<script src="([^"]+)"><\/script>/g))
        vm.runInContext(read(`raphael/${script}`), sandbox, { filename: `raphael/${script}` });
    vm.runInContext(REFERENCE, sandbox, { filename: 'reference.js' });
    const main = streams.get(scene0.id);
    const tick = ms => {
        assert.equal(frames.length, 1);
        const start = main.length, contextsBefore = nextId, createdBefore = created.length;
        frames.shift()(ms);
        return { ops: main.slice(start), newContexts: nextId - contextsBefore, created: created.slice(createdBefore) };
    };
    // Runs fn against the real scene ctx and returns only the ops it recorded there.
    const capture = fn => { const start = main.length; fn(); return main.slice(start); };
    const recorder = () => makeContext();
    const resize = (w, h) => { bounds.width = w; bounds.height = h; window.innerWidth = w; window.innerHeight = h; events.resize(); };
    const streamOf = element => streams.get(element.contextId);
    return { sandbox, main, streams, created, errors, tick, capture, recorder, resize, streamOf,
        evaluate: source => vm.runInContext(source, sandbox) };
}

const json = value => JSON.parse(JSON.stringify(value));
const count = (ops, name) => ops.filter(op => op[0] === name).length;
const centre = h => [h.evaluate('W') * 0.505, h.evaluate('H') * 0.515];
// pulse is 0 for 1150 ms of every 2000 ms (hexadecagonPulse); 1000 ms is inside a quiet window, 400 ms inside a pulse.
const QUIET_MS = 1000, PULSE_MS = 400;

// Replays a call stream with its own transform stack and reports each fill/stroke in canvas space:
// mapped path points, mapped gradient geometry, device-space line width and the paint state.
function flatten(ops) {
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    const map = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const scaleOf = m => Math.hypot(m[0], m[1]);
    let m = [1, 0, 0, 1, 0, 0], state = {}, path = [];
    const stack = [], out = [];
    const style = (value, matrix) => {
        if (!value || typeof value !== 'object') return value;
        const a = value.args, s = scaleOf(matrix);
        const geometry = value.gradient === 'createRadialGradient'
            ? [...map(matrix, a[0], a[1]), a[2] * s, ...map(matrix, a[3], a[4]), a[5] * s]
            : [...map(matrix, a[0], a[1]), ...map(matrix, a[2], a[3])];
        return { gradient: value.gradient, geometry, stops: value.stops };
    };
    for (const [name, ...a] of ops) {
        if (name === 'save') stack.push([m, { ...state }]);
        else if (name === 'restore') [m, state] = stack.pop();
        else if (name === 'translate') m = mul(m, [1, 0, 0, 1, a[0], a[1]]);
        else if (name === 'scale') m = mul(m, [a[0], 0, 0, a[1], 0, 0]);
        else if (name === 'rotate') m = mul(m, [Math.cos(a[0]), Math.sin(a[0]), -Math.sin(a[0]), Math.cos(a[0]), 0, 0]);
        else if (name === 'setTransform') m = a.slice(0, 6);
        else if (name.startsWith('=')) state[name.slice(1)] = a[0];
        else if (name === 'beginPath') path = [];
        else if (name === 'moveTo' || name === 'lineTo') path.push([name, ...map(m, a[0], a[1])]);
        else if (name === 'arc') path.push(['arc', ...map(m, a[0], a[1]), a[2] * scaleOf(m), a[4] - a[3]]);
        else if (name === 'closePath') path.push([name]);
        else if (name === 'fill' || name === 'stroke') {
            const blur = state.shadowBlur || 0;
            out.push({ name, path, composite: state.globalCompositeOperation ?? 'source-over',
                alpha: state.globalAlpha ?? 1, lineCap: state.lineCap, lineJoin: state.lineJoin,
                style: style(name === 'fill' ? state.fillStyle : state.strokeStyle, m),
                lineWidth: name === 'stroke' ? state.lineWidth * scaleOf(m) : undefined,
                shadow: blur > 0 ? [blur, state.shadowColor] : null });
        }
    }
    return out;
}

function assertClose(actual, expected, where = '') {
    if (typeof expected === 'number') {
        assert.equal(typeof actual, 'number', where);
        assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${where}: ${actual} vs ${expected}`);
    } else if (Array.isArray(expected)) {
        assert.ok(Array.isArray(actual), where);
        assert.equal(actual.length, expected.length, `${where} length`);
        expected.forEach((value, i) => assertClose(actual[i], value, `${where}[${i}]`));
    } else if (expected && typeof expected === 'object') {
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), where);
        for (const key of Object.keys(expected)) assertClose(actual[key], expected[key], `${where}.${key}`);
    } else assert.equal(actual, expected, where);
}

test('raphael mini: glyph-ring delimiters bake once into a device-aligned layer composited with screen', () => {
    const h = harness();
    const first = h.tick(QUIET_MS);
    assert.deepEqual(h.errors, []);
    const [cx, cy] = centre(h);
    const annuli = h.evaluate('glyphRingAnnuli(coreRadius(Math.min(W, H)))');
    const reference = h.recorder();
    h.sandbox.referenceLayers(reference.proxy).drawGlyphRingDelimiters(cx, cy, annuli);
    // The scene canvas never strokes the blurred circles itself any more.
    assert.ok(!first.ops.some(op => op[0] === '=shadowBlur' && op[1] === h.evaluate('GLYPH_RING_DELIMITER_GLOW_BLUR')));
    const layers = first.created.filter(element => element.contextId !== null && JSON.stringify(json(h.streamOf(element).slice(4))) === JSON.stringify(json(reference.ops)));
    assert.equal(layers.length, 1, 'one layer holds exactly the reference delimiter stream');
    const layerOps = h.streamOf(layers[0]);
    const zoom = h.evaluate('MINI_SCENE_ZOOM');
    const [set, sx, b, c, sy, ex, ey] = layerOps[0];
    assert.deepEqual([set, sx, b, c, sy], ['setTransform', 1, 0, 0, 1]);
    assert.ok(Number.isInteger(ex) && Number.isInteger(ey), 'layer origin is whole device pixels');
    assert.deepEqual(layerOps.slice(1, 4), [['translate', cx, cy], ['scale', zoom, zoom], ['translate', -cx, -cy]]);
    // The layer reaches past the outermost circle's stroke plus 2x the blur radius (4 sigma) on every side.
    const reach = (annuli[3].outerRadius + 1) * zoom + 20;
    assert.ok(-ex <= cx - reach && -ex + layers[0].width >= cx + reach, 'horizontal extent covers the glow');
    assert.ok(-ey <= cy - reach && -ey + layers[0].height >= cy + reach, 'vertical extent covers the glow');
    // Scene canvas: the layer is the first paint after clearRect, drawn 1:1 at its device origin with 'screen'.
    const draw = first.ops.findIndex(op => op[0] === 'drawImage' && op[1] === layers[0]);
    assert.deepEqual(first.ops[draw], ['drawImage', layers[0], -ex, -ey]);
    assert.deepEqual(first.ops.slice(draw - 3, draw), [['save'], ['setTransform', 1, 0, 0, 1, 0, 0], ['=globalCompositeOperation', 'screen']]);
    const paintsBefore = first.ops.slice(first.ops.findIndex(op => op[0] === 'clearRect') + 1, draw)
        .filter(op => ['fill', 'stroke', 'drawImage', 'fillRect'].includes(op[0]));
    assert.deepEqual(paintsBefore, [], 'nothing is painted on the scene canvas before the delimiters');
    for (const ms of [QUIET_MS + 33, QUIET_MS + 66, PULSE_MS + 2000]) {
        const later = h.tick(ms);
        assert.equal(later.newContexts, 0, `no layer rebuilt at ${ms}`);
        assert.equal(later.ops.filter(op => op[0] === 'drawImage' && op[1] === layers[0]).length, 1);
    }
    h.resize(200, 200);
    const resized = h.tick(QUIET_MS + 4000);
    assert.ok(resized.newContexts >= 1, 'layer rebuilt after resize');
    assert.deepEqual(h.errors, []);
});

test('raphael mini: each glyph ring is baked once and drawn rotated with one drawImage per frame', () => {
    const h = harness();
    const first = h.tick(QUIET_MS);
    const [cx, cy] = centre(h);
    const progress = h.sandbox.animationProgress(QUIET_MS);
    const gold = h.sandbox.goldGlyphRingDrawParams(progress);
    const blue = h.evaluate('glyphRingAnnuli(coreRadius(Math.min(W, H)))[3]');
    const scale = h.evaluate('MINI_SCENE_ZOOM') * 2;
    const rings = [
        [h.evaluate('sprites.outlineGlyphsGold'), gold.radius, gold.rotation],
        [h.evaluate('sprites.outlineGlyphs'), (blue.innerRadius + blue.outerRadius) / 2, progress * Math.PI * 2 * h.evaluate('GLYPH_RING_BLUE_ROTATION_SPEED')],
    ];
    // Reference: ~one stamp per glyph per frame.
    const reference = h.recorder();
    h.sandbox.referenceLayers(reference.proxy).drawGlyphRings(cx, cy, progress);
    assert.ok(count(reference.ops, 'drawImage') >= 150, `${count(reference.ops, 'drawImage')} reference stamps`);
    for (const [spriteSet, radius, rotation] of rings) {
        // The bake holds exactly the reference ring stream at rotation 0, centred, at 2x the device scale.
        const ring = h.recorder();
        h.sandbox.referenceLayers(ring.proxy).drawOutlineGlyphRing(0, 0, radius, spriteSet.length, spriteSet, 0);
        const bakes = first.created.filter(element => element.contextId !== null &&
            JSON.stringify(json(h.streamOf(element).slice(1))) === JSON.stringify(json(ring.ops)));
        assert.equal(bakes.length, 1, 'one bake per ring');
        const bake = bakes[0];
        assert.equal(bake.width, bake.height);
        assert.equal(bake.width % 2, 0);
        assert.deepEqual(h.streamOf(bake)[0], ['setTransform', scale, 0, 0, scale, bake.width / 2, bake.height / 2]);
        const reach = Math.max(...spriteSet.map(sprite => Math.hypot(sprite.hw, sprite.hh)));
        assert.ok(bake.width / 2 / scale >= radius + reach, 'bake covers every glyph corner');
        const half = bake.width / 2 / scale;
        const draw = first.ops.findIndex(op => op[0] === 'drawImage' && op[1] === bake);
        assert.deepEqual(first.ops.slice(draw - 4, draw + 2), [['save'], ['translate', cx, cy], ['rotate', rotation],
            ['=globalAlpha', 1], ['drawImage', bake, -half, -half, half * 2, half * 2], ['restore']]);
    }
    for (const ms of [QUIET_MS + 33, PULSE_MS + 2000]) {
        const later = h.tick(ms);
        assert.equal(later.newContexts, 0, `no bake rebuilt at ${ms}`);
        // delimiter layer + two rings (+ the quiet-pulse hexadecagon glow layer)
        assert.ok(count(later.ops, 'drawImage') <= 4, `${count(later.ops, 'drawImage')} drawImage calls at ${ms}`);
    }
    h.resize(200, 200);
    assert.ok(h.tick(QUIET_MS + 4000).newContexts >= 2, 'ring bakes rebuilt after resize');
    assert.deepEqual(h.errors, []);
});

test('raphael mini: quiet hexadecagon glow is baked shadow-only and rotated; pulses draw the reference stream', () => {
    const h = harness();
    h.tick(QUIET_MS);
    const [cx, cy] = centre(h);
    const progress = h.sandbox.animationProgress(QUIET_MS);
    const reference = h.recorder();
    h.sandbox.referenceLayers(reference.proxy).drawGoldenHexadecagon(cx, cy, progress, 0);
    const createdBefore = h.created.length;
    const quiet = h.capture(() => h.sandbox.drawGoldenHexadecagon(cx, cy, progress, 0));
    const draws = quiet.filter(op => op[0] === 'drawImage');
    assert.equal(draws.length, 1, 'one glow layer stamp');
    assert.equal(h.created.length, createdBefore, 'glow layer reused from the first frame');
    const layer = draws[0][1];
    const scale = h.evaluate('MINI_SCENE_ZOOM');
    const half = layer.width / 2 / scale;
    assert.deepEqual(draws[0], ['drawImage', layer, -half, -half, half * 2, half * 2]);
    // Without the stamp, the scene stream is the reference minus the core stroke's shadow.
    const coreStart = reference.ops.findIndex(op => op[0] === '=strokeStyle' && op[1] === h.evaluate('HEXADECAGON_RING_CORE_COLOR'));
    const expected = reference.ops.filter((op, i) => !(i > coreStart && (op[0] === '=shadowColor' || op[0] === '=shadowBlur')));
    const stamp = quiet.indexOf(draws[0]);
    assert.equal(stamp, quiet.findIndex(op => op[0] === '=strokeStyle' && op[1] === h.evaluate('HEXADECAGON_RING_CORE_COLOR')) - 1,
        'the glow lands between the chromatic copies and the core stroke');
    assert.deepEqual(json(quiet.filter(op => op !== draws[0])), json(expected));
    assertClose(flatten(quiet.filter(op => op !== draws[0])), flatten(reference.ops).map((record, i, all) =>
        i === all.length - 1 ? { ...record, shadow: null } : record));
    // Layer: the reference core stroke at rotation 0, its shape pushed one layer width off-canvas and its
    // shadow offset back by the same whole number of pixels, so only the blurred glow lands in the layer.
    const layerOps = h.streamOf(layer);
    assert.deepEqual(layerOps.slice(0, 3), [['setTransform', scale, 0, 0, scale, -layer.width / 2, layer.height / 2],
        ['=lineCap', 'round'], ['=lineJoin', 'round']]);
    const core = reference.ops.slice(coreStart, -1);
    const blurAt = core.findIndex(op => op[0] === '=shadowBlur');
    assert.equal(core[blurAt][1], h.evaluate('HEXADECAGON_PULSE_BLUR_BASE'));
    assert.deepEqual(json(layerOps.slice(3)), json([...core.slice(0, blurAt + 1), ['=shadowOffsetX', layer.width], ...core.slice(blurAt + 1)]));
    const r = h.evaluate('coreRadius(Math.min(W, H))');
    const lineWidth = core.find(op => op[0] === '=lineWidth')[1];
    assert.ok(-layer.width / 2 + (r + lineWidth) * scale < 0, 'the shape itself lies wholly left of the layer');
    assert.ok(layer.width / 2 >= (r + lineWidth) * scale + 2 * h.evaluate('HEXADECAGON_PULSE_BLUR_BASE'), 'the layer holds 4 sigma of glow');
    // During a pulse the blur changes every frame: reference stream, nothing baked.
    for (const pulse of [0.25, 1]) {
        const pulseReference = h.recorder();
        h.sandbox.referenceLayers(pulseReference.proxy).drawGoldenHexadecagon(cx, cy, progress, pulse);
        const ops = h.capture(() => h.sandbox.drawGoldenHexadecagon(cx, cy, progress, pulse));
        assert.deepEqual(json(ops), json(pulseReference.ops), `pulse ${pulse}`);
    }
    assert.equal(h.created.length, createdBefore);
    h.resize(200, 200);
    assert.ok(h.tick(QUIET_MS + 4000).created.includes(h.created.at(-1)), 'rebuilt after resize');
    assert.deepEqual(h.errors, []);
});

test('raphael mini: central core paints the reference geometry from cached gradients', () => {
    const h = harness();
    h.tick(QUIET_MS);
    const [cx, cy] = centre(h);
    let radials = 0, linears = 0, calls = 0;
    for (const phase of [0, 0.7, 2.9, 5.5]) {
        for (const pulse of [0, 0.5, 1]) {
            const reference = h.recorder();
            h.sandbox.referenceLayers(reference.proxy).drawCentralCore(cx, cy, phase, pulse);
            const ops = h.capture(() => h.sandbox.drawCentralCore(cx, cy, phase, pulse));
            assertClose(flatten(ops), flatten(reference.ops), `phase ${phase} pulse ${pulse}`);
            assert.equal(count(reference.ops, 'createRadialGradient'), 4);
            assert.equal(count(reference.ops, 'createLinearGradient'), 8);
            assert.equal(count(ops, 'createLinearGradient'), 1, 'one glare gradient shared by every streak');
            radials += count(ops, 'createRadialGradient');
            linears += count(ops, 'createLinearGradient');
            calls++;
        }
    }
    assert.equal(radials, 0, 'the four unit radial gradients were already created by the first frame');
    assert.equal(linears, calls);
    assert.deepEqual(h.errors, []);
});

test('raphael mini bakes only the glyph-ring sprites; full still bakes every sprite', () => {
    const mini = harness();
    mini.tick(QUIET_MS);
    assert.deepEqual(mini.errors, []);
    const miniCanvases = mini.created.length;
    assert.deepEqual(Object.keys(mini.evaluate('sprites')).sort(), ['outlineGlyphs', 'outlineGlyphsGold']);
    const optimized = mini.evaluate('sprites');
    // Reference buildSprites (sprites.js with its O3 blocks stripped) run in the same mini page: the glyph
    // geometry is variant-dependent (glyph-rings.js), so the comparison must stay inside mini.
    const referenceSource = read('raphael/js/sprites.js').replace(/^[ \t]*\/\/ Linux mini optimization begin[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux mini optimization end\.\n/gm, '');
    mini.evaluate(`(function () {\n${referenceSource}\nreturn buildSprites;\n})()()`);
    const reference = mini.evaluate('sprites');
    assert.ok(reference !== optimized);
    assert.ok(reference.halo.length > 0 && reference.featherSharp.length > 0);
    for (const name of ['outlineGlyphsGold', 'outlineGlyphs']) {
        const geometry = set => set.map(sprite => [sprite.hw, sprite.hh, sprite.canvas.width, sprite.canvas.height]);
        assert.deepEqual(geometry(optimized[name]), geometry(reference[name]), `${name} baked identically`);
        const streams = set => set.map(sprite => json(mini.streamOf(sprite.canvas)));
        assert.deepEqual(streams(optimized[name]), streams(reference[name]), `${name} paint streams identical`);
    }
    const referenceCanvases = mini.created.length - miniCanvases;
    const full = harness({ variant: 'full' });
    full.tick(QUIET_MS);
    assert.deepEqual(full.errors, []);
    assert.deepEqual(Object.keys(full.evaluate('sprites')).sort(), ['chromaRings', 'circularOvals', 'featherBlurred',
        'featherGoldMask', 'featherSharp', 'flareBodies', 'flareRings', 'halo', 'outlineGlyphs', 'outlineGlyphsGold', 'softOvals']);
    const glyphSprites = optimized.outlineGlyphsGold.length + optimized.outlineGlyphs.length;
    assert.ok(referenceCanvases > glyphSprites * 1.2, `${referenceCanvases} reference sprite canvases vs ${glyphSprites} glyph sprites`);
});

// B5 (wallpaper optimizations): the wallpaper (full variant) uses the O3 changes whose output
// is the reference one (delimiter layer, cached core gradients); the glyph-ring and hexadecagon bakes,
// which resample, stay mini-only, so those streams are still the reference ones.
// PERF-5: the wallpaper hexadecagon stamps baked pulse glows instead of its canvas shadow, so its stream
// differs from the reference by design (blur-free-glow.contract.test.mjs checks its reference shapes).
test('raphael wallpaper (B5): glyph rings keep the reference streams, delimiters come from one layer', () => {
    for (const [width, height] of [[320, 200], [1920, 1080]]) {
        const h = harness({ variant: 'full', width, height });
        const first = h.tick(QUIET_MS);
        assert.deepEqual(h.errors, []);
        const [cx, cy] = centre(h);
        const progress = h.sandbox.animationProgress(QUIET_MS);
        const annuli = h.evaluate('glyphRingAnnuli(coreRadius(Math.min(W, H)))');
        const delimiters = h.recorder();
        h.sandbox.referenceLayers(delimiters.proxy).drawGlyphRingDelimiters(cx, cy, annuli);
        const rings = h.recorder();
        h.sandbox.referenceLayers(rings.proxy).drawGlyphRings(cx, cy, progress);
        assert.deepEqual(json(rings.ops.slice(0, delimiters.ops.length)), json(delimiters.ops));
        const layer = first.created.find(element => element.contextId !== null &&
            JSON.stringify(json(h.streamOf(element).slice(4))) === JSON.stringify(json(delimiters.ops)));
        assert.ok(layer, 'one layer holds exactly the reference delimiter stream');
        const [, , , , , ex, ey] = h.streamOf(layer)[0];
        const ops = h.capture(() => h.sandbox.drawGlyphRings(cx, cy, progress));
        assert.deepEqual(json(ops), json([['save'], ['setTransform', 1, 0, 0, 1, 0, 0], ['=globalCompositeOperation', 'screen'],
            ['drawImage', layer, -ex, -ey], ['restore'], ...rings.ops.slice(delimiters.ops.length)]), `${width}x${height}`);
    }
});

test('raphael wallpaper (B5): glyph-ring delimiters bake once into a device-aligned layer composited with screen', () => {
    const h = harness({ variant: 'full', width: 1920, height: 1080 });
    const first = h.tick(QUIET_MS);
    assert.deepEqual(h.errors, []);
    const [cx, cy] = centre(h);
    const annuli = h.evaluate('glyphRingAnnuli(coreRadius(Math.min(W, H)))');
    const reference = h.recorder();
    h.sandbox.referenceLayers(reference.proxy).drawGlyphRingDelimiters(cx, cy, annuli);
    // The scene canvas never strokes the delimiter circles itself any more.
    const delimiterArcs = reference.ops.filter(op => op[0] === 'arc').map(op => JSON.stringify(op));
    assert.equal(delimiterArcs.length, 5);
    assert.ok(!first.ops.some(op => op[0] === 'arc' && delimiterArcs.includes(JSON.stringify(op))));
    const layers = first.created.filter(element => element.contextId !== null && JSON.stringify(json(h.streamOf(element).slice(4))) === JSON.stringify(json(reference.ops)));
    assert.equal(layers.length, 1);
    const layerOps = h.streamOf(layers[0]);
    const zoom = h.evaluate('viewZoom');
    const [set, sx, b, c, sy, ex, ey] = layerOps[0];
    assert.deepEqual([set, sx, b, c, sy], ['setTransform', 1, 0, 0, 1]);
    assert.ok(Number.isInteger(ex) && Number.isInteger(ey), 'layer origin is whole device pixels');
    assert.deepEqual(layerOps.slice(1, 4), [['translate', cx, cy], ['scale', zoom, zoom], ['translate', -cx, -cy]]);
    const reach = (annuli[3].outerRadius + 1) * zoom + 20;
    assert.ok(-ex <= cx - reach && -ex + layers[0].width >= cx + reach, 'horizontal extent covers the glow');
    assert.ok(-ey <= cy - reach && -ey + layers[0].height >= cy + reach, 'vertical extent covers the glow');
    for (const ms of [QUIET_MS + 33, QUIET_MS + 66, PULSE_MS + 2000]) {
        const later = h.tick(ms);
        assert.equal(later.ops.filter(op => op[0] === 'drawImage' && op[1] === layers[0]).length, 1);
        assert.ok(!later.created.some(element => JSON.stringify(json((h.streamOf(element) ?? []).slice(4))) === JSON.stringify(json(reference.ops))), `no delimiter layer rebuilt at ${ms}`);
    }
    h.resize(1280, 720);
    const resized = h.tick(QUIET_MS + 4000);
    const [cx2, cy2] = centre(h);
    const reference2 = h.recorder();
    h.sandbox.referenceLayers(reference2.proxy).drawGlyphRingDelimiters(cx2, cy2, h.evaluate('glyphRingAnnuli(coreRadius(Math.min(W, H)))'));
    assert.ok(resized.created.some(element => JSON.stringify(json((h.streamOf(element) ?? []).slice(4))) === JSON.stringify(json(reference2.ops))), 'layer rebuilt after resize');
    assert.deepEqual(h.errors, []);
});

test('raphael wallpaper (B5): central core paints the reference geometry from cached gradients', () => {
    const h = harness({ variant: 'full', width: 1920, height: 1080 });
    h.tick(QUIET_MS);
    const [cx, cy] = centre(h);
    let radials = 0, linears = 0, calls = 0;
    for (const phase of [0, 0.7, 2.9, 5.5]) {
        for (const pulse of [0, 0.5, 1]) {
            const reference = h.recorder();
            h.sandbox.referenceLayers(reference.proxy).drawCentralCore(cx, cy, phase, pulse);
            const ops = h.capture(() => h.sandbox.drawCentralCore(cx, cy, phase, pulse));
            // PERF-5: the wallpaper stamps the spoke and hot-core glows; the shapes are the reference ones.
            assertClose(flatten(ops), flatten(reference.ops).map(paint => ({ ...paint, shadow: null })), `phase ${phase} pulse ${pulse}`);
            radials += count(ops, 'createRadialGradient');
            linears += count(ops, 'createLinearGradient');
            calls++;
        }
    }
    assert.equal(radials, 0, 'the unit radial gradients were already created by the first frame');
    assert.equal(linears, calls, 'one glare gradient shared by every streak');
    assert.deepEqual(h.errors, []);
});

test('raphael mini: per-frame draw calls, gradients and blurred draws drop against the reference', () => {
    const h = harness();
    h.tick(QUIET_MS - 33);
    for (const ms of [QUIET_MS, PULSE_MS + 2000]) {
        const { ops } = h.tick(ms);
        const blurred = ops.filter(op => op[0] === '=shadowBlur' && op[1] > 0).length;
        // Reference mini frame: ~200 drawImage, 4 radial + 8 linear core gradients, 6 blurred paints
        // (delimiters, hexadecagon, three glow-segment strokes, hot core).
        assert.ok(count(ops, 'drawImage') <= 4, `${count(ops, 'drawImage')} drawImage`);
        assert.equal(count(ops, 'createRadialGradient'), 0, 'core and mask radial gradients are cached');
        assert.equal(count(ops, 'createLinearGradient'), 1);
        assert.equal(blurred, ms === QUIET_MS ? 4 : 5, `${blurred} blurred paints at ${ms}`);
    }
    assert.deepEqual(h.errors, []);
});

test('raphael O3 changes are removable marked blocks over the CielWin reference', () => {
    const strip = source => source.replace(/^[ \t]*\/\/ Linux mini optimization begin[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux mini optimization end\.\n/gm, '');
    // Re-pinned after old-name→CielWin comment rename (text-only); was 2a745ee5c5757d09eb475b30fab349ba53cb79d63321dc234fbdef24537de2fc
    assert.equal(sha256(strip(read('raphael/js/layers.js'))), 'e6265d4759314ffb58b143b4af56edfb16cd20b0fea3530d172f207eab906c68');
    assert.equal(sha256(strip(read('raphael/js/sprites.js'))), 'b97ab8fba52b6255e33909d470ff871eb269c6125d9cdeb9b736049b55af8ee5');
    for (const name of ['layers', 'sprites'])
        assert.match(read(`raphael/js/${name}.js`), /\/\/ Linux mini optimization begin \(O3\)/, name);
});
