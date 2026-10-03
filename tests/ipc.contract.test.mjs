// A6 local control: `cielinux --cycle-position next|prev` reaches the running instance over a
// per-user Unix socket in $XDG_RUNTIME_DIR/cielinux/ (dir 0700, socket owner-only, peer uid
// checked) and exits; the same directory's lock keeps one instance per user (CielWin
// SingleInstanceGuard, CielWin/CielWin.App/Composition/SingleInstanceGuard.cs). Runs a real
// harness compiled from the shipped sources, with temp XDG_RUNTIME_DIRs only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { SRC, source } from './paths.mjs';

const read = name => readFileSync(source(name), 'utf8');
let binary, fixture;

const run = (program, args, env = process.env) => {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 240000, env });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
};
const envFor = runtime => ({ ...process.env, XDG_RUNTIME_DIR: runtime, QT_QPA_PLATFORM: 'offscreen',
                             DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' });

after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

before(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cielinux-a6-ipc.'));
    binary = join(fixture, 'build', 'ipc-contract');
    writeFileSync(join(fixture, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(IpcContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Network)
add_executable(ipc-contract harness.cpp "${SRC}/instance-control.cpp" "${SRC}/instance-control.h")
target_include_directories(ipc-contract PRIVATE "${SRC}")
target_link_libraries(ipc-contract PRIVATE Qt6::Core Qt6::Network)
`);
    writeFileSync(join(fixture, 'harness.cpp'), String.raw`
#include "instance-control.h"
#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QEventLoop>
#include <QTimer>
#include <atomic>
#include <cstring>
#include <iostream>
#include <thread>
#define CHECK(x) do { if (!(x)) { std::cerr << "CHECK " << __LINE__ << ": " #x "\n"; return 3; } } while (false)
using InstanceControl::Command;

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    const QString mode = argc > 1 ? argv[1] : "";
    auto log = [](const QString &line) { std::cerr << line.toStdString() << "\n"; };
    if (mode == "check") {
        CHECK(InstanceControl::directory("/run/user/7") == "/run/user/7/cielinux");
        CHECK(InstanceControl::directory("").isEmpty());
        CHECK(InstanceControl::directory("relative/dir").isEmpty());
        CHECK(InstanceControl::parseCommand("next") == Command::Next);
        CHECK(InstanceControl::parseCommand("prev") == Command::Prev);
        for (const char *bad : {"", "Next", "next ", " prev", "previous", "up", "next\n"})
            CHECK(!InstanceControl::parseCommand(bad));
        // In-process round trip: client on a thread, server on this event loop.
        const QString dir = InstanceControl::directory(qgetenv("XDG_RUNTIME_DIR"));
        QList<Command> got;
        InstanceServer server(dir, log);
        CHECK(server.acquire() == InstanceServer::Start::Acquired);
        server.setHandler([&](Command c) { got << c; return QByteArray(c == Command::Next ? "ok" : "ignored: not in mini mode"); });
        CHECK(server.listen());
        InstanceServer second(dir, log);
        CHECK(second.acquire() == InstanceServer::Start::AlreadyRunning);
        std::string m1, m2;
        std::atomic<int> c1{-1}, c2{-1};
        std::thread client([&] {
            c1 = InstanceControl::sendCycle(dir, "next", m1);
            c2 = InstanceControl::sendCycle(dir, "prev", m2);
        });
        QEventLoop loop;
        QTimer poll;
        QObject::connect(&poll, &QTimer::timeout, &loop, [&] { if (c2 != -1) loop.quit(); });
        poll.start(5);
        QTimer::singleShot(5000, &loop, &QEventLoop::quit);
        loop.exec();
        client.join();
        CHECK(c1 == 0 && m1.empty());
        CHECK(c2 == 0 && m2 == "ignored: not in mini mode");
        CHECK((got == QList<Command>{Command::Next, Command::Prev}));
        std::cout << "CHECK_OK";
        return 0;
    }
    if (mode == "acquire") {
        InstanceServer server(argv[2], log);
        const auto start = server.acquire();
        if (start == InstanceServer::Start::AlreadyRunning) { std::cout << "RUNNING"; return 3; }
        if (start == InstanceServer::Start::Unavailable) { std::cout << "UNAVAILABLE"; return 4; }
        if (!server.listen()) { std::cout << "NOLISTEN"; return 5; }
        const QFileInfo socket(server.socketPath());
        std::cout << "ACQUIRED socket-owner-only=" << ((socket.permissions() & 0x0077) == 0 ? "yes" : "no");
        return 0;
    }
    if (mode == "serve") {
        InstanceServer server(argv[2], log);
        if (server.acquire() != InstanceServer::Start::Acquired) return 4;
        server.setHandler([](Command c) {
            std::cout << "COMMAND " << (c == Command::Next ? "next" : "prev") << std::endl;
            return QByteArray("ok");
        });
        if (!server.listen()) return 5;
        std::cout << "READY" << std::endl;
        return app.exec();
    }
    if (mode == "send") {
        std::string message;
        const int code = InstanceControl::sendCycle(argv[2], argv[3], message);
        if (!message.empty()) std::cerr << message << "\n";
        return code;
    }
    return 9;
}
`);
    for (const args of [['-S', fixture, '-B', join(fixture, 'build')], ['--build', join(fixture, 'build'), '-j2']]) {
        const result = run('cmake', args);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
});

const runtimeDir = () => {
    const dir = mkdtempSync(join(fixture, 'run.'));
    chmodSync(dir, 0o700);
    return dir;
};

test('commands, directory rule and an in-process round trip', () => {
    const runtime = runtimeDir();
    const result = run(binary, ['check'], envFor(runtime));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /CHECK_OK/);
    assert.equal(statSync(join(runtime, 'cielinux')).mode & 0o777, 0o700);
});

test('owner-only directory and socket; a too-open directory is tightened; a symlink is refused', () => {
    const runtime = runtimeDir();
    const dir = join(runtime, 'cielinux');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const result = run(binary, ['acquire', dir], envFor(runtime));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.match(result.stdout, /ACQUIRED socket-owner-only=yes/);
    assert.equal(statSync(join(dir, 'instance.lock')).mode & 0o077, 0);

    const other = runtimeDir();
    mkdirSync(join(other, 'elsewhere'), { mode: 0o700 });
    symlinkSync(join(other, 'elsewhere'), join(other, 'cielinux'));
    const refused = run(binary, ['acquire', join(other, 'cielinux')], envFor(other));
    assert.equal(refused.status, 4, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /UNAVAILABLE/);
});

test('a live instance blocks a second one and receives exactly next/prev; garbage is refused', async () => {
    const runtime = runtimeDir();
    const dir = join(runtime, 'cielinux');
    const server = spawn(binary, ['serve', dir], { env: envFor(runtime) });
    let out = '';
    server.stdout.on('data', chunk => { out += chunk; });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('server not ready: ' + out)), 10000);
            server.stdout.on('data', () => { if (out.includes('READY')) { clearTimeout(timer); resolve(); } });
            server.on('exit', code => reject(new Error('server exited ' + code)));
        });
        const second = run(binary, ['acquire', dir], envFor(runtime));
        assert.equal(second.status, 3);
        assert.match(second.stdout, /RUNNING/);

        const raw = line => new Promise(resolve => {
            const socket = createConnection(join(dir, 'control.sock'));
            let reply = '';
            socket.on('data', chunk => { reply += chunk; });
            socket.on('close', () => resolve(reply));
            socket.on('error', () => resolve(reply));
            socket.end(line);
        });
        for (const bad of ['cycle-position up\n', 'cycle-position next \n', 'CYCLE-POSITION next\n',
                           'cycle-position next\nextra\n', 'x'.repeat(200) + '\n', 'cycle-position next'])
            assert.match(await raw(bad), /^(error: .*\n)?$/, JSON.stringify(bad));
        assert.equal(await raw('cycle-position prev\n'), 'ok\n');

        for (const word of ['next', 'prev']) {
            const sent = spawnSync(binary, ['send', dir, word], { encoding: 'utf8', env: envFor(runtime) });
            assert.equal(sent.status, 0, sent.stderr);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.deepEqual(out.match(/COMMAND \w+/g), ['COMMAND prev', 'COMMAND next', 'COMMAND prev']);
    } finally {
        server.kill('SIGKILL');
        await new Promise(resolve => server.once('exit', resolve));
    }
    const none = spawnSync(binary, ['send', dir, 'next'], { encoding: 'utf8', env: envFor(runtime) });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no running CieLinux instance/);
    // The killed instance left its socket behind: the lock decides, so a new start takes over.
    assert.ok(statSync(join(dir, 'control.sock')).isSocket());
    const takeover = run(binary, ['acquire', dir], envFor(runtime));
    assert.equal(takeover.status, 0, takeover.stdout + takeover.stderr);
    const missing = spawnSync(binary, ['send', join(runtime, 'absent'), 'next'], { encoding: 'utf8', env: envFor(runtime) });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no running CieLinux instance/);
});

test('main: client mode before any Qt/Wayland work, guard before Wayland, server wired to the glider', () => {
    const control = read('instance-control.cpp');
    assert.match(control, /SO_PEERCRED/);
    assert.match(control, /flock\([^)]*LOCK_EX \| LOCK_NB/);
    assert.match(control, /UserAccessOption/);
    const main = read('main.cpp');
    const client = main.indexOf('"--cycle-position"');
    assert.ok(client > 0 && client < main.indexOf('HostOptions options;'));
    assert.match(main, /InstanceControl::sendCycle\(/);
    assert.match(main, /Usage: cielinux --cycle-position next\|prev/);
    const guard = main.indexOf('instance.acquire()');
    assert.ok(guard > 0 && guard < main.indexOf('!hasLayerShell()'));
    assert.match(main, /InstanceServer::Start::AlreadyRunning\) \{[^}]*return 3;/);
    assert.ok(main.indexOf('instance.listen()') > main.indexOf('QApplication app(argc, argv)'));
    assert.match(main, /miniGlider\.glideTo\(next\)/);
    assert.match(main, /stored\.settings\.miniPosition = next;/);
    assert.match(read('CMakeLists.txt'), /target_sources\(cielinux PRIVATE [^)]*src\/instance-control\.cpp/);
});
