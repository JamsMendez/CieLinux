import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { readText, source } from './paths.mjs';

const read = name => readText(source(name));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const exists = name => existsSync(source(name));
const html = exists('raphael/index.html') ? read('raphael/index.html') : '';
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
const renderFiles = ['config', 'math', 'hexadecagon', 'nebula', 'sphere', 'scene-data', 'feathers',
    'glyphs', 'glyph-rings', 'digits', 'central-core', 'sprites', 'layers'];
const manifest = ['raphael/index.html', 'raphael/styles.css',
    ...[...renderFiles, 'see-through-hook', 'render-loop', 'main'].map(name => `raphael/js/${name}.js`)];
// A4: the shared alert overlay loads between the hook and the render loop (CielWin order).
const pageScripts = [...renderFiles, 'see-through-hook'].map(name => `js/${name}.js`)
    .concat(['../shared/js/alert-overlay.js', 'js/render-loop.js', 'js/main.js']);
const selected = 'qrc:/raphael/index.html?variant=mini&fps=30';
// Pinned CielWin cebb941^ (4a83e62) Wallpaper/Web/raphael/js sources: the working tree no longer has them.
const referenceSha256 = {
    // Re-pinned after old-name→CielWin comment rename (text-only); was 5d78271d01daec3d292ed74fa2314b6275f6bccff31f0d8f1f24f619f04141c7
    // Re-pinned for B6 (MINI_SCENE_ZOOM 1.2 -> 1.3507 plus its comment; mini-only, the wallpaper uses viewZoom);
    // was 27eb358a85f00038e52b4fdb3848ba04db3adceab752905407df51dccbf514d8 (undoing B6 restores it, tested below)
    config: 'a4db30f066cb0db05fc64f02d9b7c2769c912c5f3cd7876945948e5c9aa83edc',
    math: 'd2bef6c68490200c732b3f3dd906b1ab77bfb8bcc7353f3313e55a4e0be20f1e',
    hexadecagon: '16f3df7983f4d9bd113ff831cbd224ffca0f032b1e2edd38e3facff241a74999',
    sphere: '130aa6b7822ce0a161ef62ab2bf42d31cfe2786796d2f50fa16f86025f2c4645',
    'scene-data': '83ce96f8fdb11246bca17e733f504b9f87297c5fc5c4edf29318630ffaafb62e',
    feathers: 'bd0080b4c2d08311fa8a62f56814f16e9bf9fb4d5956f6aa740f61f3e4e613c2',
    glyphs: 'd0d434c668c2cf2b7a7afc004daf620050d0de62c07bf71b045f1082daf3b265',
    'glyph-rings': 'fd53bc0dcc4e23656db92c1a15c34175a1c980829d1545631963f0b2e19331b9',
    digits: 'f042fa5afc0c1666065f939d396882723ae722dae8a20e431606aeb1ca3394fd',
    'central-core': '76d8ec4b30810e005b0b9c5c69bc0568f9e05947a3b9e0765613011f7cff2bf8',
    // Linux mini optimization (O3, odd/tasks/mini-scene-optimization.md); CielWin reference: b97ab8fba52b6255e33909d470ff871eb269c6125d9cdeb9b736049b55af8ee5
    // Re-pinned for PERF-5/NEB-1 (odd/tasks/wallpaper-microstutters.md); was 05c9f793b0813feb303b3d44a432254975ce3a79ca21a5467bb43553c65c8baf
    sprites: 'f2ece2e0cf0680b49e42fc7e4832d0b55980c4c9f797008268621a92c3925aa5',
    // Linux mini optimization (O3, odd/tasks/mini-scene-optimization.md); CielWin reference: 2a745ee5c5757d09eb475b30fab349ba53cb79d63321dc234fbdef24537de2fc
    // Re-pinned after old-name→CielWin comment rename (text-only); was 33d28a90a373dffe0d3354b54e1d3be9706f2c5b853154d77a9bb3b442af86a9
    // Re-pinned for B5 (wallpaper uses the delimiter layer and cached core gradients); was 731e58cc614ed87d88dc6a88246883f0a9d8ce08f09d6dcf4b0827644fc00460
    // Re-pinned for PERF-5/NEB-1 (odd/tasks/wallpaper-microstutters.md); was a1fa128ba2f159265f8572e57a4e751ad9dcb6acc3747ecc3e5b08420554285e
    layers: 'aff3013c638f8780fb0cba5d7468a8cf55cdb08c43db3deb47b3746704affa1a',
};
// Reference nebula.js minus its two unbounded console.error lines, which the diagnostics replace.
// Re-pinned after old-name→CielWin comment rename (text-only); was c1ba2023e1b91580bfb5ac671215cd8e840d0387c07125358da17f98d35d6576
// Re-pinned for PERF-5/NEB-1 (odd/tasks/wallpaper-microstutters.md); was 102512cbbe59fa4f8295e8407c628017a2178abaafe059b4943911cd0f7fb19d
const nebulaWithoutReferenceLogsSha256 = '955b3f192e0e774830bc243713c4c00d6c6d993a3b26e5d8a56539ddc15ff9fe';
const kept = ['drawGlyphRings', 'drawGoldenHexadecagon', 'drawPerspectiveRays', 'drawCentralCore'];
const skipped = ['drawFeathers', 'drawSoftOvalFields', 'drawCircularOvalFields', 'drawStars',
    'drawRadialStreaks', 'drawLensFlares', 'drawChromaticSideLoops', 'drawFilmGrain', 'drawVignette',
    'drawGlyphCounters'];
const probeText = ['CIELINUX_DIAGNOSTICS_JS_INFO synthetic transport probe',
    'CIELINUX_DIAGNOSTICS_JS_WARN synthetic transport probe',
    'CIELINUX_DIAGNOSTICS_JS_ERROR synthetic transport probe'];

// Recording API mocks run the real packaged scripts; they do not model pixels or shader execution.
function harness({ webgl = true, width = 240, height = 240, configureGl = () => {} } = {}) {
    const calls = [], errors = [], probes = [], logs = [], alertLogs = [], gradients = [], frames = [], events = {}, layers = [];
    const state = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
    const context = new Proxy(state, {
        get(target, name) {
            if (name in target) return target[name];
            if (name === 'measureText') return text => ({ width: String(text).length * 4 });
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
    const window = { devicePixelRatio: 1, innerWidth: width, innerHeight: height,
        WebGLRenderingContext: webgl ? function () {} : undefined,
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
            getElementById: name => name === 'scene' ? canvas : nebula,
            createElement: () => ({ width: 0, height: 0, getContext: () => context }),
            documentElement: { classList: { add: name => calls.push(['class', name]) } },
            addEventListener: (name, fn) => { events[name] = fn; }
        } });
    for (const script of scripts) vm.runInContext(read(`raphael/${script}`), sandbox, { filename: script });
    for (const name of [...kept, ...skipped]) {
        const original = sandbox[name];
        sandbox[name] = (...args) => { layers.push(name); return original(...args); };
    }
    const tick = ms => {
        assert.equal(frames.length, 1, 'exactly one pending RAF');
        frames.shift()(ms);
        assert.equal(frames.length, 1, 'frame always rescheduled');
    };
    return { sandbox, calls, errors, probes, logs, alertLogs, gradients, frames, events, layers, gl, tick,
        evaluate: code => vm.runInContext(code, sandbox) };
}

test('raphael page loads the packaged scene scripts plus the CielWin alert hook and shared overlay (A4)', () => {
    assert.deepEqual(scripts, pageScripts);
    for (const file of manifest) assert.ok(exists(file), file);
    assert.ok(exists('shared/js/alert-overlay.js'));
    // CielWin order: the scene's see-through hook, then the shared overlay, then the render loop.
    assert.ok(scripts.indexOf('js/see-through-hook.js') < scripts.indexOf('../shared/js/alert-overlay.js'));
    assert.ok(scripts.indexOf('../shared/js/alert-overlay.js') < scripts.indexOf('js/render-loop.js'));
    assert.doesNotMatch(html, /fonts|<script>|onload=/);
});

// CielWin/CielWin.App/Wallpaper/Web/raphael/js/see-through-hook.js (14ff645), byte-identical once any
// additive, marked Linux block is removed.
test('raphael see-through hook is the CielWin hook', () => {
    const hook = read('raphael/js/see-through-hook.js');
    const stripped = hook.replace(/^\/\/ Linux port begin[^\n]*\n[\s\S]*?^\/\/ Linux port end\.\n\n/gm, '');
    assert.equal(sha256(stripped), 'd6f6c34f4af60e7fb5b1566393d5a347b303639796fe87d54fb13961af9f1720');
    assert.match(hook, /^function sceneSeeThroughLayer\(g, sceneW, sceneH, /m);
});

test('raphael page CSP is the processing qrc-only policy', () => {
    const csp = page => page.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/)?.[1];
    assert.ok(csp(html));
    assert.equal(csp(html), csp(read('processing/index.html')));
    assert.match(html, /script-src qrc:; style-src qrc:; font-src qrc:;/);
    assert.doesNotMatch(html, /unsafe-|https?:|file:|\*|<script>|<style>|style="/);
});

test('raphael styles paint an opaque black mini root with transparent canvases and the alert font', () => {
    const css = read('raphael/styles.css');
    assert.match(css, /html\.scene-mini \{\s*background: #000;\s*\}/);
    assert.match(css, /html\.scene-mini body,\s*html\.scene-mini #scene,\s*html\.scene-mini #nebula \{\s*background: transparent;\s*\}/);
    // A4: the one bundled alert title face (CielWin's @font-face, verbatim), nothing else external.
    assert.match(css, /@font-face \{\n  font-family: "Archivo Black";\n  src: url\("\.\.\/shared\/fonts\/ArchivoBlack-Regular\.ttf"\) format\("truetype"\);\n  font-weight: 400;\n  font-style: normal;\n  font-display: block;\n\}/);
    assert.equal(css.match(/url\(/g).length, 1);
    assert.doesNotMatch(css, /!important|https?:/);
});

test('scene render files are byte-identical to the pinned CielWin reference', () => {
    for (const [name, hash] of Object.entries(referenceSha256))
        assert.equal(sha256(read(`raphael/js/${name}.js`)), hash, name);
    assert.equal(read('raphael/js/render-loop.js'), read('processing/js/render-loop.js'),
        'one Linux render-loop adapter content for every ported scene');
});

test('B6 is the only change to config.js: undoing it restores the previous pinned hash', () => {
    const config = read('raphael/js/config.js');
    const b6 = /\/\/ B6 \(CieLinux\):[^\n]*\n(?:\/\/[^\n]*\n)*const MINI_SCENE_ZOOM = 1\.3507;/;
    assert.match(config, b6);
    const undone = config.replace(b6, 'const MINI_SCENE_ZOOM = 1.2;');
    assert.equal(sha256(undone), '27eb358a85f00038e52b4fdb3848ba04db3adceab752905407df51dccbf514d8');
});

test('nebula diverges only by removable diagnostics blocks replacing the two reference logs', () => {
    const destination = read('raphael/js/nebula.js');
    const withoutDiagnostics = destination.replace(
        /^[ \t]*\/\/ Linux diagnostics begin[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux diagnostics end\.\n(?:\n)?/gm, '');
    assert.equal(sha256(withoutDiagnostics), nebulaWithoutReferenceLogsSha256);
    assert.doesNotMatch(destination, /Nebula shader (compile|program link) failed/);
    assert.match(destination, /console\.error\('\[raphael-nebula\] ' \+ stage/);
});

test('main.js restores the CielWin alert clock and overlay stage and keeps the gold glyph ring seam', () => {
    const main = read('raphael/js/main.js');
    // A4: the scene draws with alertSceneMs's clock (frozen while a FAILED tile shakes) ...
    assert.match(main, /const sceneMs = alertSceneMs\(ms\);/);
    assert.match(main, /renderNebula\(sceneMs\);/);
    assert.match(main, /const p = animationProgress\(sceneMs\);\n\s*alertSceneTime = p;/);
    assert.match(main, /hexadecagonPulse\(sceneMs\)/);
    assert.match(main, /drawGlyphCounters\(sceneMs\)/);
    // ... and the overlay draws last with the real timestamp, in its own try.
    assert.match(main, /\} finally \{\n\s*cadence\.end\(workStart\);\n\s*\}\n\s*\/\/ Linux port begin \(A4\)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*try \{\n\s*renderAlertOverlay\(ms, W, H, alertSceneTime\);\n\s*\} catch \(error\) \{\n\s*resetCanvasStateForFrame\(\);\n\s*reportRenderError\("alert-overlay", error\);/);
    assert.doesNotMatch(main, /chrome\.webview|postMessage|sceneSeeThroughLayer/);
    assert.match(read('raphael/js/render-loop.js'), /if \(typeof applyFailureShake === "function"\) applyFailureShake\(null\);/);
    assert.match(main, /var cadence = createCadence\('raphael'\);/);
    assert.equal(main.match(/CIELINUX_SCENE_DRAW_READY_V1 raphael/g).length, 1);
    assert.match(read('raphael/js/layers.js'), /function goldGlyphRingDrawParams\(progress\)/);
});

test('host selector, allowlist, navigation and readiness accept raphael and stay closed', () => {
    const header = read('resident-control.h');
    const parser = header.slice(header.indexOf('inline bool parseHostOptions('),
        header.indexOf('inline void configureLifetime('));
    assert.match(parser, /value == QStringLiteral\("processing"\) \|\| value == QStringLiteral\("raphael"\)/);
    assert.match(parser, /!sceneSeen/);
    assert.match(parser, /\} else return false;/);
    const cpp = read('main.cpp');
    assert.match(cpp, /--scene processing\|explorer\|idle\|raphael\b/);
    // A1: the closed scene -> URL table (mini and full-size wallpaper) lives in scene-host.cpp.
    for (const fps of [30, 60]) {
        assert.ok(read('scene-host.cpp').includes(`"qrc:/raphael/index.html?variant=mini&fps=${fps}"`));
        assert.ok(read('scene-host.cpp').includes(`"qrc:/raphael/index.html?fps=${fps}"`));
    }
    const resources = [...cpp.match(/resourceUrls = \{([\s\S]*?)\};/)[1].matchAll(/"qrc:\/([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(resources.filter(url => url.startsWith('raphael/')), manifest);
    assert.equal(new Set(resources).size, resources.length);
    const cmakeFiles = read('CMakeLists.txt').match(/PREFIX "\/" BASE scenes FILES([\s\S]*?)\)/)[1].trim().split(/\s+/).map(file => file.replace(/^scenes\//, ''));
    assert.deepEqual(cmakeFiles.filter(file => file.startsWith('raphael/')), manifest);
    const resourceAllowed = url => url === selected || resources.map(r => `qrc:/${r}`).includes(url);
    assert.ok(resourceAllowed('qrc:/raphael/js/glyph-rings.js'));
    // A4: the hook, the shared overlay and its font are packaged; nothing else under shared/.
    for (const url of ['qrc:/raphael/js/see-through-hook.js', 'qrc:/shared/js/alert-overlay.js',
        'qrc:/shared/fonts/ArchivoBlack-Regular.ttf'])
        assert.ok(resourceAllowed(url), url);
    for (const url of ['qrc:/shared/js/render-loop.js', 'qrc:/shared/fonts/OFL.txt', 'qrc:/raphael/js/../js/main.js',
        'qrc:/raphael/index.html?fps=30&variant=mini', `${selected}#x`])
        assert.ok(!resourceAllowed(url), url);
    const policy = read('policy.h');
    assert.match(policy, /selectedUrl == "qrc:\/raphael\/index.html\?variant=mini&fps=30" \|\|\s*selectedUrl == "qrc:\/raphael\/index.html\?variant=mini&fps=60" \|\|\s*selectedUrl == "qrc:\/raphael\/index.html\?fps=30" \|\|\s*selectedUrl == "qrc:\/raphael\/index.html\?fps=60"\) &&\s*source == QStringLiteral\("qrc:\/raphael\/js\/main.js"\) &&\s*message == QStringLiteral\("CIELINUX_SCENE_DRAW_READY_V1 raphael"\)/);
});

test('synthetic transport probes occur once at initialization, separately from actual errors', () => {
    const h = harness();
    assert.deepEqual(h.probes, [['info', probeText[0]], ['warn', probeText[1]], ['error', probeText[2]]]);
    h.tick(0); h.tick(34);
    assert.equal(h.probes.length, 3);
    assert.deepEqual(h.errors, []);
});

test('one mini tick draws the gold structures, masks the edge and logs readiness once', () => {
    const h = harness();
    assert.ok(h.calls.some(call => call[0] === 'class' && call[1] === 'scene-mini'));
    h.tick(1234);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.layers, kept);
    assert.ok(h.calls.some(call => call[0] === 'drawImage'));
    assert.ok(h.gradients.some(g => g.stops[0]?.[1] === 'rgba(1,4,10,0.9)'));
    const edge = h.gradients.at(-1);
    assert.equal(edge.args[5], 240 * 0.48);
    assert.deepEqual(edge.stops.at(-1), [1, 'rgba(0,0,0,0)']);
    assert.deepEqual(h.logs, ['CIELINUX_SCENE_DRAW_READY_V1 raphael']);
    h.tick(1268); h.tick(1302);
    assert.deepEqual(h.logs, ['CIELINUX_SCENE_DRAW_READY_V1 raphael']);
    assert.equal(h.calls.find(c => c[0] === 'webglContext')[1].alpha, true);
    assert.deepEqual(h.calls.find(c => c[0] === 'clearColor'), ['clearColor', 0, 0, 0, 0]);
    assert.ok(h.calls.some(c => c[0] === 'uniform1f' && c[1] === 'u_mini' && c[2] === 1));
    assert.ok(h.calls.some(c => c[0] === 'uniform1f' && c[1] === 'u_miniGain' && c[2] === 1.4));
    assert.equal(h.calls.find(c => c[0] === 'uniform1f' && c[1] === 'u_drift')[2],
        ((1234 / 1000 / h.evaluate('NEBULA_WARP_PERIOD')) % 1) * Math.PI * 2, 'raw rAF timestamp');
});

test('missing WebGL keeps Canvas2D drawing and reports one bounded unavailable diagnostic', () => {
    const h = harness({ webgl: false });
    h.tick(0); h.tick(34);
    assert.deepEqual(h.layers, [...kept, ...kept]);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0][0], /^\[raphael-nebula\] unavailable: WebGL API unavailable$/);
    assert.deepEqual(h.logs, ['CIELINUX_SCENE_DRAW_READY_V1 raphael']);
});

test('shader compile and link failures report per stage once and keep the fallback', () => {
    const compile = harness({ configureGl(gl) {
        gl.createShader = type => ({ type });
        gl.getShaderParameter = () => false;
        gl.getShaderInfoLog = shader => `driver failure ${shader.type}`;
    } });
    assert.equal(compile.errors.length, 2);
    assert.match(compile.errors[0][0], /\[raphael-nebula\] compile-vertex: driver failure VERTEX_SHADER/);
    assert.match(compile.errors[1][0], /\[raphael-nebula\] compile-fragment: driver failure FRAGMENT_SHADER/);
    for (let i = 0; i < 3; i++) { compile.sandbox.initializeNebulaRenderer(); compile.tick(i * 34); }
    assert.equal(compile.errors.length, 2);
    assert.equal(compile.layers.length, kept.length * 3);
    const link = harness({ configureGl(gl) {
        gl.getProgramParameter = () => false;
        gl.getProgramInfoLog = () => 'driver program mismatch';
    } });
    assert.equal(link.errors.length, 1);
    assert.match(link.errors[0][0], /\[raphael-nebula\] link: driver program mismatch/);
    link.events.webglcontextlost({ preventDefault() {}, statusMessage: 'reset detail' });
    link.events.webglcontextlost({ preventDefault() {}, statusMessage: 'reset detail' });
    assert.equal(link.errors.length, 2);
    assert.match(link.errors[1][0], /context-lost: reset detail/);
});

test('throwing scene resets canvas state, reports once per message and always reschedules', () => {
    const h = harness({ webgl: false });
    h.errors.length = 0;
    const original = h.sandbox.drawGoldenHexadecagon;
    h.sandbox.drawGoldenHexadecagon = () => { throw new Error('failure A'); };
    h.tick(0); h.tick(34);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0][0], /^\[raphael-scene\] render frame failed \(scene\)$/);
    assert.deepEqual(h.logs, []);
    h.sandbox.drawGoldenHexadecagon = original;
    h.tick(68);
    assert.deepEqual(h.logs, ['CIELINUX_SCENE_DRAW_READY_V1 raphael']);
});

test('a host show command draws the CielWin alert overlay over the finished raphael scene', () => {
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
    h.tick(4100); // past the duration: done posted once, overlay stops
    assert.deepEqual(h.alertLogs, ['CIELINUX_ALERT_READY_V1', 'CIELINUX_ALERT_DONE_V1']);
    const after = h.calls.length;
    h.tick(4134);
    assert.ok(!h.calls.slice(after).some(call => call[0] === 'fillText' && call[1] === 'FAILED'));
    assert.deepEqual(h.errors, []);
});
