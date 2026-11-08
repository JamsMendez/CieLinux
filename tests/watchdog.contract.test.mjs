// GUI-thread hang watchdog: a deadlock inside Qt WebEngine's compositor (render thread stuck on
// a WebEngine mutex, GUI thread waiting on the render thread) froze the host silently with the
// unit still "active". The watchdog aborts the process once the GUI event loop stops turning, so
// systemd (Restart=always) brings it back and systemd-coredump keeps the evidence. Runs a real
// harness compiled from the shipped source.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SRC, source } from './paths.mjs';

let binary, fixture;

const run = (program, args, options = {}) => {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 240000, ...options });
    assert.ifError(result.error);
    return result;
};

after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

before(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cielinux-watchdog.'));
    binary = join(fixture, 'build', 'watchdog-contract');
    writeFileSync(join(fixture, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(WatchdogContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
find_package(Qt6 REQUIRED COMPONENTS Core)
find_package(Threads REQUIRED)
add_executable(watchdog-contract harness.cpp "${SRC}/hang-watchdog.cpp" "${SRC}/hang-watchdog.h")
target_include_directories(watchdog-contract PRIVATE "${SRC}")
target_link_libraries(watchdog-contract PRIVATE Qt6::Core Threads::Threads)
`);
    writeFileSync(join(fixture, 'harness.cpp'), String.raw`
#include "hang-watchdog.h"
#include <QCoreApplication>
#include <QTimer>
#include <chrono>
#include <iostream>
#include <thread>

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    const QString mode = argc > 1 ? argv[1] : "";
    // Short timings keep the test fast; production uses HangWatchdog's defaults.
    HangWatchdog watchdog(std::chrono::milliseconds(400), std::chrono::milliseconds(50));
    watchdog.arm();
    if (mode == "hang") {
        // The event loop turns briefly, then the GUI thread blocks for good.
        QTimer::singleShot(100, [] { std::this_thread::sleep_for(std::chrono::seconds(30)); });
        QTimer::singleShot(10000, &app, &QCoreApplication::quit);
    } else if (mode == "busy") {
        // Blocking for less than the timeout is not a hang.
        QTimer::singleShot(100, [] { std::this_thread::sleep_for(std::chrono::milliseconds(200)); });
        QTimer::singleShot(1500, &app, &QCoreApplication::quit);
    } else if (mode == "stopped") {
        // After stop(), a blocked GUI thread (e.g. teardown after exec) never aborts.
        QTimer::singleShot(100, [&] {
            watchdog.stop();
            std::this_thread::sleep_for(std::chrono::milliseconds(1200));
            QCoreApplication::quit();
        });
    } else {
        QTimer::singleShot(1500, &app, &QCoreApplication::quit);
    }
    app.exec();
    watchdog.stop();
    std::cout << "exited normally\n";
    return 0;
}
`);
    const configure = run('cmake', ['-S', fixture, '-B', join(fixture, 'build'), '-DCMAKE_BUILD_TYPE=Release']);
    assert.equal(configure.status, 0, configure.stderr);
    const build = run('cmake', ['--build', join(fixture, 'build')]);
    assert.equal(build.status, 0, build.stdout + build.stderr);
});

const harness = mode => run(binary, [mode], { env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } });

test('a GUI thread blocked past the timeout aborts the process with one watchdog line', () => {
    const result = harness('hang');
    assert.equal(result.signal, 'SIGABRT', result.stderr);
    assert.doesNotMatch(result.stdout, /exited normally/);
    const lines = result.stderr.split('\n').filter(line => line.startsWith('CIELINUX_WATCHDOG'));
    assert.equal(lines.length, 1, result.stderr);
    assert.match(lines[0], /^CIELINUX_WATCHDOG hang stalled_ms=\d+ timeout_ms=400; aborting$/);
    const stalled = Number(lines[0].match(/stalled_ms=(\d+)/)[1]);
    assert.ok(stalled >= 400 && stalled < 5000, lines[0]);
});

test('a turning event loop, or a block shorter than the timeout, never aborts', () => {
    for (const mode of ['idle', 'busy']) {
        const result = harness(mode);
        assert.equal(result.signal, null, `${mode}: ${result.stderr}`);
        assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
        assert.match(result.stdout, /exited normally/);
        assert.doesNotMatch(result.stderr, /CIELINUX_WATCHDOG/);
    }
});

test('a stopped watchdog never aborts a blocked GUI thread', () => {
    const result = harness('stopped');
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /CIELINUX_WATCHDOG/);
});

test('the host arms the watchdog right before the event loop and stops it right after', () => {
    const main = readFileSync(source('main.cpp'), 'utf8');
    assert.match(main, /#include "hang-watchdog\.h"/);
    assert.match(main, /HangWatchdog watchdog;\s*\n\s*watchdog\.arm\(\);\s*\n\s*app\.exec\(\);\s*\n\s*watchdog\.stop\(\);/);
    const cmake = readFileSync(source('CMakeLists.txt'), 'utf8');
    assert.match(cmake, /src\/hang-watchdog\.cpp/);
});
