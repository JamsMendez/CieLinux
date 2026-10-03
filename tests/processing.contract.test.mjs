import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { SRC, source } from './paths.mjs';

const read = name => readFileSync(source(name), 'utf8');
const html = read('processing/index.html');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
const renderFiles = ['config', 'math', 'nebula', 'sphere', 'scene-data', 'sprites', 'layers'];
const copied = renderFiles.filter(name => name !== 'nebula');
const kept = ['drawSegmentedSphere', 'drawAtomicOrbits', 'drawOrbitBlocks',
    'drawCentralOctagon', 'drawTriangularPrism', 'drawPerspectiveRays', 'drawCentralCore'];
const skipped = ['drawSoftOvalFields', 'drawStars', 'drawRadialStreaks', 'drawLensFlares',
    'drawChromaticSideLoops', 'drawFilmGrain', 'drawVignette'];

// Recording API mocks exercise real destination scripts, not native pixels or shader execution.
function harness({ webgl = true, search = '?variant=mini&fps=30', dpr = 3,
    width = 240.25, height = 239.75, configureGl = () => {} } = {}) {
    const calls = [], errors = [], probes = [], gradients = [], frames = [], events = {}, layers = [], alertLogs = [];
    const context = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
    const stack = [];
    for (const name of ['setTransform', 'clearRect', 'translate', 'scale', 'rotate',
        'beginPath', 'arc', 'ellipse', 'fill', 'stroke', 'fillRect', 'strokeRect',
        'moveTo', 'lineTo', 'closePath', 'drawImage', 'quadraticCurveTo', 'bezierCurveTo',
        'rect', 'clip', 'setLineDash', 'fillText']) {
        context[name] = (...args) => calls.push([name, ...args]);
    }
    context.measureText = text => ({ width: String(text).length * 10 }); // A4 alert titles
    context.save = () => { calls.push(['save']); stack.push([context.globalAlpha, context.globalCompositeOperation]); };
    context.restore = () => {
        calls.push(['restore']);
        const saved = stack.pop();
        if (saved) [context.globalAlpha, context.globalCompositeOperation] = saved;
    };
    for (const name of ['createRadialGradient', 'createLinearGradient', 'createConicGradient']) {
        context[name] = (...args) => {
            const gradient = { name, args, stops: [], addColorStop(stop, color) { this.stops.push([stop, color]); } };
            gradients.push(gradient);
            return gradient;
        };
    }
    const gl = {};
    for (const name of ['VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS',
        'ARRAY_BUFFER', 'STATIC_DRAW', 'COLOR_BUFFER_BIT', 'FLOAT', 'TRIANGLES']) gl[name] = name;
    for (const name of ['createShader', 'createProgram', 'createBuffer']) gl[name] = () => ({});
    gl.getShaderParameter = gl.getProgramParameter = () => true;
    gl.getUniformLocation = (_, name) => name;
    gl.getAttribLocation = () => 0;
    for (const name of ['shaderSource', 'compileShader', 'deleteShader', 'attachShader',
        'linkProgram', 'deleteProgram', 'bindBuffer', 'bufferData', 'viewport', 'clearColor',
        'clear', 'useProgram', 'enableVertexAttribArray', 'vertexAttribPointer', 'uniform2f',
        'uniform1f', 'drawArrays']) gl[name] = (...args) => calls.push([name, ...args]);
    configureGl(gl);
    const bounds = { width, height };
    const canvas = { width: 0, height: 0, style: {}, getContext: (_, options) => {
        calls.push(['canvasContext', options]); return context;
    }, getBoundingClientRect: () => bounds };
    const nebula = { width: 0, height: 0, style: {}, getContext: (_, options) => {
        calls.push(['webglContext', options]); return webgl ? gl : null;
    }, addEventListener: (name, fn) => { events[name] = fn; } };
    const window = { devicePixelRatio: dpr, innerWidth: width, innerHeight: height,
        WebGLRenderingContext: webgl ? function () {} : undefined,
        requestAnimationFrame: fn => frames.push(fn),
        addEventListener: (name, fn) => { events[name] = fn; } };
    const sandbox = vm.createContext({ window, location: { search, hash: '' }, URLSearchParams,
        console: {
            // A4: only the overlay's bridge markers are recorded here.
            log: (...args) => { if (String(args[0]).startsWith('CIELINUX_ALERT_')) alertLogs.push(args.join(' ')); },
            info: (...args) => probes.push(['info', ...args]),
            warn: (...args) => probes.push(['warn', ...args]),
            error: (...args) => {
                if (args.length === 1 && args[0] === 'CIELINUX_DIAGNOSTICS_JS_ERROR synthetic transport probe')
                    probes.push(['error', ...args]);
                else errors.push(args);
            }
        }, document: {
            getElementById: name => name === 'scene' ? canvas : nebula,
            // Offscreen canvases share the recording context; each knows its own element (A4: the
            // alert overlay reads layer.canvas, as on a real CanvasRenderingContext2D).
            createElement: () => {
                const element = { width: 0, height: 0 };
                element.getContext = () => Object.assign(Object.create(context), { canvas: element });
                return element;
            },
            documentElement: { classList: { add: name => calls.push(['class', name]) } },
            addEventListener: (name, fn) => { events[name] = fn; }
        } });
    for (const script of scripts) vm.runInContext(read(`processing/${script}`), sandbox, { filename: script });
    for (const name of [...kept, ...skipped]) {
        const original = sandbox[name];
        sandbox[name] = (...args) => { layers.push([name, ...args]); return original(...args); };
    }
    const tick = ms => {
        assert.equal(frames.length, 1, 'exactly one pending RAF');
        frames.shift()(ms);
        assert.equal(frames.length, 1, 'frame always rescheduled');
    };
    return { sandbox, calls, errors, probes, alertLogs, gradients, frames, events, layers, context,
        canvas, nebula, bounds, window, gl, tick,
        evaluate: code => vm.runInContext(code, sandbox) };
}

test('synthetic transport probes occur once at initialization, separately from actual errors', () => {
    const h = harness();
    assert.deepEqual(h.probes, [
        ['info', 'CIELINUX_DIAGNOSTICS_JS_INFO synthetic transport probe'],
        ['warn', 'CIELINUX_DIAGNOSTICS_JS_WARN synthetic transport probe'],
        ['error', 'CIELINUX_DIAGNOSTICS_JS_ERROR synthetic transport probe']
    ]);
    h.tick(0); h.tick(34);
    assert.equal(h.probes.length, 3);
    assert.equal(h.errors.length, 0);
    h.sandbox.console.error('actual error');
    assert.deepEqual(h.errors, [['actual error']]);
});

// Pinned CielWin c06df99 Wallpaper/Web/processing/js sources (the copied revision); the
// CielWin working tree no longer has them (deleted in cebb941). sphere, sprites and layers carry the
// O2 Linux mini optimizations (odd/tasks/mini-scene-optimization.md): their pins are the optimized
// files, with the CielWin reference hash beside each; processing-optimization.contract.test.mjs
// strips the marked blocks back to those reference hashes.
const referenceSha256 = {
    // Re-pinned after old-name→CielWin comment rename (text-only); was 3b0f1e6130112af7b2b1d4f63227815275558229e6eb3a4037ed99a23e328b11
    config: '7bc8567353f200d0d96942d452c321bc614e9fab8be2d05c58ec5c57f38ae4d2',
    math: '10951705adf6a91c232909443cc34fb4b54b185c2e219508330aed2e38dfc20f',
    // Linux mini optimization (O2); CielWin reference: 0ae7e1443c5da47f92a0434adbd87bc1a7ef1a59a69f8f0a6bb55a1dc4788bf8
    sphere: 'daf83b2c906eb0ed5bf1bf528f4a761f62190f98c9e6a29f8c0df82480c90304',
    'scene-data': 'de7018c6f1079238acdd70db64dcffbae719099df5c4ded97b75c07e4d19451b',
    // Linux mini optimization (O2; B5 wallpaper glow index); was e32fc55627878ee0e83e3496d41a99c72d26a65eab93beefe1acb88f74460255;
    // CielWin reference: cd1c36857f4504393befb6c53b12e562d458f461860b1d366f4b24c9b5b0094b
    sprites: '62eac9e5a312388493bed26d413b0f427d83324a67893b6feacee47c9502946a',
    // Linux mini optimization (O2, O2b; B5 wallpaper exact-stream layers); was 6fc77931949e0dfceadbbecd96f11370b2c2bb8816fb58fa7f769af315f428b0;
    // CielWin reference: 84cce57bef22a17d9a41f4f9b91cd7c7bfeaa0f485ed082a76643aa7f0c3a405
    layers: '4af337720deb49ec9664ed42721326d8896b39baeb65e02189d27da51888cf35',
    nebula: '0691660c5ca8a4fe9ff34dbf0954beaddd1e5bcbb02d16175b51678c9dc17162',
};
const sha256 = text => createHash('sha256').update(text).digest('hex');

test('six render files match their pinned hashes (three reference copies, three O2-optimized)', () => {
    assert.deepEqual(copied, Object.keys(referenceSha256).filter(name => name !== 'nebula'));
    for (const name of copied) assert.equal(sha256(read(`processing/js/${name}.js`)), referenceSha256[name], name);
});

test('HTML dependencies match the finite packaged browser manifest', () => {
    // A4: the CielWin alert hook, then the shared overlay, before the render loop (CielWin order).
    assert.deepEqual(scripts, [...renderFiles, 'see-through-hook'].map(name => `js/${name}.js`)
        .concat(['../shared/js/alert-overlay.js', 'js/render-loop.js', 'js/main.js']));
    const shared = ['shared/js/alert-overlay.js', 'shared/fonts/ArchivoBlack-Regular.ttf'];
    const manifest = ['processing/index.html', 'processing/styles.css',
        ...scripts.filter(name => name.startsWith('js/')).map(name => `processing/${name}`), ...shared];
    const cpp = read('main.cpp');
    const resourceBlock = cpp.match(/resourceUrls = \{([\s\S]*?)\};/)[1];
    const urls = [...resourceBlock.matchAll(/"qrc:\/([^"]+)"/g)].map(match => match[1]);
    // Other ported scenes own their entries (<scene>.contract.test.mjs).
    const ported = /^(?:raphael|idle|explorer)\//;
    assert.deepEqual(urls.filter(url => !ported.test(url)), manifest);
    const cmakeFiles = read('CMakeLists.txt').match(/PREFIX "\/" BASE scenes FILES([\s\S]*?)\)/)[1].trim().split(/\s+/).map(file => file.replace(/^scenes\//, ''));
    assert.deepEqual(cmakeFiles.filter(file => !ported.test(file)).sort(), [...manifest].sort());
    assert.doesNotMatch(read('CMakeLists.txt'), /GLOB|CielWin/);
    assert.match(html, /script-src qrc:; style-src qrc:; font-src qrc:;/);
    for (const directive of ["default-src 'none'", "connect-src 'none'", "base-uri 'none'",
        "form-action 'none'", "frame-src 'none'"]) assert.ok(html.includes(directive));
    assert.doesNotMatch(html, /unsafe-|https?:|file:|\*/);
    // A4: one bundled font face for the alert title, nothing else external.
    const css = read('processing/styles.css');
    // A4: the one bundled alert title face (CielWin's @font-face, verbatim), nothing else external.
    assert.match(css, /@font-face \{\n  font-family: "Archivo Black";\n  src: url\("\.\.\/shared\/fonts\/ArchivoBlack-Regular\.ttf"\) format\("truetype"\);\n  font-weight: 400;\n  font-style: normal;\n  font-display: block;\n\}/);
    assert.equal(css.match(/url\(/g).length, 1);
    assert.doesNotMatch(css, /!important|https?:/);
    for (const name of ['main', 'render-loop']) assert.doesNotMatch(read(`processing/js/${name}.js`),
        /chrome\.webview|postMessage/i);
    const hook = read('processing/js/see-through-hook.js');
    assert.equal(sha256(hook), 'ff0dc530ca117e5cda5849ebb2b0520b7517dd0385fcf27c7c2f30558037bd05', 'CielWin processing see-through hook, verbatim');
});

test('main.js restores the CielWin alert clock and overlay stage (A4)', () => {
    const main = read('processing/js/main.js');
    assert.match(main, /const sceneMs = alertSceneMs\(ms\);\n\s*renderNebula\(sceneMs\);\n\s*const p = animationProgress\(sceneMs\);\n\s*alertSceneTime = p;/);
    assert.match(main, /const pulse = octagonPulse\(sceneMs\);/);
    assert.match(main, /\} finally \{\n\s*cadence\.end\(workStart\);\n\s*\}\n\s*\/\/ Linux port begin \(A4\)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*try \{\n\s*renderAlertOverlay\(ms, W, H, alertSceneTime\);\n\s*\} catch \(error\) \{\n\s*resetCanvasStateForFrame\(\);\n\s*reportRenderError\("alert-overlay", error\);/);
    assert.match(read('processing/js/render-loop.js'), /if \(typeof applyFailureShake === "function"\) applyFailureShake\(null\);/);
});

test('selector is closed before Qt initialization; navigation differs from resources', () => {
    const cpp = read('main.cpp');
    const before = cpp.slice(0, cpp.indexOf('QtWebEngineQuick::initialize()'));
    // D2 moved argument parsing into resident-control.h (parseHostOptions).
    const header = read('resident-control.h');
    const parser = header.slice(header.indexOf('inline bool parseHostOptions('),
        header.indexOf('inline void configureLifetime('));
    assert.match(header, /QString scene = QStringLiteral\("processing"\);/);
    assert.match(parser, /!sceneSeen/);
    assert.match(parser, /!outputSeen/);
    assert.match(parser, /i < argc; \+\+i/);
    assert.match(parser, /std::strcmp\(argv\[i - 1\], "--duration"\) == 0 && !durationSeen/);
    assert.match(parser, /std::strcmp\(argv\[i\], "15"\) == 0 \|\|\s*std::strcmp\(argv\[i\], "120"\) == 0/);
    assert.match(parser, /durationSeen = true/);
    assert.match(parser, /if \(i \+ 1 >= argc\) return false;/);
    assert.match(parser, /\} else return false;/);
    assert.match(parser, /value == QStringLiteral\("processing"\) \|\| value == QStringLiteral\("raphael"\)/);
    assert.doesNotMatch(parser, /--help|--fps|--url|--query/);
    const main = cpp.slice(cpp.indexOf('int main('));
    assert.match(main, /if \(!parseHostOptions\(argc, argv, options\)\) \{\s*std::cerr << "Unsupported, missing or duplicate arguments\\n";\s*return 2;/);
    assert.ok(main.indexOf('parseHostOptions(argc, argv, options)') < main.indexOf('const QUrl sceneUrl'));
    for (const boundary of ['!hasLayerShell()', 'QtWebEngineQuick::initialize()',
        'QApplication app(argc, argv)', 'startupDiagnostics.startup()']) {
        assert.ok(main.indexOf('const QUrl sceneUrl') < main.indexOf(boundary), boundary);
    }
    const help = main.slice(0, main.indexOf('HostOptions options;'));
    assert.match(help, /argc == 2 && std::strcmp\(argv\[1\], "--help"\) == 0/);
    assert.match(help, /return 0/);
    // A1: the URL table moved to scene-host.cpp; main.cpp resolves it before Qt initialization.
    assert.match(before, /const QUrl sceneUrl\(sceneUrlFor\(scene, mode\)\);/);
    assert.match(read('scene-host.cpp'), /\{"processing", "qrc:\/processing\/index.html\?variant=mini&fps=30", "qrc:\/processing\/index.html\?fps=60"\}/);
    assert.match(read('policy.h'), /url.toEncoded\(\) == selectedUrl/);
    assert.match(cpp, /encoded != selectedUrl && !resourceUrls.contains\(encoded\)/);
    // Model only the literal encoded comparison contract, not Qt URL parsing at runtime.
    const resources = [...cpp.match(/resourceUrls = \{([\s\S]*?)\};/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const selected = 'qrc:/processing/index.html?variant=mini&fps=30';
    const resourceAllowed = url => url === selected || resources.includes(url);
    const navigationAllowed = url => url === selected;
    assert.ok(resourceAllowed('qrc:/processing/js/config.js'));
    assert.ok(!navigationAllowed('qrc:/processing/js/config.js'));
    assert.ok(!navigationAllowed('qrc:/view.qml'));
    for (const url of ['qrc:/processing/js/config.js?x=1', 'qrc:/processing/js/config.js#x',
        'qrc://host/processing/js/config.js', 'qrc://host:80/processing/js/config.js',
        'qrc:/processing/js/../js/config.js', 'qrc:/processing/js/%63onfig.js',
        'qrc:/view.qml', 'file:/scene.html', 'https://example.org/', 'data:text/html,x',
        'qrc:/processing/index.html?fps=30&variant=mini', `${selected}#x`]) {
        assert.ok(!resourceAllowed(url), url);
        assert.ok(!navigationAllowed(url), url);
    }
});

test('actual mini rendering keeps structures and masks, skips backgrounds', () => {
    const h = harness();
    h.tick(1234);
    assert.deepEqual(h.layers.map(call => call[0]), kept);
    assert.equal(h.errors.length, 0);
    assert.ok(h.calls.some(call => call[0] === 'clearRect'));
    assert.ok(h.calls.some(call => call[0] === 'drawImage'));
    const base = h.gradients.find(g => g.stops[0]?.[1] === 'rgba(1,4,10,0.9)');
    assert.ok(base);
    assert.equal(base.stops[1][0], 0.32 / 0.40);
    assert.equal(base.stops.at(-1)[1], 'rgba(1,4,10,0)');
    const edge = h.gradients.at(-1);
    assert.equal(edge.args[5], 239.75 * 0.48);
    assert.deepEqual(edge.stops.at(-1), [1, 'rgba(0,0,0,0)']);
    assert.equal(edge.stops[1][0], 0.41 / 0.48);
    assert.equal(h.evaluate('MINI_POLYGON_STROKE_PX'), 0.75);
    assert.equal(h.evaluate('structurePx(6)'), 6 * 239.75 / 1440);
    assert.equal(h.evaluate('MINI_FOLDING_BAND_WIDTH_FACTOR'), 0.35);
});

test('WebGL receives raw timestamp uniforms, mini flag and transparent clear', () => {
    const h = harness();
    h.tick(1234);
    assert.equal(h.calls.find(c => c[0] === 'webglContext')[1].alpha, true);
    assert.deepEqual(h.calls.find(c => c[0] === 'clearColor'), ['clearColor', 0, 0, 0, 0]);
    assert.ok(h.calls.some(c => c[0] === 'uniform1f' && c[1] === 'u_mini' && c[2] === 1));
    const rotation = h.calls.find(c => c[0] === 'uniform1f' && c[1] === 'u_rotation')[2];
    assert.equal(rotation, ((1234 / 1000 / 30 * (16 / 5)) % 1) * Math.PI * 2);
    assert.equal(h.calls.find(c => c[0] === 'uniform1f' && c[1] === 'u_drift')[2],
        ((1234 / 1000 / 24) % 1) * Math.PI * 2);
    assert.match(h.evaluate('NEBULA_FRAGMENT_SHADER'), /vec4\(green \* alpha, alpha\)/);
    assert.match(h.evaluate('NEBULA_FRAGMENT_SHADER'), /smoothstep\(0.5, 0.9, squareRadius\)/);
});

test('missing WebGL, context loss and restoration preserve Canvas2D scheduling', () => {
    const unavailable = harness({ webgl: false });
    unavailable.tick(0);
    unavailable.tick(34);
    assert.equal(unavailable.layers.length, kept.length * 2);
    assert.equal(unavailable.errors.length, 1);
    assert.match(unavailable.errors[0][0], /unavailable: WebGL API unavailable/);
    const h = harness();
    h.tick(0);
    const draws = h.calls.filter(c => c[0] === 'drawArrays').length;
    let prevented = false;
    h.events.webglcontextlost({ preventDefault() { prevented = true; } });
    h.tick(34);
    assert.ok(prevented);
    assert.equal(h.calls.filter(c => c[0] === 'drawArrays').length, draws);
    assert.equal(h.layers.length, kept.length * 2);
    h.events.webglcontextrestored();
    h.tick(67);
    assert.equal(h.calls.filter(c => c[0] === 'drawArrays').length, draws + 1);
});

test('reference deadline scheduler converges to 30FPS at multiple refresh rates and resyncs hitches', () => {
    for (const hz of [60, 75, 144, 164]) {
        const h = harness({ webgl: false });
        const timestamps = [];
        h.sandbox.render = ms => { timestamps.push(ms); h.sandbox.scheduleFrame(h.sandbox.render); };
        // Replace expensive rendering while exercising the already-pending real scheduler callback.
        h.frames.length = 0;
        h.sandbox.scheduleFrame(h.sandbox.render);
        for (let frame = 0; frame < hz * 10; frame++) h.tick(frame * 1000 / hz);
        assert.ok(Math.abs(timestamps.length - 300) <= 1, `${hz}Hz: ${timestamps.length}`);
        assert.ok(timestamps.every(ms => Math.abs(ms * hz / 1000 - Math.round(ms * hz / 1000)) < 1e-8));
    }
    const h = harness({ webgl: false });
    h.tick(0);
    h.tick(10);
    assert.equal(h.layers.length, kept.length);
    h.tick(1000);
    assert.equal(h.evaluate('wallpaperNextDueFrameTimeMs'), 1000 + 1000 / 30);
    h.tick(1006);
    assert.equal(h.layers.length, kept.length * 2);
    h.tick(1034);
    assert.equal(h.layers.length, kept.length * 3);
});

test('fractional CSS sizes use capped effective backing transforms and event-only resize', () => {
    const h = harness();
    assert.equal(h.canvas.width, Math.round(240.25 * 2));
    assert.equal(h.canvas.height, Math.round(239.75 * 2));
    assert.equal(h.nebula.width, Math.round(240.25 * 0.45));
    assert.equal(h.nebula.height, Math.round(239.75 * 0.45));
    const transform = h.calls.find(c => c[0] === 'setTransform');
    assert.deepEqual(transform, ['setTransform', h.canvas.width / 240.25, 0, 0, h.canvas.height / 239.75, 0, 0]);
    h.evaluate('spritesStale = false');
    const count = h.calls.filter(c => c[0] === 'setTransform').length;
    h.events.resize();
    assert.equal(h.calls.filter(c => c[0] === 'setTransform').length, count);
    assert.equal(h.evaluate('spritesStale'), false);
    h.bounds.width = 241.125;
    h.events.resize();
    assert.equal(h.canvas.width, Math.round(241.125 * 2));
    assert.equal(h.evaluate('spritesStale'), true);
    h.window.devicePixelRatio = 1.25;
    h.events.resize();
    assert.equal(h.canvas.width, Math.round(241.125 * 1.25));
    assert.equal(h.nebula.width, Math.round(241.125 * 0.45));
    assert.doesNotMatch(read('processing/js/main.js'), /resize\(/);
});

test('throwing scene resets state, deduplicates errors and always reschedules', () => {
    const h = harness({ webgl: false });
    h.errors.length = 0; // This test isolates the scene reporter from startup's unavailable diagnostic.
    const original = h.sandbox.drawSegmentedSphere;
    let message = 'failure A';
    h.sandbox.drawSegmentedSphere = () => {
        h.context.save(); h.context.globalAlpha = 0.2;
        h.context.globalCompositeOperation = 'xor';
        throw new Error(message);
    };
    h.tick(0); h.tick(34);
    assert.equal(h.errors.length, 1);
    assert.equal(h.context.globalAlpha, 1);
    assert.equal(h.context.globalCompositeOperation, 'source-over');
    assert.ok(h.calls.filter(c => c[0] === 'restore').length >= 32);
    assert.deepEqual(h.calls.filter(c => c[0] === 'setTransform').at(-1),
        ['setTransform', h.canvas.width / 240.25, 0, 0, h.canvas.height / 239.75, 0, 0]);
    message = 'failure B'; h.tick(67);
    assert.equal(h.errors.length, 2);
    h.sandbox.drawSegmentedSphere = original; h.tick(100);
    assert.equal(h.errors.length, 2);
    assert.ok(h.gradients.some(g => g.stops.at(-1)?.[1] === 'rgba(1,4,10,0)'));
    const reporter = h.sandbox.createRenderStageReporter('[test]');
    reporter('a', new Error('same')); reporter('a', new Error('same'));
    reporter('b', new Error('same'));
    assert.equal(h.errors.length, 4, 'dedup is per stage');
});

test('nebula sole fidelity exception is removable diagnostic blocks only', () => {
    const destination = read('processing/js/nebula.js');
    assert.notEqual(sha256(destination), referenceSha256.nebula, 'approved diagnostics-only divergence');
    const withoutDiagnostics = destination.replace(
        /^[ \t]*\/\/ Linux diagnostics begin[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux diagnostics end\.\n(?:\n)?/gm, '');
    assert.equal(sha256(withoutDiagnostics), referenceSha256.nebula,
        'all shaders, algorithms, DPR, timestamps, fallback and restoration remain exactly reference source');
});

test('shader failures report actual per-shader logs and deduplicate retries without stopping Canvas2D', () => {
    const h = harness({ configureGl(gl) {
        gl.createShader = type => ({ type });
        gl.getShaderParameter = () => false;
        gl.getShaderInfoLog = shader => `driver failure ${shader.type}`;
    } });
    assert.equal(h.errors.length, 2);
    assert.match(h.errors[0][0], /compile-vertex: driver failure VERTEX_SHADER/);
    assert.match(h.errors[1][0], /compile-fragment: driver failure FRAGMENT_SHADER/);
    for (let i = 0; i < 5; i++) {
        h.sandbox.initializeNebulaRenderer(); h.tick(i * 34);
    }
    assert.equal(h.errors.length, 2);
    assert.equal(h.layers.length, kept.length * 5);
    assert.equal(h.evaluate('nebulaRenderer'), null);
    assert.ok(h.calls.filter(c => c[0] === 'deleteShader').length >= 12);
    h.gl.getShaderInfoLog = () => 'different driver detail';
    h.sandbox.initializeNebulaRenderer();
    assert.equal(h.errors.length, 4, 'changed detail is reported once for each fixed shader stage');
    h.gl.getShaderParameter = () => true;
    h.events.webglcontextrestored(); h.tick(170);
    assert.ok(h.calls.some(c => c[0] === 'drawArrays'));
});

test('link failure reports program log, preserves fallback and can recover', () => {
    const h = harness({ configureGl(gl) {
        gl.getProgramParameter = () => false;
        gl.getProgramInfoLog = () => 'driver program mismatch';
    } });
    assert.match(h.errors[0][0], /link: driver program mismatch/);
    assert.ok(h.calls.some(c => c[0] === 'deleteProgram'));
    h.sandbox.initializeNebulaRenderer(); h.tick(0); h.tick(34);
    assert.equal(h.errors.length, 1);
    assert.equal(h.layers.length, kept.length * 2);
    h.gl.getProgramParameter = () => true;
    h.events.webglcontextrestored(); h.tick(67);
    assert.ok(h.calls.some(c => c[0] === 'drawArrays'));
});

test('initialize and render exceptions include details, deduplicate and retain recovery/scheduling', () => {
    const h = harness({ configureGl(gl) {
        gl.createBuffer = () => { throw new Error('buffer allocation detail'); };
    } });
    assert.match(h.errors[0][0], /initialize: buffer allocation detail/);
    h.events.webglcontextrestored(); h.tick(0);
    assert.equal(h.errors.length, 1);
    assert.equal(h.layers.length, kept.length);
    h.gl.createBuffer = () => ({});
    const viewport = h.gl.viewport;
    let detail = 'viewport detail A';
    h.gl.viewport = () => { throw new Error(detail); };
    h.events.webglcontextrestored(); h.tick(34);
    assert.match(h.errors[1][0], /render: viewport detail A/);
    for (let i = 2; i < 6; i++) {
        h.events.webglcontextrestored(); h.tick(i * 34);
    }
    assert.equal(h.errors.length, 2);
    assert.equal(h.layers.length, kept.length * 6);
    assert.equal(h.evaluate('nebulaRenderer'), null);
    detail = 'viewport detail B';
    h.events.webglcontextrestored(); h.tick(204);
    assert.match(h.errors[2][0], /render: viewport detail B/);
    h.gl.viewport = viewport;
    h.events.webglcontextrestored(); h.tick(238);
    assert.equal(h.errors.length, 3);
    assert.ok(h.calls.some(c => c[0] === 'drawArrays'));
});

test('unavailable and context-lost diagnostics are explicit and bounded across repeated events', () => {
    const absent = harness({ webgl: false });
    absent.sandbox.initializeNebulaRenderer(); absent.tick(0); absent.tick(34);
    assert.equal(absent.errors.length, 1);
    absent.window.WebGLRenderingContext = function () {};
    absent.sandbox.initializeNebulaRenderer();
    assert.match(absent.errors[1][0], /unavailable: WebGL context unavailable/);
    absent.sandbox.initializeNebulaRenderer(); absent.tick(67);
    assert.equal(absent.errors.length, 2);
    const h = harness();
    for (let i = 0; i < 5; i++) {
        h.events.webglcontextlost({ preventDefault() {}, statusMessage: 'driver reset detail' });
        h.tick(i * 34);
    }
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0][0], /context-lost: driver reset detail/);
    assert.equal(h.layers.length, kept.length * 5);
    h.events.webglcontextlost({ preventDefault() {} });
    assert.match(h.errors[1][0], /context-lost: WebGL context lost/);
    h.events.webglcontextrestored(); h.tick(170);
    assert.ok(h.calls.some(c => c[0] === 'drawArrays'));
    assert.equal(h.evaluate('Object.keys(nebulaFailureDetails).length'), 7);
    assert.equal(h.evaluate('Object.isSealed(nebulaFailureDetails)'), true);
});

test('failed info-log retrieval and failed logging do not mask failure stage or break fallback', () => {
    const h = harness({ configureGl(gl) {
        gl.getProgramParameter = () => false;
        gl.getProgramInfoLog = () => { throw new Error('info log access detail'); };
    } });
    assert.match(h.errors[0][0], /link: Diagnostic detail unavailable: Error: info log access detail/);
    h.sandbox.console.error = () => { throw new Error('logger unavailable'); };
    h.gl.getProgramInfoLog = () => 'changed original driver failure';
    assert.doesNotThrow(() => h.events.webglcontextrestored());
    h.tick(0); h.tick(34);
    assert.equal(h.evaluate('nebulaRenderer'), null);
    assert.equal(h.layers.length, kept.length * 2);
    h.gl.getProgramParameter = () => true;
    h.events.webglcontextrestored();
    h.gl.viewport = () => { throw new Error('original render failure'); };
    h.tick(67);
    assert.equal(h.evaluate('nebulaRenderer'), null);
    assert.equal(h.layers.length, kept.length * 3);
});

test('a host show command draws the CielWin alert overlay over the finished processing scene', () => {
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
    assert.ok(h.calls.some(call => call[0] === 'fillText' && call[1] === 'FAILED'));
    h.tick(4100); // past the duration: done posted once, overlay stops
    assert.deepEqual(h.alertLogs, ['CIELINUX_ALERT_READY_V1', 'CIELINUX_ALERT_DONE_V1']);
    const after = h.calls.length;
    h.tick(4134);
    assert.ok(!h.calls.slice(after).some(call => call[0] === 'fillText' && call[1] === 'FAILED'));
    assert.deepEqual(h.errors, []);
});
