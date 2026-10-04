// Exercise the shipped same-mode replacement hook and the existing renderer scheduler.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { SRC, source } from './paths.mjs';

let fixture, binary;
const read = name => readFileSync(source(name), 'utf8');
const run = (program, args) => {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
};
after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });
before(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cielinux-global-fps.'));
    binary = join(fixture, 'build', 'global-fps');
    const main = read('main.cpp');
    const hook = main.slice(main.indexOf('QString alertSurfaceMode'), main.indexOf('QTimer alertTick;'));
    assert.ok(hook.includes('SceneHost::changed'));
    writeFileSync(join(fixture, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(GlobalFpsContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Qml)
add_executable(global-fps harness.cpp "${SRC}/scene-host.cpp" "${SRC}/scene-host.h"
    "${SRC}/alerts.cpp" "${SRC}/alerts.h" "${SRC}/alert-bridge.h" "${SRC}/policy.h")
target_include_directories(global-fps PRIVATE "${SRC}")
target_link_libraries(global-fps PRIVATE Qt6::Core Qt6::Qml)
`);
    writeFileSync(join(fixture, 'harness.cpp'), String.raw`
#include "scene-host.h"
#include "policy.h"
#include "alerts.h"
#include "alert-bridge.h"
#include <QCoreApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTimer>
#include <iostream>
#define CHECK(x) do { if (!(x)) { std::cerr << "CHECK " << __LINE__ << ": " #x "\n"; return 3; } } while (false)

static int replay(bool initialReady, bool expire, bool covered) {
    qint64 now = 0;
    Policy policy(sceneUrlFor("idle", "scene", 30));
    AlertBridge alertBridge;
    alertBridge.attach(1);
    if (initialReady) alertBridge.pageMessage(1, 0, AlertBridge::readyMarker, AlertBridge::overlaySource);
    policy.bindReconstruction([&](int gen) {
        QTimer::singleShot(0, &policy, [&, gen] { alertBridge.attach(gen); });
    });
    SceneHost sceneHost("idle", "scene", 30, [&](const QUrl &url) { return policy.retarget(url); },
        [](const QString &, const QString &, int) {});
    AlertDriver alertDriver([&] { return now; }, [](const QString &) {});
    int sounds = 0;
    QObject::connect(&alertDriver, &AlertDriver::alertShown, [&] { ++sounds; });
    QList<QPair<int, QJsonObject>> commands;
    QObject::connect(&alertBridge, &AlertBridge::pageCommand, [&](int gen, const QString &json) {
        commands.append({gen, QJsonDocument::fromJson(json.toUtf8()).object()});
    });
    AlertSurface surface{[&](bool isCovered) { return !isCovered; },
        [&](const AlertShowRequest &request) { alertBridge.post(AlertLayerMessages::show(request)); },
        [&] { alertBridge.hide(); }};
    auto updateAlerts = [&] { alertDriver.update(&surface, covered); };
    int pauses = 0;
    auto updateScenePause = [&] { ++pauses; };
    struct Watch { int calls = 0; void setCoverage(bool) { ++calls; } } fullscreenWatch;
    // Start visible, then cover the wallpaper if this case requires it.
    CHECK(alertDriver.accept("failed:1 duration:5") == "ok id=1");
    alertDriver.update(&surface, false);
    CHECK(sounds == 1);
    alertBridge.setScenePaused(covered);
    commands.clear();
    ` + hook + String.raw`
    now = expire ? 6000 : 1700;
    CHECK(sceneHost.setFps(60));
    QCoreApplication::processEvents();
    CHECK(fullscreenWatch.calls == 0 && pauses == 0 && sounds == 1);
    CHECK(commands.isEmpty()); // Nothing sent to the retired ready page.
    CHECK(!alertBridge.pageMessage(1, 0, AlertBridge::readyMarker, AlertBridge::overlaySource));
    CHECK(alertBridge.pageMessage(2, 0, AlertBridge::readyMarker, AlertBridge::overlaySource));
    if (covered) {
        CHECK(commands.size() == 2 && commands[0].second["type"] == "pause"); // pause precedes active replay
        covered = false;
        alertBridge.setScenePaused(false);
        updateAlerts();
    }
    int shows = 0;
    for (const auto &command : commands) {
        CHECK(command.first == 2);
        if (command.second["type"] == "show") {
            ++shows;
            CHECK(command.second["duration"].toInt() == 3300);
        }
    }
    CHECK(shows == (expire ? 0 : 1) && sounds == 1);
    now = expire ? 6001 : 5001;
    updateAlerts();
    const int before = commands.size();
    CHECK(sceneHost.setFps(30));
    QCoreApplication::processEvents();
    CHECK(alertBridge.pageMessage(3, 0, AlertBridge::readyMarker, AlertBridge::overlaySource));
    for (int i = before; i < commands.size(); ++i) CHECK(commands[i].second["type"] != "show");
    CHECK(sounds == 1 && fullscreenWatch.calls == 0);
    return 0;
}
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    for (bool ready : {false, true}) {
        CHECK(replay(ready, false, false) == 0);
        CHECK(replay(ready, true, false) == 0);
        CHECK(replay(ready, false, true) == 0);
    }
    std::cout << "GLOBAL_FPS_ALERTS_OK\n";
}
`);
    run('cmake', ['-S', fixture, '-B', join(fixture, 'build')]);
    run('cmake', ['--build', join(fixture, 'build'), '-j2']);
});

test('same-mode rate replacement replays active/pending alerts without repeat sound or mode side effects', () => {
    const result = run(binary, []);
    assert.match(result.stdout, /GLOBAL_FPS_ALERTS_OK/);
    assert.doesNotMatch(result.stderr, /CIELINUX_MODE/);
});

for (const scene of ['processing', 'explorer', 'idle', 'raphael']) {
    for (const variant of ['', 'variant=mini&']) {
        for (const fps of [30, 60]) {
            test(`${scene} ${variant ? 'mini' : 'wallpaper'} ${fps} FPS: cadence and hitch resynchronization`, () => {
                const frames = [], drawn = [];
                const sandbox = vm.createContext({
                    window: { requestAnimationFrame: fn => frames.push(fn) },
                    location: { search: `?${variant}fps=${fps}`, hash: '' }, URLSearchParams,
                    document: { documentElement: { classList: { add() {} } } }, console,
                });
                vm.runInContext(read(`${scene}/js/render-loop.js`), sandbox);
                sandbox.draw = ms => { drawn.push(ms); sandbox.scheduleFrame(sandbox.draw); };
                sandbox.scheduleFrame(sandbox.draw);
                const tick = ms => { for (const fn of frames.splice(0)) fn(ms); };
                for (let i = 0; i < 1440; ++i) tick(i * 1000 / 144);
                assert.ok(Math.abs(drawn.length - fps * 10) <= 1, String(drawn.length));
                const before = drawn.length;
                tick(20000);
                assert.equal(drawn.length, before + 1, 'one draw, never a catch-up burst');
                assert.equal(sandbox.wallpaperNextDueFrameTimeMs, 20000 + 1000 / fps);
                tick(20001);
                assert.equal(drawn.length, before + 1);
                tick(20000 + 1000 / fps);
                assert.equal(drawn.length, before + 2);
            });
        }
    }
}
