import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import vm from 'node:vm';
import { SCENES } from './paths.mjs';

// W1 (odd/tasks/wallpaper-explorer-idle-cpu.md): wallpaper CPU of the explorer and idle scenes and of the
// alert overlay drawn over them. Every W1 change lives in marked blocks that only add lines:
//   - Earth (idle + explorer earth.js): grayscale fast path of the per-pixel texture loop, byte-identical.
//   - Vignette (rings.js) and explorer blue-layer glow: gradients cached per geometry, same fills.
//   - Explorer full rising sparks: mature sparks stamped as two trail-half sprites from a brightness-
//     preserving atlas; young sparks and the whole mini path keep their streams.
//   - Alert overlay: wash, title letters and their drop shadow baked once per tile/theme/font.
// WALLOPT_SCENES=<scenes dir> runs these tests against another tree (used to observe RED on the pre-W1 copy).

const ROOT = process.env.WALLOPT_SCENES || SCENES;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const json = value => JSON.parse(JSON.stringify(value));
const count = (ops, name) => ops.filter(op => op[0] === name).length;

const stripW1 = text => text
    .replace(/^[ \t]*\/\/ Linux wallpaper optimization begin \(W1\)[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux wallpaper optimization end \(W1\)\.\n(\n(?=\/\/|function|const))?/gm, '')
    .replace(/^[ \t]*\/\/ Linux port begin \(W1\)[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux port end\.\n(\n(?=\/\/|function))?/gm, '');

// Pre-W1 pins (the hashes explorer/idle/alerts contract tests pinned before W1).
const PRE_W1 = {
    'explorer/js/earth.js': 'c7e2bbc5c6be17389d27632604d14679b8a8b0ada0f063447ddbd622136a822e',
    'explorer/js/rings.js': '5fbbf2e05ce270ae388f41ec83513108963577cdf1ce689cdac925be8588f68f',
    'explorer/js/rising-sparks.js': '2ad6813e392bb5a948a9fa3f30c49364a190fb7cc20979fa25dd685f1ce24201',
    'idle/js/earth.js': 'ee21ce5b3159b04663b36fff784b0cc89613559816ecb425b3f227fb4865fd88',
    'idle/js/rings.js': '7979253e3038ab679417258ab369ef97fe9be315b0188f5949f2da7b64270f70',
};

// Recording Canvas2D mock: every method call and property set lands in one ordered stream per context.
function harness(scene, { variant = 'full', width = 640, height = 360, dpr = 1, hash = '', transform = text => text } = {}) {
    const frames = [], events = {}, contexts = [];
    const record = (extra = {}) => {
        const ops = [];
        const state = { globalAlpha: 1, globalCompositeOperation: 'source-over', ...extra };
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
    const scene0 = record();
    const canvas = { width: 0, height: 0, style: {}, getContext: () => scene0.proxy };
    const window = { devicePixelRatio: dpr, innerWidth: width, innerHeight: height,
        requestAnimationFrame: fn => frames.push(fn), addEventListener: (name, fn) => { events[name] = fn; } };
    const sandbox = vm.createContext({ window, URLSearchParams, performance: { now: () => 0 },
        location: { search: variant === 'mini' ? '?variant=mini&fps=60' : '?fps=60', hash },
        console: { log() {}, info() {}, warn() {}, error() {} },
        document: {
            getElementById: name => name === 'scene' ? canvas : null,
            createElement: () => { const element = { width: 0, height: 0, style: {} }; let c = null;
                element.getContext = () => { if (!c) { c = record(); contexts.push({ element, ...c }); } return c.proxy; };
                return element; },
            documentElement: { classList: { add() {} } },
            addEventListener: (name, fn) => { events[name] = fn; } } });
    const html = read(`${scene}/index.html`);
    for (const [, script] of html.matchAll(/<script src="([^"]+)"><\/script>/g))
        vm.runInContext(transform(read(`${scene}/${script}`)), sandbox, { filename: `${scene}/${script}` });
    const resize = (w, h, ratio = window.devicePixelRatio) => {
        window.innerWidth = w; window.innerHeight = h; window.devicePixelRatio = ratio; events.resize();
    };
    const tick = ms => { scene0.ops.length = 0; frames.shift()(ms); return scene0.ops.slice(); };
    return { sandbox, record, resize, contexts, scene: scene0, tick, evaluate: code => vm.runInContext(code, sandbox) };
}

// ---- Source convention ------------------------------------------------------------------------

test('W1 blocks only add lines: stripping them restores the pre-W1 files', () => {
    for (const [name, hash] of Object.entries(PRE_W1)) {
        const text = read(name);
        assert.match(text, /^[ \t]*\/\/ Linux wallpaper optimization begin \(W1\)/m, `${name} marks W1`);
        assert.equal(sha256(stripW1(text)), hash, name);
    }
    const overlay = read('shared/js/alert-overlay.js');
    assert.equal(overlay.match(/\/\/ Linux port begin \(W1\)/g)?.length, 3, 'three W1 overlay blocks');
    assert.doesNotMatch(stripW1(stripW4(overlay)), /W1|failureStaticCache/);
});

// ---- Earth -----------------------------------------------------------------------------------

for (const scene of ['idle', 'explorer']) {
    test(`${scene} earth: the grayscale fast path writes the reference bytes with no per-pixel Math calls`, () => {
        const h = harness(scene);
        assert.notEqual(h.evaluate('typeof EARTH_EQUIRECT_GRAY !== "undefined" && EARTH_EQUIRECT_GRAY'), false,
            'the equirect bake is grayscale and the fast path is active');
        // The reference: the same sources with the W1 blocks stripped.
        const reference = harness(scene, { transform: stripW1 });
        for (const size of [64, 109, 33, 241, 64]) {
            for (const longitude of [0, 0.002, 1.3, -2.2, 100.7, 4.8 * Math.PI / 180 * 3600, 4.8 * Math.PI / 180 * 86400.37]) {
                h.sandbox.renderEarthFrame(size, longitude);
                reference.sandbox.renderEarthFrame(size, longitude);
                assert.deepEqual(Uint8ClampedArray.from(h.evaluate('earthFrameImageData.data')),
                    Uint8ClampedArray.from(reference.evaluate('earthFrameImageData.data')), `size ${size}, longitude ${longitude}`);
            }
        }
        const MathObject = h.evaluate('Math'), saved = { round: MathObject.round, min: MathObject.min, max: MathObject.max };
        let calls = 0;
        for (const name of Object.keys(saved)) MathObject[name] = (...args) => { calls++; return saved[name](...args); };
        try { h.sandbox.renderEarthFrame(64, 0.5); } finally { Object.assign(MathObject, saved); }
        assert.equal(calls, 0, `${calls} Math.round/min/max calls per frame (reference: ~5 per inside pixel)`);
    });
}

// ---- Gradients -------------------------------------------------------------------------------

for (const scene of ['idle', 'explorer']) {
    test(`${scene} full frame: the vignette${scene === 'explorer' ? ' and blue-layer glow gradients are' : ' gradient is'} created once per geometry`, () => {
        const h = harness(scene);
        const radials = ops => ops.filter(op => op[0] === 'createRadialGradient');
        h.tick(1000);
        const first = radials(h.tick(1033));
        const later = radials(h.tick(1066));
        // The chroma fan, glow sparks and the Earth flare still build their per-frame gradients.
        assert.equal(first.length, later.length);
        const vignette = h.evaluate('vignetteGradientCache.gradient');
        assert.ok(vignette && vignette.stops.length === 2);
        const h2 = harness(scene);
        h2.evaluate('vignetteGradientCache = { context: null, width: -1, height: -1, gradient: null }');
        h2.tick(1000);
        assert.ok(radials(h2.tick(1033)).length === later.length, 'steady frames rebuild nothing');
        h.resize(800, 400);
        h.tick(1100);
        assert.notEqual(h.evaluate('vignetteGradientCache.gradient'), vignette, 'rebuilt on resize');
        assert.deepEqual(json(h.evaluate('[vignetteGradientCache.width, vignetteGradientCache.height]')), [800, 400]);
    });

    // A gradient that fails to build must not leave a dangling save(): the failing frame is caught by the render
    // loop, and an unbalanced save would grow the canvas state stack on every failing frame.
    test(`${scene} vignette: a throwing createRadialGradient leaves save/restore balanced, and the next frame fills`, () => {
        const h = harness(scene);
        let throws = 1, saves = 0, restores = 0, fills = 0;
        const context = {
            save() { saves++; },
            restore() { restores++; },
            fillRect() { fills++; },
            createRadialGradient() {
                if (throws > 0) { throws--; throw new Error('createRadialGradient failed'); }
                return { addColorStop() {} };
            },
        };
        assert.throws(() => h.sandbox.drawVignette(context), /createRadialGradient failed/);
        assert.equal(saves, restores, `balanced after the failing frame (${saves} saves, ${restores} restores)`);
        assert.equal(fills, 0, 'nothing filled on the failing frame');
        h.sandbox.drawVignette(context);
        assert.equal(saves, restores, 'balanced after the next frame');
        assert.equal(fills, 1, 'the next frame fills the vignette');
    });
}

test('explorer full frame: vignette and blue layer fill the reference gradients', () => {
    const h = harness('explorer');
    h.tick(1000);
    const ops = h.tick(1033);
    const vignette = h.evaluate('vignetteGradientCache.gradient'), glow = h.evaluate('blueLayerGlowCache.gradient');
    const W = 640, H = 360, maxRadius = Math.hypot(W / 2, H / 2);
    assert.deepEqual(json(vignette.args), [W / 2, H / 2, maxRadius * 0.5, W / 2, H / 2, maxRadius]);
    assert.deepEqual(vignette.stops, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.9)']]);
    assert.deepEqual(glow.stops, [[0, h.evaluate('BLUE_LAYER_GLOW_COLOR')], [1, 'rgba(0, 0, 0, 0)']]);
    assert.equal(glow.args[5], Math.max(W, H) * h.evaluate('BLUE_LAYER_GLOW_RADIUS_FRACTION'));
    const at = ops.findIndex(op => op[0] === '=fillStyle' && op[1] === glow);
    assert.deepEqual(json(ops.slice(at - 4, at + 2)).map(op => op[0] + (typeof op[1] === 'string' ? ' ' + op[1] : '')),
        ['=globalCompositeOperation color', '=fillStyle rgba(25, 120, 175, 0.75)', 'fillRect', '=globalCompositeOperation screen',
            '=fillStyle', 'fillRect']);
    const v = ops.findIndex(op => op[0] === '=fillStyle' && op[1] === vignette);
    assert.deepEqual(ops[v + 1], ['fillRect', 0, 0, W, H]);
});

// ---- Explorer rising sparks ---------------------------------------------------------------------

const sparkTimes = [0.5, 1.234, 7.7, 10, 10 + 1 / 60, 63.2, 3600.1];

// The sparks drawRisingSparks would stroke (reference filters and order), with their trails.
function visibleSparks(h, time) {
    return JSON.parse(h.evaluate(`JSON.stringify((() => {
      const out = [], trail = new Float64Array((RISING_SPARK_TRAIL_SAMPLES + 1) * 2);
      for (let i = 0; i < RISING_SPARK_COUNT; i++) {
        const spark = risingSparkAt(i, ${time}, W, H);
        if (spark.age > spark.lifetime) continue;
        const alpha = risingSparkEnvelope(spark.age / spark.lifetime) * spark.brightness;
        if (alpha <= 0.01) continue;
        risingSparkPositionInto(spark, Math.max(0, spark.age - RISING_SPARK_TRAIL_SECONDS), W, H, trail, 0);
        for (let s = 1; s <= RISING_SPARK_TRAIL_SAMPLES; s++)
          risingSparkPositionInto(spark, Math.max(0, spark.age - RISING_SPARK_SEGMENT_LAG[s]), W, H, trail, s * 2);
        out.push({ index: i, young: spark.age < RISING_SPARK_TRAIL_SECONDS, alpha, size: spark.size, trail: Array.from(trail) });
      }
      return out;
    })())`));
}

// Splits a full drawRisingSparks stream into per-spark units: a sprite unit is the two halves' setTransform +
// alpha + 1..2 drawImage; a stroke unit ends with its head 'fill' (a base-transform reset is dropped).
function fullUnits(ops) {
    if (ops[0]?.[0] === 'getTransform') ops = ops.slice(1); // W1 reads the base transform once
    assert.deepEqual(ops.slice(0, 3), [['save'], ['=globalCompositeOperation', 'lighter'], ['=lineCap', 'round']]);
    assert.deepEqual(ops.at(-1), ['restore']);
    const body = ops.slice(3, -1), units = [];
    for (let i = 0; i < body.length;) {
        if (body[i][0] === 'setTransform' && body[i + 1]?.[0] === '=globalAlpha' && body[i + 2]?.[0] === 'drawImage') {
            const halves = [];
            for (let half = 0; half < 2; half++) {
                const transform = body[i++], alpha = body[i++][1], draws = [];
                while (body[i]?.[0] === 'drawImage') draws.push(body[i++]);
                halves.push({ transform, alpha, draws });
            }
            units.push({ sprite: true, halves });
            continue;
        }
        const group = [];
        while (body[i][0] !== 'fill') group.push(body[i++]);
        group.push(body[i++]);
        units.push({ sprite: false, ops: group.filter(op => op[0] !== 'setTransform' && op[0] !== '=globalAlpha') });
    }
    return units;
}

test('explorer full sparks: mature sparks are two atlas halves, young sparks keep the reference strokes', t => {
    const h = harness('explorer', { width: 1720, height: 720 });
    const reference = harness('explorer', { width: 1720, height: 720, transform: stripW1 });
    let mature = 0, young = 0, draws = 0, referenceDraws = 0;
    for (const time of sparkTimes) {
        const visible = visibleSparks(h, time);
        const now = h.record(), ref = reference.record();
        h.sandbox.drawRisingSparks(now.proxy, time);
        reference.sandbox.drawRisingSparks(ref.proxy, time);
        const units = fullUnits(now.ops), refUnits = fullUnits(ref.ops);
        assert.equal(units.length, visible.length, `t=${time}`);
        assert.deepEqual(units.map(unit => !unit.sprite), visible.map(spark => spark.young), `unit order at t=${time}`);
        units.forEach((unit, k) => {
            if (unit.sprite) { mature++; return; }
            young++;
            assert.deepEqual(json(unit.ops), json(refUnits[k].ops), `young spark ${visible[k].index} at t=${time}`);
        });
        assert.equal(count(now.ops, 'stroke'), 6 * units.filter(unit => !unit.sprite).length);
        draws += count(now.ops, 'drawImage') + count(now.ops, 'stroke') + count(now.ops, 'fill');
        referenceDraws += count(ref.ops, 'stroke') + count(ref.ops, 'fill');
    }
    assert.ok(mature > 1000 && young / (mature + young) < 0.15, `${mature} mature, ${young} young`);
    assert.ok(draws < referenceDraws * 0.5, `${draws} draw ops vs reference ${referenceDraws}`);
    t.diagnostic(`${mature} mature + ${young} young sparks: ${draws} draw ops (reference ${referenceDraws} anti-aliased paths)`);
});

test('explorer full sparks: halves follow the analytic trail and keep the additive brightness', t => {
    for (const [width, height, dpr] of [[3440, 1440, 1], [1720, 720, 2]]) {
        const h = harness('explorer', { width, height, dpr });
        let worst = 0, checked = 0;
        const errors = [];
        for (const time of sparkTimes) {
            const visible = visibleSparks(h, time);
            const now = h.record();
            h.sandbox.drawRisingSparks(now.proxy, time);
            const atlas = h.evaluate('risingSparkFullAtlas');
            fullUnits(now.ops).forEach((unit, k) => {
                if (!unit.sprite) return;
                const spark = visible[k];
                unit.halves.forEach(({ transform, alpha, draws }, half) => {
                    const [, a, b, c, d, e, f] = transform;
                    // Brightness: half 0 at unit gain once at alpha; half 1 (half gain) totals 2 x alpha.
                    const total = alpha * draws.length * (half === 1 ? 0.5 : 1);
                    assert.ok(Math.abs(total - spark.alpha) < 1e-12, `alpha ${total} vs ${spark.alpha}`);
                    assert.ok(alpha <= 1 && draws.length === (half === 1 && spark.alpha > 0.5 ? 2 : 1));
                    const [, image, sx, sy, sw, sh, dx, dy, dw, dh] = draws[0];
                    assert.equal(image, atlas.canvas);
                    for (const draw of draws) assert.deepEqual(draw, draws[0]);
                    const cell = (sy / atlas.cellHeight) * atlas.perRow + sx / atlas.cellWidth;
                    assert.ok(Number.isInteger(cell));
                    const col = cell % atlas.lengthCount, row = (cell - col) / atlas.lengthCount;
                    assert.equal(row % 2, half);
                    const size = atlas.sizes[(row - half) / 2], length = atlas.lengths[col];
                    assert.ok(Math.abs(size - spark.size) <= atlas.sizeStep / 2 + 1e-12);
                    assert.equal(sw, atlas.cellWidth); assert.equal(sh, atlas.cellHeight);
                    for (let j = 0; j <= 3; j++) {
                        const localX = dx + (atlas.pad + j / 3 * length) * atlas.dpr * dw / sw;
                        const localY = dy + atlas.pad * atlas.dpr * dh / sh;
                        const px = a * localX + c * localY + e, py = b * localX + d * localY + f;
                        const p = (half * 3 + j) * 2;
                        const error = Math.hypot(px - spark.trail[p] * dpr, py - spark.trail[p + 1] * dpr);
                        errors.push(error);
                        worst = Math.max(worst, error);
                        // Chord endpoints within the 0.25 device px length bucket; inner samples within 1 px.
                        assert.ok(error <= (j === 0 || j === 3 ? 0.25 : 1) * Math.max(1, dpr), `${width}x${height}@${dpr} t=${time} spark ${spark.index} point ${half * 3 + j}: ${error}`);
                    }
                    checked++;
                });
            });
        }
        errors.sort((x, y) => x - y);
        const median = errors[errors.length >> 1], p99 = errors[Math.floor(errors.length * 0.99)];
        assert.ok(checked > 1000 && median < 0.1, `median ${median}`);
        t.diagnostic(`${width}x${height}@${dpr}: ${checked} halves, point error median ${median.toFixed(3)}, p99 ${p99.toFixed(3)}, worst ${worst.toFixed(3)} device px`);
    }
});

test('explorer full sparks: the atlas bakes the reference segments, half 1 at half gain, once per geometry', () => {
    const h = harness('explorer', { width: 1720, height: 720 });
    const created = () => h.contexts.length;
    h.sandbox.drawRisingSparks(h.record().proxy, 1);
    const atlas = h.evaluate('risingSparkFullAtlas'), before = created();
    h.sandbox.drawRisingSparks(h.record().proxy, 1.5);
    assert.equal(created(), before, 'not rebaked on the next frame');
    assert.ok(atlas.canvas.width <= 4096, `atlas ${atlas.canvas.width}x${atlas.canvas.height}`);
    const bake = h.contexts.find(c => c.element === atlas.canvas).ops;
    assert.deepEqual(bake.slice(0, 2), [['=globalCompositeOperation', 'lighter'], ['=lineCap', 'round']]);
    const prefix = h.evaluate('RISING_SPARK_STROKE_PREFIX'), tau = h.evaluate('TAU');
    let i = 2;
    for (let sizeIndex = 0; sizeIndex < atlas.sizeCount; sizeIndex++) for (let half = 0; half < 2; half++)
        for (let col = 0; col < atlas.lengthCount; col++) {
            const size = atlas.sizes[sizeIndex], length = atlas.lengths[col], gain = half ? 0.5 : 1;
            const cell = (sizeIndex * 2 + half) * atlas.lengthCount + col;
            assert.deepEqual(bake[i++], ['setTransform', 1, 0, 0, 1, (cell % atlas.perRow) * atlas.cellWidth,
                Math.floor(cell / atlas.perRow) * atlas.cellHeight]);
            for (let k = 1; k <= 3; k++) {
                const s = half * 3 + k;
                assert.deepEqual(bake.slice(i, i + 6), [['=strokeStyle', prefix + h.evaluate(`RISING_SPARK_SEGMENT_T[${s}]`) * gain + ')'],
                    ['=lineWidth', h.evaluate(`RISING_SPARK_WIDTH * ${size} * RISING_SPARK_SEGMENT_WIDTH[${s}]`)], ['beginPath'],
                    ['moveTo', atlas.pad + (k - 1) / 3 * length, atlas.pad], ['lineTo', atlas.pad + k / 3 * length, atlas.pad],
                    ['stroke']]);
                i += 6;
            }
            if (half === 1) {
                assert.deepEqual(bake.slice(i, i + 4), [['=fillStyle', 'rgba(255, 255, 255, 0.5)'], ['beginPath'],
                    ['arc', atlas.pad + length, atlas.pad, h.evaluate('RISING_SPARK_HEAD_RADIUS') * size, 0, tau], ['fill']]);
                i += 4;
            }
        }
    assert.equal(i, bake.length);
    h.resize(1600, 700);
    h.sandbox.drawRisingSparks(h.record().proxy, 2);
    assert.notEqual(h.evaluate('risingSparkFullAtlas'), atlas, 'rebuilt on resize');
});

test('explorer full sparks: sprites compose with the context transform (alert see-through tile layer)', () => {
    const h = harness('explorer', { width: 1720, height: 720 });
    const plain = h.record(), shifted = h.record({ getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: -100.5, f: 40 }) });
    h.sandbox.drawRisingSparks(plain.proxy, 7.7);
    h.sandbox.drawRisingSparks(shifted.proxy, 7.7);
    const transforms = ops => ops.filter(op => op[0] === 'setTransform');
    const a = transforms(plain.ops), b = transforms(shifted.ops);
    assert.equal(a.length, b.length);
    assert.ok(a.length > 100);
    a.forEach((op, k) => {
        assert.deepEqual(b[k].slice(1, 5), op.slice(1, 5));
        assert.ok(Math.abs(b[k][5] - (op[5] - 100.5)) < 1e-9 && Math.abs(b[k][6] - (op[6] + 40)) < 1e-9);
    });
});

test('explorer mini sparks are untouched by W1 (no full atlas, same stream)', () => {
    const h = harness('explorer', { variant: 'mini', width: 240, height: 240 });
    const off = harness('explorer', { variant: 'mini', width: 240, height: 240 });
    off.evaluate('risingSparkFullAtlasFor = () => { throw new Error("full atlas in mini"); }');
    for (const time of sparkTimes) {
        const a = h.record(), b = off.record();
        h.sandbox.drawRisingSparks(a.proxy, time);
        off.sandbox.drawRisingSparks(b.proxy, time);
        assert.deepEqual(json(a.ops), json(b.ops), `t=${time}`);
    }
    assert.equal(h.evaluate('risingSparkFullAtlas'), null);
});

// ---- Alert overlay ------------------------------------------------------------------------------

function alertRun(hash, frames) {
    const h = harness('explorer', { width: 640, height: 360, hash });
    const perFrame = [];
    h.tick(0);
    for (const ms of frames) perFrame.push(h.tick(ms));
    return { h, perFrame };
}

test('alert overlay: wash, title letters and their shadow are baked once, not per frame', () => {
    const { h, perFrame } = alertRun('#kind=warning&duration=99999', [300, 900, 1500, 1533, 1566]);
    const all = h.contexts.flatMap(c => c.ops);
    // Two titles (mirrored top/bottom) per bake; one bake for the whole alert.
    assert.equal(all.filter(op => op[0] === 'fillText' && op[1] === 'WARNING').length, 2);
    assert.equal(all.filter(op => op[0] === '=shadowBlur').length, 1);
    assert.equal(all.filter(op => op[0] === 'fill' && op[1] === 'evenodd').length, 1);
    for (const ops of perFrame.slice(2)) {
        assert.equal(ops.filter(op => op[0] === '=shadowBlur').length, 0, 'no per-frame shadow on the scene canvas');
        assert.equal(ops.filter(op => op[0] === 'fill' && op[1] === 'evenodd').length, 0);
        assert.ok(ops.filter(op => op[0] === '=globalCompositeOperation' && op[1] === 'difference').length === 1, 'rails stay per frame');
    }
    const cache = Object.values(h.evaluate('failureStaticCache'));
    assert.equal(cache.length, 1);
    // The shadow bake is the reference letters stamp: shadow, offset, alpha 0.86, letters at the tile size.
    const shadowed = h.contexts.find(c => c.element === cache[0].shadowed.canvas).ops;
    assert.deepEqual(json(shadowed.map(op => op[0] === 'drawImage' ? [op[0], ...op.slice(2)] : op)), [['setTransform', 1, 0, 0, 1, 0, 0],
        ['=shadowColor', 'rgba(0,0,0,0.8)'], ['=shadowBlur', 360 * 0.03], ['=shadowOffsetY', 360 * 0.008], ['=globalAlpha', 0.86],
        ['drawImage', 0, 0, 640, 360]]);
    assert.equal(shadowed.at(-1)[1], cache[0].letters.canvas);
});

test('alert overlay: the see-through intersections are clipped by the cached letters every frame', () => {
    const { h } = alertRun('#kind=failed&duration=99999', [300, 900, 1500, 1533]);
    const cache = Object.values(h.evaluate('failureStaticCache'))[0];
    const intersections = h.evaluate('failureLayers.intersections');
    const ops = h.contexts.find(c => c.element === intersections.canvas).ops;
    const clips = ops.filter(op => op[0] === 'drawImage' && op[1] === cache.letters.canvas);
    assert.ok(clips.length >= 3, `${clips.length} destination-in stamps of the cached letters`);
    assert.equal(h.evaluate('failureLayers.letters'), undefined, 'no per-frame letters layer');
});

test('alert overlay: cached layers are released when the alert stops and rebuilt when the title face changes', () => {
    const h = harness('explorer', { width: 640, height: 360, hash: '#kind=warning&duration=1000' });
    h.tick(0);
    h.tick(500);
    h.tick(800);
    const first = Object.values(h.evaluate('failureStaticCache'))[0];
    assert.ok(first);
    // Title face loads: a different measured width means a different bake key.
    h.evaluate('failureMeasureContext.measureText = text => ({ width: String(text).length * 5 })');
    h.tick(900);
    const keys = Object.keys(h.evaluate('failureStaticCache'));
    assert.equal(keys.length, 2);
    h.tick(1100); // done -> stops animating
    h.tick(1200);
    assert.equal(Object.keys(h.evaluate('failureStaticCache')).length, 0);
    assert.equal(first.wash.canvas.width, 0);
    assert.equal(first.shadowed.canvas.width, 0);
});

// ---- W4: alert overlay per-frame work over the full wallpaper ----------------------------------
// The full (unkeyed) wallpaper only: explorer's see-through layer reuses the sparks the scene already drew
// this frame, the intersections are recolored and composited over the letters' two bands only, the
// module boxes/counters re-render only when the counter ticks, and a shown FAILED tile pixelates the
// scene canvas directly instead of copying the whole canvas first. Mini keeps its op streams.

const stripW4 = text => text.replace(
    /(?:\n(?=\/\/ Linux port begin \(W4\)))?^[ \t]*\/\/ Linux port begin \(W4\)[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux port end\.\n/gm, '');
// alert-overlay.js and explorer/js/animate.js as installed with W1 (build 0bf0b4d0).
const PRE_W4 = {
    'shared/js/alert-overlay.js': '5c6cd27e7ce5257fb0761e7389bced1233e6375195f3b2654886420d8e1ebfab',
    'explorer/js/animate.js': '3fd5fa3241be1929f582efe1a2c0d5ddb09f59de7fc7481e6597cb168f2e00a2',
};
const opsSince = (h, marks) => h.contexts.map((c, k) => ({ c, ops: c.ops.slice(marks[k] ?? 0) }));
const marksOf = h => h.contexts.map(c => c.ops.length);

test('W4 blocks only add lines: stripping them restores the W1 files', () => {
    for (const [name, hash] of Object.entries(PRE_W4)) {
        const text = read(name);
        assert.match(text, /^[ \t]*\/\/ Linux port begin \(W4\)/m, `${name} marks W4`);
        assert.equal(sha256(stripW4(text)), hash, name);
    }
});

function sparkCounting(hash, variant = 'full') {
    const h = harness('explorer', { width: 640, height: 360, hash, variant });
    h.evaluate('var w4SparkCalls = 0; var w4ReferenceSparks = drawRisingSparks;'
        + 'drawRisingSparks = function (c, t) { w4SparkCalls++; return w4ReferenceSparks(c, t); };');
    return h;
}

test('W4 explorer alert: the rising sparks run once per frame; the see-through reuses the scene spark layer', () => {
    for (const hash of ['#kind=warning&duration=99999', '#kind=failed&duration=99999', '#tiles=warning,failed&columns=2&rows=1&gap=8&duration=99999']) {
        const h = sparkCounting(hash);
        h.tick(0);
        h.tick(100);
        for (const ms of [500, 1500, 1533]) {
            h.evaluate('w4SparkCalls = 0');
            const ops = h.tick(ms);
            assert.equal(h.evaluate('w4SparkCalls'), 1, `${hash} @${ms}: one spark pass`);
            // The scene composites its spark layer additively, as the sparks themselves draw.
            const layer = ops.findIndex(op => op[0] === 'drawImage' && op[1] !== h.scene.proxy && op.length === 4 && op[2] === 0 && op[3] === 0);
            assert.ok(layer > 0, `${hash} @${ms}: spark layer stamped`);
            assert.deepEqual(ops.slice(0, layer).filter(op => op[0] === '=globalCompositeOperation').at(-1), ['=globalCompositeOperation', 'lighter']);
        }
    }
    // No alert: the scene draws its sparks straight onto the canvas, no layer.
    const plain = sparkCounting('');
    plain.tick(0);
    const ops = plain.tick(1500);
    assert.equal(plain.evaluate('w4SparkCalls'), 2);
    assert.equal(ops.filter(op => op[0] === 'drawImage' && op.length === 4 && op[2] === 0 && op[3] === 0).length, 0);
});

test('W4 alert overlay: module boxes and counters re-render only when the counter ticks', () => {
    const { h } = alertRun('#kind=warning&duration=99999', [300, 900, 1500]);
    const before = marksOf(h);
    const same = h.tick(1533); // counter 15 again
    assert.equal(opsSince(h, before).flatMap(x => x.ops).concat(same).filter(op => op[0] === 'fillText').length, 0, 'same counter: no text');
    assert.equal(same.filter(op => op[0] === 'strokeRect').length, 1, 'only the frame stroke on the scene canvas');
    const mark = marksOf(h);
    const next = h.tick(1633); // counter 16
    const texts = opsSince(h, mark).flatMap(x => x.ops).concat(next).filter(op => op[0] === 'fillText');
    assert.equal(texts.length, 8, 'eight module labels when the counter ticks');
    assert.ok(texts.every(op => /^00:16 [01]{8}$/.test(op[1])));
    assert.equal(next.filter(op => op[0] === 'fillText').length, 0, 'labels live on the module layer');
});

test('W4 alert overlay: intersections are recolored and composited over the letters bands only', () => {
    const { h } = alertRun('#kind=failed&duration=99999', [300, 900, 1500]);
    const mark = marksOf(h);
    const ops = h.tick(1533);
    const intersections = h.evaluate('failureLayers.intersections');
    const layerOps = opsSince(h, mark).find(x => x.c.element === intersections.canvas).ops;
    const area = 640 * 360;
    const recolor = layerOps.filter(op => op[0] === 'fillRect');
    const filled = recolor.reduce((sum, op) => sum + op[3] * op[4], 0);
    assert.equal(recolor.length, 2, 'one source-in recolor per band');
    assert.ok(filled <= 0.6 * area, `recolor area ${filled}`);
    // Layers from failureLayer are stamped through their context's `canvas`, a fresh recorder in this mock.
    const fromLayer = ops.filter(op => op[0] === 'drawImage' && typeof op[1] === 'function');
    const stamps = fromLayer.filter(op => op.length === 10);
    assert.equal(stamps.length, 2, 'two band stamps');
    assert.equal(fromLayer.filter(op => op.length === 6 && op[4] === 640 && op[5] === 360).length, 0, 'no whole-tile stamp');
    assert.ok(stamps.reduce((sum, op) => sum + op[8] * op[9], 0) <= 0.6 * area);
});

test('W4 failed shown: no whole-canvas backdrop copy; each tile pixelates the scene canvas directly', () => {
    for (const hash of ['#kind=failed&duration=99999', '#tiles=failed,failed&columns=2&rows=1&gap=8&duration=99999']) {
        const { h } = alertRun(hash, [300, 900, 1500]);
        const mark = marksOf(h);
        h.tick(1533);
        const backdrop = h.evaluate('failureLayers.backdrop');
        const touched = opsSince(h, mark);
        if (backdrop) assert.equal(touched.find(x => x.c.element === backdrop.canvas).ops.filter(op => op[0] === 'drawImage').length, 0, `${hash}: no copy`);
        const reads = touched.flatMap(x => x.ops).filter(op => op[0] === 'drawImage' && op[1] === h.evaluate('canvas'));
        assert.equal(reads.length, hash.includes('tiles') ? 2 : 1, `${hash}: one direct downscale per failed tile`);
    }
});

test('W4 mini alerts keep their op streams', () => {
    const run = transform => {
        const h = harness('explorer', { variant: 'mini', width: 240, height: 240, transform,
            hash: '#tiles=failed,warning&columns=2&rows=1&gap=8&duration=99999' });
        const frames = [0, 100, 300, 600, 1000, 1533, 1633, 2000].map(ms => h.tick(ms));
        return json({ frames, layers: h.contexts.map(c => c.ops) });
    };
    assert.deepEqual(run(text => text), run(stripW4));
});
