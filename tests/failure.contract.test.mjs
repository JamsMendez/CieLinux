import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SRC, source } from './paths.mjs';

const root = SRC;
const failureToken = 'CIELINUX_DIAGNOSTICS_HOST_FAILURE';
const failureRecord = `${failureToken} HTML load or renderer failed; closing host`;
let binary;

// Compile the production header itself, including its real moc-generated
// metaobject. QtQml supplies the registration header; only QCoreApplication
// is constructed, so this does not initialize a GUI or browser.
function command(program, args, timeout) {
    const result = spawnSync(program, args, {
        encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${program} terminated: ${result.stderr}`);
    return result;
}

before(() => {
    const harness = mkdtempSync(join(tmpdir(), 'cielinux-failure-contract.'));
    const build = join(harness, 'build');
    binary = join(build, 'failure-contract');
    // Retain this uniquely owned harness for inspection, like the other
    // compiled contracts. No repository output or global process cleanup.
    writeFileSync(join(harness, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(FailureContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Qml)
add_executable(failure-contract harness.cpp "${root}/policy.h")
target_include_directories(failure-contract PRIVATE "${root}")
target_link_libraries(failure-contract PRIVATE Qt6::Core Qt6::Qml)
`);
    writeFileSync(join(harness, 'harness.cpp'), `
#include "policy.h"
#include <QTimer>
#include <cstdio>
#include <cstring>

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    if (argc != 2) return 2;
    const char *scenario = argv[1];
    if (std::strcmp(scenario, "normal") != 0 &&
        std::strcmp(scenario, "failure") != 0 &&
        std::strcmp(scenario, "repeated-failure") != 0 &&
        std::strcmp(scenario, "quit-then-fail") != 0 &&
        std::strcmp(scenario, "fail-then-quit") != 0) return 2;

    Policy policy(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
    // All requests execute inside one timer callback after exec() begins.
    // Exercise the production result latch, never a copied policy or fake exit.
    QTimer::singleShot(0, &app, [&] {
        std::fputs("ACTIVE_EVENT_LOOP\\n", stdout);
        if (std::strcmp(scenario, "normal") == 0) {
            policy.closeNormally();
        } else if (std::strcmp(scenario, "failure") == 0) {
            policy.fail();
        } else if (std::strcmp(scenario, "repeated-failure") == 0) {
            policy.fail();
            policy.fail();
        } else if (std::strcmp(scenario, "quit-then-fail") == 0) {
            QCoreApplication::quit();
            policy.fail();
        } else {
            policy.fail();
            QCoreApplication::quit();
        }
        std::fputs("REQUESTS_COMPLETED\\n", stdout);
    });
    app.exec();
    return policy.terminalResult();
}
`);
    const configure = command('cmake', ['-S', harness, '-B', build], 30000);
    assert.equal(configure.status, 0, configure.stdout + configure.stderr);
    const compile = command('cmake', ['--build', build, '-j2'], 60000);
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
}, { timeout: 100000 });

// Each scenario gets its own process/application/policy/sink. These expected
// statuses pin observed serialized same-turn Qt behavior, not an ordering
// guarantee for independently delivered browser or timer signals.
const cases = [
    ['normal', 0, 0],
    ['failure', 1, 1],
    ['repeated-failure', 1, 1],
    ['quit-then-fail', 1, 1],
    ['fail-then-quit', 1, 1],
];

for (const [scenario, exitCode, failures] of cases) {
    test(`actual Policy: ${scenario} exits ${exitCode}, HOST_FAILURE count ${failures}`, () => {
        const run = command(binary, [scenario], 5000);
        assert.equal(run.status, exitCode, run.stdout + run.stderr);
        assert.equal(run.stdout, 'ACTIVE_EVENT_LOOP\nREQUESTS_COMPLETED\n');
        const records = run.stderr.split('\n').filter(Boolean);
        assert.equal(records.filter(line => line.startsWith(failureToken)).length, failures);
        assert.deepEqual(records, Array(failures).fill(failureRecord));
    }, { timeout: 10000 });
}
