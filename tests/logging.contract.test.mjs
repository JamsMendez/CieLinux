// B3: every host log line goes to stderr. Qt builds with journald support (Arch's qt6-base)
// send qInfo/qWarning to the journal instead of stderr whenever the process has no controlling
// terminal (Qt's stderrHasConsoleAttached() check), while CieLinux's own diagnostics and IPC
// lines always fwrite to stderr. A host started from a script, an agent or a unit therefore
// split its log: `CIELINUX_MODE switched`, `CIELINUX_HTTP listening` and the tray lines were
// missing from the captured stderr. LogRouting::toStderr() (QT_FORCE_STDERR_LOGGING=1, unless
// the user chose a value) is the first thing main() does, so the rule is fixed before Qt's
// one-time check runs. Verified with a harness run under `setsid` (no controlling terminal).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SRC, source } from './paths.mjs';

const read = name => readFileSync(source(name), 'utf8');
let binary, fixture;

const run = (program, args, env = process.env) => {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 240000, env });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
};
const cleanEnv = extra => {
    const env = { ...process.env, QT_QPA_PLATFORM: 'offscreen', ...extra };
    for (const name of ['QT_FORCE_STDERR_LOGGING', 'QT_LOGGING_TO_CONSOLE', 'QT_LOGGING_RULES', 'QT_MESSAGE_PATTERN'])
        if (!(name in extra)) delete env[name];
    return env;
};

after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

before(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cielinux-b3-log.'));
    binary = join(fixture, 'build', 'log-contract');
    writeFileSync(join(fixture, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(LogContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
find_package(Qt6 REQUIRED COMPONENTS Core)
add_executable(log-contract harness.cpp "${SRC}/log-routing.h")
target_include_directories(log-contract PRIVATE "${SRC}")
target_link_libraries(log-contract PRIVATE Qt6::Core)
`);
    writeFileSync(join(fixture, 'harness.cpp'), String.raw`
#include "log-routing.h"
#include <QCoreApplication>
#include <cstdio>
int main(int argc, char **argv) {
    LogRouting::toStderr();
    QCoreApplication app(argc, argv);
    std::printf("env=%s\n", qgetenv("QT_FORCE_STDERR_LOGGING").constData());
    std::fflush(stdout);
    qInfo("CIELINUX_MODE switched mode=scene");
    qWarning("CIELINUX_TEST warning marker");
    return 0;
}
`);
    for (const args of [['-S', fixture, '-B', join(fixture, 'build')], ['--build', join(fixture, 'build'), '-j2']]) {
        const result = run('cmake', args);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
});

test('without a controlling terminal, qInfo and qWarning still reach stderr', () => {
    // setsid -w: new session, no controlling tty; stderr is a pipe, as under an agent or a unit.
    const result = run('setsid', ['-w', binary], cleanEnv({}));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^env=1$/m);
    assert.match(result.stderr, /CIELINUX_MODE switched mode=scene/);
    assert.match(result.stderr, /CIELINUX_TEST warning marker/);
});

test('an explicit user choice of QT_FORCE_STDERR_LOGGING is kept', () => {
    const result = run('setsid', ['-w', binary], cleanEnv({ QT_FORCE_STDERR_LOGGING: '0' }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^env=0$/m);
});

test('main() fixes the routing first, before options, settings or any Qt log', () => {
    const cpp = read('main.cpp');
    assert.match(cpp, /#include "log-routing\.h"/);
    const body = cpp.slice(cpp.indexOf('int main(int argc, char **argv) {'));
    const firstStatement = body.split('\n').slice(1).find(line => line.trim() && !line.trim().startsWith('//'));
    assert.equal(firstStatement.trim(), 'LogRouting::toStderr();');
    assert.match(read('CMakeLists.txt'), /src\/log-routing\.h|log-routing\.h/);
});
