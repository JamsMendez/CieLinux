import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { SRC, source } from './paths.mjs';

const root = SRC;
const read = name => readFileSync(source(name), 'utf8');
const token = scene => `CIELINUX_SCENE_DRAW_READY_V1 ${scene}`;
let binary;
function command(program, args, timeout) {
    const run = spawnSync(program, args, { encoding: 'utf8', timeout,
        killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    assert.ifError(run.error);
    assert.equal(run.signal, null, run.stderr);
    return run;
}
before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'cielinux-readiness-contract.'));
    binary = join(dir, 'build', 'readiness-contract');
    writeFileSync(join(dir, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(ReadinessContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Qml)
add_executable(readiness-contract harness.cpp "${root}/policy.h")
target_include_directories(readiness-contract PRIVATE "${root}")
target_link_libraries(readiness-contract PRIVATE Qt6::Core Qt6::Qml)
`);
    writeFileSync(join(dir, 'harness.cpp'), `
#include "policy.h"
#include <QTimer>
#include <cstdio>
#include <cstdlib>
#define CHECK(value) do { if (!(value)) { std::fprintf(stderr, "CHECK line %d\\n", __LINE__); std::abort(); } } while (false)
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    const bool failure = argc == 2;
    int result = 0;
    QTimer::singleShot(0, &app, [&] {
        const char *scenes[][3] = {
            {"qrc:/processing/index.html?variant=mini&fps=30", "qrc:/processing/js/main.js", "CIELINUX_SCENE_DRAW_READY_V1 processing"},
            {"qrc:/raphael/index.html?variant=mini&fps=30", "qrc:/raphael/js/main.js", "CIELINUX_SCENE_DRAW_READY_V1 raphael"},
            {"qrc:/idle/index.html?variant=mini&fps=30", "qrc:/idle/js/animate.js", "CIELINUX_SCENE_DRAW_READY_V1 idle"},
            {"qrc:/explorer/index.html?variant=mini&fps=30", "qrc:/explorer/js/animate.js", "CIELINUX_SCENE_DRAW_READY_V1 explorer"}};
        const int sceneCount = int(sizeof(scenes) / sizeof(scenes[0]));
        for (int scene = 0; scene < sceneCount; ++scene) for (bool drawFirst : {false, true}) {
            const QUrl selected(scenes[scene][0]);
            const QString source = scenes[scene][1];
            const QString token = scenes[scene][2];
            Policy policy(selected);
            int notifications = 0;
            QObject::connect(&policy, &Policy::readyChanged, [&] { ++notifications; });
            CHECK(!policy.ready());
            policy.loadSucceeded(QUrl("qrc:/wrong.html"));
            policy.loadSucceeded(QUrl(selected.toString() + "#alias"));
            for (int level : {-1, 1, 2, 3, 99}) policy.consoleMessage(level, token, 1, source);
            for (const QString &alias : {source + "?x", source + "#x", source + QString(300, 'x'), QString("file:") + source})
                policy.consoleMessage(0, token, 1, alias);
            // A ported scene's token from a sibling script of the same scene is rejected.
            if (source.contains("/js/")) for (const char *sibling : {"js/main.js", "js/animate.js", "js/render-loop.js"}) {
                const QString wrong = source.left(source.lastIndexOf("js/")) + sibling;
                if (wrong != source) policy.consoleMessage(0, token, 1, wrong);
            }
            // Every other scene's token and source is rejected, in either pairing.
            for (int other = 0; other < sceneCount; ++other) if (other != scene) {
                policy.consoleMessage(0, scenes[other][2], 1, source);
                policy.consoleMessage(0, token, 1, scenes[other][1]);
            }
            policy.consoleMessage(0, token + QString(600, 'x'), 1, source);
            policy.consoleMessage(0, token + "\\n", 1, source);
            // The diagnostics cap must not suppress the control path.
            for (int i = 0; i < 70; ++i) policy.consoleMessage(0, "noise", 1, source);
            CHECK(!policy.ready() && notifications == 0);
            if (drawFirst) policy.consoleMessage(0, token, 1, source);
            else policy.loadSucceeded(selected);
            CHECK(!policy.ready() && notifications == 0);
            if (drawFirst) policy.loadSucceeded(selected);
            else policy.consoleMessage(0, token, 1, source);
            CHECK(policy.ready() && notifications == 1);
            policy.loadSucceeded(selected);
            policy.consoleMessage(0, token, 1, source);
            CHECK(policy.ready() && notifications == 1);
            if (failure) {
                policy.fail(); policy.fail();
                CHECK(!policy.ready() && notifications == 2);
                policy.loadSucceeded(selected); policy.consoleMessage(0, token, 1, source);
                CHECK(!policy.ready() && notifications == 2);
                result = policy.terminalResult();
                std::puts("INVALIDATED_LATE_REJECTED");
                return;
            }
        }
        for (const char *url : {"qrc:/processing/index.html?variant=mini&fps=30&x", "qrc:/processing/index.html", "qrc:/raphael/index.html",
                                "qrc:/raphael/index.html?fps=30&variant=mini", "qrc:/idle/index.html",
                                "qrc:/idle/index.html?fps=30&variant=mini", "qrc:/explorer/index.html",
                                "qrc:/explorer/index.html?fps=30&variant=mini", "qrc:/other.html"}) {
            Policy other{QUrl(url)};
            other.loadSucceeded(QUrl(url));
            for (int scene = 0; scene < sceneCount; ++scene)
                other.consoleMessage(0, scenes[scene][2], 1, scenes[scene][1]);
            CHECK(!other.ready());
        }
        // A failure before either prerequisite must also reject late events.
        Policy early(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
        early.fail();
        early.loadSucceeded(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
        early.consoleMessage(0, "CIELINUX_SCENE_DRAW_READY_V1 processing", 1, "qrc:/processing/js/main.js");
        CHECK(!early.ready());
        std::puts("ORDERS_AND_ADMISSION_PASSED");
        result = early.terminalResult();
        QCoreApplication::quit(); // Ambient quit cannot downgrade observed failure.
    });
    app.exec();
    return result;
}
`);
    for (const [args, timeout] of [[['-S', dir, '-B', join(dir, 'build')], 30000],
        [['--build', join(dir, 'build'), '-j2'], 60000]]) {
        const run = command('cmake', args, timeout);
        assert.equal(run.status, 0, run.stdout + run.stderr);
    }
}, { timeout: 100000 });
test('actual Policy: both orders, raw admission, cap independence and notification dedup', () => {
    const run = command(binary, [], 5000);
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stdout, 'ORDERS_AND_ADMISSION_PASSED\n');
});
test('actual Policy failure invalidates readiness and rejects late callbacks with exit1', () => {
    const run = command(binary, ['failure'], 5000);
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stdout, 'INVALIDATED_LATE_REJECTED\n');
    assert.equal(run.stderr.split('\n').filter(s => s.startsWith('CIELINUX_DIAGNOSTICS_HOST_FAILURE')).length, 1);
});

function sceneHarness(scene, loggerThrows = false) {
    const logs = [], frames = [], timers = [];
    let fail = false;
    const context = new Proxy({}, { get: (_, name) => () => {
        if (fail && name === 'fill') throw Error('outer draw');
    }, set: () => true });
    const canvas = { clientWidth: 0, clientHeight: 240, getContext: () => context };
    const window = { devicePixelRatio: 1, addEventListener() {},
        requestAnimationFrame: fn => frames.push(fn) };
    const sandbox = vm.createContext({ window,
        console: { info() {}, warn() {}, error() {}, log: message => {
            logs.push(message); if (loggerThrows) throw Error('logger');
        } }, performance: { now: () => 0 },
        document: { getElementById: () => canvas },
        requestAnimationFrame: fn => frames.push(fn), setTimeout: fn => timers.push(fn),
        setInterval: fn => timers.push(fn), clearInterval() {},
        createRenderStageReporter: () => () => {}, initializeNebulaRenderer() {},
        scheduleFrame: fn => frames.push(fn), W: 0, H: 240, ctx: context,
        OCTAGON_PULSE_DURATION: 1, OCTAGON_PULSE_INTERVAL: 3, ONE_WAY_DURATION: 1,
        ANIMATION_CYCLE_DURATION: 1, TAU: Math.PI * 2, pingpong01: () => 0,
        renderNebula() {}, ensureSprites() {}, viewZoom: 1, isMiniVariant: true,
        drawMiniSceneBase() {}, applyMiniEdgeFade() {}, resetCanvasStateForFrame() {},
        // A4: shared/js/alert-overlay.js's clock and stage, idle (no alert showing).
        alertSceneMs: ms => ms, renderAlertOverlay() {} });
    for (const name of ['drawSegmentedSphere', 'drawAtomicOrbits', 'drawOrbitBlocks',
        'drawCentralOctagon', 'drawTriangularPrism', 'drawPerspectiveRays', 'drawCentralCore'])
        sandbox[name] = () => { if (fail) throw Error('outer draw'); };
    const source = read(`${scene}/js/main.js`);
    vm.runInContext(source, sandbox);
    return { logs, frames, timers, sandbox, canvas,
        size(w, h) { canvas.clientWidth = sandbox.W = w; canvas.clientHeight = sandbox.H = h; },
        fail(value) { fail = value; },
        draw(ms) { vm.runInContext(`render(${ms})`, sandbox); } };
}
for (const scene of ['processing']) {
    test(`${scene}: only completed positive outer draw reports once; later success after exception`, () => {
        const h = sceneHarness(scene);
        assert.deepEqual(h.logs, []);
        h.draw(0); h.size(240, 0); h.draw(34);
        assert.deepEqual(h.logs, []);
        h.size(240, 240); h.fail(true);
        h.draw(68);
        assert.deepEqual(h.logs, []);
        h.fail(false); h.draw(102); h.draw(136);
        assert.deepEqual(h.logs, [token(scene)]);
    });
    test(`${scene}: throwing readiness logger attempts once without breaking scheduling`, () => {
        const h = sceneHarness(scene, true); h.size(240, 240);
        // Processing chains one frame request per draw.
        const before = h.frames.length + h.timers.length, first = 0;
        assert.doesNotThrow(() => h.draw(first));
        assert.equal(h.frames.length + h.timers.length, before + 1);
        h.draw(first + 34);
        assert.deepEqual(h.logs, [token(scene)]);
    });
}
for (const initializationThrows of [false, true]) {
test(`real packaged processing scripts: ${initializationThrows ? 'failed' : 'unavailable'} WebGL fallback completes before reporting`, () => {
    const calls = [], logs = [], frames = [];
    const context = new Proxy({}, { get: (object, name) => object[name] ?? ((...args) => {
        calls.push([name, ...args]);
        if (String(name).startsWith('create')) return { addColorStop() {} };
    }) });
    const canvas = { width: 0, height: 0, getContext: () => context,
        getBoundingClientRect: () => ({ width: 240, height: 240 }) };
    const nebula = { getContext: () => {
        if (initializationThrows) throw Error('WebGL initialization');
        return null;
    }, addEventListener() {} };
    const sandbox = vm.createContext({ URLSearchParams, location: { search: '?variant=mini&fps=30', hash: '' },
        performance: { now: () => 0 },
        window: { devicePixelRatio: 1, innerWidth: 240, innerHeight: 240,
            WebGLRenderingContext: initializationThrows ? function () {} : undefined,
            addEventListener() {}, requestAnimationFrame: fn => frames.push(fn) },
        document: { getElementById: name => name === 'scene' ? canvas : nebula,
            createElement: () => ({ getContext: () => context }), addEventListener() {},
            documentElement: { classList: { add() {} } } },
        console: { info() {}, warn() {}, error() {}, log: message => {
            assert.equal(calls.at(-1)[0], 'restore', 'edge fade completed before readiness');
            logs.push(message);
        } } });
    const scripts = [...read('processing/index.html').matchAll(/<script src="([^"]+)"><\/script>/g)];
    for (const [, script] of scripts) vm.runInContext(read(`processing/${script}`), sandbox);
    assert.deepEqual(logs, []);
    for (const ms of [0, 34, 68]) {
        assert.equal(frames.length, 1);
        frames.shift()(ms);
        assert.equal(frames.length, 1);
    }
    assert.deepEqual(logs, [token('processing')]);
    assert.ok(calls.some(([name]) => name === 'fillRect'));
});
}
test('production QML routes selected successful load and exposes the actual Policy report', () => {
    const qml = read('view.qml');
    assert.match(qml, /readonly property bool ready: sceneRoot\.scenePolicy\.ready/);
    assert.match(qml, /info\.status === WebEngineView\.LoadSucceededStatus[\s\S]*sceneRoot\.scenePolicy\.loadSucceededFor\(sceneRoot\.sceneAttachment\.generation, info\.url\)/);
    assert.match(qml, /sceneRoot\.scenePolicy\.consoleMessageFor\(sceneRoot\.sceneAttachment\.generation,\s*level, message, lineNumber, sourceID\)/);
});
