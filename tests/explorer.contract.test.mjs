import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { source } from './paths.mjs';

const read = name => readFileSync(source(name), 'utf8');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const exists = name => existsSync(source(name));
const html = exists('explorer/index.html') ? read('explorer/index.html') : '';
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
const renderFiles = ['config', 'math', 'glyphs', 'earth', 'rings', 'rising-sparks'];
const scriptOrder = [...renderFiles, 'see-through-hook', 'render-loop', 'animate', 'main'];
// A4: the shared alert overlay loads between the hook and the render loop (CielWin order).
const pageScripts = [...renderFiles, 'see-through-hook'].map(name => `js/${name}.js`)
    .concat(['../shared/js/alert-overlay.js', 'js/render-loop.js', 'js/animate.js', 'js/main.js']);
const manifest = ['explorer/index.html', 'explorer/styles.css', ...scriptOrder.map(name => `explorer/js/${name}.js`)];
const selected = 'qrc:/explorer/index.html?variant=mini&fps=30';
// Pinned CielWin cebb941^ (4a83e62) Wallpaper/Web/explorer/js sources: the working tree no longer has them.
const referenceSha256 = {
    // Re-pinned after old-name→CielWin comment rename (text-only); was d14e9c85133be01687e2dc5e992e8966a1fe1d1107a0a4fe2c880ad75ebc07c4
    config: 'a78dd46f74c8063a1134f015a35198bb5f2e17da7e08f9f0cf6b19eddd2c0044',
    math: 'fb643e65a3677d4b4f34b251d182ae08985ff323f1dcbff4adcf8ae47d1fd220',
    glyphs: '99ad743bff502854b72af11edc72a03aff14d5fdc552153dc445677696a4fc55',
    // Linux mini optimization (O1 + O1b, odd/tasks/mini-scene-optimization.md); CielWin reference: 85a55b1bda1ec79011b4a5ac2a81c3eddc73a979f657fc509e3b529fff3b8e3f
    earth: 'c7e2bbc5c6be17389d27632604d14679b8a8b0ada0f063447ddbd622136a822e',
    // Linux mini optimization (O1 + O1b, odd/tasks/mini-scene-optimization.md); CielWin reference: 085d434f797d114b3084988494e37e9aaf9939cf1100dd0a3f19ecd1f9e6962b
    rings: '5fbbf2e05ce270ae388f41ec83513108963577cdf1ce689cdac925be8588f68f',
    // Linux mini optimization (O1 + O1b + O1c P1 + O1d, odd/tasks/mini-scene-optimization.md); O1c P1: b8305ad6ed0d8b3a1d6697a4b458f6642e2049d8f74cb21d57def777ee1aad71; O1b: af1b6a3ebbb98ef7006839ab03f9967c6ae6191d98a113bfe0fde54a31930211; CielWin reference: 8103d08efe541a6853bd63f35961137a18f009273821ed40d995667c44a9d39a
    'rising-sparks': '2ad6813e392bb5a948a9fa3f30c49364a190fb7cc20979fa25dd685f1ce24201',
    // Re-pinned after old-name→CielWin comment rename (text-only); was 2480a1ae00f32a88b8c1887b638532dcce28acff428d07ee5ba720f1ceb88e69
    main: '2eee53ac0f3b37ec123445838048f7c2cef4a37bbd04e26d2037fe474cd49ae0',
};
// Reference animate.js before its "Main animation loop" section (unchanged in the port).
// Re-pinned after old-name→CielWin comment rename (text-only); was 946c401b8fab33a827e4258225c9cd1b5673cb4ef7d01feda82d04a9278420f1
const animatePrefixSha256 = '8392aa900ebff87c567bff80a22a1c995ca3fa30f430cfb2bf1b4180fce1c93a';
const loopMarker = '// --- Main animation loop';
// Files that deliberately diverge from the CielWin reference for the Linux mini optimization (O1).
const linuxMiniOptimized = ['earth', 'rings', 'rising-sparks'];
// animate.js's O1 change is one self-contained marked block; stripping it restores the reference text.
const stripMiniOptimizations = source => source.replace(/^[ \t]*\/\/ Linux mini optimization begin[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux mini optimization end\.\n/gm, '');
const kept = ['drawDiscBorder', 'drawCachedRingContent', 'drawInnerRing', 'drawEarth', 'drawBlueRingTint',
    'drawChromaticGlowAnimated', 'drawRisingSparks', 'drawMiniRingBases', 'applyMiniEdgeFade'];
const skipped = ['drawStarfield', 'drawCombinedLightingMask', 'drawBlueLayer', 'drawVignette'];
const probeText = ['CIELINUX_DIAGNOSTICS_JS_INFO synthetic transport probe',
    'CIELINUX_DIAGNOSTICS_JS_WARN synthetic transport probe',
    'CIELINUX_DIAGNOSTICS_JS_ERROR synthetic transport probe'];
const code = source => source.replace(/^[ \t]*\/\/[^\n]*$/gm, '');

// Recording API mocks run the real packaged scripts; they do not model pixels or text shaping.
function harness({ width = 240, height = 240 } = {}) {
    const calls = [], errors = [], probes = [], logs = [], alertLogs = [], gradients = [], frames = [], events = {}, layers = [], composites = [];
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
            set(target, name, value) {
                if (name === 'globalCompositeOperation') composites.push(value);
                target[name] = value; return true;
            }
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
            vm.runInContext(read(`explorer/${script}`), sandbox, { filename: script });
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
    return { sandbox, calls, errors, probes, logs, alertLogs, gradients, frames, events, layers, composites, tick,
        evaluate: code => vm.runInContext(code, sandbox) };
}

test('explorer page loads the packaged scene scripts plus the CielWin alert hook and shared overlay (A4)', () => {
    assert.deepEqual(scripts, pageScripts);
    for (const file of manifest) assert.ok(exists(file), file);
    assert.ok(exists('shared/js/alert-overlay.js'));
    // CielWin order: the scene's see-through hook, then the shared overlay, then the render loop.
    assert.ok(scripts.indexOf('js/see-through-hook.js') < scripts.indexOf('../shared/js/alert-overlay.js'));
    assert.ok(scripts.indexOf('../shared/js/alert-overlay.js') < scripts.indexOf('js/render-loop.js'));
    assert.doesNotMatch(html, /fonts|<script>|onload=/);
});

// CielWin/CielWin.App/Wallpaper/Web/explorer/js/see-through-hook.js (14ff645), byte-identical once any
// additive, marked Linux block is removed.
test('explorer see-through hook is the CielWin hook', () => {
    const hook = read('explorer/js/see-through-hook.js');
    const stripped = hook.replace(/^\/\/ Linux port begin[^\n]*\n[\s\S]*?^\/\/ Linux port end\.\n\n/gm, '');
    assert.equal(sha256(stripped), '4ee5d0bfe8a7d148f411842c48eaf25517f12f3270f91a3d298b7c12df9e62f2');
    assert.match(hook, /^function sceneSeeThroughLayer\(g, sceneW, sceneH, /m);
});

test('explorer page CSP is the processing qrc-only policy', () => {
    const csp = page => page.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/)?.[1];
    assert.ok(csp(html));
    assert.equal(csp(html), csp(read('processing/index.html')));
    assert.match(html, /script-src qrc:; style-src qrc:; font-src qrc:;/);
    assert.doesNotMatch(html, /unsafe-|https?:|file:|\*|<script>|<style>|style="/);
});

test('explorer styles paint an opaque black mini root with a transparent canvas and the alert font', () => {
    const css = read('explorer/styles.css');
    assert.match(css, /html\.scene-mini \{\s*background: #000;\s*\}/);
    assert.match(css, /html\.scene-mini body,\s*html\.scene-mini #scene \{\s*background: transparent;\s*\}/);
    // A4: the one bundled alert title face (CielWin's @font-face, verbatim), nothing else external.
    assert.match(css, /@font-face \{\n  font-family: "Archivo Black";\n  src: url\("\.\.\/shared\/fonts\/ArchivoBlack-Regular\.ttf"\) format\("truetype"\);\n  font-weight: 400;\n  font-style: normal;\n  font-display: block;\n\}/);
    assert.equal(css.match(/url\(/g).length, 1);
    assert.doesNotMatch(css, /!important|https?:/);
});

test('explorer render files are byte-identical to the pinned CielWin reference', () => {
    for (const [name, hash] of Object.entries(referenceSha256))
        assert.equal(sha256(read(`explorer/js/${name}.js`)), hash, name);
    for (const name of linuxMiniOptimized)
        assert.match(read(`explorer/js/${name}.js`), /^\/\/ Linux mini optimization begin \(O1\)/m, `${name} marks its Linux mini optimization`);
    assert.equal(read('explorer/js/render-loop.js'), read('processing/js/render-loop.js'),
        'one Linux render-loop adapter content for every ported scene');
});

test('animate.js keeps the reference body and replaces only the loop section', () => {
    const animate = read('explorer/js/animate.js');
    const prefix = animate.slice(0, animate.indexOf(loopMarker));
    assert.notEqual(stripMiniOptimizations(prefix), prefix, 'marked Linux mini optimization block present');
    assert.equal(sha256(stripMiniOptimizations(prefix)), animatePrefixSha256);
    // The reference body stays alert-free; A4 restores CielWin's alert clock and overlay stage in
    // the Linux loop section only, as marked blocks.
    const loopSection = animate.slice(animate.indexOf(loopMarker));
    assert.doesNotMatch(code(animate.slice(0, animate.indexOf(loopMarker))),
        /alertSceneMs|renderAlertOverlay|applyFailureShake|sceneSeeThroughLayer|chrome\.webview|postMessage/);
    assert.match(loopSection, /const sceneMs = alertSceneMs\(nowMs\);\n\s*if \(animationStartMs === null\) animationStartMs = sceneMs;\n\s*const timeSeconds = \(sceneMs - animationStartMs\) \/ 1000;\n\s*alertSceneTime = timeSeconds;/);
    assert.match(loopSection, /\} finally \{\n\s*cadence\.end\(workStart\);\n\s*\}\n\s*\/\/ Linux port begin \(A4\)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*try \{\n\s*renderAlertOverlay\(nowMs, W, H, alertSceneTime\);\n\s*\} catch \(error\) \{\n\s*resetCanvasStateForFrame\(\);\n\s*reportRenderError\("alert-overlay", error\);/);
    assert.equal(loopSection.match(/\/\/ Linux port begin \(A4\)/g).length, 2);
    assert.doesNotMatch(code(loopSection), /chrome\.webview|postMessage/);
    const loop = animate.slice(animate.indexOf(loopMarker));
    assert.match(loop, /var cadence = createCadence\('explorer'\);/);
    assert.equal(animate.match(/CIELINUX_SCENE_DRAW_READY_V1 explorer/g).length, 1);
    const cadence = source => source.slice(source.indexOf('function createCadence'), source.indexOf('\nvar cadence'));
    assert.equal(cadence(animate), cadence(read('raphael/js/main.js')), 'same cadence helper as raphael');
    assert.doesNotMatch(read('explorer/js/render-loop.js'), /alertSceneMs|renderAlertOverlay/);
    assert.match(read('explorer/js/render-loop.js'), /if \(typeof applyFailureShake === "function"\) applyFailureShake\(null\);/);
});

test('host selector, allowlist, navigation, readiness and diagnostics accept explorer and stay closed', () => {
    const header = read('resident-control.h');
    const parser = header.slice(header.indexOf('inline bool parseHostOptions('),
        header.indexOf('inline void configureLifetime('));
    assert.match(parser, /value == QStringLiteral\("explorer"\)/);
    assert.match(parser, /!sceneSeen/);
    assert.match(parser, /\} else return false;/);
    const cpp = read('main.cpp');
    assert.match(cpp, /--scene processing\|explorer\|idle\|raphael\b/);
    // A1: the closed scene -> URL table (mini and full-size wallpaper) lives in scene-host.cpp.
    for (const fps of [30, 60]) {
        assert.ok(read('scene-host.cpp').includes(`"qrc:/explorer/index.html?variant=mini&fps=${fps}"`));
        assert.ok(read('scene-host.cpp').includes(`"qrc:/explorer/index.html?fps=${fps}"`));
    }
    const resources = [...cpp.match(/resourceUrls = \{([\s\S]*?)\};/)[1].matchAll(/"qrc:\/([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(resources.filter(url => url.startsWith('explorer/')), manifest);
    assert.equal(new Set(resources).size, resources.length);
    const cmakeFiles = read('CMakeLists.txt').match(/PREFIX "\/" BASE scenes FILES([\s\S]*?)\)/)[1].trim().split(/\s+/).map(file => file.replace(/^scenes\//, ''));
    assert.deepEqual(cmakeFiles.filter(file => file.startsWith('explorer/')), manifest);
    const resourceAllowed = url => url === selected || resources.map(r => `qrc:/${r}`).includes(url);
    assert.ok(resourceAllowed('qrc:/explorer/js/animate.js'));
    // A4: the hook, the shared overlay and its font are packaged; nothing else under shared/.
    for (const url of ['qrc:/explorer/js/see-through-hook.js', 'qrc:/shared/js/alert-overlay.js',
        'qrc:/shared/fonts/ArchivoBlack-Regular.ttf'])
        assert.ok(resourceAllowed(url), url);
    for (const url of ['qrc:/shared/js/render-loop.js', 'qrc:/shared/fonts/OFL.txt',
        'qrc:/explorer/js/../js/main.js', 'qrc:/explorer/index.html?fps=30&variant=mini', `${selected}#x`])
        assert.ok(!resourceAllowed(url), url);
    const policy = read('policy.h');
    assert.match(policy, /selectedUrl == "qrc:\/explorer\/index.html\?variant=mini&fps=30" \|\|\s*selectedUrl == "qrc:\/explorer\/index.html\?variant=mini&fps=60" \|\|\s*selectedUrl == "qrc:\/explorer\/index.html\?fps=30" \|\|\s*selectedUrl == "qrc:\/explorer\/index.html\?fps=60"\) &&\s*source == QStringLiteral\("qrc:\/explorer\/js\/animate.js"\) &&\s*message == QStringLiteral\("CIELINUX_SCENE_DRAW_READY_V1 explorer"\)/);
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

test('one mini tick draws the blue ring system and 360 rising sparks, masks the edge and logs readiness once', () => {
    const h = harness();
    assert.ok(h.calls.some(call => call[0] === 'class' && call[1] === 'scene-mini'));
    assert.equal(h.calls.find(call => call[0] === 'canvasContext')[1].alpha, true);
    h.tick(1234);
    assert.deepEqual(h.errors, []);
    assert.deepEqual([...new Set(h.layers)], kept);
    assert.equal(h.layers.filter(name => name === 'drawCachedRingContent').length, 6, 'six rotating rings');
    assert.ok(h.calls.some(call => call[0] === 'drawImage'));
    assert.ok(h.calls.some(call => call[0] === 'fillText'), 'ring glyphs');
    // Rising sparks stay identical to Windows: all 360 slots, additive blending, no Linux limit.
    assert.equal(h.evaluate('RISING_SPARK_COUNT'), 360);
    assert.ok(h.composites.includes('lighter'));
    // O1c P1: mature mini sparks are two streak-atlas sprites each; young ones keep strokes.
    assert.ok(h.calls.filter(call => call[0] === 'drawImage' && call[1] === h.evaluate('risingSparkAtlas').canvas).length > 100, 'spark streak sprites drawn');
    const edge = h.gradients.at(-1);
    assert.equal(edge.args[5], 240 * 0.48);
    assert.deepEqual(edge.stops.at(-1), [1, 'rgba(0,0,0,0)']);
    assert.deepEqual(h.logs, ['CIELINUX_SCENE_DRAW_READY_V1 explorer']);
    h.tick(1268); h.tick(1302);
    assert.deepEqual(h.logs, ['CIELINUX_SCENE_DRAW_READY_V1 explorer']);
    assert.deepEqual(h.errors, []);
});

test('throwing scene resets canvas state, reports once per message and always reschedules', () => {
    const h = harness();
    const original = h.sandbox.drawEarth;
    h.sandbox.drawEarth = () => { throw new Error('failure A'); };
    h.tick(0); h.tick(34);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0][0], /^\[explorer-scene\] render frame failed \(scene\)$/);
    assert.deepEqual(h.logs, []);
    h.sandbox.drawEarth = original;
    h.tick(68);
    assert.deepEqual(h.logs, ['CIELINUX_SCENE_DRAW_READY_V1 explorer']);
});

test('a host show command draws the CielWin alert overlay over the finished explorer scene', () => {
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
    assert.ok(h.layers.filter(name => name === 'drawRisingSparks').length > 3, 'rising sparks redrawn through the letters');
    h.tick(4100); // past the duration: done posted once, overlay stops
    assert.deepEqual(h.alertLogs, ['CIELINUX_ALERT_READY_V1', 'CIELINUX_ALERT_DONE_V1']);
    const after = h.calls.length;
    h.tick(4134);
    assert.ok(!h.calls.slice(after).some(call => call[0] === 'fillText' && call[1] === 'FAILED'));
    assert.deepEqual(h.errors, []);
});
