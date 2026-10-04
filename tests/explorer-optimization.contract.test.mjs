import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SRC, source } from './paths.mjs';

// O1b (odd/tasks/mini-scene-optimization.md): second explorer pass. Every change must draw the same
// pixels, so each test compares the shipped code against a verbatim copy of the post-O1 function (O1
// below) on recorded Canvas2D call streams or on the produced pixel bytes, then checks the JS work saved.
//
// Canvas command count is deliberately NOT reduced: every rising-spark stroke and head fill carries its
// own style (alpha and width depend on the spark), so no two draws can share one path without changing
// the 'lighter' result. The op-count test below pins that the stream length is unchanged.

const read = name => readFileSync(source(name), 'utf8');

// Verbatim post-O1 code (explorer/js at the O1 hashes), renamed with an o1 prefix.
const O1 = String.raw`
function o1DrawRisingSparks(context, timeSeconds) {
  const cullRadius = isMiniVariant ? Math.min(W, H) * MINI_EDGE_FADE_OUTER + RISING_SPARK_CULL_MARGIN_PX : Infinity;
  const fadeCx = W / 2, fadeCy = H / 2;
  const trail = risingSparkTrail;
  context.save();
  context.globalCompositeOperation = 'lighter';
  context.lineCap = 'round';
  for (let i = 0; i < RISING_SPARK_COUNT; i++) {
    const spark = risingSparkAt(i, timeSeconds, W, H);
    if (spark.age > spark.lifetime) continue;
    const alpha = risingSparkEnvelope(spark.age / spark.lifetime) * spark.brightness;
    if (alpha <= 0.01) continue;

    risingSparkPositionInto(spark, Math.max(0, spark.age - RISING_SPARK_TRAIL_SECONDS), W, H, trail, 0);
    for (let s = 1; s <= RISING_SPARK_TRAIL_SAMPLES; s++) {
      const t = s / RISING_SPARK_TRAIL_SAMPLES;
      const sampleAge = Math.max(0, spark.age - RISING_SPARK_TRAIL_SECONDS * (1 - t));
      risingSparkPositionInto(spark, sampleAge, W, H, trail, s * 2);
    }
    if (cullRadius !== Infinity && risingSparkTrailOutside(fadeCx, fadeCy, cullRadius)) continue;

    for (let s = 1; s <= RISING_SPARK_TRAIL_SAMPLES; s++) {
      const t = s / RISING_SPARK_TRAIL_SAMPLES;
      context.strokeStyle = ` + '`rgba(${RISING_SPARK_COLOR}, ${alpha * t})`' + String.raw`;
      context.lineWidth = RISING_SPARK_WIDTH * spark.size * mix(0.4, 1, t);
      context.beginPath();
      context.moveTo(trail[s * 2 - 2], trail[s * 2 - 1]);
      context.lineTo(trail[s * 2], trail[s * 2 + 1]);
      context.stroke();
    }

    const head = RISING_SPARK_TRAIL_SAMPLES * 2;
    context.fillStyle = ` + '`rgba(255, 255, 255, ${alpha})`' + String.raw`;
    context.beginPath();
    context.arc(trail[head], trail[head + 1], RISING_SPARK_HEAD_RADIUS * spark.size, 0, TAU);
    context.fill();
  }
  context.restore();
}
function o1DrawSpark(context, x, y, size, intensity, color, rayLength) {
  if (intensity <= 0) return;
  const rays = rayLength || size * 2;
  context.save();
  context.translate(x, y);
  context.globalCompositeOperation = 'lighter';
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, size);
  gradient.addColorStop(0, applyBrightness(color, intensity));
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(0, 0, size, 0, TAU);
  context.fill();

  const drawRay = (x1, y1, x2, y2) => {
    const rayGradient = context.createLinearGradient(x1, y1, x2, y2);
    rayGradient.addColorStop(0, applyBrightness(color, intensity));
    rayGradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.strokeStyle = rayGradient;
    context.lineWidth = Math.max(1, size * 0.12);
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
  };
  context.lineCap = 'round';
  drawRay(0, 0, -rays, 0);
  drawRay(0, 0, rays, 0);
  drawRay(0, 0, 0, -rays);
  drawRay(0, 0, 0, rays);
  context.restore();
}
// The O1 renderEarthFrame loop, writing into a fresh buffer instead of the shared ImageData.
function o1EarthPixels(size, longitude) {
  const { lon, lat, light, rim, inside } = buildEarthDiscLookup(size);
  const cloudVisibility = buildEarthCloudVisibilityLookup(size);
  const data = new Uint8ClampedArray(size * size * 4);
  const count = size * size;
  const ew = EARTH_EQUIRECT.width, eh = EARTH_EQUIRECT.height, erg = EARTH_EQUIRECT.rgb;
  for (let idx = 0; idx < count; idx++) {
    const o = idx * 4;
    if (!inside[idx]) {
      data[o + 3] = 0;
      continue;
    }
    const sampleLon = lon[idx] + longitude, sampleLat = lat[idx];
    const u = (fract(sampleLon / TAU) * ew + ew) % ew; // wrap
    const v = clamp01((sampleLat / Math.PI) + 0.5) * (eh - 1); // clamp at poles
    const u0 = Math.floor(u) % ew, u1 = (u0 + 1) % ew;
    const v0 = Math.floor(v), v1 = Math.min(v0 + 1, eh - 1);
    const fu = u - Math.floor(u), fv = v - v0;
    const i00 = (v0 * ew + u0) * 3, i10 = (v0 * ew + u1) * 3;
    const i01 = (v1 * ew + u0) * 3, i11 = (v1 * ew + u1) * 3;
    const r0 = mix(mix(erg[i00], erg[i10], fu), mix(erg[i01], erg[i11], fu), fv);
    const g0 = mix(mix(erg[i00 + 1], erg[i10 + 1], fu), mix(erg[i01 + 1], erg[i11 + 1], fu), fv);
    const b0 = mix(mix(erg[i00 + 2], erg[i10 + 2], fu), mix(erg[i01 + 2], erg[i11 + 2], fu), fv);
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
`;

// Recording Canvas2D mock: every method call and property set lands in one ordered stream per context.
function harness({ variant = 'mini', width = 240, height = 240 } = {}) {
    const frames = [], events = {}, errors = [];
    const record = () => {
        const ops = [];
        const state = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
        const proxy = new Proxy(state, {
            get(target, name) {
                if (name in target) return target[name];
                if (name === 'measureText') return text => ({ width: String(text).length * 4 });
                if (name === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
                return (...args) => {
                    ops.push([name, ...args]);
                    if (String(name).startsWith('create'))
                        return { gradient: name, args, stops: [], addColorStop(stop, color) { this.stops.push([stop, color]); } };
                };
            },
            set(target, name, value) { ops.push([`=${String(name)}`, value]); target[name] = value; return true; }
        });
        return { ops, proxy };
    };
    const scene = record();
    const canvas = { width: 0, height: 0, getContext: () => scene.proxy };
    const window = { devicePixelRatio: 1, innerWidth: width, innerHeight: height,
        requestAnimationFrame: fn => frames.push(fn), addEventListener: (name, fn) => { events[name] = fn; } };
    const sandbox = vm.createContext({ window, URLSearchParams, performance: { now: () => 0 },
        location: { search: `?variant=${variant}&fps=30`, hash: '' },
        console: { log() {}, info() {}, warn() {}, error: (...args) => {
            if (!/synthetic transport probe/.test(String(args[0]))) errors.push(args);
        } },
        document: {
            getElementById: name => name === 'scene' ? canvas : null,
            createElement: () => { const element = { width: 0, height: 0 }; let c = null;
                element.getContext = () => (c ||= record()).proxy; return element; },
            documentElement: { classList: { add() {} } },
            addEventListener: (name, fn) => { events[name] = fn; } } });
    const html = read('explorer/index.html');
    for (const [, script] of html.matchAll(/<script src="([^"]+)"><\/script>/g))
        vm.runInContext(read(`explorer/${script}`), sandbox, { filename: `explorer/${script}` });
    vm.runInContext(O1, sandbox, { filename: 'o1-reference.js' });
    // Counts calls of a global helper while `fn` runs (scripts resolve globals at call time).
    const countCalls = (name, fn) => {
        const original = sandbox[name];
        let calls = 0;
        sandbox[name] = (...args) => { calls++; return original(...args); };
        try { fn(); } finally { sandbox[name] = original; }
        return calls;
    };
    const tick = ms => { assert.equal(frames.length, 1); const start = scene.ops.length; frames.shift()(ms); return scene.ops.slice(start); };
    return { sandbox, errors, record, countCalls, tick, scene, evaluate: source => vm.runInContext(source, sandbox) };
}

const json = value => JSON.parse(JSON.stringify(value));
const sparkTimes = [0, 0.5, 1.234, 7.7, 63.2, 3600.1];
const variants = [{ variant: 'mini' }, { variant: 'full', width: 320, height: 200 }];

// O1c P1 (user-approved visual-risk change) replaced mini's mature-spark strokes with streak-atlas sprites
// (explorer-sprites.contract.test.mjs pins their geometry), so only full stays op-for-op; mini checks that
// every visible spark is drawn exactly once, as two sprites or as its 6 strokes + head fill.
const spriteCount = (ops, o1Ops) => {
    const count = name => ops.filter(op => op[0] === name).length;
    const visible = o1Ops.filter(op => op[0] === 'fill').length;
    assert.equal(count('drawImage') / 2 + count('fill'), visible, 'each visible spark drawn once');
    assert.equal(count('stroke'), 6 * count('fill'), 'strokes only for stroke-path (young) sparks');
    assert.ok(count('drawImage') > count('stroke') / 3, 'most sparks are sprites');
};

test('explorer rising sparks: the stream is identical to the O1 stream, op for op (full; mini sprite count)', () => {
    for (const options of variants) {
        const h = harness(options);
        // W1 (odd/tasks/wallpaper-explorer-idle-cpu.md) stamps mature full-variant sparks from an atlas; disabling
        // its atlas runs the unchanged reference path below the W1 block (W1 itself: wallpaper-optimization.contract).
        if (options.variant !== 'mini') h.evaluate('risingSparkFullAtlasFor = () => null');
        for (const time of [...sparkTimes, 10, 10 + 1 / 30, 10 + 2 / 30]) {
            const o1 = h.record(), now = h.record();
            h.sandbox.o1DrawRisingSparks(o1.proxy, time);
            h.sandbox.drawRisingSparks(now.proxy, time);
            assert.ok(o1.ops.length > 100, `sparks drawn at t=${time}`);
            if (options.variant === 'mini') { spriteCount(now.ops, o1.ops); continue; }
            // Same op count: no batching (see the header), every stroke and fill keeps its own style.
            assert.equal(now.ops.length, o1.ops.length, `${options.variant} t=${time}`);
            assert.deepEqual(now.ops, o1.ops, `${options.variant} t=${time}`);
        }
    }
});

test('explorer rising sparks: per-segment constants are hoisted out of the frame loop', () => {
    const h = harness();
    const samples = h.evaluate('RISING_SPARK_TRAIL_SAMPLES');
    // The tables hold exactly the values the O1 loop derived per segment, per spark, per frame.
    for (let s = 1; s <= samples; s++) {
        const t = h.evaluate(`${s} / RISING_SPARK_TRAIL_SAMPLES`);
        assert.equal(h.evaluate(`RISING_SPARK_SEGMENT_T[${s}]`), t);
        assert.equal(h.evaluate(`RISING_SPARK_SEGMENT_WIDTH[${s}]`), h.evaluate(`mix(0.4, 1, ${t})`));
        assert.equal(h.evaluate(`RISING_SPARK_SEGMENT_LAG[${s}]`), h.evaluate(`RISING_SPARK_TRAIL_SECONDS * (1 - ${t})`));
    }
    // The last segment reuses the head's alpha string, which relies on alpha * t === alpha there.
    assert.equal(h.evaluate('RISING_SPARK_SEGMENT_T[RISING_SPARK_TRAIL_SAMPLES]'), 1);
    assert.equal(h.evaluate('RISING_SPARK_STROKE_PREFIX'), h.evaluate('`rgba(${RISING_SPARK_COLOR}, `'));
    // No per-segment mix() or template-literal style building is left in the frame loop.
    const body = h.sandbox.drawRisingSparks.toString();
    assert.doesNotMatch(body, /\bmix\(|`rgba\(/);
});

test('explorer drawSpark: stream and gradient stops identical to O1, one applyBrightness per spark', () => {
    const h = harness();
    const cases = [[10, 20, 4, 0.7, 'rgba(255, 240, 200, 0.9)', undefined], [120, 60.5, 2.3, 1, 'rgb(200, 220, 255)', 30],
        [0, 0, 1, 0, 'rgba(1, 2, 3, 0.5)', undefined], [5, 5, 3, 0.123456, '#fff', 12]];
    for (const args of cases) {
        const o1 = h.record(), now = h.record();
        const o1Calls = h.countCalls('applyBrightness', () => h.sandbox.o1DrawSpark(o1.proxy, ...args));
        const nowCalls = h.countCalls('applyBrightness', () => h.sandbox.drawSpark(now.proxy, ...args));
        assert.deepEqual(json(now.ops), json(o1.ops), JSON.stringify(args));
        assert.equal(o1Calls, args[3] > 0 ? 5 : 0);
        assert.equal(nowCalls, args[3] > 0 ? 1 : 0, JSON.stringify(args));
    }
});

test('explorer earth: renderEarthFrame writes exactly the O1 bytes, across spins and size changes', () => {
    const h = harness();
    for (const size of [64, 109, 33, 64]) {
        for (const longitude of [0, 0.002, 1.3, -2.2, 100.7, 4.8 * Math.PI / 180 * 3600]) {
            h.sandbox.renderEarthFrame(size, longitude);
            const actual = Uint8ClampedArray.from(h.evaluate('earthFrameImageData.data'));
            assert.deepEqual(actual, Uint8ClampedArray.from(h.sandbox.o1EarthPixels(size, longitude)),
                `size ${size}, longitude ${longitude}`);
        }
    }
});

test('explorer earth: latitude-only sampling terms are computed once per size, not per frame', () => {
    const h = harness();
    h.sandbox.renderEarthFrame(64, 0);
    const inside = h.evaluate('earthDiscLookup.inside').reduce((sum, value) => sum + value, 0);
    // Math.min per inside pixel: O1 = clamp01(latitude row) + min(v0 + 1, eh - 1) + 3 output clamp01 = 5;
    // with the per-size row table only the 3 output clamps remain.
    const MathObject = h.evaluate('Math'), min = MathObject.min;
    let calls = 0;
    MathObject.min = (...args) => { calls++; return min(...args); };
    try { h.sandbox.renderEarthFrame(64, 0.5); } finally { MathObject.min = min; }
    // W1 (odd/tasks/wallpaper-explorer-idle-cpu.md): the grayscale fast path inlines the output clamp, so no
    // Math.min call is left per pixel (O1b: 3 per inside pixel).
    assert.equal(calls, 0, `${calls} Math.min calls for ${inside} inside pixels (O1: ${5 * inside}, O1b: ${3 * inside})`);
});

test('explorer mini frame: the scene stream outside the sparks matches a frame drawn with the O1 functions', () => {
    const now = harness(), o1 = harness();
    o1.sandbox.drawRisingSparks = o1.sandbox.o1DrawRisingSparks;
    o1.sandbox.drawSpark = o1.sandbox.o1DrawSpark;
    // Bracket the spark section of each frame stream (animate.js resolves drawRisingSparks at call time).
    for (const h of [now, o1]) {
        const draw = h.sandbox.drawRisingSparks;
        h.sandbox.drawRisingSparks = (...args) => { h.scene.ops.push(['<sparks>']); draw(...args); h.scene.ops.push(['</sparks>']); };
    }
    const split = ops => {
        const from = ops.findIndex(op => op[0] === '<sparks>'), to = ops.findIndex(op => op[0] === '</sparks>');
        return { outside: [...ops.slice(0, from), ...ops.slice(to + 1)], sparks: ops.slice(from + 1, to) };
    };
    for (const ms of [1000, 1033, 1066, 1100, 4321]) {
        const expected = split(o1.tick(ms)), actual = split(now.tick(ms));
        assert.ok(expected.sparks.filter(op => op[0] === 'stroke').length > 1000, `sparks drawn at ${ms}`);
        assert.equal(actual.outside.length, expected.outside.length, `same op count outside the sparks at ${ms}`);
        assert.deepEqual(json(actual.outside), json(expected.outside), `frame ${ms}`);
        spriteCount(actual.sparks, expected.sparks);
        assert.deepEqual(Uint8ClampedArray.from(now.evaluate('earthFrameImageData.data')),
            Uint8ClampedArray.from(o1.evaluate('earthFrameImageData.data')), `earth texture ${ms}`);
    }
    assert.deepEqual(now.errors, []);
    assert.deepEqual(o1.errors, []);
});
