import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const scripts = html => [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);

test('standalone build is opt-in and bundles only the fixture and original resources', () => {
    const cmake = read('CMakeLists.txt');
    assert.match(cmake, /option\(CIELINUX_NATIVE_PROCESSING\s+"[^"]+"\s+OFF\)/);
    assert.match(cmake, /if\(NOT CIELINUX_NATIVE_PROCESSING\)\s+return\(\)/);
    assert.match(cmake, /qt_add_executable\(native-processing runner\.cpp\)/);
    assert.match(cmake, /qt_add_resources/);
    assert.doesNotMatch(cmake, /add_subdirectory|install\(|src\/|GLOB/);
    const original = scripts(read('../../scenes/processing/index.html'));
    const fixture = scripts(read('fixture.html'));
    assert.deepEqual(fixture, [...original.map(s => `qrc:/${s.startsWith('../') ? s.slice(3) : `processing/${s}`}`), 'qrc:/native-processing/driver.js']);
    for (const path of original.map(s => s.startsWith('../') ? s.slice(3) : `processing/${s}`)) {
        assert.ok(cmake.includes(`scenes/${path}`), path);
    }
    for (const path of ['processing/styles.css', 'shared/fonts/ArchivoBlack-Regular.ttf']) {
        assert.ok(cmake.includes(`scenes/${path}`), path);
    }
    const html = read('fixture.html');
    assert.match(html, /width:\s*3440px;\s*height:\s*1440px/);
    assert.doesNotMatch(html, /transform|variant=mini/);
    assert.match(html, /connect-src 'none'/);
});

test('Qt minimum supports the QML permissionRequested API without an exact-version pin', () => {
    assert.match(read('view.qml'), /onPermissionRequested:/);
    // This required minimum rejects older Qt installations while allowing newer Qt 6.
    assert.match(read('CMakeLists.txt'),
        /^find_package\(Qt6 6\.8 REQUIRED COMPONENTS Quick Qml WebEngineQuick\)$/m);
});

test('native safety guards precede initialization; no override or production integration', () => {
    const cpp = read('runner.cpp');
    const init = cpp.indexOf('QtWebEngineQuick::initialize();');
    assert.ok(init > 0 && init < cpp.indexOf('QGuiApplication app(argc, argv);'));
    for (const name of ['QTWEBENGINE_DISABLE_SANDBOX', 'QTWEBENGINE_CHROMIUM_FLAGS', 'QTWEBENGINE_REMOTE_DEBUGGING']) {
        assert.ok(cpp.indexOf(`"${name}"`) < init);
    }
    assert.match(cpp, /qEnvironmentVariableIsSet\(name\)/); // Empty values must also fail.
    for (const pattern of [/argc != 1/, /getuid\(\) == 0/, /geteuid\(\) == 0/,
        /qEnvironmentVariableIsEmpty\("WAYLAND_DISPLAY"\)/,
        /compatibleOverride\("QT_QPA_PLATFORM", "wayland"\)/,
        /compatibleOverride\("QT_WAYLAND_SHELL_INTEGRATION", "xdg-shell"\)/]) assert.match(cpp, pattern);
    assert.match(cpp, /!qEnvironmentVariableIsSet\(name\) \|\| qgetenv\(name\) == expected/);
    assert.match(cpp, /alarm\(15\)/);
    assert.match(cpp, /_exit\(4\)/);
    assert.match(cpp, /setOffTheRecord\(true\)/);
    assert.match(cpp, /NoCache/);
    assert.match(cpp, /NoPersistentCookies/);
    assert.match(cpp, /download->cancel\(\)/);
    assert.match(cpp, /info\.block\(!allowed/);
    assert.doesNotMatch(cpp, /qputenv|setenv|QProcess|QApplication|InstanceServer|setUrlRequestInterceptor\(nullptr/);
    const allowed = [...cpp.matchAll(/QStringLiteral\("(qrc:[^"]+)"\)/g)].map(m => m[1]);
    const expected = [...scripts(read('fixture.html')), 'qrc:/native-processing/fixture.html',
        'qrc:/processing/styles.css', 'qrc:/shared/fonts/ArchivoBlack-Regular.ttf'];
    assert.deepEqual([...new Set(allowed)].sort(), expected.sort());
});

test('QML requires load and draw checkpoint, denies browser escape paths', () => {
    const qml = read('view.qml');
    assert.match(qml, /loaded && drawn && !checking/);
    assert.match(qml, /LoadSucceededStatus/);
    assert.match(qml, /LoadFailedStatus/);
    assert.match(qml, /onRenderProcessTerminated/);
    assert.match(qml, /request\.reject\(\)/);
    assert.match(qml, /permission\.deny\(\)/);
    assert.match(qml, /onNewWindowRequested/);
    assert.match(qml, /onFullScreenRequested/);
    for (const setting of ['localContentCanAccessRemoteUrls', 'localContentCanAccessFileUrls',
        'javascriptCanOpenWindows', 'javascriptCanAccessClipboard', 'screenCaptureEnabled',
        'fullScreenSupportEnabled', 'pluginsEnabled']) assert.ok(qml.includes(`settings.${setting}: false`));
    assert.doesNotMatch(qml, /showFullScreen|acceptAsNewWindow|grant\(/);
});

// These are driver-level mocks, not native rendering, GPU or Wayland evidence.
function checkpointSandbox(change = () => {}) {
    const bounds = { width: 3440, height: 1440 };
    const sandbox = {
        window: { devicePixelRatio: 1 }, document: { readyState: 'complete' },
        canvas: { width: 3440, height: 1440, getBoundingClientRect: () => bounds },
        nebulaCanvas: { width: 1548, height: 648, getBoundingClientRect: () => bounds },
        nebulaRenderer: { gl: { isContextLost: () => false, drawingBufferWidth: 1548, drawingBufferHeight: 648 } },
        ctx: {}, isMiniVariant: false, drawReadyAttempted: true, NEBULA_DPR_CAP: 0.45,
    };
    change(sandbox);
    return sandbox;
}

function checkpoint(change = () => {}) {
    const sandbox = vm.createContext(checkpointSandbox(change));
    vm.runInContext(read('driver.js'), sandbox);
    return JSON.parse(JSON.stringify(vm.runInContext('nativeProcessingCheckpoint()', sandbox)));
}

test('checkpoint reports actual separate foreground and nebula buffers without timing claims', () => {
    assert.deepEqual(checkpoint(), { ok: true, dpr: 1, css: [3440, 1440],
        foreground: [3440, 1440], nebula: [1548, 648], nebulaCap: 0.45 });
    const checkpointSource = read('driver.js').match(/function nativeProcessingCheckpoint\(\)[\s\S]*?\n}/)[0];
    assert.doesNotMatch(checkpointSource, /requestAnimationFrame|setTimeout|Math\.random|readPixels|getImageData|toDataURL|performance\./);
});

for (const [name, change, reason] of [
    ['load incomplete', s => { s.document.readyState = 'interactive'; }, 'not-ready'],
    ['no completed draw', s => { s.drawReadyAttempted = false; }, 'not-ready'],
    ['mini variant', s => { s.isMiniVariant = true; }, 'not-full'],
    ['DPR mismatch', s => { s.window.devicePixelRatio = 2; }, 'dpr'],
    ['CSS mismatch', s => { s.canvas.getBoundingClientRect = () => ({ width: 640, height: 480 }); }, 'css'],
    ['foreground mismatch', s => { s.canvas.width = 3439; }, 'foreground'],
    ['missing 2D context', s => { s.ctx = null; }, 'foreground'],
    ['missing nebula', s => { s.nebulaRenderer = null; }, 'nebula'],
    ['lost WebGL', s => { s.nebulaRenderer.gl.isContextLost = () => true; }, 'nebula'],
    ['nebula cap changed', s => { s.NEBULA_DPR_CAP = 1; }, 'nebula'],
    ['nebula size changed', s => { s.nebulaCanvas.width = 3440; }, 'nebula'],
    ['WebGL buffer mismatch', s => { s.nebulaRenderer.gl.drawingBufferHeight = 1; }, 'nebula'],
]) test(`checkpoint rejects ${name}`, () => assert.deepEqual(checkpoint(change), { ok: false, reason }));

const stages = ['renderNebula', 'ensureSprites', 'drawSoftOvalFields', 'drawStars',
    'drawRadialStreaks', 'drawLensFlares', 'drawChromaticSideLoops', 'drawSegmentedSphere',
    'drawAtomicOrbits', 'drawOrbitBlocks', 'drawCentralOctagon', 'drawTriangularPrism',
    'drawPerspectiveRays', 'drawCentralCore', 'drawFilmGrain', 'drawVignette', 'renderAlertOverlay'];
const marker = 'CIELINUX_NATIVE_PROCESSING_ATTRIBUTION_READY_V1';
const plain = value => JSON.parse(JSON.stringify(value));

// Real production main/scheduler, stubbed drawing stages: call-flow evidence, not native pixels.
function attributionHarness(customRender) {
    const pending = [], calls = [], messages = [], drawTimes = [], costs = {};
    let clock = 0, clockReads = 0;
    const sandbox = checkpointSandbox();
    Object.assign(sandbox, {
        location: { search: '', hash: '' }, URLSearchParams,
        W: 3440, H: 1440, viewZoom: 1, TAU: Math.PI * 2,
        ONE_WAY_DURATION: 300, ANIMATION_CYCLE_DURATION: 30,
        OCTAGON_PULSE_DURATION: 1, OCTAGON_PULSE_INTERVAL: 3,
        pingpong01: x => x, alertSceneMs: x => x, initializeNebulaRenderer() {},
        performance: { now() { clockReads++; clock += 0.01; return clock; } },
        console: { log: text => messages.push(text), info() {}, warn() {}, error() {} },
    });
    for (const name of ['clearRect', 'save', 'restore', 'translate', 'scale', 'setTransform']) sandbox.ctx[name] = () => {};
    sandbox.window.requestAnimationFrame = callback => pending.push(callback);
    sandbox.window.addEventListener = () => {};
    for (const name of stages) sandbox[name] = function (...args) {
        calls.push({ name, receiver: this, args });
        if (name === 'renderNebula') drawTimes.push(args[0]);
        clock += costs[name] ?? 1;
        return args[1];
    };
    vm.createContext(sandbox);
    vm.runInContext(read('../../scenes/processing/js/render-loop.js'), sandbox);
    vm.runInContext(read('../../scenes/processing/js/main.js'), sandbox);
    const tick = ms => {
        assert.equal(pending.length, 1);
        pending.shift()(ms);
        assert.equal(pending.length, 1, 'unchanged scheduler keeps one callback');
    };
    tick(0); // Readiness draw; its next original render callback is already queued.
    if (customRender) sandbox.render = customRender(sandbox);
    vm.runInContext(read('driver.js'), sandbox);
    const start = () => vm.runInContext('nativeProcessingStart()', sandbox);
    const take = () => vm.runInContext('nativeProcessingResult()', sandbox);
    const markerCount = () => messages.filter(message => message === marker).length;
    return { sandbox, calls, messages, drawTimes, costs, tick, start, take, markerCount,
        clockReads: () => clockReads };
}

function completedAttribution() {
    const h = attributionHarness();
    assert.equal(h.start(), true);
    for (let ms = 20; !h.markerCount() && ms < 10000; ms += 20) h.tick(ms);
    assert.equal(h.markerCount(), 1);
    return { h, result: plain(h.take()) };
}

test('attribution excludes queued original callback, discards 30 draws and caps at 120 samples', () => {
    const h = attributionHarness();
    assert.equal(h.start(), true);
    assert.equal(h.start(), false, 'cannot restart');
    assert.equal(h.take(), null, 'cannot retrieve partial data');
    const beforeQueued = h.clockReads();
    h.tick(20);
    assert.equal(h.clockReads() - beforeQueued, 2, 'only original cadence clock reads');
    for (let i = 0; i < 149; i++) h.tick(40 + i * 20);
    assert.equal(h.markerCount(), 0, '30 warmup + 119 samples is incomplete');
    h.tick(3020);
    assert.equal(h.markerCount(), 1);
    const result = plain(h.take());
    assert.deepEqual(result.checkpoint, checkpoint());
    assert.equal(result.attribution.warmup, 30);
    assert.equal(result.attribution.count, 120);
    assert.deepEqual(result.attribution.timestampRangeMs, [640, 3020]);
    assert.deepEqual(result.attribution.stages.map(stage => stage.name), stages);
    for (const stage of result.attribution.stages) {
        assert.equal(stage.count, 120);
        for (const key of ['meanMs', 'medianMs', 'p95Ms', 'firstHalfMeanMs', 'secondHalfMeanMs']) {
            assert.ok(Math.abs(stage[key] - 1.01) < 1e-8, `${stage.name}.${key}`);
        }
    }
    assert.equal(result.attribution.clock.reads, 5400);
    assert.equal(result.attribution.clock.residualToleranceMs, 0);
    assert.ok(result.attribution.residual.meanMs > 0);
    const afterCap = h.clockReads();
    h.tick(3040);
    assert.equal(h.clockReads() - afterCap, 2, 'no observer clock reads after cap');
    assert.equal(h.markerCount(), 1);
    assert.equal(h.take(), null, 'one bounded retrieval only');
});

test('statistics use all 120 ordered samples, nearest-rank p95 and independent halves', () => {
    const h = attributionHarness();
    assert.equal(h.start(), true);
    for (let ms = 20; ms <= 620; ms += 20) h.tick(ms);
    for (let i = 0; i < 120; i++) {
        h.costs.drawStars = i + 1;
        h.tick(640 + i * 20);
    }
    const stats = plain(h.take()).attribution.stages.find(stage => stage.name === 'drawStars');
    for (const [key, expected] of Object.entries({ meanMs: 60.51, medianMs: 60.51, p95Ms: 114.01,
        firstHalfMeanMs: 30.51, secondHalfMeanMs: 90.51 })) assert.ok(Math.abs(stats[key] - expected) < 1e-8, key);
});

test('strict originals receive null and primitive receivers without wrapper coercion', () => {
    const receivers = [];
    const h = attributionHarness(s => function (ms) {
        receivers.push(this);
        for (const name of stages) Reflect.apply(s[name], this, [ms]);
        return this;
    });
    assert.equal(h.start(), true);
    for (const [i, receiver] of [null, undefined, 7, 'receiver'].entries()) {
        assert.equal(Reflect.apply(h.sandbox.render, receiver, [20 + i * 20]), receiver);
        assert.equal(receivers[i], receiver);
        assert.equal(h.calls.at(-1).receiver, receiver);
    }
});

test('production throttle callbacks are not draws; live timestamps remain unchanged', () => {
    const h = attributionHarness();
    assert.equal(h.start(), true);
    let callbacks = 0;
    for (let ms = 5; !h.markerCount() && ms < 10000; ms += 5) { h.tick(ms); callbacks++; }
    const result = plain(h.take());
    assert.ok(callbacks > 300);
    assert.equal(h.drawTimes.length, 152, 'readiness + queued original + 30 + 120');
    assert.deepEqual(result.attribution.timestampRangeMs, [h.drawTimes[32], h.drawTimes[151]]);
    assert.equal(result.attribution.count, 120);
});

test('wrappers forward receiver, arguments, return values and stage order exactly once', () => {
    const token = {}, receiver = {};
    const h = attributionHarness(s => function (...args) {
        for (const name of stages) assert.equal(Reflect.apply(s[name], this, args), token);
        return token;
    });
    assert.equal(h.start(), true);
    h.calls.length = 0;
    assert.equal(Reflect.apply(h.sandbox.render, receiver, [20, token, null]), token);
    assert.deepEqual(h.calls.map(call => call.name), stages);
    for (const call of h.calls) {
        assert.equal(call.receiver, receiver);
        assert.deepEqual(call.args, [20, token, null]);
    }
    const reads = h.clockReads();
    assert.equal(h.sandbox.drawStars.call(receiver, 22, token), token);
    assert.equal(h.clockReads(), reads, 'stage calls outside render are not observed');
});

for (const mode of ['partial', 'misordered', 'duplicate', 'stage-throw', 'render-throw', 'clock-throw']) {
    test(`invalid ${mode} frame fails without masking original exceptions`, () => {
        const sentinel = {};
        const h = attributionHarness(s => function (ms) {
            if (mode === 'render-throw') throw sentinel;
            const order = stages.slice();
            if (mode === 'partial') order.pop();
            if (mode === 'misordered') [order[0], order[1]] = [order[1], order[0]];
            if (mode === 'duplicate') order.push(order[0]);
            for (const name of order) s[name](ms);
        });
        if (mode === 'stage-throw') h.sandbox.drawStars = () => { throw sentinel; };
        assert.equal(h.start(), true);
        if (mode === 'clock-throw') h.sandbox.performance.now = () => { throw sentinel; };
        if (mode.endsWith('-throw') && mode !== 'clock-throw') {
            assert.throws(() => h.sandbox.render(20), error => error === sentinel);
        } else assert.doesNotThrow(() => h.sandbox.render(20));
        assert.equal(h.markerCount(), 1);
        const result = plain(h.take());
        assert.equal(typeof result.attribution.error, 'string');
        assert.equal(h.sandbox.nativeProcessingValidSummary(result.attribution), false);
    });
}

test('clock and logger failures cannot mask an original exception', () => {
    const originalError = {}, observerError = {};
    const h = attributionHarness(() => function () { throw originalError; });
    assert.equal(h.start(), true);
    h.sandbox.performance.now = () => { throw observerError; };
    h.sandbox.console.log = () => { throw observerError; };
    assert.throws(() => h.sandbox.render(20), error => error === originalError);
    assert.equal(typeof h.take().attribution.error, 'string');
});

test('quantization remains explicit and the final checkpoint is freshly evaluated', () => {
    const h = attributionHarness();
    const now = h.sandbox.performance.now;
    h.sandbox.performance.now = () => Math.floor(now());
    assert.equal(h.start(), true);
    for (let ms = 20; !h.markerCount() && ms < 10000; ms += 20) h.tick(ms);
    h.sandbox.window.devicePixelRatio = 2;
    const result = plain(h.take());
    assert.equal(h.sandbox.nativeProcessingValidSummary(result.attribution), true);
    assert.ok(result.attribution.clock.zeroDeltas > 0);
    assert.equal(result.attribution.clock.minimumPositiveDeltaMs, 1);
    assert.deepEqual(result.checkpoint, { ok: false, reason: 'dpr' });
});

test('production catches a stage exception but attribution still rejects the incomplete draw', () => {
    const h = attributionHarness();
    h.sandbox.drawStars = () => { throw new Error('stage'); };
    assert.equal(h.start(), true);
    h.tick(20); // Queued original callback is deliberately not counted.
    assert.equal(h.markerCount(), 0);
    h.tick(40);
    assert.equal(h.markerCount(), 1);
    assert.equal(typeof h.take().attribution.error, 'string');
});

test('readiness failure never installs wrappers; coarse/backwards clocks never fabricate timings', () => {
    const notReady = attributionHarness();
    const original = notReady.sandbox.render;
    notReady.sandbox.window.devicePixelRatio = 2;
    assert.equal(notReady.start(), false);
    assert.equal(notReady.sandbox.render, original);
    for (const backwards of [false, true]) {
        const h = attributionHarness();
        assert.equal(h.start(), true);
        let value = 100;
        h.sandbox.performance.now = () => backwards ? --value : value;
        for (let ms = 20; !h.markerCount() && ms < 10000; ms += 20) h.tick(ms);
        assert.equal(h.markerCount(), 1);
        assert.equal(typeof h.take().attribution.error, 'string');
    }
});

test('summary validation rejects wrong types, extras, malformed stages, counts and residuals', () => {
    const { h, result } = completedAttribution();
    const valid = h.sandbox.nativeProcessingValidSummary;
    assert.equal(valid(result.attribution), true);
    const changes = [
        s => { s.count = '120'; }, s => { s.count = 119; }, s => { s.warmup = 29; },
        s => { s.version = true; }, s => { s.warmup = '30'; }, s => { s.stages[0].count = 119; },
        s => { s.extra = 1; }, s => { delete s.frame; }, s => { s.stages.pop(); },
        s => { s.stages[0].name = 'drawStars'; }, s => { s.stages.reverse(); },
        s => { s.frame.meanMs = NaN; }, s => { s.frame.medianMs = Infinity; },
        s => { s.frame.p95Ms = -1; }, s => { s.frame.count = true; },
        s => { s.frame.firstHalfMeanMs += 2; }, s => { s.stages[0].extra = 0; },
        s => { s.residual.meanMs = -1e-12; }, s => { s.clock.residualToleranceMs = 1; },
        s => { s.clock.reads = 5399; }, s => { s.clock.minimumPositiveDeltaMs = 0; },
        s => { s.clock.extra = 0; }, s => { s.frame.extra = 0; },
        s => { s.clock.zeroDeltas = 0.5; }, s => { s.timestampRangeMs.reverse(); },
        s => { s.timestampRangeMs[1] = s.timestampRangeMs[0] + 15001; },
        s => { s.timestampRangeMs.push(0); }, s => { s.timestampRangeMs[1] = '3020'; },
    ];
    for (const change of changes) {
        const modified = structuredClone(result.attribution);
        change(modified);
        assert.equal(valid(modified), false, change.toString());
    }
    for (const bad of [null, [], true, 'summary', {}]) assert.equal(valid(bad), false);
});

test('QML awaits the exact driver marker; native schema checks are structural, not runtime proof', () => {
    const qml = read('view.qml'), cpp = read('runner.cpp'), driver = read('driver.js');
    assert.match(qml, /nativeProcessingStart\(\)/);
    assert.match(qml, /nativeProcessingResult\(\)/);
    assert.ok(qml.includes(marker));
    assert.match(qml, /sourceID === "qrc:\/native-processing\/driver\.js"/);
    assert.match(qml, /!retrieving/);
    assert.match(cpp, /validAttribution/);
    assert.match(cpp, /isDouble\(\)/);
    assert.match(cpp, /std::isfinite/);
    assert.match(cpp, /synchronous-layer-attribution/);
    assert.match(cpp, /16384/);
    for (const name of stages) assert.ok(cpp.includes(`"${name}"`));
    assert.doesNotMatch(driver, /requestAnimationFrame|setTimeout|Math\.random|readPixels|getImageData|toDataURL/);
});

test('all seven untracked fixture files have clean whitespace and no conflict markers', () => {
    for (const name of ['CMakeLists.txt', 'runner.cpp', 'view.qml', 'fixture.html', 'driver.js',
        'contract.test.mjs', 'README.md']) {
        const text = read(name);
        assert.doesNotMatch(text, /[ \t]+$/m, name);
        assert.doesNotMatch(text, /^(?:<{7}|={7}|>{7})(?: |$)/m, name);
        assert.ok(text.endsWith('\n'), name);
    }
});

