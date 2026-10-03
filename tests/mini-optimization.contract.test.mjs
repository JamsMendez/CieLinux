import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SRC, source } from './paths.mjs';

// O1 (odd/tasks/mini-scene-optimization.md): idle + explorer mini CPU optimizations. Every change must
// draw the same pixels; these tests compare the optimized code against verbatim copies of the
// pre-optimization CielWin functions (REFERENCE below) on recorded Canvas2D call streams.

const read = name => readFileSync(source(name), 'utf8');
const scenes = ['idle', 'explorer'];

// Verbatim pre-O1 code (CielWin reference), renamed with a reference prefix.
const REFERENCE = String.raw`
function referenceRisingSparkAt(index, timeSeconds, width, height) {
  const slotRandom = risingSparkRandom(index, -1);
  const lifetime = mix(RISING_SPARK_LIFETIME_MIN_SECONDS, RISING_SPARK_LIFETIME_MAX_SECONDS, slotRandom());
  const period = lifetime * (1 + RISING_SPARK_REST_FRACTION);
  const localTime = timeSeconds + slotRandom() * period;
  const cycle = Math.floor(localTime / period);
  const age = localTime - cycle * period;
  const random = risingSparkRandom(index, cycle);
  const x0 = random();
  const y0 = mix(RISING_SPARK_SPAWN_TOP_FRACTION, 1.02, random());
  const offCenter = (0.5 - x0) * 2;
  const tilt = Math.sign(offCenter || 1)
    * (RISING_SPARK_TILT_BASE + RISING_SPARK_TILT_EDGE * Math.abs(offCenter))
    * mix(0.8, 1, random());
  const bendJitter = (random() - 0.5) * 0.1;
  return { index, cycle, age, lifetime, period, x0, y0,
    speed: mix(RISING_SPARK_SPEED_MIN, RISING_SPARK_SPEED_MAX, random()),
    tilt, bendStart: RISING_SPARK_BEND_START + bendJitter, bendEnd: RISING_SPARK_BEND_END + bendJitter,
    size: mix(0.6, 1.4, random()), brightness: mix(0.45, 1, random()) };
}
function referenceRisingSparkPosition(spark, age, width, height) {
  const rise = spark.speed * height * age;
  const u = age / spark.lifetime;
  const drift = spark.tilt * spark.speed * height * spark.lifetime * risingSparkDrift(u, spark.bendStart, spark.bendEnd);
  return { x: spark.x0 * width + drift, y: spark.y0 * height - rise };
}
function referenceDrawRisingSparks(context, timeSeconds) {
  context.save();
  context.globalCompositeOperation = 'lighter';
  context.lineCap = 'round';
  for (let i = 0; i < RISING_SPARK_COUNT; i++) {
    const spark = referenceRisingSparkAt(i, timeSeconds, W, H);
    if (spark.age > spark.lifetime) continue;
    const alpha = risingSparkEnvelope(spark.age / spark.lifetime) * spark.brightness;
    if (alpha <= 0.01) continue;
    let previous = referenceRisingSparkPosition(spark, Math.max(0, spark.age - RISING_SPARK_TRAIL_SECONDS), W, H);
    for (let s = 1; s <= RISING_SPARK_TRAIL_SAMPLES; s++) {
      const t = s / RISING_SPARK_TRAIL_SAMPLES;
      const sampleAge = Math.max(0, spark.age - RISING_SPARK_TRAIL_SECONDS * (1 - t));
      const point = referenceRisingSparkPosition(spark, sampleAge, W, H);
      context.strokeStyle = ` + '`rgba(${RISING_SPARK_COLOR}, ${alpha * t})`' + String.raw`;
      context.lineWidth = RISING_SPARK_WIDTH * spark.size * mix(0.4, 1, t);
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(point.x, point.y);
      context.stroke();
      previous = point;
    }
    context.fillStyle = ` + '`rgba(255, 255, 255, ${alpha})`' + String.raw`;
    context.beginPath();
    context.arc(previous.x, previous.y, RISING_SPARK_HEAD_RADIUS * spark.size, 0, TAU);
    context.fill();
  }
  context.restore();
}
function referenceSampleEquirect(lon, lat) {
  const w = EARTH_EQUIRECT.width, h = EARTH_EQUIRECT.height, rgb = EARTH_EQUIRECT.rgb;
  const u = (fract(lon / TAU) * w + w) % w;
  const v = clamp01((lat / Math.PI) + 0.5) * (h - 1);
  const u0 = Math.floor(u) % w, u1 = (u0 + 1) % w;
  const v0 = Math.floor(v), v1 = Math.min(v0 + 1, h - 1);
  const fu = u - Math.floor(u), fv = v - v0;
  const i00 = (v0 * w + u0) * 3, i10 = (v0 * w + u1) * 3;
  const i01 = (v1 * w + u0) * 3, i11 = (v1 * w + u1) * 3;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = mix(rgb[i00 + c], rgb[i10 + c], fu);
    const bottom = mix(rgb[i01 + c], rgb[i11 + c], fu);
    out[c] = mix(top, bottom, fv);
  }
  return out;
}
function referenceEarthPixels(size, longitude) {
  const { lon, lat, light, rim, inside } = earthDiscLookup;
  const cloudVisibility = earthCloudVisibilityLookup;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let idx = 0; idx < size * size; idx++) {
    const o = idx * 4;
    if (!inside[idx]) { data[o + 3] = 0; continue; }
    const [r0, g0, b0] = referenceSampleEquirect(lon[idx] + longitude, lat[idx]);
    const l = light[idx];
    const rimAmount = rim[idx];
    const cv = cloudVisibility[idx];
    let rr = mix(r0 * 0.55, r0, cv);
    let gg = mix(g0 * 0.55, g0, cv);
    let bb = mix(b0 * 0.55, b0, cv);
    rr = mix(rr, 235, rimAmount);
    gg = mix(gg, 235, rimAmount);
    bb = mix(bb, 235, rimAmount);
    data[o] = Math.round(clamp01((rr * l) / 255) * 255);
    data[o + 1] = Math.round(clamp01((gg * l) / 255) * 255);
    data[o + 2] = Math.round(clamp01((bb * l) / 255) * 255);
    data[o + 3] = 255;
  }
  return data;
}
function referenceEarthRim(context, cx, cy, radius) {
  const rimArcHalfAngle = (70 * Math.PI) / 180;
  const rimSegmentCount = 90;
  context.save();
  for (let s = 0; s < rimSegmentCount; s++) {
    const t0 = s / rimSegmentCount;
    const t1 = (s + 1) / rimSegmentCount;
    const a0 = -Math.PI / 2 - rimArcHalfAngle + t0 * rimArcHalfAngle * 2;
    const a1 = -Math.PI / 2 - rimArcHalfAngle + t1 * rimArcHalfAngle * 2;
    const angularFade = Math.sin(Math.PI * (t0 + t1) / 2);
    if (angularFade <= 0.01) continue;
    context.beginPath();
    context.arc(cx, cy, radius * 1.035, a0, a1);
    context.arc(cx, cy, radius * 0.95, a1, a0, true);
    context.closePath();
    const rimGradient = context.createRadialGradient(cx, cy, radius * 0.95, cx, cy, radius * 1.035);
    rimGradient.addColorStop(0, 'rgba(150,200,255,0)');
    rimGradient.addColorStop(1, applyBrightness(EARTH_RIM_LIGHT_COLOR, angularFade));
    context.fillStyle = rimGradient;
    context.fill();
  }
  context.restore();
}
function referenceDrawDiscBorder(context, cx, cy, innerRadius, outerRadius) {
  const segmentCount = 128;
  context.save();
  for (let s = 0; s < segmentCount; s++) {
    const a0 = (s / segmentCount) * TAU;
    const a1 = ((s + 1) / segmentCount) * TAU;
    const brightness = verticalLightBrightness((a0 + a1) / 2);
    if (brightness <= 0.001) continue;
    context.beginPath();
    context.arc(cx, cy, outerRadius, a0, a1);
    context.arc(cx, cy, innerRadius, a1, a0, true);
    context.closePath();
    context.fillStyle = applyBrightness(DISC_BORDER_RIM_COLOR, brightness);
    context.fill();
    context.strokeStyle = applyBrightness(DISC_BORDER_EDGE_COLOR, brightness);
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(cx, cy, outerRadius, a0, a1);
    context.stroke();
  }
  context.restore();
}
`;

// Recording Canvas2D mock: every method call and property set lands in one ordered stream per context.
// Gradients serialize to their creation args + stops so streams compare by value.
function harness(scene, { variant = 'mini', width = 240, height = 240 } = {}) {
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
                if (name === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
                return (...args) => {
                    ops.push([name, ...args]);
                    if (String(name).startsWith('create')) {
                        const gradient = { gradient: name, args, stops: [], addColorStop(stop, color) { this.stops.push([stop, color]); } };
                        return gradient;
                    }
                };
            },
            set(target, name, value) { ops.push([`=${String(name)}`, value]); target[name] = value; return true; }
        });
        return { id, ops, proxy };
    };
    const scene0 = makeContext();
    const canvas = { width: 0, height: 0, getContext: () => scene0.proxy };
    const window = { devicePixelRatio: 1, innerWidth: width, innerHeight: height,
        requestAnimationFrame: fn => frames.push(fn), addEventListener: (name, fn) => { events[name] = fn; } };
    const sandbox = vm.createContext({ window, URLSearchParams, performance: { now: () => 0 },
        location: { search: `?variant=${variant}&fps=30`, hash: '' },
        console: { log() {}, info() {}, warn() {}, error: (...args) => {
            if (!/synthetic transport probe/.test(String(args[0]))) errors.push(args);
        } },
        document: {
            getElementById: name => name === 'scene' ? canvas : null,
            createElement: () => {
                const element = { width: 0, height: 0, contextId: null };
                let c = null;
                element.getContext = () => { if (!c) { c = makeContext(); element.contextId = c.id; } return c.proxy; };
                created.push(element);
                return element;
            },
            documentElement: { classList: { add() {} } },
            addEventListener: (name, fn) => { events[name] = fn; } } });
    const html = read(`${scene}/index.html`);
    for (const [, script] of html.matchAll(/<script src="([^"]+)"><\/script>/g))
        vm.runInContext(read(`${scene}/${script}`), sandbox, { filename: `${scene}/${script}` });
    vm.runInContext(REFERENCE, sandbox, { filename: 'reference.js' });
    const main = streams.get(scene0.id);
    const tick = ms => {
        assert.equal(frames.length, 1);
        const start = main.length, contextsBefore = nextId, createdBefore = created.length;
        frames.shift()(ms);
        return { ops: main.slice(start), newContexts: nextId - contextsBefore, created: created.slice(createdBefore) };
    };
    const recorder = () => makeContext();
    const resize = (w, h) => { window.innerWidth = w; window.innerHeight = h; events.resize(); };
    return { sandbox, main, streams, created, errors, tick, recorder, resize,
        evaluate: source => vm.runInContext(source, sandbox) };
}

const gradientOps = ops => ops.filter(op => /^create.*Gradient$/.test(op[0]));
const json = value => JSON.parse(JSON.stringify(value));

// Splits a drawRisingSparks stream into one group per spark (each spark ends with its head 'fill').
function sparkGroups(ops) {
    assert.deepEqual(ops.slice(0, 3), [['save'], ['=globalCompositeOperation', 'lighter'], ['=lineCap', 'round']]);
    assert.deepEqual(ops.at(-1), ['restore']);
    const groups = [];
    let current = [];
    for (const op of ops.slice(3, -1)) {
        current.push(op);
        if (op[0] === 'fill') { groups.push(current); current = []; }
    }
    assert.deepEqual(current, []);
    return groups;
}

const segmentDistance = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// Smallest distance from (cx, cy) to any painted pixel of the spark group (stroke half-width, head radius).
function groupInnerReach(group, cx, cy) {
    let lineWidth = 0, from = null, reach = Infinity;
    for (const op of group) {
        if (op[0] === '=lineWidth') lineWidth = op[1];
        if (op[0] === 'moveTo') from = [op[1], op[2]];
        if (op[0] === 'lineTo') reach = Math.min(reach, segmentDistance(cx, cy, ...from, op[1], op[2]) - lineWidth / 2);
        if (op[0] === 'arc') reach = Math.min(reach, Math.hypot(op[1] - cx, op[2] - cy) - op[3]);
    }
    return reach;
}

const sparkTimes = [0, 0.5, 1.234, 7.7, 63.2, 3600.1];

// O1d (user-approved): mini young-spark heads are 0.55 x size CSS px instead of the reference 1.3 x size;
// every other op of a young spark's group is the reference op (explorer-sprites pins the exact radius).
const youngMatches = (actual, reference) => actual.length === reference.length && actual.every((op, k) => {
    const expected = reference[k];
    if (op[0] !== 'arc') return JSON.stringify(op) === JSON.stringify(expected);
    return expected[0] === 'arc' && JSON.stringify([...op.slice(0, 3), ...op.slice(4)]) === JSON.stringify([...expected.slice(0, 3), ...expected.slice(4)])
        && Math.abs(op[3] - 0.55 * expected[3] / 1.3) <= 1e-12;
});

// O1c P1 (user-approved visual-risk change): mini draws each spark older than RISING_SPARK_TRAIL_SECONDS as
// two streak-atlas sprites ([=globalAlpha, setTransform, drawImage, setTransform, drawImage]); younger sparks
// keep their reference stroke group (after a transform/alpha reset that is dropped here). The sprite
// geometry itself is pinned by explorer-sprites.contract.test.mjs; this test pins culling and order.
function miniSparkUnits(ops) {
    assert.deepEqual(ops.slice(0, 3), [['save'], ['=globalCompositeOperation', 'lighter'], ['=lineCap', 'round']]);
    assert.deepEqual(ops.at(-1), ['restore']);
    const body = ops.slice(3, -1), units = [];
    for (let i = 0; i < body.length;) {
        if (body[i][0] === '=globalAlpha' && body[i + 1]?.[0] === 'setTransform') {
            units.push({ sprite: true, alpha: body[i][1], head: [body[i + 3], body[i + 4]] });
            i += 5;
            continue;
        }
        const group = [];
        while (body[i][0] !== 'fill') group.push(body[i++]);
        group.push(body[i++]);
        units.push({ sprite: false, group: group.filter(op => op[0] !== 'setTransform' && op[0] !== '=globalAlpha') });
    }
    return units;
}

test('explorer mini rising sparks: visible sparks are drawn in reference order, culled ones lie outside the edge fade', () => {
    const h = harness('explorer');
    const fadeRadius = 240 * h.evaluate('MINI_EDGE_FADE_OUTER');
    let culled = 0, kept = 0;
    for (const time of sparkTimes) {
        const reference = h.recorder(), optimized = h.recorder();
        h.sandbox.referenceDrawRisingSparks(reference.proxy, time);
        h.sandbox.drawRisingSparks(optimized.proxy, time);
        const atlas = h.evaluate('risingSparkAtlas');
        const expected = sparkGroups(reference.ops), actual = miniSparkUnits(optimized.ops);
        // The head end of a sprite unit's second half, in CSS px (local (pad + length, pad) of its atlas cell).
        const spriteHead = ([transform, draw]) => {
            const [, a, b, c, d, e, f] = transform, [, , sx, , sw, sh, dx, dy, dw, dh] = draw;
            const x = dx + (atlas.pad + atlas.lengths[sx / atlas.cellWidth]) * atlas.dpr * dw / sw;
            const y = dy + atlas.pad * atlas.dpr * dh / sh;
            return [(a * x + c * y + e) / h.evaluate('canvasScaleX'), (b * x + d * y + f) / h.evaluate('canvasScaleY')];
        };
        let next = 0;
        for (const group of expected) {
            const unit = actual[next], arc = group.find(op => op[0] === 'arc');
            const headAlpha = Number(group.at(-4)[1].slice('rgba(255, 255, 255, '.length, -1));
            const matches = unit && (unit.sprite
                ? unit.alpha === headAlpha && Math.hypot(...spriteHead(unit.head).map((v, k) => v - arc[1 + k])) <= 0.5
                : youngMatches(unit.group, group));
            if (matches) { next++; kept++; continue; }
            culled++;
            assert.ok(groupInnerReach(group, 120, 120) > fadeRadius + 1,
                `culled spark at t=${time} reaches ${groupInnerReach(group, 120, 120)} <= ${fadeRadius + 1}`);
        }
        assert.equal(next, actual.length, `every optimized spark unit matches a reference group in order (t=${time})`);
    }
    assert.ok(kept > 0, 'visible sparks are still drawn');
    // Measured: ~6% of drawn sparks (102 of 1845 over these timestamps) sit wholly in the corners.
    assert.ok(culled > 0, `culling is active (culled ${culled}, kept ${kept})`);
});

test('explorer full rising sparks are unculled and stream-identical to the reference', () => {
    const h = harness('explorer', { variant: 'full', width: 320, height: 200 });
    for (const time of sparkTimes) {
        const reference = h.recorder(), optimized = h.recorder();
        h.sandbox.referenceDrawRisingSparks(reference.proxy, time);
        h.sandbox.drawRisingSparks(optimized.proxy, time);
        assert.deepEqual(json(optimized.ops), json(reference.ops), `t=${time}`);
    }
});

test('explorer rising sparks do not rebuild per-slot PRNG closures every frame', () => {
    const h = harness('explorer');
    const original = h.sandbox.mulberry32;
    let calls = 0;
    h.sandbox.mulberry32 = seed => { calls++; return original(seed); };
    h.sandbox.drawRisingSparks(h.recorder().proxy, 10);
    calls = 0;
    h.sandbox.drawRisingSparks(h.recorder().proxy, 10 + 1 / 30);
    assert.ok(calls < 40, `${calls} mulberry32 closures for one 30 fps step (reference: 720+)`);
});

for (const scene of scenes) {
    test(`${scene} earth: inlined bilinear sample writes exactly the reference pixels`, () => {
        const h = harness(scene);
        for (const longitude of [0, 1.3, -2.2, 100.7]) {
            h.sandbox.renderEarthFrame(64, longitude);
            const actual = Uint8ClampedArray.from(h.evaluate('earthFrameImageData.data'));
            const expected = h.sandbox.referenceEarthPixels(64, longitude);
            assert.deepEqual(actual, Uint8ClampedArray.from(expected), `longitude ${longitude}`);
        }
    });

    test(`${scene} mini: earth rim and disc border bake once into device-aligned layers drawn by one drawImage`, () => {
        const h = harness(scene);
        const first = h.tick(1000);
        assert.deepEqual(h.errors, []);
        const basis = h.evaluate('activeSceneBasis()');
        const earthRadius = basis * h.evaluate('EARTH_RADIUS_FRACTION');
        const inner = basis * h.evaluate('DISC_BORDER_INNER_RADIUS_FRACTION');
        const outer = basis * h.evaluate('DISC_BORDER_OUTER_RADIUS_FRACTION');
        // Reference streams, drawn directly (old code) on recorders.
        const rim = h.recorder(), disc = h.recorder();
        h.sandbox.referenceEarthRim(rim.proxy, 120, 120, earthRadius);
        h.sandbox.referenceDrawDiscBorder(disc.proxy, 120, 120, inner, outer);
        // The main context never draws rim or border geometry itself any more.
        assert.equal(gradientOps(first.ops).filter(op => op[0] === 'createRadialGradient' && op[3] === earthRadius * 0.95).length, 0);
        assert.ok(!first.ops.some(op => op[0] === '=lineWidth' && op[1] === 1.5), 'disc border edge not stroked on screen');
        const layerStreams = first.created.map(element => element.contextId).filter(id => id !== null)
            .map(id => h.streams.get(id));
        for (const reference of [rim.ops, disc.ops]) {
            const match = layerStreams.filter(ops => JSON.stringify(json(ops.slice(1))) === JSON.stringify(json(reference)));
            assert.equal(match.length, 1, 'one layer holds exactly the reference paint stream');
            const [op, sx, b, c, sy, ex, ey] = match[0][0];
            assert.deepEqual([op, sx, b, c, sy], ['setTransform', 1, 0, 0, 1]);
            assert.ok(Number.isInteger(ex) && Number.isInteger(ey), 'layer origin is whole device pixels');
            // Main context: identity transform, drawImage at the same whole-pixel origin, no scaling.
            const draw = first.ops.findIndex(o => o[0] === 'drawImage' && o[2] === -ex && o[3] === -ey && o.length === 4);
            assert.ok(draw > 0, 'layer drawn 1:1 at its device origin');
            assert.deepEqual(first.ops[draw - 1], ['setTransform', 1, 0, 0, 1, 0, 0]);
        }
        for (const ms of [1033, 1066, 1100, 1133]) {
            const later = h.tick(ms);
            assert.equal(later.newContexts, 0, `no offscreen canvas rebuilt at ${ms}`);
            assert.equal(gradientOps(later.ops).filter(op => op[3] === earthRadius * 0.95).length, 0);
        }
        h.resize(200, 200);
        const resized = h.tick(1166);
        assert.ok(resized.newContexts >= 2, 'layers rebuilt after resize');
        assert.deepEqual(h.errors, []);
    });

    test(`${scene} mini: per-frame gradient churn drops and the edge-fade gradient is reused`, () => {
        const h = harness(scene);
        h.tick(1000);
        let edgeGradients = 0;
        for (const ms of [1033, 1066, 1100, 1133, 1166]) {
            const { ops } = h.tick(ms);
            const gradients = gradientOps(ops);
            edgeGradients += gradients.filter(op => op[6] === 240 * 0.48).length;
            assert.ok(gradients.length <= 61, `${gradients.length} gradients in one frame (reference: 107+)`);
            // The cached edge fade still lands last, as destination-in over the whole window.
            const fade = ops.findLastIndex(op => op[0] === '=globalCompositeOperation' && op[1] === 'destination-in');
            assert.equal(ops[fade + 1][0], '=fillStyle');
            assert.equal(ops[fade + 1][1].args[5], 240 * 0.48);
            assert.deepEqual(ops[fade + 2], ['fillRect', 0, 0, 240, 240]);
        }
        assert.equal(edgeGradients, 0, 'edge fade gradient created once, on the first frame');
        h.resize(200, 200);
        const { ops } = h.tick(1200);
        assert.equal(gradientOps(ops).filter(op => op[6] === 200 * 0.48).length, 1, 'rebuilt for the new size');
    });

    test(`${scene}: mini skips the unused lighting mask, full still builds it`, () => {
        const mini = harness(scene);
        mini.tick(1000);
        assert.equal(mini.evaluate('combinedLightingMask'), null);
        assert.ok(![...mini.streams.values()].flat().some(op => op[0] === 'createConicGradient'));
        const full = harness(scene, { variant: 'full', width: 320, height: 200 });
        full.tick(1000);
        assert.deepEqual(full.errors, []);
        assert.ok(full.evaluate('combinedLightingMask') !== null);
        assert.equal([...full.streams.values()].flat().filter(op => op[0] === 'createConicGradient').length, 1);
    });
}

test('render-loop caches the mini edge-fade and base gradients per context and geometry', () => {
    const copies = ['processing', 'raphael', 'idle', 'explorer'].map(scene => read(`${scene}/js/render-loop.js`));
    for (const copy of copies) assert.equal(copy, copies[0], 'one render-loop.js for every scene');
    const sandbox = vm.createContext({ window: {}, URLSearchParams, location: { search: '?variant=mini', hash: '' },
        document: { documentElement: { classList: { add() {} } } } });
    vm.runInContext(copies[0], sandbox);
    const record = () => {
        const ops = [];
        return { ops, proxy: new Proxy({}, {
            get: (_, name) => (...args) => {
                ops.push([name, ...args]);
                if (String(name).startsWith('create')) return { args, stops: [], addColorStop(s, c) { this.stops.push([s, c]); } };
            },
            set: (_, name, value) => { ops.push([`=${String(name)}`, value]); return true; } }) };
    };
    const a = record(), b = record();
    for (let i = 0; i < 3; i++) sandbox.applyMiniEdgeFade(a.proxy, 240, 240);
    assert.equal(gradientOps(a.ops).length, 1);
    const fills = a.ops.filter(op => op[0] === '=fillStyle').map(op => op[1]);
    assert.ok(fills.every(fill => fill === fills[0]), 'same cached gradient object every call');
    assert.deepEqual(json(fills[0].stops), [[0, 'rgba(0,0,0,1)'], [0.41 / 0.48, 'rgba(0,0,0,1)'],
        ...[[0.25, 0.84], [0.5, 0.5], [0.75, 0.16]].map(([t, v]) => [0.41 / 0.48 + (1 - 0.41 / 0.48) * t, `rgba(0,0,0,${v})`]),
        [1, 'rgba(0,0,0,0)']]);
    assert.deepEqual(json(fills[0].args), [120, 120, 0, 120, 120, 240 * 0.48]);
    sandbox.applyMiniEdgeFade(a.proxy, 200, 240);
    sandbox.applyMiniEdgeFade(b.proxy, 200, 240);
    assert.equal(gradientOps(a.ops).length, 2, 'rebuilt on size change');
    assert.equal(gradientOps(b.ops).length, 1, 'never shared across contexts');
    const c = record();
    for (let i = 0; i < 3; i++) sandbox.drawMiniSceneBase(c.proxy, 121.2, 123.6, 76.8, 96);
    assert.equal(gradientOps(c.ops).length, 1);
    sandbox.drawMiniSceneBase(c.proxy, 121.2, 123.6, 70, 96);
    assert.equal(gradientOps(c.ops).length, 2, 'rebuilt on radius change');
    const base = c.ops.find(op => op[0] === '=fillStyle')[1];
    assert.deepEqual(json(base.stops), [[0, 'rgba(1,4,10,0.9)'], [76.8 / 96, 'rgba(1,4,10,0.9)'], [1, 'rgba(1,4,10,0)']]);
    // Per-call paint ops are unchanged: save, composite, fill, path, restore.
    assert.deepEqual(c.ops.slice(-7).map(op => op[0]), ['save', '=globalCompositeOperation', '=fillStyle', 'beginPath', 'arc', 'fill', 'restore']);
});
