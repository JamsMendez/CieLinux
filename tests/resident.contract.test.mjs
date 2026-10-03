import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SRC, source } from './paths.mjs';
const root = SRC;
let binary, fixture;
after(() => {
    if (fixture) {
        rmSync(fixture, { recursive: true });
        console.log(`Removed owned headless fixture: ${fixture}`);
    }
});
const run = (program, args) => {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 60000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
};
before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'cielinux-d2-contract.'));
    fixture = dir;
    console.log(`Created owned headless fixture: ${dir}`);
    binary = join(dir, 'build', 'resident-contract');
    // RED baseline executes the current native parser, not a copied model.
    const cpp = readFileSync(source('main.cpp'), 'utf8');
    const baseline = cpp.slice(cpp.indexOf('    QString output;'), cpp.indexOf('    const QUrl sceneUrl'));
    const implemented = existsSync(source('resident-control.h'));
    writeFileSync(join(dir, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(ResidentContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Qml)
add_executable(resident-contract harness.cpp "${root}/policy.h")
target_include_directories(resident-contract PRIVATE "${root}")
target_link_libraries(resident-contract PRIVATE Qt6::Core Qt6::Qml)
`);
    writeFileSync(join(dir, 'harness.cpp'), `
#include "policy.h"
#include <QTimer>
#include <cstring>
#include <iostream>
#include <csignal>
#include <unistd.h>
${implemented ? '#include "resident-control.h"' : ''}
#define CHECK(x) do { if (!(x)) { std::cerr << "CHECK " << __LINE__ << "\\n"; return 3; } } while(false)
int main(int argc, char **argv) {
    if (argc == 1 || std::strcmp(argv[1], "stop-test") != 0) {
${implemented ? '        HostOptions options; CHECK(parseHostOptions(argc, argv, options));\n        std::cout << options.scene.toStdString() << " " << options.durationMs << " " << options.resident << " " << options.output.toStdString();' : `${baseline}\n        std::cout << scene.toStdString() << " " << durationMs << " 0 " << output.toStdString();`}
        return 0;
    }
${implemented ? `
    QCoreApplication app(argc, argv);
    if (argc > 2 && std::strcmp(argv[2], "retirement") == 0) {
        const auto old = std::signal(SIGTERM, SIG_IGN);
        int callbacks = 0;
        {
            ResidentControl retired;
            CHECK(retired.valid());
            retired.activate(&app, [&] { ++callbacks; });
            ::kill(::getpid(), SIGTERM); // Queued but never delivered to Qt.
        }
        ::kill(::getpid(), SIGTERM); // Must use restored SIG_IGN, not a stale FD.
        app.processEvents();
        std::signal(SIGTERM, old);
        CHECK(callbacks == 0);
        std::cout << "EVENT_LOOP_NATIVE_STOP";
        return 0;
    }
    ResidentControl control;
    CHECK(control.valid());
    { ResidentControl duplicate; CHECK(!duplicate.valid()); }
    Policy policy(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
    QTimer lifetime;
    configureLifetime(lifetime, HostOptions{});
    CHECK(lifetime.isActive() && lifetime.isSingleShot() && lifetime.interval() == 15000);
    lifetime.stop();
    HostOptions finite;
    finite.durationMs = 120000;
    configureLifetime(lifetime, finite);
    CHECK(lifetime.isActive() && lifetime.interval() == 120000);
    lifetime.stop();
    HostOptions resident;
    resident.resident = true;
    configureLifetime(lifetime, resident);
    CHECK(!lifetime.isActive() && lifetime.isSingleShot());
    int hides = 0, cancels = 0, stops = 0;
    bool ordering = true;
    policy.bindHost([&] { ++hides; ordering &= policy.closed() && !policy.ready(); },
                    [&] { ++cancels; ordering &= hides == 1; lifetime.stop(); });
    const QString scenario = argc > 2 ? argv[2] : "normal";
    std::function<void()> pendingRecovery;
    policy.bindReconstruction([&](int generation) {
        pendingRecovery = [&, generation] { ordering &= !policy.admits(generation); };
    });
    control.activate(&policy, [&] {
        ++stops;
        ordering &= QThread::currentThread() == app.thread();
        policy.closeNormally();
        policy.closeNormally();
        if (pendingRecovery) pendingRecovery(); // Explicitly gated until native stop.
        if (scenario == "late-failure") policy.fail();
    });
    QTimer::singleShot(0, &app, [&] {
        policy.loadSucceeded(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
        policy.consoleMessage(0, "CIELINUX_SCENE_DRAW_READY_V1 processing", 1, "qrc:/processing/js/main.js");
        if (scenario == "recovery") policy.incident(policy.generation(), 0);
        if (scenario == "failure") policy.fail();
        // Real signals target only this fresh headless child, never a running instance.
        ::kill(::getpid(), SIGTERM);
        ::kill(::getpid(), SIGINT);
    });
    // Failure closes before notifier delivery; drain it in another real loop turn.
    QTimer::singleShot(50, &app, &QCoreApplication::quit);
    app.exec();
    if (stops == 0) {
        QTimer::singleShot(50, &app, &QCoreApplication::quit);
        app.exec();
    }
    policy.closeNormally();
    CHECK(stops == 1 && hides == 1 && cancels == 1 && ordering);
    CHECK(policy.closed() && !policy.ready());
    CHECK(policy.terminalResult() == ((scenario == "failure" || scenario == "late-failure") ? 1 : 0));
    std::cout << "EVENT_LOOP_NATIVE_STOP";
    return 0;
` : '    return 4;'}
}
`);
    for (const args of [['-S', dir, '-B', join(dir, 'build')], ['--build', join(dir, 'build'), '-j2']]) {
        const result = run('cmake', args);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
});
test('actual parser: resident default processing, finite modes and closed arguments', () => {
    for (const [args, expected] of [
        [['--resident'], 'processing 15000 1 '],
        [[], 'processing 15000 0 '],
        [['--duration', '15'], 'processing 15000 0 '],
        [['--duration', '120'], 'processing 120000 0 '],
        [['--resident', '--scene', 'processing', '--output', 'DP-1'], 'processing 15000 1 DP-1'],
        [['--scene', 'raphael', '--duration', '120'], 'raphael 120000 0 '],
        [['--scene', 'idle', '--resident'], 'idle 15000 1 '],
        [['--output', 'DP-1', '--scene', 'explorer'], 'explorer 15000 0 DP-1'],
        [['--output', 'DP-1', '--resident'], 'processing 15000 1 DP-1']
    ]) {
        const result = run(binary, args);
        assert.equal(result.status, 0, `${args}: ${result.stderr}`);
        assert.equal(result.stdout, expected);
    }
    for (const args of [['--resident', '--duration', '15'], ['--duration', '120', '--resident'],
        ['--resident', '--resident'], ['--resident', '15'], ['--duration'], ['--scene'], ['--output'],
        ['--duration', '0'], ['--duration', '015'], ['--unknown'], ['--scene', 'other'],
        ['--output', ''], ['--output', '--resident'], ['--scene', 'circle'], ['--scene', 'processing', '--scene', 'processing'],
        ['--scene', 'raphael', '--scene', 'processing'], ['--scene', 'Raphael'], ['--scene', 'Idle'],
        ['--scene', 'idle', '--scene', 'raphael'], ['--scene', 'idle-mini'], ['--scene', 'shared'],
        ['--scene', 'Explorer'], ['--scene', 'explorer', '--scene', 'idle'],
        ['--duration', '15', '--duration', '15'], ['--output', 'DP-1', '--output', 'DP-1']]) {
        assert.notEqual(run(binary, args).status, 0, args.join(' '));
    }
});
for (const scenario of ['normal', 'recovery', 'failure', 'late-failure', 'retirement']) {
    test(`actual Qt event-loop native stop: ${scenario}`, () => {
        const result = run(binary, ['stop-test', scenario]);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.stdout, 'EVENT_LOOP_NATIVE_STOP');
    });
}
