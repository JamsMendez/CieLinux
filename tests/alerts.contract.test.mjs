// A4 alerts (stage 1, mini): CielWin parity for the alert command grammar, the HTTP body
// translation and status mapping, the single-slot busy-ignore queue with its 5-minute max wait,
// the failed-first <= 8 tile layout and grid table, the host -> page JSON messages, the alert
// driver (show/hide/re-show, one "shown" per new alert, failed wins) and the host <-> page bridge.
// Sources of truth: CielWin/CielWin.App/Alerts/{AlertCommandParser,AlertQueue,AlertTileLayout,
// AlertLayerMessages}.cs, CielWin/CielWin.Interop/AlertHttpProtocol.cs, CielWin/CielWin.App/
// Composition/AlertDriver.cs, CielWin/CielWin.App/Wallpaper/MiniSceneWindowController.cs and
// their tests (AlertCommandParserTests, AlertQueueTests, AlertTileLayoutTests,
// AlertLayerMessagesTests, AlertHttpProtocolTests, AlertDriverSoundTests). The shipped sources
// are compiled into a small offscreen Qt harness and driven over stdin/stdout and loopback HTTP.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import vm from 'node:vm';
import { ROOT, SRC, readText, source } from './paths.mjs';

const read = name => readText(source(name));
let binary, fixture;

const harnessEnv = () => {
    const env = { ...process.env, QT_QPA_PLATFORM: 'offscreen', QT_FORCE_STDERR_LOGGING: '1' };
    delete env.WAYLAND_DISPLAY;
    env.XDG_STATE_HOME = join(fixture, 'state');
    env.XDG_CONFIG_HOME = join(fixture, 'config');
    env.XDG_DATA_HOME = join(fixture, 'data');
    env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent';
    return env;
};

const run = (args, input = '') => {
    const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30000, env: harnessEnv(), input });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
};

after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

before(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cielinux-a4-contract.'));
    binary = join(fixture, 'build', 'alerts-contract');
    const cmake = `
cmake_minimum_required(VERSION 3.21)
project(AlertsContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Network Qml)
add_executable(alerts-contract harness.cpp "${SRC}/alerts.cpp" "${SRC}/alerts.h" "${SRC}/alert-bridge.h"
    "${SRC}/http-server.cpp" "${SRC}/http-server.h" "${SRC}/http-token.cpp" "${SRC}/http-token.h")
target_include_directories(alerts-contract PRIVATE "${SRC}")
target_link_libraries(alerts-contract PRIVATE Qt6::Core Qt6::Network Qt6::Qml)
`;
    const harness = String.raw`
#include "alerts.h"
#include "alert-bridge.h"
#include "http-server.h"
#include "http-token.h"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFile>
#include <QTextStream>
#include <iostream>
#include <stdexcept>

static QString kinds(const AlertCommand &command) {
    QStringList parts;
    for (const AlertGroup &group : command.groups)
        parts << QStringLiteral("%1:%2").arg(alertKindName(group.kind)).arg(group.count);
    return parts.join(',');
}

static QStringList stdinLines() {
    QFile in; in.open(stdin, QIODevice::ReadOnly);
    return QString::fromUtf8(in.readAll()).split('\n', Qt::SkipEmptyParts);
}

static void out(const QString &line) { std::cout << line.toStdString() << std::endl; }

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    const QStringList args = app.arguments().mid(1);
    const QString command = args.value(0);
    if (command == "parse" || command == "parse-null") {
        QFile in; in.open(stdin, QIODevice::ReadOnly);
        QString text = QString::fromUtf8(in.readAll());
        if (text.isNull()) text = QStringLiteral("");
        const AlertParseResult r = AlertCommandParser::parse(command == "parse-null" ? QString() : text);
        std::cout << (r.success() ? "OK " + kinds(*r.command).toStdString() + " " + std::to_string(r.command->durationMs)
                                  : "ERR " + r.error.toStdString());
        return 0;
    }
    if (command == "translate") {
        QFile in; in.open(stdin, QIODevice::ReadOnly);
        const AlertTranslation t = AlertHttpProtocol::translate(QString::fromUtf8(in.readAll()));
        std::cout << (t.ok ? "OK " + t.command.toStdString() : "ERR " + t.error.toStdString());
        return 0;
    }
    if (command == "clear-body") {
        // H1: POST /v1/alerts/clear body -> "OK <id>" (0 = no id) or "ERR <reason>".
        QFile in; in.open(stdin, QIODevice::ReadOnly);
        const AlertClearRequest c = AlertHttpProtocol::parseClear(QString::fromUtf8(in.readAll()));
        std::cout << (c.ok ? "OK " + std::to_string(c.id) : "ERR " + c.error.toStdString());
        return 0;
    }
    if (command == "status") { std::cout << AlertHttpProtocol::statusCodeFor(args.value(1)); return 0; }
    if (command == "constants") {
        std::cout << HttpProtocol::alertsPath << ' ' << HttpProtocol::alertsMaxBodyBytes << ' ' << HttpProtocol::defaultPort
                  << ' ' << AlertTileLayout::gapPixels << ' ' << AlertTileLayout::maxTiles << ' ' << AlertQueue::defaultMaxAgeMs;
        return 0;
    }
    if (command == "constants-hold") {
        std::cout << HttpProtocol::alertsClearPath << ' ' << HttpProtocol::alertsClearMaxBodyBytes << ' ' << AlertQueue::defaultHoldMaxMs;
        return 0;
    }
    if (command == "layout") {
        const AlertParseResult r = AlertCommandParser::parse(args.value(1));
        if (!r.success()) { std::cout << "ERR " << r.error.toStdString(); return 0; }
        const AlertTileLayout layout = AlertTileLayout::from(*r.command);
        QStringList tiles;
        for (AlertKind kind : layout.tiles) tiles << alertKindName(kind);
        std::cout << tiles.join(',').toStdString() << ' ' << layout.columns << 'x' << layout.rows;
        return 0;
    }
    if (command == "messages") {
        out(AlertLayerMessages::show({{"failed", "warning"}, 2, 1, 8, 5000, 10, 20, 1700, 1000}));
        out(AlertLayerMessages::show({{"warning"}, 1, 1, 8, 1000, -5, -6, -7, -8}));
        out(AlertLayerMessages::hide()); out(AlertLayerMessages::pause()); out(AlertLayerMessages::resume());
        return 0;
    }
    if (command == "workarea") {
        // B2 (CielWin AlertLayerWorkArea.Resolve): surface x y w h, work area x y w h -> l t w h
        auto print = [](const AlertWorkArea &a) { out(QStringLiteral("%1 %2 %3 %4").arg(a.left).arg(a.top).arg(a.width).arg(a.height)); };
        print(AlertWorkArea::resolve(QRect(0, 0, 1920, 1080), QRect(0, 0, 1920, 1040)));
        print(AlertWorkArea::resolve(QRect(1920, 0, 2560, 1440), QRect(1920, 40, 2560, 1400)));
        print(AlertWorkArea::resolve(QRect(0, 0, 1920, 1080), QRect(-10, -10, 3000, 3000)));
        print(AlertWorkArea::resolve(QRect(0, 0, 1920, 1080), QRect(2000, 0, 100, 100)));
        print(AlertWorkArea::resolve(QRect(0, 0, 0, 1080), QRect(0, 0, 100, 100)));
        // The wallpaper output: logical size minus Hyprland's reserved zones, in physical pixels.
        print(AlertWorkArea::forOutput(QSize(1920, 1080), QMargins(0, 0, 37, 0), 1.0));
        print(AlertWorkArea::forOutput(QSize(1280, 720), QMargins(0, 30, 0, 0), 1.5));
        print(AlertWorkArea::forOutput(QSize(1920, 1080), QMargins(), 1.0));
        print(AlertWorkArea::forOutput(QSize(1920, 1080), QMargins(1000, 0, 1000, 0), 1.0));
        return 0;
    }
    if (command == "queue") {
        // new [maxAgeMs] [holdMaxMs] | enqueue <t> <command text> | advance <t> <visible 0|1>
        // H1: enq <t> <command text> (prints the id, 0 = ignored) | clear <t> <id> | state <t> <visible 0|1>
        std::unique_ptr<AlertQueue> queue;
        auto diag = [](const QString &m) { out("DIAG " + m); };
        for (const QString &line : stdinLines()) {
            const QStringList w = line.split(' ');
            if (w[0] == "new") {
                try {
                    queue = std::make_unique<AlertQueue>(w.size() > 1 ? w[1].toLongLong() : AlertQueue::defaultMaxAgeMs, diag,
                                                         w.size() > 2 ? w[2].toLongLong() : AlertQueue::defaultHoldMaxMs);
                    out("NEW");
                }
                catch (const std::invalid_argument &) { out("THROWS"); }
            } else if (w[0] == "enqueue") {
                queue->enqueue(*AlertCommandParser::parse(w.mid(2).join(' ')).command, w[1].toLongLong());
            } else if (w[0] == "enq") {
                out(QStringLiteral("ID %1").arg(queue->enqueue(*AlertCommandParser::parse(w.mid(2).join(' ')).command, w[1].toLongLong())));
            } else if (w[0] == "clear") {
                queue->clear(w[2].toULongLong(), w[1].toLongLong());
            } else if (w[0] == "state") {
                const std::optional<ActiveAlert> a = queue->advance(w[1].toLongLong(), w[2] == "1");
                out(a ? QStringLiteral("ACTIVE %1 %2 started=%3 ends=%4 id=%5").arg(kinds(a->command)).arg(a->command.durationMs)
                            .arg(a->startedAtMs).arg(a->endsAtMs).arg(a->serial)
                      : QStringLiteral("NONE"));
            } else if (w[0] == "advance") {
                const std::optional<ActiveAlert> a = queue->advance(w[1].toLongLong(), w[2] == "1");
                out(a ? QStringLiteral("ACTIVE %1 %2 started=%3").arg(kinds(a->command)).arg(a->command.durationMs).arg(a->startedAtMs)
                      : QStringLiteral("NONE"));
            }
        }
        return 0;
    }
    if (command == "driver") {
        // clock <t> | step <ms per read> | accept <text> | canshow 0|1 | showfail <n> | update | update-none | replace
        // B2: wallpaper (canShow honours covered) | covered 0|1 | workarea <l> <t> <w> <h> | workarea-throw
        // H1: argument 1 is the hold max in ms (default AlertQueue::defaultHoldMaxMs) | clear <id>
        qint64 now = 1000000, step = 0;
        bool canShow = true, honourCovered = false, covered = false; int showFailures = 0;
        AlertDriver driver([&] { const qint64 t = now; now += step; return t; }, [](const QString &m) { out("TRACE " + m); },
                           args.size() > 1 ? args[1].toLongLong() : AlertQueue::defaultHoldMaxMs);
        QObject::connect(&driver, &AlertDriver::alertShown, [](const QString &kind) { out("SHOWN " + kind); });
        QObject::connect(&driver, &AlertDriver::alertRepeated, [](const QString &kind) { out("REPEAT " + kind); }); // H4
        AlertSurface surface{[&](bool isCovered) { return canShow && !(honourCovered && isCovered); },
            [&](const AlertShowRequest &request) {
                if (showFailures > 0) { --showFailures; throw std::runtime_error("show failed"); }
                out("SHOW " + AlertLayerMessages::show(request));
            },
            [&] { out("HIDE"); }};
        for (const QString &line : stdinLines()) {
            const QStringList w = line.split(' ');
            if (w[0] == "clock") now = w[1].toLongLong();
            else if (w[0] == "step") step = w[1].toLongLong();
            else if (w[0] == "accept") out("REPLY " + driver.accept(w.mid(1).join(' ')));
            else if (w[0] == "clear") out("REPLY " + driver.clear(w[1].toULongLong()));
            else if (w[0] == "canshow") canShow = w[1] == "1";
            else if (w[0] == "showfail") showFailures = w[1].toInt();
            else if (w[0] == "wallpaper") honourCovered = true;
            else if (w[0] == "covered") covered = w[1] == "1";
            else if (w[0] == "workarea") {
                const AlertWorkArea area{w[1].toInt(), w[2].toInt(), w[3].toInt(), w[4].toInt()};
                surface.workArea = [area] { return area; };
            } else if (w[0] == "workarea-throw") surface.workArea = []() -> AlertWorkArea { throw std::runtime_error("no read"); };
            else if (w[0] == "update") driver.update(&surface, covered);
            else if (w[0] == "update-none") driver.update(nullptr, false); // B1: wallpaper holds alerts
            else if (w[0] == "replace") driver.surfaceReplaced();
        }
        return 0;
    }
    if (command == "bridge") {
        // attach <gen> | post <json> | hide | msg <gen> <level> <source> <message...>
        AlertBridge bridge;
        QObject::connect(&bridge, &AlertBridge::pageCommand, [](int gen, const QString &json) {
            out(QStringLiteral("CMD %1 %2").arg(gen).arg(json));
        });
        QObject::connect(&bridge, &AlertBridge::pageDone, [](int gen) { out(QStringLiteral("DONE %1").arg(gen)); });
        for (const QString &line : stdinLines()) {
            const QStringList w = line.split(' ');
            if (w[0] == "attach") bridge.attach(w[1].toInt());
            else if (w[0] == "post") bridge.post(w.mid(1).join(' '));
            else if (w[0] == "hide") bridge.hide();
            else if (w[0] == "pause") bridge.setScenePaused(w[1] == "1"); // B2: wallpaper covered
            else if (w[0] == "ready?") out(bridge.pageReady() ? "READY" : "NOT_READY");
            else if (w[0] == "msg")
                out(bridge.pageMessage(w[1].toInt(), w[2].toInt(), w.mid(4).join(' '), w[3]) ? "CONSUMED" : "PASS");
        }
        return 0;
    }
    if (command == "serve") {
        const QByteArray token = HttpToken::loadOrCreate(args.value(1), [](const QString &) {});
        if (token.isEmpty()) return 4;
        QElapsedTimer clock; clock.start();
        AlertDriver driver([&] { return clock.elapsed(); }, [](const QString &m) { out("TRACE " + m); });
        AlertSurface surface{[](bool) { return true; },
            [](const AlertShowRequest &request) { out("SHOW " + AlertLayerMessages::show(request)); },
            [] { out("HIDE"); }};
        HttpServer server(0, token, [](const QString &) { return true; }, [&](const QString &text) {
            const QString reply = driver.accept(text);
            driver.update(&surface, false);
            return reply;
        }, [&](quint64 id) {
            const QString reply = driver.clear(id);
            driver.update(&surface, false);
            return reply;
        });
        if (!server.start()) return 5;
        out(QStringLiteral("LISTENING %1").arg(server.port()));
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

// ---- AlertCommandParserTests ----

const parse = text => run(['parse'], text);

test('parser: groups in command order, default and explicit duration, case-insensitive keys', () => {
    assert.equal(parse('warning:2 failed:1'), 'OK warning:2,failed:1 5000');
    assert.equal(parse('failed:3 duration:8'), 'OK failed:3 8000');
    assert.equal(parse('WARNING:2 Duration:10'), 'OK warning:2 10000');
    assert.equal(parse('  warning:1   failed:2  \t '), 'OK warning:1,failed:2 5000');
    assert.equal(parse('failed:2 warning:3'), 'OK failed:2,warning:3 5000');
    assert.equal(parse('warning:8 failed:8'), 'OK warning:8,failed:8 5000', 'exactly sixteen tiles');
    assert.equal(parse('warning:00005'), 'OK warning:5 5000');
});

test('parser: every CielWin rejection, with its exact message', () => {
    const cases = [
        ['warning:1 warning:2', "ERR 'warning' is repeated in 'warning:2'"],
        ['duration:5 warning:1 duration:9', "ERR 'duration' is repeated in 'duration:9'"],
        ['duration:5', "ERR at least one 'warning:N' or 'failed:N' group is required"],
        ['', "ERR at least one 'warning:N' or 'failed:N' group is required"],
        ['   ', "ERR at least one 'warning:N' or 'failed:N' group is required"],
        ['warning:16 failed:1', 'ERR 17 tiles were requested, past the 16-tile limit'],
        ['warning2', "ERR 'warning2' is not a 'key:count' token"],
        [':5', "ERR ':5' is not a 'key:count' token"],
        ['warning:', "ERR 'warning:' is not a 'key:count' token"],
        ['foo:2', "ERR 'foo:2' names an unknown key 'foo'"],
        ['warning:abc', "ERR 'warning:abc' does not carry a whole number"],
        ['warning:-1', "ERR 'warning:-1' does not carry a whole number"],
        ['warning:+1', "ERR 'warning:+1' does not carry a whole number"],
        ['warning:1.5', "ERR 'warning:1.5' does not carry a whole number"],
        ['warning:99999999999', "ERR 'warning:99999999999' does not carry a whole number"],
        ['warning:0', "ERR 'warning:0' must be 1..16"],
        ['warning:17', "ERR 'warning:17' must be 1..16"],
        ['failed:1 duration:0', "ERR 'duration:0' requires warning only"],
        ['warning:1 failed:1 duration:0', "ERR 'duration:0' requires warning only"],
        ['duration:0', "ERR at least one 'warning:N' or 'failed:N' group is required"],
        ['warning:1 duration:61', "ERR 'duration:61' must be 1..60 seconds"],
    ];
    for (const [input, expected] of cases) assert.equal(parse(input), expected, input);
    assert.equal(run(['parse-null']), 'ERR no command was given');
});

test('parser: 256 characters is the input limit', () => {
    const atLimit = 'warning:1'.padEnd(256, ' ');
    assert.equal(parse(atLimit), 'OK warning:1 5000');
    const tooLong = `warning:1 ${' '.repeat(260)}`;
    assert.equal(parse(tooLong), `ERR command is ${tooLong.length} characters long, past the 256-character limit`);
});

test('parser: H1 duration:0 holds a warning-only command until cleared', () => {
    assert.equal(parse('warning:1 duration:0'), 'OK warning:1 0');
    assert.equal(parse('WARNING:3 Duration:0'), 'OK warning:3 0');
    assert.equal(parse('duration:0 warning:16'), 'OK warning:16 0');
    assert.equal(parse('warning:1 duration:00'), 'OK warning:1 0');
});

// ---- AlertHttpProtocolTests ----

const translate = body => run(['translate'], body);

test('http body: fields become command text in the order written', () => {
    for (const [body, expected] of [['{"warning":2}', 'warning:2'], ['{"failed":1}', 'failed:1'],
        ['{"warning":2,"failed":1,"duration":5}', 'warning:2 failed:1 duration:5'],
        ['{"duration":5,"failed":1,"warning":2}', 'duration:5 failed:1 warning:2'],
        ['  { "warning" : 3 }  ', 'warning:3'], ['{}', ''],
        ['{"warning":1,"warning":2}', 'warning:1 warning:2'], ['{"warning":-1}', 'warning:-1'],
        ['{"warning":-0}', 'warning:0'], ['{"warning":2147483647}', 'warning:2147483647']])
        assert.equal(translate(body), `OK ${expected}`, body);
});

test('http body: every CielWin rejection, with its exact reason', () => {
    for (const [body, expected] of [['', 'body is not valid JSON'], ['{', 'body is not valid JSON'],
        ['warning:2', 'body is not valid JSON'], ['{"\\uD800":1}', 'body is not valid JSON'],
        ['{"warning":1} x', 'body is not valid JSON'],
        ['[1]', 'body must be a JSON object'], ['2', 'body must be a JSON object'], ['null', 'body must be a JSON object'],
        ['{"Warning":1}', "unknown field 'Warning'"], ['{"info":1}', "unknown field 'info'"],
        ['{"info":1,"\\uD800":1}', "unknown field 'info'"],
        ['{"warning":"2"}', "field 'warning' must be a whole number"],
        ['{"warning":1.5}', "field 'warning' must be a whole number"],
        ['{"warning":1.0}', "field 'warning' must be a whole number"],
        ['{"warning":1e2}', "field 'warning' must be a whole number"],
        ['{"warning":true}', "field 'warning' must be a whole number"],
        ['{"duration":null}', "field 'duration' must be a whole number"],
        ['{"warning":{"a":1}}', "field 'warning' must be a whole number"],
        ['{"failed":99999999999}', "field 'failed' must be a whole number"],
        ['{"failed":2147483648}', "field 'failed' must be a whole number"],
        ['{"warning":1,"duration":"x","info":2}', "field 'duration' must be a whole number"]])
        assert.equal(translate(body), `ERR ${expected}`, body);
    // .NET's default maximum depth (64) rejects a deeper document as malformed JSON.
    assert.equal(translate(`{"warning":${'['.repeat(64)}${']'.repeat(64)}}`), 'ERR body is not valid JSON');
    assert.equal(translate(`{"warning":${'['.repeat(63)}${']'.repeat(63)}}`), "ERR field 'warning' must be a whole number");
});

test('http status: 202 ok, 503 alerts disabled, 500 internal or unknown, 400 any other error', () => {
    for (const [reply, status] of [['ok', '202'], ['error: alerts are disabled', '503'],
        ["error: 'warning:0' must be 1..16", '400'], ['error: internal error', '500'], ['something unexpected', '500']])
        assert.equal(run(['status', reply]), status, reply);
    assert.equal(run(['constants']), '/v1/alerts 1024 43811 8 8 300000');
});

test('http status: H1 an accepted alert answers ok id=<n> with 202; anything else after ok is unrecognised', () => {
    for (const [reply, status] of [['ok id=1', '202'], ['ok id=42', '202'], ['ok id=', '500'], ['ok id=0', '500'],
        ['ok id=x', '500'], ['ok id=1 ', '500'], ['ok  id=1', '500'], ['okid=1', '500']])
        assert.equal(run(['status', reply]), status, reply);
    assert.equal(translate('{"warning":1,"duration":0}'), 'OK warning:1 duration:0');
    assert.equal(run(['constants-hold']), '/v1/alerts/clear 64 600000');
});

test('clear body: H1 {} or {"id": n} with n a whole number >= 1, nothing else', () => {
    const clearBody = body => run(['clear-body'], body);
    for (const [body, expected] of [['{}', 'OK 0'], ['  { }  ', 'OK 0'], ['{"id":1}', 'OK 1'], ['{ "id" : 12 }', 'OK 12'],
        ['{"id":2147483647}', 'OK 2147483647']])
        assert.equal(clearBody(body), expected, body);
    for (const [body, expected] of [['', 'body is not valid JSON'], ['{', 'body is not valid JSON'],
        ['{"\\uD800":1}', 'body is not valid JSON'], ['[1]', 'body must be a JSON object'], ['null', 'body must be a JSON object'],
        ['{"warning":1}', "unknown field 'warning'"], ['{"Id":1}', "unknown field 'Id'"],
        ['{"id":0}', "field 'id' must be a whole number >= 1"], ['{"id":-1}', "field 'id' must be a whole number >= 1"],
        ['{"id":1.5}', "field 'id' must be a whole number >= 1"], ['{"id":"1"}', "field 'id' must be a whole number >= 1"],
        ['{"id":null}', "field 'id' must be a whole number >= 1"], ['{"id":2147483648}', "field 'id' must be a whole number >= 1"],
        ['{"id":1,"id":2}', "field 'id' is repeated"]])
        assert.equal(clearBody(body), `ERR ${expected}`, body);
});

// ---- AlertTileLayoutTests ----

test('layout: the grid table, failed first, capped at eight', () => {
    const grid = { 1: '1x1', 2: '2x1', 3: '2x2', 4: '2x2', 5: '3x2', 6: '3x2', 7: '4x2', 8: '4x2' };
    for (const [count, expected] of Object.entries(grid))
        assert.equal(run(['layout', `warning:${count}`]), `${Array(Number(count)).fill('warning').join(',')} ${expected}`);
    assert.equal(run(['layout', 'warning:16']), `${Array(8).fill('warning').join(',')} 4x2`);
    assert.equal(run(['layout', 'warning:2 failed:3']), 'failed,failed,failed,warning,warning 3x2');
    assert.equal(run(['layout', 'failed:3']), 'failed,failed,failed 2x2');
    assert.equal(run(['layout', 'failed:8 warning:1']), `${Array(8).fill('failed').join(',')} 4x2`);
    assert.equal(run(['layout', 'failed:6 warning:5']), `${Array(6).fill('failed').join(',')},warning,warning 4x2`);
    assert.equal(run(['layout', 'warning:9 failed:7']), `${Array(7).fill('failed').join(',')},warning 4x2`);
});

// ---- AlertLayerMessagesTests ----

test('messages: show carries tiles, grid, gap, clamped work area and duration; hide/pause/resume', () => {
    assert.deepEqual(run(['messages']).trim().split('\n'), [
        '{"type":"show","tiles":["failed","warning"],"columns":2,"rows":1,"gap":8,'
            + '"workArea":{"left":10,"top":20,"width":1700,"height":1000},"duration":5000}',
        '{"type":"show","tiles":["warning"],"columns":1,"rows":1,"gap":8,'
            + '"workArea":{"left":0,"top":0,"width":0,"height":0},"duration":1000}',
        '{"type":"hide"}', '{"type":"pause"}', '{"type":"resume"}']);
});

// ---- AlertQueueTests (ms timestamps; CielWin's DateTimeOffset ticks map to 1 ms) ----

const queue = script => run(['queue'], script.join('\n')).trim().split('\n');

test('queue: first in shows, busy-ignore while showing or waiting, ends exactly at start + duration', () => {
    assert.deepEqual(queue(['new', 'advance 0 1']), ['NEW', 'NONE']);
    assert.deepEqual(queue(['new', 'enqueue 0 warning:1', 'enqueue 0 failed:2', 'advance 0 1']),
        ['NEW', 'DIAG alert ignored: one is already waiting to show', 'ACTIVE warning:1 5000 started=0']);
    assert.deepEqual(queue(['new', 'enqueue 0 warning:1', 'advance 0 1', 'enqueue 2000 failed:1']),
        ['NEW', 'ACTIVE warning:1 5000 started=0', 'DIAG alert ignored: one is already showing']);
    // A request right as the window ends is accepted before any advance and starts on the next one.
    assert.deepEqual(queue(['new', 'enqueue 0 warning:1', 'advance 0 1', 'enqueue 5000 failed:1', 'advance 5000 1']),
        ['NEW', 'ACTIVE warning:1 5000 started=0', 'ACTIVE failed:1 5000 started=5000']);
    assert.deepEqual(queue(['new', 'enqueue 0 warning:1', 'advance 0 1', 'advance 4999 1', 'advance 5000 1']),
        ['NEW', 'ACTIVE warning:1 5000 started=0', 'ACTIVE warning:1 5000 started=0', 'NONE']);
});

test('queue: covered holds the start, never extends a showing alert, waits at most the max age', () => {
    assert.deepEqual(queue(['new', 'enqueue 0 warning:1', 'advance 0 0', 'advance 30000 1']),
        ['NEW', 'NONE', 'ACTIVE warning:1 5000 started=30000']);
    assert.deepEqual(queue(['new', 'enqueue 0 warning:1', 'advance 0 1', 'advance 3000 0', 'advance 5000 0']),
        ['NEW', 'ACTIVE warning:1 5000 started=0', 'ACTIVE warning:1 5000 started=0', 'NONE']);
    // Default max age: 5 minutes. Exactly the max age is still eligible; strictly past it is dropped.
    assert.deepEqual(queue(['new', 'enqueue 0 warning:1', 'advance 300000 1']), ['NEW', 'ACTIVE warning:1 5000 started=300000']);
    assert.deepEqual(queue(['new', 'enqueue 0 warning:1', 'advance 300001 1']),
        ['NEW', 'DIAG alert dropped: waited longer than the 00:05:00 max age without starting', 'NONE']);
    assert.deepEqual(queue(['new 60000', 'enqueue 0 warning:1', 'advance 61000 0']),
        ['NEW', 'DIAG alert dropped: waited longer than the 00:01:00 max age without starting', 'NONE']);
    // Ignored while waiting, and the ignored one never shows later.
    assert.deepEqual(queue(['new', 'enqueue 0 warning:1', 'advance 0 0', 'enqueue 1000 failed:1', 'advance 2000 1', 'advance 7000 1']),
        ['NEW', 'NONE', 'DIAG alert ignored: one is already waiting to show', 'ACTIVE warning:1 5000 started=2000', 'NONE']);
    // An expired waiting alert never swallows a new request.
    assert.deepEqual(queue(['new 60000', 'enqueue 0 warning:1', 'advance 0 0', 'enqueue 60001 failed:1', 'advance 60001 1']),
        ['NEW', 'NONE', 'DIAG alert dropped: waited longer than the 00:01:00 max age without starting',
            'ACTIVE failed:1 5000 started=60001']);
    assert.deepEqual(queue(['new -1']), ['THROWS']);
    assert.deepEqual(queue(['new 0', 'enqueue 0 warning:1', 'advance 0 1']), ['NEW', 'ACTIVE warning:1 5000 started=0']);
});

test('queue: H1 ids increase per accepted request; an ignored request gets 0 and uses no id', () => {
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:1', 'enq 0 failed:1', 'state 0 1', 'enq 500 failed:1', 'enq 1000 failed:2', 'state 1000 1']),
        ['NEW', 'ID 1', 'DIAG alert ignored: one is already waiting to show', 'ID 0', 'ACTIVE warning:1 1000 started=0 ends=1000 id=1',
            'DIAG alert ignored: one is already showing', 'ID 0', 'ID 2', 'ACTIVE failed:2 5000 started=1000 ends=6000 id=2']);
});

test('queue: H1 a held warning lasts until the hold max, counted from the request, not from the start', () => {
    assert.deepEqual(queue(['new 300000 60000', 'enq 0 warning:1 duration:0', 'state 0 1', 'state 59999 1', 'state 60000 1']),
        ['NEW', 'ID 1', 'ACTIVE warning:1 0 started=0 ends=60000 id=1', 'ACTIVE warning:1 0 started=0 ends=60000 id=1', 'NONE']);
    // Held back (covered) for 20 s: it still ends 60 s after the request.
    assert.deepEqual(queue(['new 300000 60000', 'enq 0 warning:1 duration:0', 'state 0 0', 'state 20000 1', 'state 60000 1']),
        ['NEW', 'ID 1', 'NONE', 'ACTIVE warning:1 0 started=20000 ends=60000 id=1', 'NONE']);
    // Waiting past its hold max: dropped then, before the 5-minute start limit.
    assert.deepEqual(queue(['new 300000 60000', 'enq 0 warning:1 duration:0', 'state 59999 0', 'state 60000 0', 'state 60001 1']),
        ['NEW', 'ID 1', 'NONE', 'DIAG alert dropped: held past the 00:01:00 hold max', 'NONE', 'NONE']);
    // Default hold max (10 minutes) is longer than the start limit: the 5-minute rule drops it first.
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:0', 'state 300001 1']),
        ['NEW', 'ID 1', 'DIAG alert dropped: waited longer than the 00:05:00 max age without starting', 'NONE']);
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:0', 'state 300000 1']),
        ['NEW', 'ID 1', 'ACTIVE warning:1 0 started=300000 ends=600000 id=1']);
    assert.deepEqual(queue(['new 0 -1']), ['THROWS']);
});

test('queue: H1 a failed request preempts a held warning, which resumes for the rest of its hold', () => {
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:0', 'state 0 1', 'enq 1000 failed:1 duration:2', 'state 1000 1',
        'state 2999 1', 'state 3000 1', 'state 600000 1']),
        ['NEW', 'ID 1', 'ACTIVE warning:1 0 started=0 ends=600000 id=1', 'DIAG alert 1 suspended: a failed alert preempts it', 'ID 2',
            'ACTIVE failed:1 2000 started=1000 ends=3000 id=2', 'ACTIVE failed:1 2000 started=1000 ends=3000 id=2',
            'ACTIVE warning:1 0 started=3000 ends=600000 id=1', 'NONE']);
    // A mixed request preempts too (it has a failed tile); a warning-only one is ignored as today.
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:0', 'state 0 1', 'enq 10 warning:2', 'enq 20 warning:1 duration:0',
        'enq 30 warning:1 failed:1', 'state 30 1']),
        ['NEW', 'ID 1', 'ACTIVE warning:1 0 started=0 ends=600000 id=1', 'DIAG alert ignored: one is already showing', 'ID 0',
            'DIAG alert ignored: one is already showing', 'ID 0', 'DIAG alert 1 suspended: a failed alert preempts it', 'ID 2',
            'ACTIVE warning:1,failed:1 5000 started=30 ends=5030 id=2']);
    // The suspended warning expires on its own deadline while the failed alert shows.
    assert.deepEqual(queue(['new 300000 4000', 'enq 0 warning:1 duration:0', 'state 0 1', 'enq 1000 failed:1', 'state 1000 1',
        'state 4000 1', 'state 6000 1']),
        ['NEW', 'ID 1', 'ACTIVE warning:1 0 started=0 ends=4000 id=1', 'DIAG alert 1 suspended: a failed alert preempts it', 'ID 2',
            'ACTIVE failed:1 5000 started=1000 ends=6000 id=2', 'DIAG alert dropped: held past the 00:00:04 hold max',
            'ACTIVE failed:1 5000 started=1000 ends=6000 id=2', 'NONE']);
    // A held warning still waiting (covered) gives way to a failed request, then follows it.
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:0', 'state 0 0', 'enq 1000 failed:1', 'state 2000 1', 'state 7000 1']),
        ['NEW', 'ID 1', 'NONE', 'ID 2', 'ACTIVE failed:1 5000 started=2000 ends=7000 id=2',
            'ACTIVE warning:1 0 started=7000 ends=600000 id=1']);
});

test('queue: H1 at most one held warning: a held request while one is suspended is ignored; a later failed one suspends the same', () => {
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:0', 'state 0 1', 'enq 1000 failed:1 duration:2', 'state 1000 1',
        'enq 1500 warning:1 duration:0', 'state 3000 1', 'enq 4000 failed:1 duration:2', 'state 4000 1', 'state 6000 1', 'state 600000 1']),
        ['NEW', 'ID 1', 'ACTIVE warning:1 0 started=0 ends=600000 id=1', 'DIAG alert 1 suspended: a failed alert preempts it', 'ID 2',
            'ACTIVE failed:1 2000 started=1000 ends=3000 id=2', 'DIAG alert ignored: a held warning is already suspended', 'ID 0',
            'ACTIVE warning:1 0 started=3000 ends=600000 id=1', 'DIAG alert 1 suspended: a failed alert preempts it', 'ID 3',
            'ACTIVE failed:1 2000 started=4000 ends=6000 id=3', 'ACTIVE warning:1 0 started=6000 ends=600000 id=1', 'NONE']);
});

test('queue: H1 a held request during a timed alert waits for it; a timed one during a timed alert is still ignored', () => {
    assert.deepEqual(queue(['new', 'enq 0 failed:1 duration:2', 'state 0 1', 'enq 1000 warning:1 duration:0', 'enq 1500 warning:1 duration:0',
        'state 1000 1', 'state 2000 1']),
        ['NEW', 'ID 1', 'ACTIVE failed:1 2000 started=0 ends=2000 id=1', 'ID 2', 'DIAG alert ignored: one is already waiting to show', 'ID 0',
            'ACTIVE failed:1 2000 started=0 ends=2000 id=1', 'ACTIVE warning:1 0 started=2000 ends=601000 id=2']);
});

test('queue: H1 clear - {} clears the held alert wherever it is, an id clears that alert, timed ones only by id', () => {
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:0', 'state 0 1', 'clear 10 0', 'state 10 1']),
        ['NEW', 'ID 1', 'ACTIVE warning:1 0 started=0 ends=600000 id=1', 'DIAG alert 1 cleared', 'NONE']);
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:0', 'state 0 1', 'clear 10 2', 'clear 10 1', 'state 10 1']),
        ['NEW', 'ID 1', 'ACTIVE warning:1 0 started=0 ends=600000 id=1', 'DIAG alert 1 cleared', 'NONE']);
    // {} never clears a timed alert; its id does.
    assert.deepEqual(queue(['new', 'enq 0 failed:1', 'state 0 1', 'clear 10 0', 'state 10 1', 'clear 20 1', 'state 20 1']),
        ['NEW', 'ID 1', 'ACTIVE failed:1 5000 started=0 ends=5000 id=1', 'ACTIVE failed:1 5000 started=0 ends=5000 id=1',
            'DIAG alert 1 cleared', 'NONE']);
    // A suspended held warning cleared meanwhile does not come back after the failed alert.
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:0', 'state 0 1', 'enq 1000 failed:1', 'state 1000 1', 'clear 2000 0',
        'state 2000 1', 'state 6000 1']),
        ['NEW', 'ID 1', 'ACTIVE warning:1 0 started=0 ends=600000 id=1', 'DIAG alert 1 suspended: a failed alert preempts it', 'ID 2',
            'ACTIVE failed:1 5000 started=1000 ends=6000 id=2', 'DIAG alert 1 cleared', 'ACTIVE failed:1 5000 started=1000 ends=6000 id=2', 'NONE']);
    // Clearing the preempting failed alert by id resumes the held warning at once.
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:0', 'state 0 1', 'enq 1000 failed:1', 'state 1000 1', 'clear 2000 2',
        'state 2000 1']),
        ['NEW', 'ID 1', 'ACTIVE warning:1 0 started=0 ends=600000 id=1', 'DIAG alert 1 suspended: a failed alert preempts it', 'ID 2',
            'ACTIVE failed:1 5000 started=1000 ends=6000 id=2', 'DIAG alert 2 cleared', 'ACTIVE warning:1 0 started=2000 ends=600000 id=1']);
    // A waiting held warning is cleared too; an unknown id or nothing held is a silent no-op.
    assert.deepEqual(queue(['new', 'enq 0 warning:1 duration:0', 'state 0 0', 'clear 10 0', 'state 20 1', 'clear 30 0', 'clear 30 9']),
        ['NEW', 'ID 1', 'NONE', 'DIAG alert 1 cleared', 'NONE']);
});

// ---- AlertDriver (AlertDriverSoundTests: the "shown" seam A5 plays sounds from) ----

const driver = script => run(['driver'], script.join('\n')).trim().split('\n');
const showJson = (tiles, columns, rows, duration) =>
    `SHOW {"type":"show","tiles":[${tiles.map(t => `"${t}"`).join(',')}],"columns":${columns},"rows":${rows},"gap":8,`
    + `"workArea":{"left":0,"top":0,"width":0,"height":0},"duration":${duration}}`;

test('driver: accept replies ok or the parser error; a new alert shows once and is announced once', () => {
    assert.deepEqual(driver(['accept warning:1 duration:10', 'update', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 10000), 'SHOWN warning']);
    assert.deepEqual(driver(['accept warning:0']), ["TRACE alert rejected: 'warning:0' must be 1..16", "REPLY error: 'warning:0' must be 1..16"]);
    assert.deepEqual(driver(['accept failed:2']).slice(0, 1), ['REPLY ok id=1']);
    assert.deepEqual(driver(['accept warning:3 failed:1', 'update']),
        ['REPLY ok id=1', showJson(['failed', 'warning', 'warning', 'warning'], 2, 2, 5000), 'SHOWN failed']);
});

test('driver: busy-ignore still replies ok; ends with a hide; a later alert is announced again', () => {
    assert.deepEqual(driver(['accept warning:1 duration:1', 'update', 'accept failed:1', 'clock 1001000', 'update',
        'accept failed:1', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 1000), 'SHOWN warning',
            'TRACE alert ignored: one is already showing', 'REPLY ok', 'HIDE',
            'REPLY ok id=2', showJson(['failed'], 1, 1, 5000), 'SHOWN failed']);
});

test('driver: held while the surface cannot show; a failed show is retried; re-show after replace is silent', () => {
    assert.deepEqual(driver(['canshow 0', 'accept warning:1', 'update', 'canshow 1', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 5000), 'SHOWN warning']);
    assert.deepEqual(driver(['showfail 1', 'accept warning:1', 'update', 'update']),
        ['REPLY ok id=1', 'TRACE alert start-failed', showJson(['warning'], 1, 1, 5000), 'SHOWN warning']);
    // Re-shown on a replaced surface for its remaining time, never announced twice.
    assert.deepEqual(driver(['accept warning:1 duration:10', 'update', 'clock 1004000', 'replace', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 10000), 'SHOWN warning', showJson(['warning'], 1, 1, 6000)]);
    // Every clock read moves one second: promoted on one read, no time left on the next.
    assert.deepEqual(driver(['step 1000', 'accept warning:1 duration:1', 'update']), ['REPLY ok id=1']);
});

test('driver: B1 mode switch - no surface in the wallpaper holds alerts; back in the mini the rest is re-shown silently', () => {
    // Shown in the mini, then the wallpaper (surface replaced, no alert surface): nothing is posted
    // and a new alert is busy-ignored; back in the mini the same alert returns for its remaining time.
    assert.deepEqual(driver(['accept warning:1 duration:10', 'update', 'replace', 'update-none', 'accept failed:1',
        'clock 1004000', 'update-none', 'replace', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 10000), 'SHOWN warning',
            'TRACE alert ignored: one is already showing', 'REPLY ok', showJson(['warning'], 1, 1, 6000)]);
    // Accepted while in the wallpaper: held (never promoted) until a surface can show it.
    assert.deepEqual(driver(['accept failed:1', 'update-none', 'clock 1060000', 'update-none', 'update']),
        ['REPLY ok id=1', showJson(['failed'], 1, 1, 5000), 'SHOWN failed']);
});

test('driver: B2 wallpaper - held while covered, shown (and announced, so the sound plays) only once uncovered', () => {
    // Accepted under a fullscreen window: nothing is shown or announced until uncovered.
    assert.deepEqual(driver(['wallpaper', 'covered 1', 'accept failed:1 warning:2', 'update', 'clock 1060000', 'update',
        'covered 0', 'update', 'update']),
        ['REPLY ok id=1', showJson(['failed', 'warning', 'warning'], 2, 2, 5000), 'SHOWN failed']);
    // Still covered past the 5-minute max age: dropped, never shown, never announced.
    assert.deepEqual(driver(['wallpaper', 'covered 1', 'accept warning:1', 'update', 'clock 1300001', 'update', 'covered 0', 'update']),
        ['REPLY ok id=1', 'TRACE alert dropped: waited longer than the 00:05:00 max age without starting']);
    // Covered while showing: the alert keeps its host-side timing (no hide, no re-show) and ends on time.
    assert.deepEqual(driver(['wallpaper', 'accept warning:1 duration:10', 'update', 'covered 1', 'clock 1004000', 'update',
        'covered 0', 'update', 'clock 1010000', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 10000), 'SHOWN warning', 'HIDE']);
    // The mini surface ignores `covered` (it is never held for coverage).
    assert.deepEqual(driver(['covered 1', 'accept warning:1', 'update']), ['REPLY ok id=1', showJson(['warning'], 1, 1, 5000), 'SHOWN warning']);
});

test('driver: B2 the work area is read from the surface at show time; a failed read lays out on the whole canvas', () => {
    assert.deepEqual(driver(['workarea 0 0 1883 1080', 'accept warning:2', 'update']),
        ['REPLY ok id=1', 'SHOW {"type":"show","tiles":["warning","warning"],"columns":2,"rows":1,"gap":8,'
            + '"workArea":{"left":0,"top":0,"width":1883,"height":1080},"duration":5000}', 'SHOWN warning']);
    assert.deepEqual(driver(['workarea-throw', 'accept warning:1', 'update']),
        ['REPLY ok id=1', 'TRACE alert workarea-failed', showJson(['warning'], 1, 1, 5000), 'SHOWN warning']);
});

test('driver: H1 a held warning is shown for the remaining hold, announced once, ended by clear or the hold max', () => {
    assert.deepEqual(driver(['accept warning:1 duration:0', 'update', 'clock 1004000', 'update', 'clear 0', 'update', 'clear 0']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 600000), 'SHOWN warning', 'TRACE alert 1 cleared', 'REPLY ok', 'HIDE', 'REPLY ok']);
    assert.deepEqual(run(['driver', '60000'], ['accept warning:1 duration:0', 'update', 'clock 1059999', 'update', 'clock 1060000', 'update']
        .join('\n')).trim().split('\n'), ['REPLY ok id=1', showJson(['warning'], 1, 1, 60000), 'SHOWN warning', 'REPEAT warning', 'HIDE']);
    assert.deepEqual(driver(['accept failed:1 duration:0']),
        ["TRACE alert rejected: 'duration:0' requires warning only", "REPLY error: 'duration:0' requires warning only"]);
});

test('driver: H1 a failed alert preempts a held warning; the warning resumes afterwards without replaying its sound', () => {
    assert.deepEqual(driver(['accept warning:1 duration:0', 'update', 'clock 1001000', 'accept failed:1 duration:2', 'update',
        'clock 1003000', 'update', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 600000), 'SHOWN warning',
            'TRACE alert 1 suspended: a failed alert preempts it', 'REPLY ok id=2', 'HIDE', showJson(['failed'], 1, 1, 2000), 'SHOWN failed',
            'HIDE', showJson(['warning'], 1, 1, 597000)]);
    // Never shown before the failed alert took its place: announced when it finally shows.
    assert.deepEqual(driver(['canshow 0', 'accept warning:1 duration:0', 'update', 'accept failed:1', 'canshow 1', 'update',
        'clock 1005000', 'update']),
        ['REPLY ok id=1', 'REPLY ok id=2', showJson(['failed'], 1, 1, 5000), 'SHOWN failed',
            'HIDE', showJson(['warning'], 1, 1, 595000), 'SHOWN warning']);
});

test('driver: H1 a held warning preempted twice never replays its sound; a held request while it is suspended is ignored', () => {
    assert.deepEqual(driver(['accept warning:1 duration:0', 'update', 'clock 1001000', 'accept failed:1 duration:1', 'update',
        'clock 1002000', 'update', 'clock 1003000', 'accept failed:1 duration:1', 'update', 'clock 1004000', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 600000), 'SHOWN warning',
            'TRACE alert 1 suspended: a failed alert preempts it', 'REPLY ok id=2', 'HIDE', showJson(['failed'], 1, 1, 1000), 'SHOWN failed',
            'HIDE', showJson(['warning'], 1, 1, 598000),
            'TRACE alert 1 suspended: a failed alert preempts it', 'REPLY ok id=3', 'HIDE', showJson(['failed'], 1, 1, 1000), 'SHOWN failed',
            'HIDE', showJson(['warning'], 1, 1, 596000)]);
    // Plain ok, no id: the suspended warning stays the only held one and comes back.
    assert.deepEqual(driver(['accept warning:1 duration:0', 'update', 'clock 1001000', 'accept failed:1 duration:2', 'update',
        'accept warning:1 duration:0', 'clock 1003000', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 600000), 'SHOWN warning',
            'TRACE alert 1 suspended: a failed alert preempts it', 'REPLY ok id=2', 'HIDE', showJson(['failed'], 1, 1, 2000), 'SHOWN failed',
            'TRACE alert ignored: a held warning is already suspended', 'REPLY ok', 'HIDE', showJson(['warning'], 1, 1, 597000)]);
});

test('driver: H4 a showing held warning repeats its sound every 5 s until cleared or its hold max; a timed one never', () => {
    assert.deepEqual(driver(['accept warning:1 duration:0', 'update', 'clock 1004999', 'update', 'clock 1005000', 'update',
        'clock 1009000', 'update', 'clock 1010000', 'update', 'clear 0', 'update', 'clock 1020000', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 600000), 'SHOWN warning', 'REPEAT warning', 'REPEAT warning',
            'TRACE alert 1 cleared', 'REPLY ok', 'HIDE']);
    // The hold max ends it: hidden, nothing more.
    assert.deepEqual(run(['driver', '60000'], ['accept warning:1 duration:0', 'update', 'clock 1058000', 'update',
        'clock 1060000', 'update', 'clock 1070000', 'update'].join('\n')).trim().split('\n'),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 60000), 'SHOWN warning', 'REPEAT warning', 'HIDE']);
    // A timed alert plays its sound once only.
    assert.deepEqual(driver(['accept warning:1 duration:20', 'update', 'clock 1005000', 'update', 'clock 1010000', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 20000), 'SHOWN warning']);
    // No extra clock read: shown on the second read of the first update, repeated on the sixth update.
    assert.deepEqual(driver(['step 1000', 'accept warning:1 duration:0', 'update', 'update', 'update', 'update', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 598000), 'SHOWN warning']);
    assert.deepEqual(driver(['step 1000', 'accept warning:1 duration:0', 'update', 'update', 'update', 'update', 'update', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 598000), 'SHOWN warning', 'REPEAT warning']);
});

test('driver: H4 no repeat while suspended by a failed alert or covered; the 5 s cadence restarts when it shows again', () => {
    assert.deepEqual(driver(['accept warning:1 duration:0', 'update', 'clock 1001000', 'accept failed:1 duration:10', 'update',
        'clock 1005000', 'update', 'clock 1011000', 'update', 'clock 1015999', 'update', 'clock 1016000', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 600000), 'SHOWN warning',
            'TRACE alert 1 suspended: a failed alert preempts it', 'REPLY ok id=2', 'HIDE', showJson(['failed'], 1, 1, 10000), 'SHOWN failed',
            'HIDE', showJson(['warning'], 1, 1, 589000), 'REPEAT warning']);
    // Covered while showing (wallpaper under a fullscreen window): silent; restarts from the uncover.
    assert.deepEqual(driver(['wallpaper', 'accept warning:1 duration:0', 'update', 'covered 1', 'clock 1005000', 'update',
        'clock 1010000', 'update', 'covered 0', 'clock 1012000', 'update', 'clock 1016999', 'update', 'clock 1017000', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 600000), 'SHOWN warning', 'REPEAT warning']);
    // Waiting under a fullscreen window: nothing until shown, then 5 s after that.
    assert.deepEqual(driver(['wallpaper', 'covered 1', 'accept warning:1 duration:0', 'update', 'clock 1010000', 'update',
        'covered 0', 'update', 'clock 1014999', 'update', 'clock 1015000', 'update']),
        ['REPLY ok id=1', showJson(['warning'], 1, 1, 590000), 'SHOWN warning', 'REPEAT warning']);
});

test('work area: CielWin AlertLayerWorkArea.Resolve, and the wallpaper output minus reserved zones', () => {
    assert.deepEqual(run(['workarea']).trim().split('\n'), [
        '0 0 1920 1040', '0 40 2560 1400', '0 0 1920 1080', '0 0 0 0', '0 0 0 0',
        '0 0 1883 1080', '0 45 1920 1035', '0 0 1920 1080', '0 0 0 0']);
});

// ---- Host <-> page bridge (MiniSceneWindowController.Post/OnReady/HideAlert) ----

const SOURCE = 'qrc:/shared/js/alert-overlay.js';
const bridge = script => run(['bridge'], script.join('\n')).trim().split('\n');

test('bridge: a show before the page is ready waits in one slot and is posted on the ready marker', () => {
    assert.deepEqual(bridge(['attach 1', 'ready?', 'post {"type":"show","a":1}', 'post {"type":"show","a":2}',
        `msg 1 0 ${SOURCE} CIELINUX_ALERT_READY_V1`, 'ready?', 'post {"type":"show","a":3}', 'hide']),
        ['NOT_READY', 'CMD 1 {"type":"show","a":2}', 'CONSUMED', 'READY', 'CMD 1 {"type":"show","a":3}', 'CMD 1 {"type":"hide"}']);
    // Hide drops a pending show and sends nothing to a page that is not ready.
    assert.deepEqual(bridge(['attach 1', 'post {"type":"show"}', 'hide', `msg 1 0 ${SOURCE} CIELINUX_ALERT_READY_V1`]), ['CONSUMED']);
    // A new generation (scene switch or recovery) is not ready until its own page says so.
    assert.deepEqual(bridge(['attach 1', `msg 1 0 ${SOURCE} CIELINUX_ALERT_READY_V1`, 'attach 2', 'ready?',
        'post {"type":"show"}', `msg 1 0 ${SOURCE} CIELINUX_ALERT_READY_V1`, `msg 2 0 ${SOURCE} CIELINUX_ALERT_READY_V1`]),
        ['CONSUMED', 'NOT_READY', 'PASS', 'CMD 2 {"type":"show"}', 'CONSUMED']);
});

test('bridge: B2 scene pause - desired state posted to a ready page on change, told again to every new page', () => {
    // CielWin WebViewAlertLayerController.SetScenePaused/TryMarkReady: remembered while not ready,
    // posted on ready (before a pending show), never repeated, re-sent to a fresh page that starts running.
    assert.deepEqual(bridge(['attach 1', 'pause 1', 'post {"type":"show"}', `msg 1 0 ${SOURCE} CIELINUX_ALERT_READY_V1`,
        'pause 1', 'pause 0', 'pause 0', 'attach 2', `msg 2 0 ${SOURCE} CIELINUX_ALERT_READY_V1`, 'pause 1',
        'attach 3', `msg 3 0 ${SOURCE} CIELINUX_ALERT_READY_V1`]),
        ['CMD 1 {"type":"pause"}', 'CMD 1 {"type":"show"}', 'CONSUMED', 'CMD 1 {"type":"resume"}', 'CONSUMED',
            'CMD 2 {"type":"pause"}', 'CMD 3 {"type":"pause"}', 'CONSUMED']);
});

test('bridge: only the exact markers from the overlay script, at info level, for the current page count', () => {
    const rejected = [
        `msg 1 1 ${SOURCE} CIELINUX_ALERT_READY_V1`, `msg 1 0 qrc:/idle/js/animate.js CIELINUX_ALERT_READY_V1`,
        `msg 1 0 ${SOURCE}?x CIELINUX_ALERT_READY_V1`, `msg 1 0 ${SOURCE} CIELINUX_ALERT_READY_V1 `,
        `msg 1 0 ${SOURCE} ready`, `msg 1 0 ${SOURCE} CIELINUX_ALERT_SHOW_V1`, `msg 3 0 ${SOURCE} CIELINUX_ALERT_DONE_V1`];
    assert.deepEqual(bridge(['attach 1', ...rejected, 'ready?']), [...rejected.map(() => 'PASS'), 'NOT_READY']);
    assert.deepEqual(bridge(['attach 1', `msg 1 0 ${SOURCE} CIELINUX_ALERT_DONE_V1`]), ['DONE 1', 'CONSUMED']);
});

// ---- POST /v1/alerts end to end (LocalHttpCommandServerTests' alert cases) ----

const startServer = () => new Promise((resolve, reject) => {
    const child = spawn(binary, ['serve', join(fixture, 'srv', 'http.token')], { env: harnessEnv() });
    const state = { child, stdout: '', port: 0 };
    child.stdout.on('data', chunk => {
        state.stdout += chunk;
        const listening = state.stdout.match(/LISTENING (\d+)/);
        if (listening && !state.port) {
            state.port = Number(listening[1]);
            state.token = readFileSync(join(fixture, 'srv', 'http.token'), 'utf8').trim();
            resolve(state);
        }
    });
    child.on('error', reject);
    child.on('exit', code => { if (!state.port) reject(new Error(`harness exited ${code}`)); });
});

const post = (port, token, body, path = '/v1/alerts') => new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const chunks = [];
    const payload = Buffer.from(body, 'utf8');
    socket.on('connect', () => socket.write(Buffer.concat([Buffer.from(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
        + `Authorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n`), payload])));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: Number(text.split(' ')[1]), body: text.slice(text.indexOf('\r\n\r\n') + 4) });
    });
});

test('server: valid 202 ok, busy-ignore 202 ok, invalid 400 with the reason', async () => {
    const server = await startServer();
    try {
        assert.deepEqual(await post(server.port, server.token, '{"failed":1,"warning":9,"duration":30}'), { status: 202, body: 'ok id=1' });
        assert.deepEqual(await post(server.port, server.token, '{"warning":1}'), { status: 202, body: 'ok' });
        assert.deepEqual(await post(server.port, server.token, '{"warning":0}'), { status: 400, body: "error: 'warning:0' must be 1..16" });
        assert.deepEqual(await post(server.port, server.token, '{"info":1}'), { status: 400, body: "error: unknown field 'info'" });
        assert.deepEqual(await post(server.port, server.token, '{}'),
            { status: 400, body: "error: at least one 'warning:N' or 'failed:N' group is required" });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.match(server.stdout, new RegExp(`SHOW \\{"type":"show","tiles":\\["failed",${Array(7).fill('"warning"').join(',')}\\],`
            + `"columns":4,"rows":2,"gap":8,"workArea":\\{"left":0,"top":0,"width":0,"height":0\\},"duration":30000\\}`));
        assert.equal(server.stdout.match(/SHOW /g).length, 1);
        assert.match(server.stdout, /TRACE alert ignored: one is already showing/);
    } finally { server.child.kill('SIGKILL'); }
});

test('server: H1 held warning, ok id=<n>, POST /v1/alerts/clear and the duration:0 rejection end to end', async () => {
    const server = await startServer();
    const clear = body => post(server.port, server.token, body, '/v1/alerts/clear');
    try {
        assert.deepEqual(await post(server.port, server.token, '{"failed":1,"duration":0}'),
            { status: 400, body: "error: 'duration:0' requires warning only" });
        assert.deepEqual(await post(server.port, server.token, '{"warning":1,"duration":0}'), { status: 202, body: 'ok id=1' });
        assert.deepEqual(await post(server.port, server.token, '{"warning":2}'), { status: 202, body: 'ok' });
        assert.deepEqual(await clear('{"id":7}'), { status: 202, body: 'ok' });
        assert.deepEqual(await clear('{"id":1}'), { status: 202, body: 'ok' });
        assert.deepEqual(await clear('{}'), { status: 202, body: 'ok' });
        assert.deepEqual(await clear('{"id":0}'), { status: 400, body: "error: field 'id' must be a whole number >= 1" });
        assert.deepEqual(await clear('{"warning":1}'), { status: 400, body: "error: unknown field 'warning'" });
        assert.deepEqual(await clear(`{}${' '.repeat(62)}`), { status: 202, body: 'ok' });
        assert.deepEqual(await clear(`{}${' '.repeat(63)}`), { status: 413, body: 'error: request body is too large' });
        assert.deepEqual(await post(server.port, server.token, '{"warning":1,"duration":0}'), { status: 202, body: 'ok id=2' });
        assert.deepEqual(await clear('{}'), { status: 202, body: 'ok' });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(server.stdout.match(/TRACE alert \d+ cleared/g).join(), 'TRACE alert 1 cleared,TRACE alert 2 cleared');
        assert.equal(server.stdout.match(/HIDE/g).length, 2);
    } finally { server.child.kill('SIGKILL'); }
});

test('docs: H1 the README documents the held warning, its id, the clear route and the hold max setting', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /"duration": ?0/);
    assert.match(readme, /ok id=<n>/);
    assert.match(readme, /\/v1\/alerts\/clear/);
    assert.match(readme, /alert-hold-max-seconds/);
    assert.match(readFileSync(join(ROOT, 'docs', 'cielwin-portability.md'), 'utf8'), /\/v1\/alerts\/clear/);
});

// ---- Page side: shared/js/alert-overlay.js over the bridge ----

function overlayHarness({ variant = 'mini' } = {}) {
    const logs = [], fills = [], texts = [];
    const context = () => new Proxy({ globalAlpha: 1 }, {
        get(target, name) {
            if (name in target) return target[name];
            if (name === 'measureText') return text => ({ width: String(text).length * 10 });
            return (...args) => { if (name === 'fillText') { texts.push(args[0]); fills.push([args[0], target.fillStyle]); } };
        },
        set(target, name, value) { target[name] = value; return true; },
    });
    const canvas = { width: 240, height: 240, style: {}, getContext: () => context() };
    const sandbox = vm.createContext({
        window: {}, location: { search: variant === 'mini' ? '?variant=mini&fps=30' : '?fps=60', hash: '' }, URLSearchParams,
        console: { log: (...args) => logs.push(args.join(' ')), error: () => {} },
        document: { createElement: () => ({ width: 0, height: 0, getContext: () => context() }) },
        canvas, ctx: context(), W: 240, H: 240, canvasScaleX: 1, canvasScaleY: 1,
        isMiniVariant: variant === 'mini',
        sceneSeeThroughLayer: () => {},
    });
    vm.runInContext(read('shared/js/alert-overlay.js'), sandbox, { filename: SOURCE });
    return { sandbox, logs, fills, texts };
}

test('overlay page: posts the ready marker once on load and never auto-shows without a command', () => {
    const h = overlayHarness();
    assert.deepEqual(h.logs, ['CIELINUX_ALERT_READY_V1']);
    assert.equal(vm.runInContext('animating', h.sandbox), false);
    assert.equal(typeof h.sandbox.cielinuxAlertCommand, 'function');
});

test('overlay page: show/hide commands drive the shared state machine and done is posted once', () => {
    const h = overlayHarness();
    h.sandbox.cielinuxAlertCommand('{"type":"show","tiles":["failed","warning"],"columns":2,"rows":1,"gap":8,'
        + '"workArea":{"left":0,"top":0,"width":0,"height":0},"duration":1000}');
    assert.equal(vm.runInContext('animating', h.sandbox), true);
    assert.equal(vm.runInContext('tiles.join()', h.sandbox), 'failed,warning');
    vm.runInContext('renderAlertOverlay(0, W, H, 0); renderAlertOverlay(500, W, H, 0); renderAlertOverlay(999, W, H, 0)', h.sandbox);
    assert.ok(h.texts.includes('FAILED') && h.texts.includes('WARNING'), 'both tiles drew their titles');
    vm.runInContext('renderAlertOverlay(1000, W, H, 0); renderAlertOverlay(1100, W, H, 0)', h.sandbox);
    assert.deepEqual(h.logs, ['CIELINUX_ALERT_READY_V1', 'CIELINUX_ALERT_DONE_V1']);
    assert.equal(vm.runInContext('animating', h.sandbox), false);
    h.sandbox.cielinuxAlertCommand('{"type":"show","tiles":["warning"],"columns":1,"rows":1,"gap":8,"duration":5000}');
    h.sandbox.cielinuxAlertCommand('{"type":"hide"}');
    assert.equal(vm.runInContext('animating', h.sandbox), false);
});

test('overlay page: malformed commands are ignored; only show/hide/pause/resume are understood', () => {
    const h = overlayHarness();
    for (const bad of ['', 'not json', '"show"', '[1]', 'null', '{"type":"eval","code":"x"}'])
        assert.doesNotThrow(() => h.sandbox.cielinuxAlertCommand(bad), bad);
    assert.equal(vm.runInContext('animating', h.sandbox), false);
    const overlay = read('shared/js/alert-overlay.js');
    assert.doesNotMatch(overlay, /\beval\(|new Function|fetch\(|XMLHttpRequest|innerHTML|setTimeout\(\s*["']/);
});

// The CielWin shared overlay (CielWin.App/Wallpaper/Web/shared/js/alert-overlay.js at 14ff645),
// byte-identical once the additive, marked Linux blocks are removed.
const OVERLAY_REFERENCE_SHA256 = 'ca3ea282f62fcee9e009548ac0a9556bd018c8c2d99d7e6d10928313ef19c2d0';
const stripLinuxPort = text => text.replace(
    /(?:\n(?=\/\/ Linux port begin))?^[ \t]*\/\/ Linux port begin[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux port end\.\n/gm, '');

test('overlay page: the CielWin overlay plus twelve additive Linux blocks (bridge, markers, keyed letters, W1 static layers, W4 bands)', async () => {
    const { createHash } = await import('node:crypto');
    const overlay = read('shared/js/alert-overlay.js');
    // W1 (odd/tasks/wallpaper-explorer-idle-cpu.md) adds three blocks: the static-layer cache, its use in
    // drawFailureOverlay and its release in renderAlertOverlay. W4 adds five: the band/module/backdrop helpers,
    // their use in drawFailureOverlay, drawTilePixelated and captureBackdropIfNeeded, and the module release.
    assert.equal(overlay.match(/\/\/ Linux port begin/g).length, 12);
    assert.equal(overlay.match(/\/\/ Linux port end\./g).length, 12);
    assert.equal(createHash('sha256').update(stripLinuxPort(overlay)).digest('hex'), OVERLAY_REFERENCE_SHA256);
    // Exactly two markers leave the page, both from postToHost's own "ready"/"done".
    assert.deepEqual([...overlay.matchAll(/CIELINUX_ALERT_[A-Z_0-9]+/g)].map(m => m[0]), ['CIELINUX_ALERT_READY_V1', 'CIELINUX_ALERT_DONE_V1']);
    // The bundled title face ships with its licence.
    assert.ok(existsSync(source('shared/fonts/ArchivoBlack-Regular.ttf')));
    assert.match(read('shared/fonts/OFL.txt'), /SIL OPEN FONT LICENSE/i);
});

test('overlay page: under the mini luminance key the letters keep their hue at full brightness', () => {
    const fillsFor = variant => {
        const h = overlayHarness({ variant });
        h.sandbox.cielinuxAlertCommand('{"type":"show","tiles":["failed","warning"],"columns":2,"rows":1,"gap":8,"duration":9000}');
        vm.runInContext('renderAlertOverlay(0, W, H, 0); renderAlertOverlay(2000, W, H, 0)', h.sandbox);
        return h.fills;
    };
    const titles = fills => fills.filter(([text]) => text === 'FAILED' || text === 'WARNING').map(pair => pair.join(' '));
    const mini = new Set(titles(fillsFor('mini'))), full = new Set(titles(fillsFor('full')));
    assert.deepEqual([...mini].sort(), ['FAILED rgb(255,0,36)', 'WARNING rgb(255,163,0)'], 'mini letters keyed opaque');
    assert.deepEqual([...full].sort(), ['FAILED rgb(112,0,16)', 'WARNING rgb(150,96,0)'], 'full-size keeps the CielWin letters');
});
