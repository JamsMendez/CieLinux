// B2 fullscreen coverage of the wallpaper's output (CielWin PrimaryMonitorFullscreenDetector +
// AppComposition IsCovered), on Linux from Hyprland IPC: the event socket (.socket2.sock) says
// WHEN something may have changed, the request socket (.socket.sock: j/monitors + j/clients)
// says WHAT is shown. Covered = a true fullscreen window (not a maximised one, CielWin's "not
// maximised" rule) on a workspace the monitor shows. Event driven, never polled; without Hyprland
// one log line and `covered` stays false. B8: a dropped event socket or a restarted Hyprland (new
// instance signature) is followed again with bounded backoff. B9: the same `j/monitors` answer
// keeps the output's reserved zones cached for the wallpaper alerts' work area. B10: the watch also
// runs in the mini with coverage off (never covered, no coverage queries or logs), so the mini's
// glide frame reads the same cache instead of a blocking request. Every test runs against a fake
// Hyprland in a temp XDG_RUNTIME_DIR, never the real one.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { SRC, ROOT } from './paths.mjs';

let fixture, binary, counter = 0;

before(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cielinux-b2-fullscreen.'));
    binary = join(fixture, 'build', 'fullscreen-contract');
    const cmake = `
cmake_minimum_required(VERSION 3.21)
project(FullscreenContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Network)
add_executable(fullscreen-contract harness.cpp "${SRC}/fullscreen-watch.cpp" "${SRC}/fullscreen-watch.h"
    "${SRC}/mini-position.cpp" "${SRC}/mini-position.h" "${SRC}/mini-dodge.cpp" "${SRC}/mini-dodge.h")
target_include_directories(fullscreen-contract PRIVATE "${SRC}")
target_link_libraries(fullscreen-contract PRIVATE Qt6::Core Qt6::Network)
`;
    const harness = String.raw`
#include "fullscreen-watch.h"
#include "mini-dodge.h"
#include "mini-position.h"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFile>
#include <QSocketNotifier>
#include <QTimer>
#include <iostream>
#include <unistd.h>

static void out(const QString &line) { std::cout << line.toStdString() << std::endl; }
static QByteArray slurp(const QString &path) { QFile f(path); f.open(QIODevice::ReadOnly); return f.readAll(); }

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    const QStringList args = app.arguments().mid(1);
    if (args.value(0) == "parse") {
        const std::optional<bool> c = HyprlandIpc::fullscreenCovers(slurp(args.value(1)), slurp(args.value(2)), args.value(3));
        out(c ? (*c ? "COVERED 1" : "COVERED 0") : "NULL");
        return 0;
    }
    if (args.value(0) == "prefix") {
        for (const QString &line : args.mid(1)) out(QString::fromLatin1(FullscreenWatch::logPrefix(line)) + " " + line);
        return 0;
    }
    if (args.value(0) == "watch") {
        // B12 test-only knobs (environment, so the positional arguments stay as they are):
        // CIELINUX_TEST_STALL_AFTER_STARTED_MS blocks the event loop on the loop turn right after
        // the watch's first query went out (as QtWebEngine's startup does in the real app);
        // CIELINUX_TEST_QUERY_RETRY="first,max" shortens the failed-query retry backoff.
        const int stallMs = qEnvironmentVariableIntValue("CIELINUX_TEST_STALL_AFTER_STARTED_MS");
        bool stalled = false;
        QObject stallContext;
        FullscreenWatch watch(args.value(1), [&](const QString &line) {
            out("TRACE " + line);
            if (stallMs > 0 && !stalled && line.startsWith("fullscreen-watch started")) {
                stalled = true;
                QTimer::singleShot(0, &stallContext, [stallMs] { ::usleep(useconds_t(stallMs) * 1000); });
            }
        });
        const QStringList queryRetry = qEnvironmentVariable("CIELINUX_TEST_QUERY_RETRY").split(u',', Qt::SkipEmptyParts);
        if (queryRetry.size() == 2) watch.setQueryRetryDelays(queryRetry[0].toInt(), queryRetry[1].toInt());
        QObject::connect(&watch, &FullscreenWatch::coveredChanged, [](bool covered) {
            out(covered ? "COVERED 1" : "COVERED 0");
        });
        // Test-only short retry delays (B8); production uses 1 s doubling to 30 s.
        if (args.size() >= 5) watch.setRetryDelays(args.value(3).toInt(), args.value(4).toInt());
        // Event-loop liveness probe: the longest gap between 10 ms ticks since the last "gap".
        QElapsedTimer clock;
        clock.start();
        qint64 last = 0, maxGap = 0;
        QTimer probe;
        QObject::connect(&probe, &QTimer::timeout, [&] {
            maxGap = qMax(maxGap, clock.elapsed() - last);
            last = clock.elapsed();
        });
        probe.start(10);
        // B10 mini mode: coverage off from the start, a MiniGlider whose glide frame is the output
        // minus watch.reserved() (as main.cpp), and a compositor model resolving every request in
        // the true usable area (argv 5-8: output width, height, true reserved right, true top).
        const bool mini = args.size() >= 6 && args.value(5) == "mini";
        const QSize output(args.value(6).toInt(), args.value(7).toInt());
        const QMargins truth(0, args.value(9).toInt(), args.value(8).toInt(), 0);
        if (mini) watch.setCoverage(false);
        QElapsedTimer glideClock;
        glideClock.start();
        MiniGlider glider([&] { return glideClock.elapsed(); },
                          [&] { return output.shrunkBy(watch.reserved().value_or(QMargins())); });
        MiniPlacement::Layer state;
        QPoint lastGlideFrame;
        // Every placement the compositor model saw since the last "path" command.
        QStringList path;
        bool awaitingLanding = false;
        auto record = [&] {
            const QPoint at = MiniPlacement::resolve(state, output.shrunkBy(truth), MiniPlacement::side);
            path << QStringLiteral("%1,%2").arg(at.x()).arg(at.y());
            if (state.anchors == (MiniPlacement::Top | MiniPlacement::Left)) lastGlideFrame = at;
        };
        if (mini) glider.attach({[&](const QMargins &m) { state.margins = m; record(); },
                                 [&](unsigned a) { state.anchors = a; record(); }}, QStringLiteral("top-right"));
        // Hover dodge as main.cpp wires it: the cursor in output coordinates minus the reserved
        // left/top is the usable-area cursor; "dodge on|off" stands for a mini attach / rebuild.
        MiniDodger dodger(glider, [&] { return glideClock.elapsed(); },
                          [&] { return output.shrunkBy(watch.reserved().value_or(QMargins())); },
                          [&](MiniDodger::Answer done) {
                              return watch.queryCursor([&watch, done](std::optional<QPoint> p) {
                                  const QMargins r = watch.reserved().value_or(QMargins());
                                  done(p ? std::optional<QPoint>(*p - QPoint(r.left(), r.top())) : std::nullopt);
                              });
                          },
                          [&] { return mini; }, [&](const QString &line) {
                              out("MINI " + line);
                              awaitingLanding = true;
                          });
        QTimer landing;
        QObject::connect(&landing, &QTimer::timeout, [&] {
            if (!awaitingLanding || glider.gliding()) return;
            awaitingLanding = false;
            const QPoint rest = MiniPlacement::resolve(state, output.shrunkBy(truth), MiniPlacement::side);
            out(QStringLiteral("LANDED %1,%2 REST %3,%4").arg(lastGlideFrame.x()).arg(lastGlideFrame.y()).arg(rest.x()).arg(rest.y()));
        });
        landing.start(5);
        // Commands on stdin, one per line: start, reserved, gap, coverage on|off, glide <pos>, cursor,
        // dodge on|off, path.
        QSocketNotifier input(0, QSocketNotifier::Read);
        QByteArray pending;
        QObject::connect(&input, &QSocketNotifier::activated, [&] {
            char buffer[256];
            const ssize_t n = ::read(0, buffer, sizeof buffer);
            if (n <= 0) { input.setEnabled(false); return; }
            pending.append(buffer, n);
            for (qsizetype end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
                const QByteArray command = pending.left(end).trimmed();
                pending.remove(0, end + 1);
                if (command == "start") watch.start();
                else if (command == "coverage on") watch.setCoverage(true);
                else if (command == "coverage off") watch.setCoverage(false);
                else if (command == "dodge on") dodger.start();
                else if (command == "dodge off") dodger.stop();
                else if (command == "path") {
                    out("PATH " + path.join(u' '));
                    path.clear();
                }
                else if (command == "cursor") {
                    // Hover dodge: one asynchronous j/cursorpos, in output coordinates.
                    QElapsedTimer call;
                    call.start();
                    const bool asked = watch.queryCursor([](std::optional<QPoint> p) {
                        out(p ? QStringLiteral("CURSOR %1,%2").arg(p->x()).arg(p->y()) : QStringLiteral("CURSOR none"));
                    });
                    out(QStringLiteral("CURSOR_US %1").arg(call.nsecsElapsed() / 1000));
                    if (!asked) out("CURSOR unavailable");
                }
                else if (command.startsWith("glide ")) {
                    QElapsedTimer call;
                    call.start();
                    glider.glideTo(QString::fromLatin1(command.mid(6)));
                    out(QStringLiteral("GLIDE_US %1").arg(call.nsecsElapsed() / 1000));
                    awaitingLanding = true;
                }
                else if (command == "reserved") {
                    QElapsedTimer read;
                    read.start();
                    const std::optional<QMargins> r = watch.reserved();
                    const qint64 us = read.nsecsElapsed() / 1000;
                    out(r ? QStringLiteral("RESERVED %1,%2,%3,%4").arg(r->left()).arg(r->top()).arg(r->right()).arg(r->bottom())
                          : QStringLiteral("RESERVED none"));
                    out(QStringLiteral("READ_US %1").arg(us));
                } else if (command == "gap") {
                    out(QStringLiteral("GAP %1").arg(qMax(maxGap, clock.elapsed() - last)));
                    maxGap = 0;
                }
            }
        });
        watch.start();
        watch.start(); // idempotent
        QTimer::singleShot(args.value(2).toInt(), &app, &QCoreApplication::quit);
        return app.exec();
    }
    return 2;
}
`;
    writeFileSync(join(fixture, 'CMakeLists.txt'), cmake);
    writeFileSync(join(fixture, 'harness.cpp'), harness);
    for (const args of [['-S', fixture, '-B', join(fixture, 'build')], ['--build', join(fixture, 'build'), '-j2']]) {
        const result = spawnSync('cmake', args, { encoding: 'utf8', timeout: 240000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
});

after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const monitor = (name, active, special = 0, reserved = [0, 0, 0, 0]) => ({ name, activeWorkspace: { id: active, name: String(active) },
    specialWorkspace: { id: special, name: special ? 'special:magic' : '' }, reserved });
const client = (workspace, fullscreen, extra = {}) => ({ workspace: { id: workspace, name: String(workspace) },
    fullscreen, fullscreenClient: 0, mapped: true, hidden: false, ...extra });

// A fake Hyprland instance: $XDG_RUNTIME_DIR/hypr/<signature>/{.socket.sock,.socket2.sock}.
// `runtime` reuses another instance's XDG_RUNTIME_DIR (a restarted Hyprland: same runtime dir, new
// signature); `state.delayMonitors` holds the j/monitors answer back for that many ms.
async function fakeHyprland(state, runtime = join(fixture, `run-${++counter}`)) {
    const signature = `cielinux-test-${process.pid}-${++counter}`;
    const dir = join(runtime, 'hypr', signature);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `waits`: per request connection, ms from accepting it to its first command byte (B13).
    const requests = [], times = [], events = [], waits = [];
    // Cursor requests open right now, and the most ever open at once.
    let cursorOpen = 0, cursorMaxOpen = 0;
    const request = createServer(socket => {
        let text = '';
        const accepted = Date.now();
        socket.on('data', chunk => {
            if (!text) waits.push(Date.now() - accepted);
            text += chunk;
            requests.push(text);
            times.push(Date.now());
            // `failMonitors` / `failClients`: that many next answers to the request are unreadable.
            if (text === 'j/monitors' && state.failMonitors > 0) { state.failMonitors--; socket.end('ok? not json'); }
            else if (text === 'j/clients' && state.failClients > 0) { state.failClients--; socket.end('ok? not json'); }
            else if (state.garbage) socket.end('ok? not json');
            else if (text === 'j/monitors' && state.delayMonitors)
                setTimeout(() => socket.end(JSON.stringify(state.monitors)), state.delayMonitors);
            else if (text === 'j/monitors') socket.end(JSON.stringify(state.monitors));
            else if (text === 'j/clients') socket.end(JSON.stringify(state.clients));
            // `cursor`: the j/cursorpos answer (a string is sent as is), held back `delayCursor` ms.
            else if (text === 'j/cursorpos' && state.cursor !== undefined) {
                cursorMaxOpen = Math.max(cursorMaxOpen, ++cursorOpen);
                socket.on('close', () => cursorOpen--);
                const body = typeof state.cursor === 'string' ? state.cursor : JSON.stringify(state.cursor);
                if (state.delayCursor) setTimeout(() => socket.end(body), state.delayCursor);
                else socket.end(body);
            }
            else socket.end('unknown request');
        });
        socket.on('error', () => {});
    });
    const event = createServer(socket => { events.push(socket); socket.on('error', () => {}); });
    await new Promise(resolve => request.listen(join(dir, '.socket.sock'), resolve));
    await new Promise(resolve => event.listen(join(dir, '.socket2.sock'), resolve));
    return {
        env: { XDG_RUNTIME_DIR: runtime, HYPRLAND_INSTANCE_SIGNATURE: signature },
        runtime,
        dir,
        requests,
        times,
        waits,
        cursorMaxOpen: () => cursorMaxOpen,
        emit: (...lines) => { for (const socket of events) socket.write(lines.map(l => l + '\n').join('')); },
        dropEvents: () => { for (const socket of events) socket.destroy(); },
        close: () => { request.close(); event.close(); for (const socket of events) socket.destroy(); },
        // Hyprland exiting cleanly: sockets closed and its instance directory removed.
        exit: () => {
            request.close(); event.close();
            for (const socket of events) socket.destroy();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

// B13: real Hyprland reads a .socket.sock command synchronously on its main thread right after
// accepting the connection (HyprCtl.cpp hyprCtlFDTick: poll(fd, POLLIN, 5000)), so the whole
// compositor waits until the command arrives. The watch must therefore send it at once, not on a
// later loop turn: in the real app a blocked GUI thread (QtWebEngine's first EGL init waiting on a
// Wayland roundtrip) and that wait deadlocked for 5 s at every start.
test('watch: a request command goes out at connect time, even when the loop is about to stall', async () => {
    const state = { monitors: [monitor('DP-1', 1)], clients: [client(1, 2)] };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1', 20000, [], [], { CIELINUX_TEST_STALL_AFTER_STARTED_MS: '1500' });
    try {
        await watch.waitFor('COVERED 1', 0, 6000);
        assert.deepEqual(hypr.requests, ['j/monitors', 'j/clients']);
        assert.ok(hypr.waits[0] < 300, `j/monitors sent ${hypr.waits[0]} ms after the connection was accepted`);
        assert.ok(hypr.waits.every(w => w < 300), JSON.stringify(hypr.waits));
    } finally {
        await watch.stop();
        hypr.close();
    }
});

// A crashed instance left behind: a directory with socket files nobody listens on.
async function staleInstance(runtime) {
    const dir = join(runtime, 'hypr', `cielinux-test-stale-${process.pid}-${++counter}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of ['.socket.sock', '.socket2.sock']) {
        const server = createServer();
        await new Promise(resolve => server.listen(join(dir, `${name}.live`), resolve));
        // Renamed away from the listening path, the socket file survives the close, dead.
        renameSync(join(dir, `${name}.live`), join(dir, name));
        await new Promise(resolve => server.close(resolve));
    }
    return dir;
}

function startWatch(env, monitorName, ms = 20000, retry = [], extra = [], testEnv = {}) {
    const childEnv = { ...process.env, QT_QPA_PLATFORM: 'offscreen', QT_FORCE_STDERR_LOGGING: '1', ...env, ...testEnv };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
    const child = spawn(binary, ['watch', monitorName, String(ms), ...retry.map(String), ...extra.map(String)], { env: childEnv });
    const lines = [];
    let pending = '';
    child.stdout.on('data', chunk => {
        pending += chunk;
        const parts = pending.split('\n');
        pending = parts.pop();
        lines.push(...parts);
    });
    const exited = new Promise(resolve => child.on('exit', resolve));
    return {
        lines,
        exited,
        // Index of `line` (or of the first line `match` accepts) at or after `from`.
        async waitFor(line, from = 0, timeout = 5000, match = null) {
            const start = Date.now();
            for (;;) {
                const index = match ? lines.findIndex((l, i) => i >= from && match(l)) : lines.indexOf(line, from);
                if (index >= 0) return index;
                if (Date.now() - start > timeout) assert.fail(`timed out waiting for "${line}"; got ${JSON.stringify(lines)}`);
                await sleep(20);
            }
        },
        send(command) { child.stdin.write(command + '\n'); },
        count(line) { return lines.filter(l => l === line).length; },
        stop() { child.kill('SIGTERM'); return exited; },
    };
}

function parse(monitors, clients, name) {
    const dir = mkdtempSync(join(fixture, 'parse-'));
    writeFileSync(join(dir, 'm.json'), typeof monitors === 'string' ? monitors : JSON.stringify(monitors));
    writeFileSync(join(dir, 'c.json'), typeof clients === 'string' ? clients : JSON.stringify(clients));
    const result = spawnSync(binary, ['parse', join(dir, 'm.json'), join(dir, 'c.json'), name], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

test('coverage rule: a true fullscreen window on a workspace this monitor shows', () => {
    const monitors = [monitor('DP-1', 1), monitor('HDMI-A-2', 3)];
    assert.equal(parse(monitors, [client(1, 2)], 'DP-1'), 'COVERED 1');
    assert.equal(parse(monitors, [client(1, 3)], 'DP-1'), 'COVERED 1', 'maximised + fullscreen bits');
    // Maximised only (Hyprland fullscreen mode 1) leaves the bars and is not fullscreen (CielWin rule).
    assert.equal(parse(monitors, [client(1, 1)], 'DP-1'), 'COVERED 0');
    assert.equal(parse(monitors, [client(1, 0)], 'DP-1'), 'COVERED 0');
    // Another monitor's fullscreen window, or one on a workspace not shown, covers nothing here.
    assert.equal(parse(monitors, [client(3, 2)], 'DP-1'), 'COVERED 0');
    assert.equal(parse(monitors, [client(3, 2)], 'HDMI-A-2'), 'COVERED 1');
    assert.equal(parse(monitors, [client(2, 2)], 'DP-1'), 'COVERED 0');
    // A shown special workspace counts; the same workspace hidden (special id 0) does not.
    assert.equal(parse([monitor('DP-1', 1, -98)], [client(-98, 2)], 'DP-1'), 'COVERED 1');
    assert.equal(parse([monitor('DP-1', 1)], [client(-98, 2)], 'DP-1'), 'COVERED 0');
    // Unmapped or hidden (e.g. an inactive group member) windows are not on screen.
    assert.equal(parse(monitors, [client(1, 2, { mapped: false })], 'DP-1'), 'COVERED 0');
    assert.equal(parse(monitors, [client(1, 2, { hidden: true })], 'DP-1'), 'COVERED 0');
    assert.equal(parse(monitors, [client(1, 0), client(1, 2)], 'DP-1'), 'COVERED 1');
    // Unreadable answers are "unknown", never a guess.
    assert.equal(parse(monitors, [client(1, 2)], 'eDP-1'), 'NULL', 'monitor not listed');
    assert.equal(parse('not json', [client(1, 2)], 'DP-1'), 'NULL');
    assert.equal(parse(monitors, '{"a":1}', 'DP-1'), 'NULL');
    assert.equal(parse([{ name: 'DP-1' }], [], 'DP-1'), 'NULL', 'no activeWorkspace');
});

test('watch: initial query on start, then follows fullscreen and workspace events', async () => {
    const state = { monitors: [monitor('DP-1', 1), monitor('HDMI-A-2', 3)], clients: [client(1, 2)] };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1');
    try {
        let at = await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1');
        at = await watch.waitFor('COVERED 1', at);
        assert.ok(watch.lines.includes('TRACE covered monitor=DP-1'));
        state.clients[0].fullscreen = 0;
        hypr.emit('fullscreen>>0');
        at = await watch.waitFor('COVERED 0', at);
        assert.ok(watch.lines.includes('TRACE uncovered monitor=DP-1'));
        state.clients[0].fullscreen = 2;
        hypr.emit('fullscreen>>1');
        at = await watch.waitFor('COVERED 1', at);
        // Switching this monitor to another workspace uncovers it, and back covers it again.
        state.monitors[0].activeWorkspace = { id: 2, name: '2' };
        hypr.emit('workspacev2>>2,2', 'workspace>>2');
        at = await watch.waitFor('COVERED 0', at);
        state.monitors[0].activeWorkspace = { id: 1, name: '1' };
        hypr.emit('workspacev2>>1,1');
        at = await watch.waitFor('COVERED 1', at);
        // The fullscreen window closing uncovers it.
        state.clients = [];
        hypr.emit('closewindow>>57c4b5ef24e0');
        at = await watch.waitFor('COVERED 0', at);
        assert.equal(watch.lines.filter(l => l.startsWith('TRACE fullscreen-watch started')).length, 1, 'start() is idempotent');
        assert.ok(!watch.lines.some(l => l.includes('unavailable') || l.includes('failed')), JSON.stringify(watch.lines));
    } finally {
        await watch.stop();
        hypr.close();
    }
});

test('watch: event driven - no queries while idle, unrelated events ignored, a burst is coalesced', async () => {
    const state = { monitors: [monitor('DP-1', 1)], clients: [] };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1');
    try {
        await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1');
        await sleep(1200);
        assert.deepEqual(hypr.requests, ['j/monitors', 'j/clients'], 'exactly one initial query, no polling');
        hypr.emit('activelayout>>keyboard,English (US)', 'activewindow>>kitty,~', 'submap>>');
        await sleep(400);
        assert.equal(hypr.requests.length, 2, 'events that cannot change coverage trigger no query');
        hypr.emit('fullscreen>>1', 'fullscreen>>0', 'workspacev2>>2,2', 'focusedmon>>DP-1,2', 'fullscreen>>1');
        await sleep(600);
        assert.ok(hypr.requests.length >= 4 && hypr.requests.length <= 6,
            `a burst of 5 events costs one or two queries, got ${JSON.stringify(hypr.requests)}`);
        assert.ok(!watch.lines.includes('COVERED 1'));
    } finally {
        await watch.stop();
        hypr.close();
    }
});

test('watch: degrades without Hyprland - one log line, never covered', async () => {
    for (const env of [
        { HYPRLAND_INSTANCE_SIGNATURE: undefined, XDG_RUNTIME_DIR: join(fixture, 'empty-a') },
        { HYPRLAND_INSTANCE_SIGNATURE: `cielinux-test-absent-${process.pid}`, XDG_RUNTIME_DIR: join(fixture, 'empty-b') },
        { HYPRLAND_INSTANCE_SIGNATURE: '../escape', XDG_RUNTIME_DIR: join(fixture, 'empty-c') },
    ]) {
        const watch = startWatch(env, 'DP-1', 600);
        await watch.exited;
        assert.deepEqual(watch.lines, ['TRACE fullscreen-watch unavailable reason=no-hyprland-socket'], JSON.stringify(env));
    }
});

test('watch: losing the event socket or a failed query reads as uncovered (CielWin IsCovered)', async () => {
    const state = { monitors: [monitor('DP-1', 1)], clients: [client(1, 2)] };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1');
    try {
        let at = await watch.waitFor('COVERED 1');
        state.garbage = true;
        hypr.emit('fullscreen>>1');
        at = await watch.waitFor('COVERED 0', at);
        assert.ok(watch.lines.includes('TRACE fullscreen-watch query-failed'));
        // Only the first failure of a streak is logged.
        hypr.emit('fullscreen>>0');
        await sleep(400);
        assert.equal(watch.lines.filter(l => l === 'TRACE fullscreen-watch query-failed').length, 1);
        state.garbage = false;
        hypr.emit('fullscreen>>1');
        at = await watch.waitFor('COVERED 1', at);
        hypr.dropEvents();
        at = await watch.waitFor('TRACE fullscreen-watch lost', at);
        await watch.waitFor('COVERED 0', at);
    } finally {
        await watch.stop();
        hypr.close();
    }
});

// B12: every real start logged one `query-failed` a few seconds after `started`: the first query went
// out, then QtWebEngine's startup blocked the GUI loop for ~5 s, and when the loop came back the
// request's 1 s timeout fired before (or right as) the answer was read; with no retry the result
// (uncovered) stood until the next Hyprland event. Now a stalled loop does not count toward the
// timeout, and a failed query is retried with a short bounded backoff until one succeeds.
const jsonRequests = (hypr, name) => hypr.requests.map((r, i) => ({ r, t: hypr.times[i] })).filter(x => x.r === name);

test('watch: a failed query is retried with bounded backoff until it succeeds, no Hyprland event needed', async () => {
    const state = { monitors: [monitor('DP-1', 1)], clients: [client(1, 2)], failClients: 3 };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1');
    try {
        let at = await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1');
        // No event is ever emitted: the fullscreen window present at start is found by the retries.
        at = await watch.waitFor('COVERED 1', at, 6000);
        assert.equal(watch.count('TRACE fullscreen-watch query-failed'), 1, 'one line per failure streak');
        assert.equal(watch.count('TRACE fullscreen-watch query-recovered'), 1);
        const failed = watch.lines.indexOf('TRACE fullscreen-watch query-failed');
        const recovered = watch.lines.indexOf('TRACE fullscreen-watch query-recovered');
        assert.ok(failed < recovered && recovered < watch.lines.indexOf('TRACE covered monitor=DP-1'), JSON.stringify(watch.lines));
        // 1 initial query + 3 retries after 250, 500, 1000 ms (each a full j/monitors + j/clients query;
        // a coarse QTimer may fire up to 5 % early).
        const starts = jsonRequests(hypr, 'j/monitors').map(x => x.t);
        assert.equal(starts.length, 4, JSON.stringify(hypr.requests));
        assert.equal(jsonRequests(hypr, 'j/clients').length, 4);
        const waits = starts.slice(1).map((t, i) => t - starts[i]);
        [250, 500, 1000].forEach((expected, i) =>
            assert.ok(waits[i] >= expected * 0.9 && waits[i] < expected + 400, `retry ${i + 1} after ${waits[i]} ms, expected ~${expected}`));
        // A success resets the backoff: the next failure is retried after 250 ms again, and logged again.
        state.failClients = 1;
        hypr.emit('fullscreen>>1');
        at = await watch.waitFor('TRACE fullscreen-watch query-failed', at);
        const before = jsonRequests(hypr, 'j/monitors').length;
        at = await watch.waitFor('TRACE fullscreen-watch query-recovered', at, 3000);
        await watch.waitFor('COVERED 1', at);
        const again = jsonRequests(hypr, 'j/monitors').map(x => x.t);
        assert.equal(again.length, before + 1);
        const wait = again.at(-1) - again.at(-2);
        assert.ok(wait >= 220 && wait < 650, `backoff restarted at 250 ms, waited ${wait} ms`);
        assert.equal(watch.lines.at(-1), 'COVERED 1', JSON.stringify(watch.lines));
        assert.equal(watch.count('TRACE fullscreen-watch query-failed'), 2);
    } finally {
        await watch.stop();
        hypr.close();
    }
});

test('watch: query retries double up to the cap, stay quiet, and stop when the event socket is lost', async () => {
    const state = { monitors: [monitor('DP-1', 1)], clients: [client(1, 2)], garbage: true };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1', 20000, [5000, 5000], [], { CIELINUX_TEST_QUERY_RETRY: '20,80' });
    try {
        await watch.waitFor('TRACE fullscreen-watch query-failed');
        await sleep(900);
        const starts = jsonRequests(hypr, 'j/monitors').map(x => x.t);
        const waits = starts.slice(1).map((t, i) => t - starts[i]);
        // 20, 40, 80, 80, ...: bounded, never a busy loop, never longer than the cap (plus slack).
        assert.ok(starts.length >= 6 && starts.length <= 16, `${starts.length} attempts in ~1 s: ${waits}`);
        assert.ok(waits.slice(3).every(w => w >= 70 && w < 200), `capped at 80 ms: ${waits}`);
        assert.equal(watch.count('TRACE fullscreen-watch query-failed'), 1, 'retries are silent');
        assert.ok(!watch.lines.includes('COVERED 1'));
        watch.send('gap');
        const gap = Number(watch.lines[await watch.waitFor('GAP', 0, 2000, l => l.startsWith('GAP '))].split(' ')[1]);
        assert.ok(gap < 200, `event loop stays live while retrying, max gap ${gap} ms`);
        // Hyprland goes away: the reconnect path takes over (5 s first delay here), query retries stop.
        hypr.exit();
        await watch.waitFor('TRACE fullscreen-watch lost');
        await sleep(100);
        const count = hypr.requests.length;
        await sleep(500);
        assert.equal(hypr.requests.length, count, 'no query retry after the event socket is lost');
    } finally {
        await watch.stop();
        hypr.close();
    }
});

test('watch: an event-loop stall longer than the request timeout is not a failed query', async () => {
    const state = { monitors: [monitor('DP-1', 1)], clients: [client(1, 2)] };
    const hypr = await fakeHyprland(state);
    // The first query is in flight when the loop blocks for 1.5 s; Hyprland answers at once.
    const watch = startWatch(hypr.env, 'DP-1', 20000, [], [], { CIELINUX_TEST_STALL_AFTER_STARTED_MS: '1500' });
    try {
        await watch.waitFor('COVERED 1', 0, 6000);
        watch.send('gap');
        const gap = Number(watch.lines[await watch.waitFor('GAP', 0, 2000, l => l.startsWith('GAP '))].split(' ')[1]);
        assert.ok(gap >= 1400, `the loop really stalled (${gap} ms)`);
        assert.deepEqual(watch.lines.filter(l => l.startsWith('TRACE')),
            ['TRACE fullscreen-watch started monitor=DP-1', 'TRACE covered monitor=DP-1']);
        assert.deepEqual(hypr.requests, ['j/monitors', 'j/clients'], 'answered by the first query, no retry');
    } finally {
        await watch.stop();
        hypr.close();
    }
});

test('watch: coverage off (mini) retries its failed j/monitors query too', async () => {
    const state = { monitors: [monitor('DP-1', 1, 0, [0, 0, 37, 0])], clients: [client(1, 2)], failMonitors: 2 };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1', 20000, [40, 160], ['mini', 1920, 1080, 37, 0]);
    try {
        let at = await watch.waitFor('TRACE fullscreen-watch query-recovered', 0, 4000);
        watch.send('reserved');
        at = await watch.waitFor('RESERVED', at, 2000, l => l.startsWith('RESERVED '));
        assert.equal(watch.lines[at], 'RESERVED 0,0,37,0');
        assert.deepEqual(hypr.requests, ['j/monitors', 'j/monitors', 'j/monitors'], 'j/monitors only, retried without an event');
        assert.equal(watch.count('TRACE fullscreen-watch query-failed'), 1);
        assert.ok(!watch.lines.some(l => l.startsWith('COVERED') || /TRACE (un)?covered/.test(l)), JSON.stringify(watch.lines));
    } finally {
        await watch.stop();
        hypr.close();
    }
});

// B8: a restarted Hyprland comes back under a new signature in the same runtime dir; the
// process environment still names the old one, so the new instance is discovered there.
test('watch: follows a restarted Hyprland - one lost, one reconnected, coverage re-queried', async () => {
    const state = { monitors: [monitor('DP-1', 1)], clients: [client(1, 2)] };
    const first = await fakeHyprland(state);
    const watch = startWatch(first.env, 'DP-1', 20000, [40, 160]);
    let second;
    try {
        let at = await watch.waitFor('COVERED 1');
        first.exit();
        at = await watch.waitFor('TRACE fullscreen-watch lost', at);
        at = await watch.waitFor('COVERED 0', at);
        // Several retries fail meanwhile (40, 80, 160, 160 ms...): none of them is logged.
        await sleep(700);
        assert.deepEqual(watch.lines.slice(at + 1), [], 'no log line per retry');
        // A crashed instance newer than the live one is skipped: only a connectable socket counts.
        second = await fakeHyprland(state, first.runtime);
        await sleep(20);
        await staleInstance(first.runtime);
        at = await watch.waitFor('TRACE fullscreen-watch reconnected monitor=DP-1', at);
        at = await watch.waitFor('COVERED 1', at);
        assert.deepEqual(second.requests.slice(0, 2), ['j/monitors', 'j/clients'], 'coverage re-queried on reconnect');
        // The discovered instance serves both the events and the queries.
        state.clients[0].fullscreen = 0;
        second.emit('fullscreen>>0');
        at = await watch.waitFor('COVERED 0', at);
        assert.equal(watch.count('TRACE fullscreen-watch lost'), 1);
        assert.equal(watch.count('TRACE fullscreen-watch reconnected monitor=DP-1'), 1);
        assert.ok(!watch.lines.some(l => l.includes('unavailable') || l.includes('failed')), JSON.stringify(watch.lines));
        // A plain drop of the event socket (same instance still up) also comes back.
        second.dropEvents();
        at = await watch.waitFor('TRACE fullscreen-watch lost', at);
        await watch.waitFor('TRACE fullscreen-watch reconnected monitor=DP-1', at);
    } finally {
        await watch.stop();
        second?.close();
    }
});

test('watch: retries back off up to the cap and stay silent while Hyprland is away', async () => {
    const state = { monitors: [monitor('DP-1', 1)], clients: [] };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1', 20000, [30, 120]);
    try {
        await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1');
        hypr.exit();
        await watch.waitFor('TRACE fullscreen-watch lost');
        // 30 + 60 + 120 + 120 + ... ms: a bounded number of attempts, not a busy loop.
        await sleep(1000);
        assert.deepEqual(watch.lines.filter(l => l.startsWith('TRACE')),
            ['TRACE fullscreen-watch started monitor=DP-1', 'TRACE fullscreen-watch lost']);
        watch.send('gap');
        const gap = Number(watch.lines[await watch.waitFor('GAP', 0, 2000, l => l.startsWith('GAP '))].split(' ')[1]);
        assert.ok(gap < 200, `event loop stays live while retrying, max gap ${gap} ms`);
    } finally {
        await watch.stop();
    }
});

test('watch: Hyprland unavailable at start is picked up later with the same backoff', async () => {
    const runtime = join(fixture, `run-late-${++counter}`);
    mkdirSync(runtime, { recursive: true });
    const watch = startWatch({ HYPRLAND_INSTANCE_SIGNATURE: undefined, XDG_RUNTIME_DIR: runtime }, 'DP-1', 20000, [40, 160]);
    let hypr;
    try {
        let at = await watch.waitFor('TRACE fullscreen-watch unavailable reason=no-hyprland-socket');
        await sleep(400);
        hypr = await fakeHyprland({ monitors: [monitor('DP-1', 1)], clients: [client(1, 2)] }, runtime);
        at = await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1', at);
        await watch.waitFor('COVERED 1', at);
        assert.equal(watch.count('TRACE fullscreen-watch unavailable reason=no-hyprland-socket'), 1, 'logged once');
    } finally {
        await watch.stop();
        hypr?.close();
    }
});

// B11: stop() is gone (B10 keeps the watch running in both modes); what still ends the watch is the
// app exiting, and that teardown must stay quiet: no `lost`, no uncovered, no retry, a clean exit,
// even with a query still waiting for Hyprland's answer.
test('watch: exit tears down quietly (no lost, no uncovered, exit 0), also with a query in flight', async () => {
    const state = { monitors: [monitor('DP-1', 1)], clients: [client(1, 2)] };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1', 800);
    try {
        await watch.waitFor('COVERED 1');
        state.delayMonitors = 1500;
        hypr.emit('openlayer>>waybar'); // its j/monitors answer is still pending when the app quits
        assert.equal(await watch.exited, 0);
        assert.ok(hypr.requests.filter(r => r === 'j/monitors').length >= 2, JSON.stringify(hypr.requests));
        assert.deepEqual(watch.lines, ['TRACE fullscreen-watch started monitor=DP-1', 'TRACE covered monitor=DP-1', 'COVERED 1']);
    } finally {
        hypr.close();
    }
});

// B11: Hyprland connection lines can appear in both modes, so they carry a mode-neutral prefix;
// coverage lines are about the wallpaper only.
test('log prefix: watch lifecycle lines are CIELINUX_HYPRLAND, coverage lines CIELINUX_WALLPAPER', () => {
    const lines = ['fullscreen-watch started monitor=DP-1', 'fullscreen-watch lost', 'fullscreen-watch reconnected monitor=DP-1',
        'fullscreen-watch unavailable reason=no-hyprland-socket', 'fullscreen-watch unavailable reason=connect-failed',
        'fullscreen-watch coverage on monitor=DP-1', 'fullscreen-watch coverage off monitor=DP-1', 'fullscreen-watch query-failed',
        'fullscreen-watch query-recovered', 'covered monitor=DP-1', 'uncovered monitor=DP-1'];
    const result = spawnSync(binary, ['prefix', ...lines], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
        ...lines.slice(0, 9).map(l => `CIELINUX_HYPRLAND ${l}`),
        'CIELINUX_WALLPAPER covered monitor=DP-1', 'CIELINUX_WALLPAPER uncovered monitor=DP-1']);
});

// B9: the wallpaper alert's work area comes from a cached copy of the output's reserved zones,
// refreshed from the watch's own asynchronous j/monitors answers, never a blocking request.
test('watch: caches the reserved zones from its j/monitors answers, refreshed on layer and config events', async () => {
    const state = { monitors: [monitor('DP-1', 1, 0, [0, 30, 0, 0]), monitor('HDMI-A-2', 3, 0, [0, 0, 37, 0])], clients: [] };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1');
    const reserved = async from => {
        watch.send('reserved');
        const at = await watch.waitFor('RESERVED', from, 2000, l => l.startsWith('RESERVED '));
        return watch.lines[at];
    };
    try {
        await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1');
        await sleep(200);
        assert.equal(await reserved(0), 'RESERVED 0,30,0,0');
        // Waybar closing (closelayer) frees the top edge; a config reload or Waybar coming back
        // (openlayer) changes it again. Each is one query, no polling.
        state.monitors[0].reserved = [0, 0, 0, 0];
        hypr.emit('closelayer>>waybar');
        await sleep(300);
        assert.equal(await reserved(watch.lines.length), 'RESERVED 0,0,0,0');
        state.monitors[0].reserved = [0, 26, 0, 0];
        hypr.emit('openlayer>>waybar');
        await sleep(300);
        assert.equal(await reserved(watch.lines.length), 'RESERVED 0,26,0,0');
        state.monitors[0].reserved = [0, 0, 0, 40];
        hypr.emit('configreloaded>>');
        await sleep(300);
        assert.equal(await reserved(watch.lines.length), 'RESERVED 0,0,0,40');
        // An unreadable answer keeps the last known value.
        state.garbage = true;
        hypr.emit('openlayer>>notifications');
        await sleep(300);
        assert.equal(await reserved(watch.lines.length), 'RESERVED 0,0,0,40');
    } finally {
        await watch.stop();
        hypr.close();
    }
});

test('watch: a slow j/monitors answer never stalls the event loop or the reserved read', async () => {
    const state = { monitors: [monitor('DP-1', 1, 0, [0, 30, 0, 0])], clients: [] };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1');
    try {
        await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1');
        await sleep(200);
        state.delayMonitors = 700;
        state.monitors[0].reserved = [0, 0, 0, 25];
        hypr.emit('openlayer>>waybar');
        await sleep(120);
        watch.send('gap');
        watch.send('reserved');
        let at = await watch.waitFor('RESERVED', 0, 2000, l => l.startsWith('RESERVED '));
        // While the answer is held back the cached value answers at once.
        assert.equal(watch.lines[at], 'RESERVED 0,30,0,0');
        const readUs = Number(watch.lines[await watch.waitFor('READ_US', at, 2000, l => l.startsWith('READ_US '))].split(' ')[1]);
        assert.ok(readUs < 5000, `reserved() is a plain read, took ${readUs} us`);
        await sleep(400);
        watch.send('gap');
        await sleep(100);
        const gaps = watch.lines.filter(l => l.startsWith('GAP ')).map(l => Number(l.split(' ')[1]));
        assert.equal(gaps.length, 2);
        assert.ok(gaps.every(g => g < 150), `event loop stays live while j/monitors is pending: ${gaps}`);
        await sleep(400);
        watch.send('reserved');
        at = await watch.waitFor('RESERVED', at + 2, 2000, l => l.startsWith('RESERVED '));
        assert.equal(watch.lines[at], 'RESERVED 0,0,0,25', 'refreshed once the answer arrives');
    } finally {
        await watch.stop();
        hypr.close();
    }
});

// B10: in the mini the watch keeps running for the reserved zones only. The mini is never covered
// (it sits on the top layer): no j/clients query, no covered/uncovered line, window events cost
// nothing; bar and config events still refresh the cache. Coverage on (switch to the wallpaper)
// asks at once.
test('watch: coverage off (mini) keeps the reserved cache fresh without coverage queries or logs', async () => {
    const state = { monitors: [monitor('DP-1', 1, 0, [0, 0, 37, 0])], clients: [client(1, 2)] };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1', 20000, [40, 160], ['mini', 1920, 1080, 37, 0]);
    try {
        let at = await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1');
        assert.equal(watch.lines.indexOf('TRACE fullscreen-watch coverage off monitor=DP-1'), 0, 'logged once, before start');
        await sleep(200);
        assert.deepEqual(hypr.requests, ['j/monitors'], 'no j/clients while coverage is off');
        watch.send('reserved');
        at = await watch.waitFor('RESERVED', at, 2000, l => l.startsWith('RESERVED '));
        assert.equal(watch.lines[at], 'RESERVED 0,0,37,0');
        // Window events cannot change the reserved zones: no query at all.
        hypr.emit('fullscreen>>1', 'workspacev2>>2,2', 'openwindow>>a,1,kitty,kitty', 'closewindow>>a');
        await sleep(300);
        assert.equal(hypr.requests.length, 1, JSON.stringify(hypr.requests));
        // A bar change still refreshes it, with j/monitors only.
        state.monitors[0].reserved = [0, 30, 0, 0];
        hypr.emit('openlayer>>waybar');
        await sleep(300);
        assert.deepEqual(hypr.requests, ['j/monitors', 'j/monitors']);
        watch.send('reserved');
        at = await watch.waitFor('RESERVED', at + 1, 2000, l => l.startsWith('RESERVED '));
        assert.equal(watch.lines[at], 'RESERVED 0,30,0,0');
        assert.ok(!watch.lines.some(l => l.startsWith('COVERED') || /TRACE (un)?covered/.test(l)), JSON.stringify(watch.lines));
        // Switch to the wallpaper: coverage asked at once (no event needed), reported as usual.
        watch.send('coverage on');
        at = await watch.waitFor('TRACE fullscreen-watch coverage on monitor=DP-1', at);
        at = await watch.waitFor('COVERED 1', at);
        assert.ok(hypr.requests.includes('j/clients'));
        // Back to the mini: uncovered quietly (the mode switch re-evaluates), no further coverage.
        watch.send('coverage off');
        at = await watch.waitFor('TRACE fullscreen-watch coverage off monitor=DP-1', at);
        const clients = hypr.requests.filter(r => r === 'j/clients').length;
        state.clients = [];
        hypr.emit('closewindow>>a', 'closelayer>>waybar');
        await sleep(300);
        assert.equal(hypr.requests.filter(r => r === 'j/clients').length, clients);
        assert.deepEqual(watch.lines.slice(at + 1).filter(l => l.startsWith('TRACE') || l.startsWith('COVERED')), []);
        // Repeating the same setting logs nothing.
        watch.send('coverage off');
        await sleep(100);
        assert.equal(watch.count('TRACE fullscreen-watch coverage off monitor=DP-1'), 2);
        assert.ok(!watch.lines.some(l => l.includes('stopped') || l.includes('lost') || l.includes('failed')), JSON.stringify(watch.lines));
    } finally {
        await watch.stop();
        hypr.close();
    }
});

// B10: a mini glide (SUPER+Z) never waits for Hyprland. Its frame is the output minus the cached
// reserved zones; before the first answer the whole output is used (the resting place is still
// exact: anchors), afterwards the last glide frame is exactly where the window comes to rest.
test('mini glide: a slow j/monitors answer never blocks the glide; positions exact once known', async () => {
    const state = { monitors: [monitor('DP-1', 1, 0, [0, 0, 37, 0])], clients: [], delayMonitors: 500 };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1', 20000, [40, 160], ['mini', 1920, 1080, 37, 0]);
    const glide = async (position, from) => {
        watch.send(`glide ${position}`);
        const call = await watch.waitFor('GLIDE_US', from, 2000, l => l.startsWith('GLIDE_US '));
        const landed = await watch.waitFor('LANDED', call, 2000, l => l.startsWith('LANDED '));
        return { us: Number(watch.lines[call].split(' ')[1]), landed: watch.lines[landed], at: landed };
    };
    try {
        let at = await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1');
        await sleep(50);
        watch.send('gap');
        // j/monitors is still held back: the glide starts at once with the whole output.
        let move = await glide('right-center', at);
        assert.ok(move.us < 5000, `glideTo returned in ${move.us} us without waiting for Hyprland`);
        assert.equal(move.landed, 'LANDED 1664,420 REST 1627,420', 'fallback frame = whole output, rest still exact');
        watch.send('reserved');
        at = await watch.waitFor('RESERVED', move.at, 2000, l => l.startsWith('RESERVED '));
        assert.equal(watch.lines[at], 'RESERVED none', 'the answer is still pending');
        // Once the answer lands (500 ms), glides use the true usable area: no jump at the end.
        await sleep(600);
        watch.send('gap');
        await watch.waitFor('GAP', watch.lines.findIndex(l => l.startsWith('GAP ')) + 1, 2000, l => l.startsWith('GAP '));
        const gaps = watch.lines.filter(l => l.startsWith('GAP ')).map(l => Number(l.split(' ')[1]));
        assert.ok(gaps.length === 2 && gaps.every(g => g < 150), `event loop stayed live: ${gaps}`);
        const expected = { 'bottom-right': '1627,824', 'bottom-center': '821,824', 'top-right': '1627,16', 'right-center': '1627,420' };
        for (const [position, xy] of Object.entries(expected)) {
            move = await glide(position, at);
            at = move.at;
            assert.ok(move.us < 5000, `${position}: glideTo took ${move.us} us`);
            assert.equal(move.landed, `LANDED ${xy} REST ${xy}`, position);
        }
        assert.deepEqual(hypr.requests, ['j/monitors']);
    } finally {
        await watch.stop();
        hypr.close();
    }
});

// Hover dodge (mini): the cursor comes from an on-demand asynchronous j/cursorpos (global layout
// coordinates) mapped onto the output with the monitor's x/y from the cached j/monitors answer.
// One request per ask, never blocking, never polled by the watch itself, nothing logged.
test('cursor query: j/cursorpos mapped onto the output, asynchronous and quiet', async () => {
    const state = { monitors: [{ ...monitor('HDMI-A-1', 1), x: 0, y: 0 }, { ...monitor('DP-1', 2), x: 1920, y: 120 }],
        clients: [], cursor: { x: 2000, y: 300 } };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1', 20000, [40, 160], ['mini', 1920, 1080, 0, 0]);
    const ask = async from => {
        watch.send('cursor');
        const call = await watch.waitFor('CURSOR_US', from, 2000, l => l.startsWith('CURSOR_US '));
        const answer = await watch.waitFor('CURSOR', from, 3000, l => /^CURSOR (-?\d+,-?\d+|none|unavailable)$/.test(l));
        return { us: Number(watch.lines[call].split(' ')[1]), answer: watch.lines[answer], at: Math.max(call, answer) + 1 };
    };
    try {
        let at = await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1');
        await sleep(200); // the j/monitors answer (origin) is cached
        let q = await ask(at);
        assert.equal(q.answer, 'CURSOR 80,180');
        assert.ok(q.us < 5000, `queryCursor returned in ${q.us} us`);
        state.cursor = { x: 1900, y: 50 }; // on another output: still mapped, off this one
        q = await ask(q.at);
        assert.equal(q.answer, 'CURSOR -20,-70');
        // An unreadable answer is no cursor, quietly (no query-failed line, no retry).
        state.cursor = 'ok? not json';
        q = await ask(q.at);
        assert.equal(q.answer, 'CURSOR none');
        await sleep(300);
        assert.equal(hypr.requests.filter(r => r === 'j/cursorpos').length, 3, 'one request per ask, never on its own');
        assert.deepEqual(watch.lines.filter(l => l.startsWith('TRACE')),
            ['TRACE fullscreen-watch coverage off monitor=DP-1', 'TRACE fullscreen-watch started monitor=DP-1']);
        assert.ok(!watch.lines.some(l => l.includes('failed')), JSON.stringify(watch.lines));
    } finally {
        await watch.stop();
        hypr.close();
    }
});

test('cursor query: unavailable before the monitor origin is known and without Hyprland', async () => {
    const state = { monitors: [{ ...monitor('DP-1', 1), x: 0, y: 0 }], clients: [], cursor: { x: 5, y: 6 }, delayMonitors: 500 };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1', 20000, [40, 160], ['mini', 1920, 1080, 0, 0]);
    try {
        const at = await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1');
        watch.send('cursor');
        await watch.waitFor('CURSOR unavailable', at, 2000);
        await sleep(700);
        watch.send('cursor');
        await watch.waitFor('CURSOR 5,6', at, 2000);
    } finally {
        await watch.stop();
        hypr.close();
    }
    const none = startWatch({ XDG_RUNTIME_DIR: join(fixture, `empty-${++counter}`), HYPRLAND_INSTANCE_SIGNATURE: undefined },
        'DP-1', 20000, [40, 160], ['mini', 1920, 1080, 0, 0]);
    try {
        await none.waitFor('TRACE fullscreen-watch unavailable reason=no-hyprland-socket');
        none.send('cursor');
        await none.waitFor('CURSOR unavailable', 0, 2000);
        assert.equal(none.count('TRACE fullscreen-watch unavailable reason=no-hyprland-socket'), 1);
    } finally {
        await none.stop();
    }
});

// Hover dodge end to end: a fake Hyprland cursor near the mini glides it aside along a straight,
// jump-free path; lingering over its spot keeps it there; a far cursor brings it back after 400 ms.
// One cursor request at a time even when Hyprland is slow, the loop stays live, and stopping the
// dodge (a rebuild) ends the polling.
test('mini dodge: a near cursor glides the mini aside, a far one brings it back', async () => {
    const state = { monitors: [{ ...monitor('DP-1', 1, 0, [0, 0, 37, 0]), x: 1920, y: 0 }], clients: [],
        cursor: { x: 1920 + 100, y: 900 } };
    const hypr = await fakeHyprland(state);
    const watch = startWatch(hypr.env, 'DP-1', 20000, [40, 160], ['mini', 1920, 1080, 37, 0]);
    const asks = () => hypr.requests.filter(r => r === 'j/cursorpos').length;
    const path = async from => {
        watch.send('path');
        const at = await watch.waitFor('PATH', from, 2000, l => l.startsWith('PATH'));
        return { at: at + 1, points: watch.lines[at].split(' ').slice(1).map(p => p.split(',').map(Number)) };
    };
    try {
        let at = await watch.waitFor('TRACE fullscreen-watch started monitor=DP-1');
        await sleep(200);
        watch.send('gap');
        assert.equal(asks(), 0, 'the watch never polls the cursor by itself');
        watch.send('dodge on');
        await sleep(400);
        assert.ok(asks() >= 2, `polled while in the mini: ${asks()}`);
        assert.ok(!watch.lines.some(l => l.startsWith('MINI ')), 'a far cursor moves nothing');
        at = (await path(at)).at;
        // Near the top-right mini from the right: aside to the left.
        state.cursor = { x: 1920 + 1870, y: 136 };
        let line = await watch.waitFor('MINI dodge direction=left', at, 2000);
        let landed = await watch.waitFor('LANDED', line, 2000, l => l.startsWith('LANDED '));
        assert.equal(watch.lines[landed], 'LANDED 1355,16 REST 1355,16');
        let p = await path(landed);
        let x = 1627;
        for (const [px, py] of p.points) { assert.ok(py === 16 && px <= x && px >= 1355, JSON.stringify(p.points)); x = px; }
        // Lingering over its spot keeps it aside.
        state.cursor = { x: 1920 + 1700, y: 136 };
        await sleep(700);
        assert.equal(watch.count('MINI dodge return'), 0);
        state.cursor = { x: 1920 + 100, y: 900 };
        const far = Date.now();
        line = await watch.waitFor('MINI dodge return', p.at, 3000);
        assert.ok(Date.now() - far >= 380, `returned ${Date.now() - far} ms after the cursor left`);
        landed = await watch.waitFor('LANDED', line, 2000, l => l.startsWith('LANDED '));
        assert.equal(watch.lines[landed], 'LANDED 1627,16 REST 1627,16');
        p = await path(landed);
        x = 1355;
        for (const [px, py] of p.points) { assert.ok(py === 16 && px >= x && px <= 1627, JSON.stringify(p.points)); x = px; }
        assert.equal(watch.count('MINI dodge direction=left'), 1, 'one line per move, never per poll');
        // A slow Hyprland: the poll skips its ticks while a request is still due.
        state.delayCursor = 300;
        const before = asks();
        await sleep(1000);
        assert.ok(asks() - before <= 4, `${asks() - before} cursor requests in 1 s at 300 ms each`);
        assert.equal(hypr.cursorMaxOpen(), 1, 'never two cursor requests at once');
        state.delayCursor = 0;
        watch.send('gap');
        const gap = await watch.waitFor('GAP', 0, 2000, l => l.startsWith('GAP '));
        const second = await watch.waitFor('GAP', gap + 1, 2000, l => l.startsWith('GAP '));
        assert.ok(Number(watch.lines[second].split(' ')[1]) < 150, watch.lines[second]);
        // Stopped (a rebuild or mode switch): no more cursor requests.
        watch.send('dodge off');
        await sleep(400);
        const stopped = asks();
        await sleep(400);
        assert.equal(asks(), stopped);
        assert.ok(!watch.lines.some(l => l.includes('failed') || l.includes('lost')), JSON.stringify(watch.lines));
    } finally {
        await watch.stop();
        hypr.close();
    }
});

test('B9 wiring: the wallpaper alert work area reads the cached reserved zones, never a blocking request', () => {
    const main = readFileSync(join(SRC, 'main.cpp'), 'utf8');
    const surface = main.slice(main.indexOf('const AlertSurface wallpaperAlerts{'), main.indexOf('auto alertSurface ='));
    assert.match(surface, /AlertWorkArea::forOutput\(screen->size\(\), fullscreenWatch\.reserved\(\)\.value_or\(QMargins\(\)\), screen->devicePixelRatio\(\)\)/);
    assert.doesNotMatch(surface, /hyprlandReserved/);
    assert.ok(main.indexOf('FullscreenWatch fullscreenWatch(') < main.indexOf('const AlertSurface wallpaperAlerts{'));
    // B10: the watch runs in both modes; coverage only in the wallpaper, set on start and per switch.
    assert.match(main, /fullscreenWatch\.setCoverage\(sceneHost\.mode\(\) == QStringLiteral\("scene"\)\);\s*fullscreenWatch\.start\(\);/);
    const hook = main.slice(main.indexOf('QString alertSurfaceMode'), main.indexOf('QTimer alertTick;'));
    assert.match(hook, /fullscreenWatch\.setCoverage\(sceneHost\.mode\(\) == QStringLiteral\("scene"\)\);/);
    assert.doesNotMatch(hook, /fullscreenWatch\.(stop|start)\(\)/);
    const watch = readFileSync(join(SRC, 'fullscreen-watch.cpp'), 'utf8');
    assert.doesNotMatch(watch, /waitFor(Connected|ReadyRead|BytesWritten)/, 'no blocking socket calls in the watch');
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /CIELINUX_HYPRLAND fullscreen-watch reconnected monitor=/);
    assert.match(readme, /CIELINUX_HYPRLAND fullscreen-watch coverage off monitor=/);
    assert.doesNotMatch(readme, /CIELINUX_WALLPAPER full[s]creen-watch/); // [s]: keeps the repo-wide grep gate at 0
    assert.doesNotMatch(watch, /void FullscreenWatch::stop\(\)/, 'B11: stop() removed');
    assert.match(readme, /fullscreen-watch coverage off monitor=/);
    assert.doesNotMatch(readme, /fullscreen-watch stopped/);
    assert.doesNotMatch(readme, /sounds coming/);
});
