import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { source } from './paths.mjs';

const read = name => readFileSync(source(name), 'utf8');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const exists = name => existsSync(source(name));
const html = exists('idle/index.html') ? read('idle/index.html') : '';
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
const renderFiles = ['config', 'math', 'glyphs', 'earth', 'rings'];
const scriptOrder = [...renderFiles, 'see-through-hook', 'render-loop', 'animate', 'main'];
// A4: the shared alert overlay loads between the hook and the render loop (CielWin order).
const pageScripts = [...renderFiles, 'see-through-hook'].map(name => `js/${name}.js`)
    .concat(['../shared/js/alert-overlay.js', 'js/render-loop.js', 'js/animate.js', 'js/main.js']);
const manifest = ['idle/index.html', 'idle/styles.css', ...scriptOrder.map(name => `idle/js/${name}.js`)];
const selected = 'qrc:/idle/index.html?variant=mini&fps=30';
// Pinned CielWin cebb941^ (4a83e62) Wallpaper/Web/idle/js sources: the working tree no longer has them.
const referenceSha256 = {
    // Re-pinned after old-name→CielWin comment rename (text-only); was 37cd3fe356fdc23e7b310fd14bb12553a278111ff94e3cfc77a4d49839d69e39
    config: '1abc6c847879e96cd1ff5088c46a5b77c7c19de370e44488c03af31bd38a3a1a',
    math: '5507d42ea5685aac5af4a132c0fc2b8dff62b50ce9503e4666a46c3c24f52e91',
    glyphs: '57284fa7cdceede3f0d79e4a95bf7df717ef35f69b8d2ac5cb492ea508f95b86',
    // Linux mini optimization (O1, odd/tasks/mini-scene-optimization.md); CielWin reference: aec872a4c6ea50409cfed6cd15a93593b1e267628079edffbd57447b6ee87d5c
    earth: 'ee21ce5b3159b04663b36fff784b0cc89613559816ecb425b3f227fb4865fd88',
    // Linux mini optimization (O1, odd/tasks/mini-scene-optimization.md); CielWin reference: 1dde4516d984afabfe84aeca85e17f8496dd15221a91eb7ae8e75ce7c6aae9d5
    rings: '7979253e3038ab679417258ab369ef97fe9be315b0188f5949f2da7b64270f70',
    // Re-pinned after old-name→CielWin comment rename (text-only); was 231a4faf26467d05f206301f69b0613f0974ade0c43e680685c911961724f3ae
    main: '15f472543e2d53fab4157ade61bcda125be14306d3d3dc12d2e7ab7288ace698',
};
// Reference animate.js before its "Main animation loop" section, minus the
// CONSTELLATION_RING_INDEX block (and its blank line) that only fed see-through-hook.js.
const animatePrefixWithoutHookIndexSha256 = '900646f3dd182a2ad5711dab58c54ac37551df8c12311f9b1fe347f612908dd0';
const loopMarker = '// --- Main animation loop';
// Files that deliberately diverge from the CielWin reference for the Linux mini optimization (O1).
const linuxMiniOptimized = ['earth', 'rings'];
// animate.js's O1 change is one self-contained marked block; stripping it restores the reference text.
const stripMiniOptimizations = source => source.replace(/^[ \t]*\/\/ Linux mini optimization begin[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux mini optimization end\.\n/gm, '');
const kept = ['drawDiscBorder', 'drawCachedRingContent', 'drawInnerRing', 'drawEarth',
    'drawChromaticGlowAnimated', 'drawMiniRingBases', 'applyMiniEdgeFade'];
const skipped = ['drawStarfield', 'drawCombinedLightingMask', 'drawVignette'];
const probeText = ['CIELINUX_DIAGNOSTICS_JS_INFO synthetic transport probe',
    'CIELINUX_DIAGNOSTICS_JS_WARN synthetic transport probe',
    'CIELINUX_DIAGNOSTICS_JS_ERROR synthetic transport probe'];
const code = source => source.replace(/^[ \t]*\/\/[^\n]*$/gm, '');

// Recording API mocks run the real packaged scripts; they do not model pixels or text shaping.
function harness({ width = 240, height = 240 } = {}) {
    const calls = [], errors = [], probes = [], logs = [], alertLogs = [], gradients = [], frames = [], events = {}, layers = [];
    const context = () => {
        const state = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
        return new Proxy(state, {
            get(target, name) {
                if (name in target) return target[name];
                if (name === 'measureText') return text => ({ width: String(text).length * 4 });
                if (name === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
                return (...args) => {
                    calls.push([name, ...args]);
                    if (String(name).startsWith('create')) {
                        const gradient = { name, args, stops: [], addColorStop(stop, color) { this.stops.push([stop, color]); } };
                        gradients.push(gradient);
                        return gradient;
                    }
                };
            },
            set(target, name, value) { target[name] = value; return true; }
        });
    };
    const sceneContext = context();
    const canvas = { width: 0, height: 0, style: {}, getContext: (_, options) => {
        calls.push(['canvasContext', options]); return sceneContext;
    } };
    const window = { devicePixelRatio: 1, innerWidth: width, innerHeight: height,
        requestAnimationFrame: fn => frames.push(fn),
        addEventListener: (name, fn) => { events[name] = fn; } };
    const sandbox = vm.createContext({ window, location: { search: '?variant=mini&fps=30', hash: '' },
        URLSearchParams, performance: { now: () => 0 },
        console: {
            // A4: the overlay's two bridge markers are kept apart from the scene's own logs.
            log: (...args) => (String(args[0]).startsWith('CIELINUX_ALERT_') ? alertLogs : logs).push(args.join(' ')),
            info: (...args) => probes.push(['info', ...args]),
            warn: (...args) => probes.push(['warn', ...args]),
            error: (...args) => {
                if (args.length === 1 && args[0] === probeText[2]) probes.push(['error', ...args]);
                else errors.push(args);
            }
        }, document: {
            getElementById: name => name === 'scene' ? canvas : null,
            createElement: () => ({ width: 0, height: 0, getContext: () => context() }),
            documentElement: { classList: { add: name => calls.push(['class', name]) } },
            addEventListener: (name, fn) => { events[name] = fn; }
        } });
    const run = () => {
        for (const script of scripts) {
            vm.runInContext(read(`idle/${script}`), sandbox, { filename: script });
            if (script === 'js/animate.js') for (const name of [...kept, ...skipped]) {
                const original = sandbox[name];
                sandbox[name] = (...args) => { layers.push(name); return original(...args); };
            }
        }
    };
    run();
    const tick = ms => {
        assert.equal(frames.length, 1, 'exactly one pending RAF');
        frames.shift()(ms);
        assert.equal(frames.length, 1, 'frame always rescheduled');
    };
    return { sandbox, calls, errors, probes, logs, alertLogs, gradients, frames, events, layers, tick };
}

test('idle page loads the packaged scene scripts plus the CielWin alert hook and shared overlay (A4)', () => {
    assert.deepEqual(scripts, pageScripts);
    for (const file of manifest) assert.ok(exists(file), file);
    assert.ok(exists('shared/js/alert-overlay.js'));
    // CielWin order: the scene's see-through hook, then the shared overlay, then the render loop.
    assert.ok(scripts.indexOf('js/see-through-hook.js') < scripts.indexOf('../shared/js/alert-overlay.js'));
    assert.ok(scripts.indexOf('../shared/js/alert-overlay.js') < scripts.indexOf('js/render-loop.js'));
    assert.doesNotMatch(html, /fonts|<script>|onload=/);
});

// CielWin/CielWin.App/Wallpaper/Web/idle/js/see-through-hook.js (14ff645), byte-identical once any
// additive, marked Linux block is removed.
test('idle see-through hook is the CielWin hook', () => {
    const hook = read('idle/js/see-through-hook.js');
    const stripped = hook.replace(/^\/\/ Linux port begin[^\n]*\n[\s\S]*?^\/\/ Linux port end\.\n\n/gm, '');
    assert.equal(sha256(stripped), 'bbc749b40b4f3986740a28eab229ea3dbd5344e0383c93f9e33c260766be1da3');
    assert.match(hook, /^function sceneSeeThroughLayer\(g, sceneW, sceneH, /m);
});

test('idle page CSP is the processing qrc-only policy', () => {
    const csp = page => page.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/)?.[1];
    assert.ok(csp(html));
    assert.equal(csp(html), csp(read('processing/index.html')));
    assert.match(html, /script-src qrc:; style-src qrc:; font-src qrc:;/);
    assert.doesNotMatch(html, /unsafe-|https?:|file:|\*|<script>|<style>|style="/);
});

test('idle styles paint an opaque black mini root with a transparent canvas and the alert font', () => {
    const css = read('idle/styles.css');
    assert.match(css, /html\.scene-mini \{\s*background: #000;\s*\}/);
    assert.match(css, /html\.scene-mini body,\s*html\.scene-mini #scene \{\s*background: transparent;\s*\}/);
    // A4: the one bundled alert title face (CielWin's @font-face, verbatim), nothing else external.
    assert.match(css, /@font-face \{\n  font-family: "Archivo Black";\n  src: url\("\.\.\/shared\/fonts\/ArchivoBlack-Regular\.ttf"\) format\("truetype"\);\n  font-weight: 400;\n  font-style: normal;\n  font-display: block;\n\}/);
    assert.equal(css.match(/url\(/g).length, 1);
    assert.doesNotMatch(css, /!important|https?:/);
});

test('idle render files are byte-identical to the pinned CielWin reference', () => {
    for (const [name, hash] of Object.entries(referenceSha256))
        assert.equal(sha256(read(`idle/js/${name}.js`)), hash, name);
    for (const name of linuxMiniOptimized)
        assert.match(read(`idle/js/${name}.js`), /^\/\/ Linux mini optimization begin \(O1\)/m, `${name} marks its Linux mini optimization`);
    assert.equal(read('idle/js/render-loop.js'), read('processing/js/render-loop.js'),
        'one Linux render-loop adapter content for every ported scene');
});

test('animate.js keeps the reference body and replaces only the hook index and the loop section', () => {
    const animate = read('idle/js/animate.js');
    const optimized = animate.slice(0, animate.indexOf(loopMarker));
    const prefix = stripMiniOptimizations(optimized);
    assert.notEqual(prefix, optimized, 'marked Linux mini optimization block present');
    const withoutLinux = prefix.replace(/^\/\/ Linux port begin[^\n]*\n[\s\S]*?^\/\/ Linux port end\.\n\n/m, '');
    assert.notEqual(withoutLinux, prefix, 'marked Linux block present');
    assert.equal(sha256(withoutLinux), animatePrefixWithoutHookIndexSha256);
    // The reference body stays alert-free; A4 restores CielWin's alert clock and overlay stage in
    // the Linux loop section only, as marked blocks.
    const loopSection = animate.slice(animate.indexOf(loopMarker));
    assert.doesNotMatch(code(animate.slice(0, animate.indexOf(loopMarker))),
        /alertSceneMs|renderAlertOverlay|applyFailureShake|sceneSeeThroughLayer|constellationRingStamp|CONSTELLATION_RING_INDEX|chrome\.webview|postMessage/);
    assert.match(loopSection, /const sceneMs = alertSceneMs\(nowMs\);\n\s*if \(animationStartMs === null\) animationStartMs = sceneMs;\n\s*const timeSeconds = \(sceneMs - animationStartMs\) \/ 1000;\n\s*alertSceneTime = timeSeconds;/);
    assert.match(loopSection, /\} finally \{\n\s*cadence\.end\(workStart\);\n\s*\}\n\s*\/\/ Linux port begin \(A4\)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*try \{\n\s*renderAlertOverlay\(nowMs, W, H, alertSceneTime\);\n\s*\} catch \(error\) \{\n\s*resetCanvasStateForFrame\(\);\n\s*reportRenderError\("alert-overlay", error\);/);
    assert.match(loopSection, /if \(RING_ANIMATIONS\[i\]\.name === 'constellation'\) constellationRingStamp = \{ cache: ringCaches\[i\], cx: cx, cy: cy, angle: angle \};/);
    assert.equal(loopSection.match(/\/\/ Linux port begin \(A4\)/g).length, 3);
    assert.doesNotMatch(code(loopSection), /chrome\.webview|postMessage/);
    const loop = animate.slice(animate.indexOf(loopMarker));
    assert.match(loop, /var cadence = createCadence\('idle'\);/);
    assert.equal(animate.match(/CIELINUX_SCENE_DRAW_READY_V1 idle/g).length, 1);
    const cadence = source => source.slice(source.indexOf('function createCadence'), source.indexOf('\nvar cadence'));
    assert.equal(cadence(animate), cadence(read('raphael/js/main.js')), 'same cadence helper as raphael');
    assert.doesNotMatch(read('idle/js/render-loop.js'), /alertSceneMs|renderAlertOverlay/);
    assert.match(read('idle/js/render-loop.js'), /if \(typeof applyFailureShake === "function"\) applyFailureShake\(null\);/);
});

test('host selector, allowlist, navigation, readiness and diagnostics accept idle and stay closed', () => {
    const header = read('resident-control.h');
    const parser = header.slice(header.indexOf('inline bool parseHostOptions('),
        header.indexOf('inline void configureLifetime('));
    assert.match(parser, /value == QStringLiteral\("idle"\)/);
    assert.match(parser, /!sceneSeen/);
    assert.match(parser, /\} else return false;/);
    const cpp = read('main.cpp');
    assert.match(cpp, /--scene processing\|explorer\|idle\|raphael\b/);
    // A1: the closed scene -> URL table (mini and full-size wallpaper) lives in scene-host.cpp.
    for (const fps of [30, 60]) {
        assert.ok(read('scene-host.cpp').includes(`"qrc:/idle/index.html?variant=mini&fps=${fps}"`));
        assert.ok(read('scene-host.cpp').includes(`"qrc:/idle/index.html?fps=${fps}"`));
    }
    const resources = [...cpp.match(/resourceUrls = \{([\s\S]*?)\};/)[1].matchAll(/"qrc:\/([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(resources.filter(url => url.startsWith('idle/')), manifest);
    assert.equal(new Set(resources).size, resources.length);
    const cmakeFiles = read('CMakeLists.txt').match(/PREFIX "\/" BASE scenes FILES([\s\S]*?)\)/)[1].trim().split(/\s+/).map(file => file.replace(/^scenes\//, ''));
    assert.deepEqual(cmakeFiles.filter(file => file.startsWith('idle/')), manifest);
    const resourceAllowed = url => url === selected || resources.map(r => `qrc:/${r}`).includes(url);
    assert.ok(resourceAllowed('qrc:/idle/js/animate.js'));
    // A4: the hook, the shared overlay and its font are packaged; nothing else under shared/.
    for (const url of ['qrc:/idle/js/see-through-hook.js', 'qrc:/shared/js/alert-overlay.js',
        'qrc:/shared/fonts/ArchivoBlack-Regular.ttf'])
        assert.ok(resourceAllowed(url), url);
    for (const url of ['qrc:/shared/js/render-loop.js', 'qrc:/shared/fonts/OFL.txt',
        'qrc:/idle/js/../js/main.js', 'qrc:/idle/index.html?fps=30&variant=mini', `${selected}#x`])
        assert.ok(!resourceAllowed(url), url);
    const policy = read('policy.h');
    assert.match(policy, /selectedUrl == "qrc:\/idle\/index.html\?variant=mini&fps=30" \|\|\s*selectedUrl == "qrc:\/idle\/index.html\?variant=mini&fps=60" \|\|\s*selectedUrl == "qrc:\/idle\/index.html\?fps=30" \|\|\s*selectedUrl == "qrc:\/idle\/index.html\?fps=60"\) &&\s*source == QStringLiteral\("qrc:\/idle\/js\/animate.js"\) &&\s*message == QStringLiteral\("CIELINUX_SCENE_DRAW_READY_V1 idle"\)/);
    const safe = read('diagnostics.h');
    for (const file of manifest) assert.ok(safe.includes(`"qrc:/${file}"`), file);
});

test('synthetic transport probes occur once at initialization, separately from actual errors', () => {
    const h = harness();
    assert.deepEqual(h.probes, [['info', probeText[0]], ['warn', probeText[1]], ['error', probeText[2]]]);
    h.tick(0); h.tick(34);
    assert.equal(h.probes.length, 3);
    assert.deepEqual(h.errors, []);
});

test('one mini tick draws the ring system, masks the edge and logs readiness once', () => {
    const h = harness();
    assert.ok(h.calls.some(call => call[0] === 'class' && call[1] === 'scene-mini'));
    assert.equal(h.calls.find(call => call[0] === 'canvasContext')[1].alpha, true);
    h.tick(1234);
    assert.deepEqual(h.errors, []);
    assert.deepEqual([...new Set(h.layers)], kept);
    assert.equal(h.layers.filter(name => name === 'drawCachedRingContent').length, 6, 'six rotating rings');
    assert.ok(h.calls.some(call => call[0] === 'drawImage'));
    assert.ok(h.calls.some(call => call[0] === 'fillText'), 'ring glyphs');
    const edge = h.gradients.at(-1);
    assert.equal(edge.args[5], 240 * 0.48);
    assert.deepEqual(edge.stops.at(-1), [1, 'rgba(0,0,0,0)']);
    assert.deepEqual(h.logs, ['CIELINUX_SCENE_DRAW_READY_V1 idle']);
    h.tick(1268); h.tick(1302);
    assert.deepEqual(h.logs, ['CIELINUX_SCENE_DRAW_READY_V1 idle']);
    assert.deepEqual(h.errors, []);
});

test('throwing scene resets canvas state, reports once per message and always reschedules', () => {
    const h = harness();
    const original = h.sandbox.drawEarth;
    h.sandbox.drawEarth = () => { throw new Error('failure A'); };
    h.tick(0); h.tick(34);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0][0], /^\[idle-scene\] render frame failed \(scene\)$/);
    assert.deepEqual(h.logs, []);
    h.sandbox.drawEarth = original;
    h.tick(68);
    assert.deepEqual(h.logs, ['CIELINUX_SCENE_DRAW_READY_V1 idle']);
});

test('a host show command draws the CielWin alert overlay over the finished idle scene', () => {
    const h = harness();
    h.tick(1000);
    assert.deepEqual(h.alertLogs, ['CIELINUX_ALERT_READY_V1']);
    const before = h.calls.length;
    h.sandbox.cielinuxAlertCommand('{"type":"show","tiles":["failed","warning"],"columns":2,"rows":1,"gap":8,'
        + '"workArea":{"left":0,"top":0,"width":0,"height":0},"duration":3000}');
    h.tick(1034); // failed shakes (scene clock frozen), warning starts revealing
    h.tick(2100); // both shown
    assert.deepEqual(h.errors, []);
    const texts = h.calls.slice(before).filter(call => call[0] === 'fillText').map(call => call[1]);
    assert.ok(texts.includes('FAILED') && texts.includes('WARNING'), 'both tiles drew their titles');
    assert.ok(h.layers.filter(name => name === 'drawCachedRingContent').length > 18, 'constellation ring re-stamped through the letters');
    h.tick(4100); // past the duration: done posted once, overlay stops
    assert.deepEqual(h.alertLogs, ['CIELINUX_ALERT_READY_V1', 'CIELINUX_ALERT_DONE_V1']);
    const after = h.calls.length;
    h.tick(4134);
    assert.ok(!h.calls.slice(after).some(call => call[0] === 'fillText' && call[1] === 'FAILED'));
    assert.deepEqual(h.errors, []);
});
