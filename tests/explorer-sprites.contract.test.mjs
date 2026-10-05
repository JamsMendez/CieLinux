import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { SRC, readText, source } from './paths.mjs';

// O1c / P1 (odd/tasks/mini-scene-optimization.md): user-approved visual-risk change. In mini, every
// rising spark older than RISING_SPARK_TRAIL_SECONDS is drawn as two rotated sprites (trail halves split
// at the middle sample) cut from a pre-baked streak atlas, instead of 6 strokes + 1 head fill. Younger
// sparks (clamped, unevenly spaced trail samples) keep the stroke path. The full variant is unchanged.
// These tests pin the geometry against the analytic streak (0.5 device px, alpha 1/255), the bake
// lifecycle, and that stripping the O1c blocks restores the O1b file byte for byte.
// O1d (user-approved, 2026-10-03): mini spark heads use RISING_SPARK_MINI_HEAD_RADIUS = 0.55 CSS px (atlas
// bake and young sparks) instead of RISING_SPARK_HEAD_RADIUS = 1.3; full keeps 1.3. O1d blocks only add
// lines, so stripping the O1c and O1d blocks still restores the O1b file byte for byte.

const read = name => readText(source(name));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const O1B_SHA256 = 'af1b6a3ebbb98ef7006839ab03f9967c6ae6191d98a113bfe0fde54a31930211';
// W1 blocks (odd/tasks/wallpaper-explorer-idle-cpu.md) are stripped too: they only add lines.
const stripO1c = source => source.replace(
    /^[ \t]*\/\/ Linux mini optimization begin \((O1c P1|O1d)\)[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux mini optimization end \(\1\)\.\n/gm, '').replace(
    /^[ \t]*\/\/ Linux wallpaper optimization begin \(W1\)[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux wallpaper optimization end \(W1\)\.\n(\n(?=\/\/|function))?/gm, '');
const MINI_HEAD_RADIUS = 0.55; // CSS px, user-approved (O1d)

// Verbatim O1b drawRisingSparks (rising-sparks.js at af1b6a3e...), renamed with an o1b prefix, plus a
// test-only helper listing the sparks the shipped loop draws (same filters, same order).
const O1B = String.raw`
function o1bDrawRisingSparks(context, timeSeconds) {
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

    // Streak: a tapered polyline through the spark's recent positions, so the tail follows the
    // bend instead of cutting straight across it.
    risingSparkPositionInto(spark, Math.max(0, spark.age - RISING_SPARK_TRAIL_SECONDS), W, H, trail, 0);
    for (let s = 1; s <= RISING_SPARK_TRAIL_SAMPLES; s++) {
      const sampleAge = Math.max(0, spark.age - RISING_SPARK_SEGMENT_LAG[s]); // O1b: hoisted lag
      risingSparkPositionInto(spark, sampleAge, W, H, trail, s * 2);
    }
    if (cullRadius !== Infinity && risingSparkTrailOutside(fadeCx, fadeCy, cullRadius)) continue;

    // O1b: RISING_SPARK_WIDTH * spark.size is the left operand the reference product evaluates first. The
    // last segment's t is exactly 1 (alpha * 1 === alpha), so it and the head share one alpha string.
    const sparkWidth = RISING_SPARK_WIDTH * spark.size;
    const alphaText = String(alpha);
    for (let s = 1; s <= RISING_SPARK_TRAIL_SAMPLES; s++) {
      const segmentAlpha = s === RISING_SPARK_TRAIL_SAMPLES ? alphaText : alpha * RISING_SPARK_SEGMENT_T[s];
      context.strokeStyle = RISING_SPARK_STROKE_PREFIX + segmentAlpha + ')';
      context.lineWidth = sparkWidth * RISING_SPARK_SEGMENT_WIDTH[s];
      context.beginPath();
      context.moveTo(trail[s * 2 - 2], trail[s * 2 - 1]);
      context.lineTo(trail[s * 2], trail[s * 2 + 1]);
      context.stroke();
    }

    const head = RISING_SPARK_TRAIL_SAMPLES * 2;
    context.fillStyle = 'rgba(255, 255, 255, ' + alphaText + ')';
    context.beginPath();
    context.arc(trail[head], trail[head + 1], RISING_SPARK_HEAD_RADIUS * spark.size, 0, TAU);
    context.fill();
  }
  context.restore();
}
function p1VisibleSparks(timeSeconds) {
  const cullRadius = isMiniVariant ? Math.min(W, H) * MINI_EDGE_FADE_OUTER + RISING_SPARK_CULL_MARGIN_PX : Infinity;
  const trail = new Float64Array((RISING_SPARK_TRAIL_SAMPLES + 1) * 2);
  const sparks = [];
  for (let i = 0; i < RISING_SPARK_COUNT; i++) {
    const spark = risingSparkAt(i, timeSeconds, W, H);
    if (spark.age > spark.lifetime) continue;
    const alpha = risingSparkEnvelope(spark.age / spark.lifetime) * spark.brightness;
    if (alpha <= 0.01) continue;
    risingSparkPositionInto(spark, Math.max(0, spark.age - RISING_SPARK_TRAIL_SECONDS), W, H, trail, 0);
    for (let s = 1; s <= RISING_SPARK_TRAIL_SAMPLES; s++)
      risingSparkPositionInto(spark, Math.max(0, spark.age - RISING_SPARK_SEGMENT_LAG[s]), W, H, trail, s * 2);
    let outside = cullRadius !== Infinity;
    for (let s = 0; outside && s < RISING_SPARK_TRAIL_SAMPLES; s++)
      outside = risingSparkSegmentOutside(trail[s * 2], trail[s * 2 + 1], trail[s * 2 + 2], trail[s * 2 + 3],
        W / 2, H / 2, cullRadius * cullRadius);
    if (outside) continue;
    sparks.push({ index: i, young: spark.age < RISING_SPARK_TRAIL_SECONDS, alpha, size: spark.size, trail: Array.from(trail) });
  }
  return sparks;
}
`;

// Recording Canvas2D mock: every method call and property set lands in one ordered stream per context.
function harness({ variant = 'mini', width = 240, height = 240, dpr = 1 } = {}) {
    const frames = [], events = {}, contexts = [];
    let created = 0;
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
    const window = { devicePixelRatio: dpr, innerWidth: width, innerHeight: height,
        requestAnimationFrame: fn => frames.push(fn), addEventListener: (name, fn) => { events[name] = fn; } };
    const sandbox = vm.createContext({ window, URLSearchParams, performance: { now: () => 0 },
        location: { search: `?variant=${variant}&fps=30`, hash: '' },
        console: { log() {}, info() {}, warn() {}, error() {} },
        document: {
            getElementById: name => name === 'scene' ? canvas : null,
            createElement: () => { created++; const element = { width: 0, height: 0 }; let c = null;
                element.getContext = () => { if (!c) { c = record(); contexts.push({ element, ...c }); } return c.proxy; };
                return element; },
            documentElement: { classList: { add() {} } },
            addEventListener: (name, fn) => { events[name] = fn; } } });
    const html = read('explorer/index.html');
    for (const [, script] of html.matchAll(/<script src="([^"]+)"><\/script>/g))
        vm.runInContext(read(`explorer/${script}`), sandbox, { filename: `explorer/${script}` });
    vm.runInContext(O1B, sandbox, { filename: 'o1b-reference.js' });
    const resize = (w, h, ratio = window.devicePixelRatio) => {
        window.innerWidth = w; window.innerHeight = h; window.devicePixelRatio = ratio; events.resize();
    };
    return { sandbox, record, resize, contexts, created: () => created,
        evaluate: source => vm.runInContext(source, sandbox) };
}

const json = value => JSON.parse(JSON.stringify(value));
const sparkTimes = [0.5, 1.234, 7.7, 10, 10 + 1 / 30, 63.2, 3600.1];
const count = (ops, name) => ops.filter(op => op[0] === name).length;

// Splits a mini drawRisingSparks stream into per-spark units: sprite units are
// [=globalAlpha, setTransform, drawImage, setTransform, drawImage]; stroke units end with the head 'fill'
// (a preceding transform/alpha reset after sprites is dropped).
function miniUnits(ops) {
    assert.deepEqual(ops.slice(0, 3), [['save'], ['=globalCompositeOperation', 'lighter'], ['=lineCap', 'round']]);
    assert.deepEqual(ops.at(-1), ['restore']);
    const units = [];
    const body = ops.slice(3, -1);
    for (let i = 0; i < body.length;) {
        if (body[i][0] === '=globalAlpha' && body[i + 1]?.[0] === 'setTransform') {
            assert.deepEqual(body.slice(i + 1, i + 5).map(op => op[0]), ['setTransform', 'drawImage', 'setTransform', 'drawImage']);
            units.push({ sprite: true, alpha: body[i][1], halves: [[body[i + 1], body[i + 2]], [body[i + 3], body[i + 4]]] });
            i += 5;
            continue;
        }
        const group = [];
        while (body[i][0] !== 'fill') group.push(body[i++]);
        group.push(body[i++]);
        units.push({ sprite: false, ops: group.filter(op => op[0] !== 'setTransform' && op[0] !== '=globalAlpha') });
    }
    return units;
}

test('stripping the O1c P1 and O1d blocks restores the O1b rising-sparks.js byte for byte', () => {
    const source = read('explorer/js/rising-sparks.js');
    assert.match(source, /^[ \t]*\/\/ Linux mini optimization begin \(O1c P1\)/m);
    assert.match(source, /^[ \t]*\/\/ Linux mini optimization begin \(O1d\)/m);
    assert.equal(sha256(stripO1c(source)), O1B_SHA256);
});

test('full variant: rising sparks stream is identical to O1b, with no sprites and no atlas', () => {
    const h = harness({ variant: 'full', width: 320, height: 200 });
    // W1 (odd/tasks/wallpaper-explorer-idle-cpu.md) stamps mature full-variant sparks from an atlas; disabling
    // its atlas runs the unchanged reference path below the W1 block (W1 itself: wallpaper-optimization.contract).
    h.evaluate('risingSparkFullAtlasFor = () => null');
    for (const time of [0, ...sparkTimes]) {
        const o1b = h.record(), now = h.record();
        h.sandbox.o1bDrawRisingSparks(o1b.proxy, time);
        const before = h.created();
        h.sandbox.drawRisingSparks(now.proxy, time);
        assert.equal(h.created(), before, 'full never bakes an atlas');
        assert.ok(count(o1b.ops, 'stroke') > 100, `sparks drawn at t=${time}`);
        assert.deepEqual(json(now.ops), json(o1b.ops), `t=${time}`);
        assert.equal(count(now.ops, 'drawImage'), 0);
    }
});

test('mini: a mature spark is two drawImage calls, only young sparks keep strokes', t => {
    const h = harness();
    let visibleTotal = 0, youngTotal = 0, drawsTotal = 0, o1bTotal = 0;
    for (const time of sparkTimes) {
        const visible = h.sandbox.p1VisibleSparks(time);
        const young = visible.filter(spark => spark.young).length, mature = visible.length - young;
        const o1b = h.record(), now = h.record();
        h.sandbox.o1bDrawRisingSparks(o1b.proxy, time);
        h.sandbox.drawRisingSparks(now.proxy, time);
        assert.equal(count(o1b.ops, 'fill'), visible.length, `same visible sparks at t=${time}`);
        assert.equal(count(now.ops, 'drawImage'), 2 * mature, `t=${time}`);
        assert.equal(count(now.ops, 'stroke'), 6 * young, `per-segment strokes only for young sparks at t=${time}`);
        assert.equal(count(now.ops, 'fill'), young);
        const draws = count(now.ops, 'drawImage') + count(now.ops, 'stroke') + count(now.ops, 'fill');
        assert.ok(draws < count(o1b.ops, 'stroke') + count(o1b.ops, 'fill'));
        drawsTotal += draws; o1bTotal += count(o1b.ops, 'stroke') + count(o1b.ops, 'fill');
        const units = miniUnits(now.ops);
        assert.deepEqual(units.map(unit => !unit.sprite), Array.from(visible, spark => spark.young), `unit order at t=${time}`);
        // Young sparks draw exactly their O1b group, except the O1d head radius (0.55 x size, CSS px).
        const o1bGroups = miniUnits(o1b.ops);
        units.forEach((unit, k) => {
            if (unit.sprite) return;
            const expected = json(o1bGroups[k].ops), arc = expected.findIndex(op => op[0] === 'arc');
            assert.equal(expected[arc][3], h.evaluate(`RISING_SPARK_HEAD_RADIUS * ${visible[k].size}`), 'O1b head is 1.3 x size');
            expected[arc][3] = MINI_HEAD_RADIUS * visible[k].size;
            assert.deepEqual(json(unit.ops), expected, `young spark ${visible[k].index} at t=${time}`);
        });
        visibleTotal += visible.length; youngTotal += young;
    }
    // Draw ops per visible spark: 2 for mature sparks; young ones (~9%) keep their 7 stroke/fill ops.
    assert.ok(youngTotal / visibleTotal < 0.15, `${youngTotal} young of ${visibleTotal}`);
    assert.ok(visibleTotal > 1000);
    t.diagnostic(`${visibleTotal} visible sparks (${youngTotal} young): ${drawsTotal} draw ops vs O1b ${o1bTotal}`);
});

test('mini: the atlas is baked once and rebuilt only on resize or DPR change', () => {
    const h = harness();
    const draw = time => { const before = h.created(); h.sandbox.drawRisingSparks(h.record().proxy, time); return h.created() - before; };
    assert.equal(draw(1), 1, 'baked on first use');
    assert.equal(draw(1.5), 0);
    assert.equal(draw(2), 0);
    const first = h.evaluate('risingSparkAtlas');
    assert.equal(first.dpr, 1);
    h.resize(240, 240);
    assert.equal(draw(3), 0, 'same size and DPR keeps the atlas');
    h.resize(300, 260);
    assert.equal(draw(3), 1, 'rebuilt on resize');
    assert.equal(draw(3.5), 0);
    h.resize(300, 260, 2);
    assert.equal(draw(4), 1, 'rebuilt on DPR change');
    const atlas = h.evaluate('risingSparkAtlas');
    assert.equal(atlas.dpr, 2);
    assert.equal(atlas.canvas.width, atlas.lengthCount * atlas.cellWidth);
    assert.equal(atlas.canvas.height, 2 * atlas.sizeCount * atlas.cellHeight);
    // Bounded texture: well under one 1024x1024 tile even at DPR 2 on this size.
    assert.ok(atlas.canvas.width <= 1024 && atlas.canvas.height <= 1024, `${atlas.canvas.width}x${atlas.canvas.height}`);
});

test('mini: the atlas cells are baked with the stroke geometry at unit alpha', () => {
    const h = harness();
    h.sandbox.drawRisingSparks(h.record().proxy, 1);
    const atlas = h.evaluate('risingSparkAtlas');
    const bake = h.contexts.find(c => c.element === atlas.canvas).ops;
    assert.deepEqual(bake.slice(0, 2), [['=globalCompositeOperation', 'lighter'], ['=lineCap', 'round']]);
    const prefix = h.evaluate('RISING_SPARK_STROKE_PREFIX');
    // O1d: the bake runs under setTransform(dpr), so the head is 0.55 x size CSS px (x DPR device px).
    assert.equal(h.evaluate('RISING_SPARK_MINI_HEAD_RADIUS'), MINI_HEAD_RADIUS);
    assert.equal(h.evaluate('RISING_SPARK_HEAD_RADIUS'), 1.3, 'config.js head radius unchanged');
    const headRadius = MINI_HEAD_RADIUS, tau = h.evaluate('TAU');
    let i = 2;
    for (let sizeIndex = 0; sizeIndex < atlas.sizeCount; sizeIndex++) for (let half = 0; half < 2; half++)
        for (let col = 0; col < atlas.lengthCount; col++) {
            const size = atlas.sizes[sizeIndex], length = atlas.lengths[col];
            assert.ok(Math.abs(size - (atlas.sizeMin + sizeIndex * atlas.sizeStep)) < 1e-12);
            assert.ok(Math.abs(length - (atlas.lengthMin + col * atlas.lengthStep)) < 1e-12);
            const row = sizeIndex * 2 + half;
            assert.deepEqual(bake[i++], ['setTransform', 1, 0, 0, 1, col * atlas.cellWidth, row * atlas.cellHeight]);
            for (let k = 1; k <= 3; k++) {
                const s = half * 3 + k;
                assert.deepEqual(bake.slice(i, i + 6), [['=strokeStyle', prefix + s / 6 + ')'],
                    ['=lineWidth', h.evaluate(`RISING_SPARK_WIDTH * ${size} * RISING_SPARK_SEGMENT_WIDTH[${s}]`)], ['beginPath'],
                    ['moveTo', atlas.pad + (k - 1) / 3 * length, atlas.pad], ['lineTo', atlas.pad + k / 3 * length, atlas.pad],
                    ['stroke']], `cell ${row},${col} segment ${s}`);
                i += 6;
            }
            if (half === 1) {
                assert.deepEqual(bake.slice(i, i + 4), [['=fillStyle', 'rgba(255, 255, 255, 1)'], ['beginPath'],
                    ['arc', atlas.pad + length, atlas.pad, headRadius * size, 0, tau], ['fill']]);
                i += 4;
            }
        }
    assert.equal(i, bake.length);
});

test('mini: sprite placement reproduces the analytic streak within 0.5 device px and 1/255 alpha', t => {
    for (const dpr of [1, 2]) {
        const h = harness({ dpr });
        const scaleX = h.evaluate('canvasScaleX'), scaleY = h.evaluate('canvasScaleY');
        const width = h.evaluate('RISING_SPARK_WIDTH'), headRadius = MINI_HEAD_RADIUS;
        let checked = 0, worst = 0;
        for (const time of sparkTimes) {
            const visible = h.sandbox.p1VisibleSparks(time);
            const now = h.record();
            h.sandbox.drawRisingSparks(now.proxy, time);
            const atlas = h.evaluate('risingSparkAtlas');
            const units = miniUnits(now.ops);
            assert.equal(units.length, visible.length);
            units.forEach((unit, k) => {
                const spark = visible[k];
                if (!unit.sprite) return;
                assert.ok(Math.abs(unit.alpha - spark.alpha) <= 1 / 255, `alpha ${unit.alpha} vs ${spark.alpha}`);
                unit.halves.forEach(([transform, draw], half) => {
                    const [, a, b, c, d, e, f] = transform;
                    const [, image, sx, sy, sw, sh, dx, dy, dw, dh] = draw;
                    assert.equal(image, atlas.canvas);
                    const col = sx / atlas.cellWidth, row = sy / atlas.cellHeight;
                    assert.ok(Number.isInteger(col) && Number.isInteger(row) && row % 2 === half);
                    assert.equal(sw, atlas.cellWidth); assert.equal(sh, atlas.cellHeight);
                    const length = atlas.lengths[col], size = atlas.sizes[(row - half) / 2];
                    // Width and head radius within 0.5 device px (as a full width, not just an edge).
                    assert.ok(Math.abs(size - spark.size) * width * dpr <= 0.5);
                    assert.ok(Math.abs(size - spark.size) * headRadius * dpr <= 0.5);
                    for (let j = 0; j <= 3; j++) {
                        const localX = dx + (atlas.pad + j / 3 * length) * atlas.dpr * dw / sw;
                        const localY = dy + atlas.pad * atlas.dpr * dh / sh;
                        const px = a * localX + c * localY + e, py = b * localX + d * localY + f;
                        const p = (half * 3 + j) * 2;
                        const error = Math.hypot(px - spark.trail[p] * scaleX, py - spark.trail[p + 1] * scaleY);
                        worst = Math.max(worst, error);
                        assert.ok(error <= 0.5, `dpr ${dpr} t=${time} spark ${spark.index} point ${half * 3 + j}: ${error} device px`);
                    }
                    checked++;
                });
            });
        }
        assert.ok(checked > 1000, `${checked} sprites checked at DPR ${dpr} (worst ${worst})`);
        t.diagnostic(`DPR ${dpr}: ${checked} sprite halves, worst point error ${worst.toFixed(3)} device px`);
    }
});
