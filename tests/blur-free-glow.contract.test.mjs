import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readText, source } from './paths.mjs';

// PERF-5 (odd/tasks/wallpaper-microstutters.md): the full wallpaper paints no per-frame canvas shadow.
// Every glow the reference draws with ctx.shadowBlur comes from a shadow-only bitmap baked once per
// geometry (the same canvas shadow, drawn off-bitmap and brought back with shadowOffsetX), stamped
// under the unshadowed shape. The reference is the CielWin code: layers.js/sprites.js with every
// "Linux mini optimization" block stripped (pinned by the O2/O3 hash tests). The mocks record Canvas2D
// calls and track the transform; they do not model pixels (the visual check is the user's).

const read = name => readText(source(name));
const strip = text => text.replace(/^[ \t]*\/\/ Linux mini optimization begin[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux mini optimization end\.\n/gm, '');
const STRIPPED = new Set(['js/layers.js', 'js/sprites.js']);

const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const map = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = m => Math.hypot(m[0], m[1]);
const rotation = a => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];

function harness(scene, { variant = 'full', width = 1920, height = 1080, dpr = 1, reference = false } = {}) {
    const streams = new Map(), frames = [], events = {}, errors = [], created = [];
    let nextId = 0;
    const makeContext = () => {
        const id = nextId++, ops = [];
        streams.set(id, ops);
        const state = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
        let matrix = IDENTITY;
        const stack = [];
        // save/restore also restore the drawing state, as a real context does (code may read it back).
        const transforms = {
            save: () => stack.push([matrix, { ...state }]),
            restore: () => {
                const saved = stack.pop();
                if (!saved) return;
                matrix = saved[0];
                for (const key of Object.keys(state)) delete state[key];
                Object.assign(state, saved[1]);
            },
            translate: (x, y) => { matrix = mul(matrix, [1, 0, 0, 1, x, y]); },
            scale: (x, y) => { matrix = mul(matrix, [x, 0, 0, y, 0, 0]); },
            rotate: a => { matrix = mul(matrix, rotation(a)); },
            setTransform: (...m) => { matrix = m.slice(0, 6); },
        };
        const proxy = new Proxy(state, {
            get(target, name) {
                if (name in target) return target[name];
                if (name === 'measureText') return text => ({ width: String(text).length * 4 });
                if (name === 'getTransform') return () => {
                    const [a, b, c, d, e, f] = matrix;
                    return { a, b, c, d, e, f };
                };
                return (...args) => {
                    ops.push([name, ...args]);
                    transforms[name]?.(...args);
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
    const window = { devicePixelRatio: dpr, innerWidth: width, innerHeight: height,
        requestAnimationFrame: fn => frames.push(fn), addEventListener: (name, fn) => { events[name] = fn; } };
    const sandbox = vm.createContext({ window, URLSearchParams, performance: { now: () => 0 },
        location: { search: `?variant=${variant}&fps=30`, hash: '' },
        console: { log() {}, info() {}, warn() {}, error: (...args) => {
            if (!/synthetic transport probe|-nebula\] unavailable/.test(String(args[0]))) errors.push(args);
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
    const html = read(`${scene}/index.html`);
    for (const [, script] of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
        const text = read(`${scene}/${script}`);
        vm.runInContext(reference && STRIPPED.has(script) ? strip(text) : text, sandbox, { filename: `${scene}/${script}` });
    }
    const main = streams.get(scene0.id);
    const tick = ms => {
        assert.equal(frames.length, 1);
        const start = main.length, createdBefore = created.length;
        frames.shift()(ms);
        return { ops: main.slice(start), created: created.slice(createdBefore) };
    };
    const capture = fn => { const start = main.length; fn(); return main.slice(start); };
    const resize = (w, h) => { bounds.width = w; bounds.height = h; window.innerWidth = w; window.innerHeight = h; events.resize(); };
    const streamOf = element => streams.get(element.contextId) ?? [];
    return { sandbox, main, created, errors, tick, capture, resize, streamOf, evaluate: text => vm.runInContext(text, sandbox) };
}

const json = value => JSON.parse(JSON.stringify(value));
const centre = h => [h.evaluate('W') * 0.505, h.evaluate('H') * 0.515];
const blurred = ops => ops.filter(op => op[0] === '=shadowBlur' && op[1] > 0);

// Replays a call stream with its own transform stack: every fill/stroke in canvas space (as the
// optimization tests' flatten) and every drawImage with the matrix it was drawn under.
function replay(ops) {
    let m = IDENTITY, state = {}, path = [];
    const stack = [], paints = [], images = [];
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
        else if (name === 'rotate') m = mul(m, rotation(a[0]));
        else if (name === 'setTransform') m = a.slice(0, 6);
        else if (name.startsWith('=')) state[name.slice(1)] = a[0];
        else if (name === 'beginPath') path = [];
        else if (name === 'moveTo' || name === 'lineTo') path.push([name, ...map(m, a[0], a[1])]);
        else if (name === 'arc') path.push(['arc', ...map(m, a[0], a[1]), a[2] * scaleOf(m), a[4] - a[3]]);
        else if (name === 'roundRect') path.push(['roundRect', ...map(m, a[0], a[1]), a[2] * scaleOf(m), a[3] * scaleOf(m), a[4]]);
        else if (name === 'closePath') path.push([name]);
        else if (name === 'fill' || name === 'stroke') {
            const blur = state.shadowBlur || 0;
            paints.push({ name, path, composite: state.globalCompositeOperation ?? 'source-over',
                alpha: state.globalAlpha ?? 1, lineCap: state.lineCap, lineJoin: state.lineJoin,
                style: style(name === 'fill' ? state.fillStyle : state.strokeStyle, m),
                lineWidth: name === 'stroke' ? state.lineWidth * scaleOf(m) : undefined,
                shadow: blur > 0 ? [blur, state.shadowColor] : null });
        } else if (name === 'drawImage') {
            images.push({ image: a[0], args: a.slice(1), matrix: m, alpha: state.globalAlpha ?? 1,
                composite: state.globalCompositeOperation ?? 'source-over' });
        }
    }
    return { paints, images };
}

function assertClose(actual, expected, where = '') {
    if (typeof expected === 'number') {
        assert.equal(typeof actual, 'number', where);
        assert.ok(Math.abs(actual - expected) <= 1e-7 * Math.max(1, Math.abs(expected)), `${where}: ${actual} vs ${expected}`);
    } else if (Array.isArray(expected)) {
        assert.ok(Array.isArray(actual), where);
        assert.equal(actual.length, expected.length, `${where} length`);
        expected.forEach((value, i) => assertClose(actual[i], value, `${where}[${i}]`));
    } else if (expected && typeof expected === 'object') {
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), where);
        for (const key of Object.keys(expected)) assertClose(actual[key], expected[key], `${where}.${key}`);
    } else assert.equal(actual, expected, where);
}

const PERIOD_MS = 600000;
// Processing pulses 0..1 during the first second of every 3 s, Raphael during 0.85 s of every 2 s.
const SCENES = {
    processing: {
        frames: [0, 1234, 2600, 3300, 3500, 4567, 9999, 17321],
        layers: (h, ms) => {
            const [cx, cy] = centre(h), p = h.sandbox.animationProgress(ms), phase = p * Math.PI * 2;
            return [
                ['drawAtomicOrbits', cx, cy, p],
                ...[0, 0.37, 1].map(pulse => ['drawCentralOctagon', cx, cy, p, pulse]),
                ['drawPerspectiveRays', cx, cy, phase],
                ['drawCentralCore', cx, cy, phase],
            ];
        },
    },
    raphael: {
        frames: [0, 400, 1000, 1700, 2200, 4567, 9999, 17321],
        layers: (h, ms) => {
            const [cx, cy] = centre(h), p = h.sandbox.animationProgress(ms), phase = p * Math.PI * 2;
            return [
                ...[0, 0.37, 1].map(pulse => ['drawGoldenHexadecagon', cx, cy, p, pulse]),
                ['drawPerspectiveRays', cx, cy, phase],
                ...[0, 0.6].map(pulse => ['drawCentralCore', cx, cy, phase, pulse]),
                ['drawGlyphCounters', ms],
            ];
        },
    },
};

for (const [scene, spec] of Object.entries(SCENES)) {
    test(`${scene} wallpaper (PERF-5): no frame paints a canvas shadow; the mini keeps its shadowBlur paths`, () => {
        for (const [width, height, dpr] of [[1920, 1080, 1], [3440, 1440, 1], [1280, 720, 2]]) {
            const h = harness(scene, { width, height, dpr });
            for (const ms of spec.frames) {
                const { ops } = h.tick(ms);
                assert.ok(ops.length > 0, `frame at ${ms} rendered`);
                assert.deepEqual(json(blurred(ops)), [], `${width}x${height}@${dpr} at ${ms}`);
                assert.ok(!ops.some(op => op[0] === '=filter' && op[1] !== 'none'), `no per-frame filter at ${ms}`);
            }
            assert.deepEqual(h.errors, []);
        }
        const mini = harness(scene, { variant: 'mini', width: 320, height: 320 });
        let miniBlurred = 0;
        for (const ms of spec.frames) miniBlurred += blurred(mini.tick(ms).ops).length;
        assert.ok(miniBlurred > 0, 'mini frames still paint their canvas shadows');
        assert.equal(mini.evaluate('wallpaperGlowCache.entries.size'), 0, 'mini bakes no wallpaper glow');
        assert.deepEqual(mini.errors, []);
    });

    test(`${scene} wallpaper (PERF-5): glows are shadow-only bakes, cached per geometry and rebuilt on resize`, () => {
        const h = harness(scene, { width: 3440, height: 1440 });
        const isBake = element => blurred(h.streamOf(element)).length > 0;
        // Raphael's B5 glyph-ring delimiter layer is a blurred static layer too, baked with its own
        // device-aligned origin; every other blurred offscreen is a PERF-5 shadow-only bake.
        const checkBake = element => {
            const ops = h.streamOf(element);
            if (!ops.some(op => op[0] === '=shadowOffsetX') && scene === 'raphael') return;
            assert.deepEqual(json(ops[0]), ['setTransform', ops[0][1], 0, 0, ops[0][1], -element.width / 2, element.height / 2]);
            assert.ok(ops.some(op => op[0] === '=shadowOffsetX' && op[1] === element.width), 'shape painted off-bitmap');
        };
        let bakes = 0;
        for (const ms of spec.frames) for (const element of h.tick(ms).created.filter(isBake)) { checkBake(element); bakes++; }
        assert.ok(bakes > 0);
        // One animation period later (600 s: the progress ping-pong; every pulse interval divides it) the
        // frames repeat exactly, and must find every glow already baked.
        for (const ms of spec.frames) {
            const { ops, created } = h.tick(ms + PERIOD_MS);
            assert.ok(ops.length > 0, `frame at ${ms + PERIOD_MS} rendered`);
            assert.deepEqual(created.filter(isBake), [], `warm cache at ${ms}`);
        }
        const before = h.evaluate('[...wallpaperGlowCache.entries.keys()]');
        h.resize(1920, 1080);
        let rebuilt = 0;
        for (const ms of spec.frames) {
            const { ops, created } = h.tick(ms + 2 * PERIOD_MS);
            assert.ok(ops.length > 0, `frame at ${ms + 2 * PERIOD_MS} rendered`);
            assert.deepEqual(json(blurred(ops)), [], `after resize at ${ms}`);
            for (const element of created.filter(isBake)) { checkBake(element); rebuilt++; }
        }
        assert.ok(rebuilt > 0, 'bakes rebuilt after resize');
        assert.equal(h.evaluate('wallpaperGlowCache.key'), '1920x1080@1,1');
        assert.notDeepEqual(h.evaluate('[...wallpaperGlowCache.entries.keys()]'), before);
        assert.deepEqual(h.errors, []);
    });

    test(`${scene} wallpaper (PERF-5): every layer keeps the reference shapes, minus only their canvas shadows`, () => {
        for (const [width, height, dpr] of [[3440, 1440, 1], [1280, 720, 2]]) {
            const h = harness(scene, { width, height, dpr });
            const r = harness(scene, { width, height, dpr, reference: true });
            h.tick(0);
            r.tick(0);
            let shadows = 0, stamps = 0;
            for (const ms of [1234, 3300, 9999]) {
                for (const [name, ...args] of spec.layers(h, ms)) {
                    const ops = h.capture(() => h.sandbox[name](...args));
                    const expected = replay(r.capture(() => r.sandbox[name](...args))).paints;
                    shadows += expected.filter(paint => paint.shadow).length;
                    assertClose(replay(ops).paints, expected.map(paint => ({ ...paint, shadow: null })), `${name} at ${ms}`);
                    assert.deepEqual(json(blurred(ops)), [], name);
                    stamps += replay(ops).images.length;
                }
            }
            assert.ok(shadows > 0 && stamps > 0, `${shadows} reference shadows, ${stamps} glow stamps`);
            assert.deepEqual(h.errors, []);
            assert.deepEqual(r.errors, []);
        }
    });

    test(`${scene} wallpaper (PERF-5): ray and spoke glows are baked from the reference shadow and laid along each segment`, () => {
        const h = harness(scene, { width: 3440, height: 1440 });
        const r = harness(scene, { width: 3440, height: 1440, reference: true });
        h.tick(0);
        r.tick(0);
        const [cx, cy] = centre(h);
        for (const phase of [0.3, 2.9, 5.5]) {
            const { paints } = replay(r.capture(() => r.sandbox.drawPerspectiveRays(cx, cy, phase)));
            const segments = paints.flatMap(paint => {
                const out = [];
                for (let i = 0; i < paint.path.length; i += 2) out.push([...paint.path[i].slice(1), ...paint.path[i + 1].slice(1)]);
                return out;
            });
            const { images } = replay(h.capture(() => h.sandbox.drawPerspectiveRays(cx, cy, phase)));
            assert.equal(images.length, 3 * segments.length, 'two end slices and one middle slice per ray');
            const bakeOps = h.streamOf(images[0].image);
            assert.ok(bakeOps.some(op => op[0] === '=shadowBlur' && op[1] === paints[0].shadow[0]));
            assert.ok(bakeOps.some(op => op[0] === '=shadowColor' && op[1] === paints[0].shadow[1]));
            assert.ok(bakeOps.some(op => op[0] === '=strokeStyle' && op[1] === paints[0].style));
            segments.forEach(([x1, y1, x2, y2], i) => {
                const [left, , right] = images.slice(3 * i, 3 * i + 3);
                assert.equal(left.composite, 'screen');
                assertClose(map(left.matrix, 0, 0), [x1, y1], `ray ${i} start`);
                // Slices reach `edge` beyond each segment end: the left one starts at -edge, the right one ends at span + edge.
                const edge = -left.args[4];
                assertClose(map(right.matrix, right.args[4] + right.args[6] - edge, 0), [x2, y2], `ray ${i} end`);
            });
        }
        assert.deepEqual(h.errors, []);
    });

    test(`${scene} wallpaper (PERF-5): the pulsing polygon glow blends baked pulse levels around the reference blur`, () => {
        const h = harness(scene, { width: 3440, height: 1440 });
        h.tick(0);
        const [cx, cy] = centre(h);
        const name = scene === 'processing' ? 'drawCentralOctagon' : 'drawGoldenHexadecagon';
        const [base, range] = scene === 'processing' ? [20, 18] : [h.evaluate('HEXADECAGON_PULSE_BLUR_BASE'), h.evaluate('HEXADECAGON_PULSE_BLUR_RANGE')];
        const levels = h.evaluate('WALLPAPER_PULSE_GLOW_LEVELS');
        const quiet = replay(h.capture(() => h.sandbox[name](cx, cy, 0.4, 0))).images;
        assert.equal(quiet.length, 1);
        assert.equal(quiet[0].alpha, 1);
        assert.ok(h.streamOf(quiet[0].image).some(op => op[0] === '=shadowBlur' && op[1] === base));
        const blurOf = stamp => h.streamOf(stamp.image).find(op => op[0] === '=shadowBlur')[1];
        for (const pulse of [0.2, 0.5, 0.93, 1]) {
            const images = replay(h.capture(() => h.sandbox[name](cx, cy, 0.4, pulse))).images;
            const blurs = images.map(blurOf);
            const target = base + pulse * range;
            assert.ok(blurs.length >= 1 && blurs.length <= 2);
            assert.ok(Math.min(...blurs) <= target + 1e-9 && Math.max(...blurs) >= target - 1e-9, `pulse ${pulse}`);
            assert.ok(Math.max(...blurs) - Math.min(...blurs) <= range / levels + 1e-9);
            assertClose(images.reduce((sum, image) => sum + image.alpha, 0), 1, `pulse ${pulse} weights`);
        }
        assert.deepEqual(h.errors, []);
    });
}
