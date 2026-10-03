import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SRC, source } from './paths.mjs';
const root = SRC;
let binary;
function command(program, args, timeout) {
    const run = spawnSync(program, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
    assert.ifError(run.error);
    assert.equal(run.signal, null, run.stderr);
    return run;
}
before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'cielinux-disposal-contract.'));
    binary = join(dir, 'build', 'disposal-contract');
    writeFileSync(join(dir, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(DisposalContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Qml)
add_executable(disposal-contract harness.cpp "${root}/policy.h")
target_include_directories(disposal-contract PRIVATE "${root}")
target_link_libraries(disposal-contract PRIVATE Qt6::Core Qt6::Qml)
`);
    writeFileSync(join(dir, 'harness.cpp'), `
#include "policy.h"
#include "output-policy.h"
#include <QTimer>
#include <cstdio>
#include <cstdlib>
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr,"CHECK %d\\n",__LINE__); std::abort(); } } while(false)
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    const QString scenario = argc == 2 ? argv[1] : "";
    Policy policy(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
    int hides = 0, cancels = 0, changes = 0;
    QTimer lifetime;
    lifetime.setSingleShot(true);
    const bool ambientOnly = scenario == "ambient-quit" || scenario == "fail-ambient-quit";
    CHECK(policy.bindHost([&] {
        ++hides;
        CHECK(policy.closed());
        CHECK(!policy.ready());
        if (scenario == "hide-fail") policy.fail();
        if (scenario == "hide-close") policy.closeNormally();
    }, [&] { ++cancels; lifetime.stop(); CHECK(policy.closed()); }));
    QObject::connect(&policy, &Policy::readyChanged, [&] {
        ++changes;
        if (policy.ready() && scenario == "ready-close") policy.closeNormally();
        if (!policy.ready() && scenario == "invalidate-fail") policy.fail();
    });
    QTimer::singleShot(0, &app, [&] {
        std::puts("ACTIVE_EVENT_LOOP");
        policy.loadSucceeded(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
        policy.consoleMessage(0, "CIELINUX_SCENE_DRAW_READY_V1 processing", 1, "qrc:/processing/js/main.js");
        if (!policy.closed()) CHECK(policy.ready());
        if (ambientOnly) {
            lifetime.start(60000);
            CHECK(lifetime.isActive() && policy.ready());
            if (scenario == "fail-ambient-quit") policy.fail();
            else CHECK(!policy.closed() && hides == 0 && cancels == 0);
            QCoreApplication::quit(); // No normal owner close before loop exit.
            std::puts("AMBIENT_QUIT_REQUESTED");
            return;
        }
        if (scenario == "failure" || scenario == "fail-normal") policy.fail();
        if (scenario == "removal") {
            int selected, foreign;
            OutputPolicy::removed(&selected, &foreign, [&] { policy.closeNormally(); }, [] {});
            CHECK(!policy.closed());
            OutputPolicy::removed(&selected, &selected, [&] { policy.closeNormally(); }, [] {});
            OutputPolicy::removed(&selected, &selected, [&] { policy.closeNormally(); }, [] {});
        } else policy.closeNormally(); // timeout and native-closing use this same entry.
        if (scenario == "normal-fail") policy.fail();
        if (policy.terminalResult() == 1) { policy.fail(); policy.fail(); }
        policy.closeNormally();
        CHECK(hides == 1 && cancels == 1 && changes == 2);
        CHECK(!policy.bindHost([] {}, [] {}));
        policy.loadSucceeded(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
        policy.consoleMessage(0, "CIELINUX_SCENE_DRAW_READY_V1 processing", 1, "qrc:/processing/js/main.js");
        CHECK(!policy.ready() && changes == 2);
        QCoreApplication::quit(); // ambient Qt exit must not downgrade the owner result.
        std::puts("CLOSED_LATE_REJECTED");
    });
    const int ambient = app.exec();
    CHECK(ambient == 0);
    if (ambientOnly) {
        policy.closeNormally(); // Actual production post-exec owner finalization.
        CHECK(policy.closed() && !policy.ready() && !lifetime.isActive());
        CHECK(hides == 1 && cancels == 1 && changes == 2);
        CHECK(!policy.bindHost([] {}, [] {}));
        policy.loadSucceeded(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
        policy.consoleMessage(0, "CIELINUX_SCENE_DRAW_READY_V1 processing", 1, "qrc:/processing/js/main.js");
        policy.closeNormally();
        CHECK(!policy.ready() && hides == 1 && cancels == 1 && changes == 2);
        std::puts("AMBIENT_FINALIZED_LATE_REJECTED");
    }
    return policy.terminalResult();
}
`);
    for (const args of [['-S', dir, '-B', join(dir, 'build')], ['--build', join(dir, 'build'), '-j2']]) {
        const run = command('cmake', args, 60000);
        assert.equal(run.status, 0, run.stdout + run.stderr);
    }
}, { timeout: 130000 });
for (const [scenario, result] of [['timeout', 0], ['removal', 0], ['dismiss', 0],
    ['failure', 1], ['normal-fail', 1], ['fail-normal', 1], ['hide-fail', 1],
    ['hide-close', 0], ['ready-close', 0], ['invalidate-fail', 1]]) {
    test(`actual terminal owner: ${scenario}`, () => {
        const run = command(binary, [scenario], 5000);
        assert.equal(run.status, result, run.stdout + run.stderr);
        assert.equal(run.stdout, 'ACTIVE_EVENT_LOOP\nCLOSED_LATE_REJECTED\n');
        assert.equal(run.stderr.split('\n').filter(s => s.startsWith('CIELINUX_DIAGNOSTICS_HOST_FAILURE')).length, result);
    });
}
for (const [scenario, result] of [['ambient-quit', 0], ['fail-ambient-quit', 1]]) {
    test(`actual owner finalizes after unowned quit: ${scenario}`, () => {
        const run = command(binary, [scenario], 5000);
        assert.equal(run.status, result, run.stdout + run.stderr);
        assert.equal(run.stdout, 'ACTIVE_EVENT_LOOP\nAMBIENT_QUIT_REQUESTED\nAMBIENT_FINALIZED_LATE_REJECTED\n');
        assert.equal(run.stderr.split('\n').filter(s => s.startsWith('CIELINUX_DIAGNOSTICS_HOST_FAILURE')).length, result);
    });
}
test('production close routes and pre-exec failure use the actual owner', () => {
    const cpp = readFileSync(source('main.cpp'), 'utf8');
    assert.match(cpp, /app\.setQuitOnLastWindowClosed\(false\)/);
    assert.match(cpp, /&QQuickWindow::closing, &policy,\s*\[&, generation\] \{\s*if \(policy.admits\(generation\)\) policy.noteCloseReason\(Diagnostics::Reason::Dismissal\);\s*policy.closeGeneration\(generation\);\s*\}/);
    assert.doesNotMatch(cpp, /view\.close\(/);
    assert.match(cpp, /&QTimer::timeout, &policy, \[&\] \{\s*policy.noteCloseReason\(Diagnostics::Reason::Deadline\);\s*policy.closeNormally\(\);\s*\}/);
    assert.match(cpp, /if \(view\.status\(\) != QQuickView::Ready\) \{ policy\.constructionFailed\(generation\); return 1; \}/);
    assert.match(cpp, /app\.exec\(\);\s*policy.noteCloseReason\(Diagnostics::Reason::Ambient\);\s*policy.closeNormally\(\);\s*return policy.terminalResult\(\)/);
    assert.match(cpp, /if \(!layer\) \{ qCritical\("LayerShellQt unavailable"\); return 2; \}/);
    assert.match(cpp, /if \(preparationResult != 0\) \{\s*if \(preparationResult == 1\) policy.fail\(\);\s*policy.noteCloseReason\(Diagnostics::Reason::Guard, preparationResult\);\s*policy.closeNormally\(\);\s*return policy.terminalResult\(\) == 1 \? 1 : preparationResult;/);
    assert.match(cpp, /policy\.bindHost\([\s\S]*?attachment\.view->hide\(\)[\s\S]*?lifetime\.stop\(\)/);
});
