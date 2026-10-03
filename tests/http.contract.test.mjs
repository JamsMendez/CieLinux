// A3 local HTTP server: CielWin parity (CielWin.Interop/LocalHttpCommandServer.cs,
// WallpaperSceneHttpProtocol.cs, AlertHttpProtocol.cs, CielWin.App/Alerts/AlertHttpTokenFile.cs
// and their tests). The server and token file are compiled from the shipped sources into a
// small QtNetwork harness and driven over raw loopback sockets on an ephemeral port, so every
// header, status and body is exactly what a real client sees.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { ROOT, SRC, source } from './paths.mjs';

const read = name => readFileSync(source(name), 'utf8');
let binary, fixture;

const harnessEnv = () => {
    const env = { ...process.env, QT_QPA_PLATFORM: 'offscreen', QT_FORCE_STDERR_LOGGING: '1' };
    delete env.WAYLAND_DISPLAY;
    env.XDG_STATE_HOME = join(fixture, 'state');
    env.XDG_CONFIG_HOME = join(fixture, 'config');
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(fixture, 'no-session-bus')}`;
    return env;
};

const run = (args, { input, env = harnessEnv() } = {}) => {
    const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30000, env, input });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
};

after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

before(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cielinux-a3-contract.'));
    binary = join(fixture, 'build', 'http-contract');
    writeFileSync(join(fixture, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(HttpContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Network)
add_executable(http-contract harness.cpp "${SRC}/http-server.cpp" "${SRC}/http-server.h"
    "${SRC}/http-token.cpp" "${SRC}/http-token.h" "${SRC}/alerts.cpp" "${SRC}/alerts.h")
target_include_directories(http-contract PRIVATE "${SRC}")
target_link_libraries(http-contract PRIVATE Qt6::Core Qt6::Network)
`);
    writeFileSync(join(fixture, 'harness.cpp'), String.raw`
#include "http-server.h"
#include "http-token.h"
#include <QCoreApplication>
#include <QFile>
#include <QHostAddress>
#include <QTextStream>
#include <cstdio>
#include <iostream>

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    const QStringList args = app.arguments().mid(1);
    const QString command = args.value(0);
    if (command == "validate") {
        QFile in; in.open(stdin, QIODevice::ReadOnly);
        const SceneBodyResult r = HttpProtocol::validateSceneBody(QString::fromUtf8(in.readAll()));
        std::cout << (r.accepted ? "ACCEPT " + r.scene.toStdString() : "REJECT " + r.error.toStdString());
        return 0;
    }
    if (command == "loopback") {
        std::cout << (HttpProtocol::isLoopbackPeer(QHostAddress(args.value(1))) ? "yes" : "no");
        return 0;
    }
    if (command == "resolve") {
        std::cout << HttpToken::resolvePath().toStdString();
        return 0;
    }
    if (command == "token") {
        const QByteArray token = HttpToken::loadOrCreate(args.value(1), [](const QString &line) {
            std::cerr << "DIAG " << line.toStdString() << "\n";
        });
        std::cout << (token.isEmpty() ? std::string("NULL") : "TOKEN " + token.toStdString());
        return 0;
    }
    if (command == "serve") {
        const QByteArray token = HttpToken::loadOrCreate(args.value(2), [](const QString &line) {
            std::cerr << "DIAG " << line.toStdString() << "\n";
        });
        if (token.isEmpty()) return 4;
        const bool refuse = args.value(3) == "refuse";
        HttpServer server(quint16(args.value(1).toUInt()), token, [&](const QString &scene) {
            std::cout << "SWITCH " << scene.toStdString() << std::endl;
            return !refuse;
        }, [&](const QString &command) {
            // A4: the alert handler sees the translated command text; "refuse" answers like
            // CielWin with alerts turned off.
            std::cout << "ALERT " << command.toStdString() << std::endl;
            return refuse ? QStringLiteral("error: alerts are disabled") : QStringLiteral("ok");
        });
        if (server.start()) std::cout << "LISTENING " << server.port() << std::endl;
        else std::cout << "UNAVAILABLE" << std::endl;
        return app.exec();
    }
    return 2;
}
`);
    for (const args of [['-S', fixture, '-B', join(fixture, 'build')], ['--build', join(fixture, 'build'), '-j2']]) {
        const result = spawnSync('cmake', args, { encoding: 'utf8', timeout: 180000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
});

// ---- pure scene body validation (WallpaperSceneHttpProtocolTests) ----

const validate = body => run(['validate'], { input: body }).stdout;
const bodyOf = scene => JSON.stringify({ scene });
const UNKNOWN = "field 'scene' must be one of: processing, explorer, idle, raphael";

test('scene body: the four scenes are accepted case-insensitively and normalised to lowercase', () => {
    for (const [raw, expected] of [['processing', 'processing'], ['explorer', 'explorer'], ['idle', 'idle'],
        ['raphael', 'raphael'], ['PROCESSING', 'processing'], ['Explorer', 'explorer'], ['IdLe', 'idle'],
        ['RAPHAEL', 'raphael']])
        assert.equal(validate(bodyOf(raw)), `ACCEPT ${expected}`, raw);
});

test('scene body: every CielWin rejection, with its exact message', () => {
    const cases = [
        ['', 'body is not valid JSON'], ['not json', 'body is not valid JSON'], ['{', 'body is not valid JSON'],
        ['{"scene":"idle\\uD800"}', 'body is not valid JSON'], ['{"\\uD800":"idle"}', 'body is not valid JSON'],
        ['{"scene":"\\uDC00"}', 'body is not valid JSON'], ['{"a":1} x', 'body is not valid JSON'],
        ['[1]', 'body must be a JSON object'], ['2', 'body must be a JSON object'],
        ['null', 'body must be a JSON object'], ['"idle"', 'body must be a JSON object'],
        ['{}', "field 'scene' is required"],
        ['{"scene":123}', "field 'scene' must be a string"], ['{"scene":true}', "field 'scene' must be a string"],
        ['{"scene":null}', "field 'scene' must be a string"],
        [bodyOf(''), "field 'scene' must not be empty"],
        ['{"scene":"idle","extra":1}', "unknown field 'extra'"],
        // Stage 1 rule (CielWin parity): the scene route switches the scene only; a mode
        // field is an unknown field, never a mode change.
        ['{"scene":"idle","mode":"scene"}', "unknown field 'mode'"],
    ];
    for (const raw of ['wallpaper', 'video', 'html', 'mini', 'proc essing', ' idle']) cases.push([bodyOf(raw), UNKNOWN]);
    for (const [body, message] of cases) assert.equal(validate(body), `REJECT ${message}`, body);
    // An escaped valid surrogate pair is not a lone surrogate.
    assert.equal(validate('{"scene":"\\uD83D\\uDE00"}'), `REJECT ${UNKNOWN}`);
    assert.equal(validate('{"scene":"idle","scene":"raphael"}'), 'ACCEPT raphael');
    assert.equal(validate(' {"scene":"idle"} \n'), 'ACCEPT idle');
});

test('loopback peer test: 127.0.0.0/8, ::1 and IPv4-mapped loopback only', () => {
    for (const [address, expected] of [['127.0.0.1', 'yes'], ['127.1.2.3', 'yes'], ['::1', 'yes'],
        ['::ffff:127.0.0.1', 'yes'], ['::ffff:10.0.0.1', 'no'], ['10.0.0.1', 'no'], ['192.168.1.1', 'no'],
        ['0.0.0.0', 'no'], ['::', 'no'], ['', 'no']])
        assert.equal(run(['loopback', address]).stdout, expected, address);
});

// ---- token file (AlertHttpTokenFileTests) ----

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const tokenAt = path => {
    const result = run(['token', path]);
    assert.equal(result.status, 0, result.stderr);
    return { token: result.stdout.replace(/^TOKEN /, ''), raw: result.stdout, diag: result.stderr };
};
const mode = path => statSync(path).mode & 0o777;

test('token: XDG_STATE_HOME path, falling back to ~/.local/state', () => {
    const env = harnessEnv();
    assert.equal(run(['resolve'], { env }).stdout, join(fixture, 'state', 'cielinux', 'http.token'));
    for (const xdg of [undefined, '', 'relative/state']) {
        const other = { ...env, HOME: '/home/someone' };
        if (xdg === undefined) delete other.XDG_STATE_HOME; else other.XDG_STATE_HOME = xdg;
        assert.equal(run(['resolve'], { env: other }).stdout, '/home/someone/.local/state/cielinux/http.token');
    }
});

test('token: first run creates a 43-char base64url token, dir 0700, file 0600; reused unchanged', () => {
    const dir = join(fixture, 'tok1', 'nested');
    const path = join(dir, 'http.token');
    const first = tokenAt(path);
    assert.match(first.token, TOKEN);
    assert.equal(first.diag, '');
    assert.equal(readFileSync(path, 'utf8').trim(), first.token);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(path), 0o600);
    assert.equal(tokenAt(path).token, first.token);
    // A trailing newline (hand-edited file) is not malformed.
    writeFileSync(path, `${first.token}\n`, { mode: 0o600 });
    assert.equal(tokenAt(path).token, first.token);
    // A valid token in a too-open file is kept, and the file is tightened to 0600.
    chmodSync(path, 0o644);
    assert.equal(tokenAt(path).token, first.token);
    assert.equal(mode(path), 0o600);
    // Two fresh files get different tokens.
    assert.notEqual(tokenAt(join(fixture, 'tok1b', 'http.token')).token, first.token);
});

test('token: empty or malformed files are replaced, with a diagnostic that never holds the token', () => {
    const malformed = ['', 'short', 'A'.repeat(44), `${'A'.repeat(42)}+`, `${'A'.repeat(21)} ${'A'.repeat(21)}`,
        `${'A'.repeat(42)}=`];
    malformed.forEach((content, index) => {
        const dir = join(fixture, `tok-bad-${index}`);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'http.token');
        writeFileSync(path, content);
        const replaced = tokenAt(path);
        assert.match(replaced.token, TOKEN, JSON.stringify(content));
        assert.match(replaced.diag, /DIAG .*invalid token/);
        assert.ok(!replaced.diag.includes(replaced.token));
        assert.equal(mode(path), 0o600);
        assert.equal(tokenAt(path).token, replaced.token);
    });
});

test('token: an unwritable path returns no token and reports a diagnostic without crashing', () => {
    const blocker = join(fixture, 'tok-blocker');
    writeFileSync(blocker, 'a file, not a directory');
    const result = tokenAt(join(blocker, 'http.token'));
    assert.equal(result.raw, 'NULL');
    assert.match(result.diag, /DIAG /);
});

test('token: concurrent first runs converge on one token', async () => {
    const path = join(fixture, 'tok-race', 'http.token');
    const runs = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
        const child = spawn(binary, ['token', path], { env: harnessEnv() });
        let out = '';
        child.stdout.on('data', chunk => { out += chunk; });
        child.on('error', reject);
        child.on('close', () => resolve(out));
    }));
    const tokens = new Set(await Promise.all(runs));
    assert.equal(tokens.size, 1, [...tokens].join(' | '));
    assert.match([...tokens][0], /^TOKEN [A-Za-z0-9_-]{43}$/);
});

// ---- the server over raw loopback sockets (LocalHttpCommandServerTests) ----

const startServer = (args = []) => new Promise((resolve, reject) => {
    const tokenPath = join(fixture, `srv-${Math.random().toString(36).slice(2)}`, 'http.token');
    const token = tokenAt(tokenPath).token;
    const child = spawn(binary, ['serve', args[0] ?? '0', tokenPath, ...args.slice(1)], { env: harnessEnv() });
    const state = { child, token, stdout: '', stderr: '', port: 0 };
    child.stderr.on('data', chunk => { state.stderr += chunk; });
    child.stdout.on('data', chunk => {
        state.stdout += chunk;
        const listening = state.stdout.match(/LISTENING (\d+)/);
        if (listening && !state.port) { state.port = Number(listening[1]); resolve(state); }
        if (state.stdout.includes('UNAVAILABLE')) resolve(state);
    });
    child.on('error', reject);
    child.on('exit', code => { if (!state.port) reject(new Error(`harness exited ${code}: ${state.stderr}`)); });
});

const send = (port, raw, { host = '127.0.0.1', timeout = 4000 } = {}) => new Promise((resolve, reject) => {
    const socket = connect({ port, host });
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timed out')); }, timeout);
    socket.on('connect', () => socket.write(raw));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        const split = text.indexOf('\r\n\r\n');
        const head = split < 0 ? text : text.slice(0, split);
        const [statusLine, ...lines] = head.split('\r\n');
        const headers = {};
        for (const line of lines) {
            const colon = line.indexOf(':');
            if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
        }
        resolve({ status: Number(statusLine.split(' ')[1]) || 0, headers, body: split < 0 ? '' : text.slice(split + 4), text });
    });
});

const req = (port, { method = 'POST', path = '/v1/wallpaper/scene', host = `127.0.0.1:${port}`, headers = {},
    body = '', token, contentType = 'application/json', chunked = false } = {}) => {
    const lines = [`${method} ${path} HTTP/1.1`];
    if (host !== null) lines.push(`Host: ${host}`);
    if (token !== undefined && token !== null) lines.push(`Authorization: Bearer ${token}`);
    if (contentType !== null) lines.push(`Content-Type: ${contentType}`);
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    if (chunked) lines.push('Transfer-Encoding: chunked');
    else lines.push(`Content-Length: ${payload.length}`);
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    let framed = payload;
    if (chunked) {
        const parts = [];
        for (let i = 0; i < payload.length; i += 100) {
            const piece = payload.subarray(i, i + 100);
            parts.push(Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from('\r\n'));
        }
        parts.push(Buffer.from('0\r\n\r\n'));
        framed = Buffer.concat(parts);
    }
    return send(port, Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), framed]));
};

let server;
before(async () => { server = await startServer(); });
after(() => { server?.child.kill('SIGKILL'); });

const expectReply = (reply, status, body) => {
    assert.equal(reply.status, status, reply.text);
    assert.equal(reply.body, body, reply.text);
    assert.equal(reply.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(reply.headers['content-length'], String(Buffer.byteLength(body)));
};
const switches = () => server.stdout.match(/SWITCH \S+/g) ?? [];

test('server: a valid scene request switches through the delegate with the canonical name -> 202 ok', async () => {
    const p = server.port, t = server.token;
    expectReply(await req(p, { token: t, body: '{"scene":"Explorer"}' }), 202, 'ok');
    expectReply(await req(p, { token: t, body: '{"scene":"idle"}', host: `localhost:${p}` }), 202, 'ok');
    expectReply(await req(p, { token: t, body: '{"scene":"idle"}', contentType: 'application/json; charset=utf-8' }), 202, 'ok');
    expectReply(await req(p, { token: t, body: '{"scene":"raphael"}', chunked: true }), 202, 'ok');
    // Bearer scheme is case-insensitive; the token is not.
    expectReply(await req(p, { body: '{"scene":"processing"}', headers: { Authorization: `bearer ${t}` } }), 202, 'ok');
    // The route is matched on the path; a query string is ignored (HttpListener AbsolutePath).
    expectReply(await req(p, { token: t, body: '{"scene":"idle"}', path: '/v1/wallpaper/scene?x=1' }), 202, 'ok');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(switches(), ['SWITCH explorer', 'SWITCH idle', 'SWITCH idle', 'SWITCH raphael',
        'SWITCH processing', 'SWITCH idle']);
});

test('server: the gate order is loopback, Origin, Host, 404, 405+Allow, 401, 415, 413, UTF-8, validate', async () => {
    const p = server.port, t = server.token;
    const before = switches().length;
    // 2. Any Origin header wins over everything after it (even a wrong path).
    expectReply(await req(p, { path: '/nope', headers: { Origin: 'http://evil.example' } }), 403,
        'error: browser requests are not accepted');
    // 3. Host must be exactly 127.0.0.1:port or localhost:port.
    expectReply(await req(p, { path: '/nope', host: 'evil.example:1234' }), 403, 'error: unexpected host header');
    expectReply(await req(p, { host: `127.0.0.1:${p + 1}`, token: t, body: '{"scene":"idle"}' }), 403, 'error: unexpected host header');
    expectReply(await req(p, { host: null, token: t, body: '{"scene":"idle"}' }), 403, 'error: unexpected host header');
    // 4. Unknown path (and the retired video route) before the method.
    expectReply(await req(p, { method: 'GET', path: '/nope' }), 404, 'error: no such route');
    expectReply(await req(p, { path: '/v1/wallpaper/video', token: t }), 404, 'error: no such route');
    // 5. Method before the token, with Allow: POST; OPTIONS gets no CORS headers.
    for (const method of ['GET', 'PUT', 'OPTIONS']) {
        const reply = await req(p, { method });
        expectReply(reply, 405, 'error: method not allowed');
        assert.equal(reply.headers.allow, 'POST');
        assert.ok(!Object.keys(reply.headers).some(name => name.startsWith('access-control-')), reply.text);
    }
    // 6. Bearer token before the content type, with WWW-Authenticate: Bearer.
    for (const token of [undefined, 'wrong', `${t}x`, t.toLowerCase() === t ? null : t.toLowerCase()].filter(v => v !== null)) {
        const reply = await req(p, { token, contentType: 'text/plain' });
        expectReply(reply, 401, 'error: missing or invalid bearer token');
        assert.equal(reply.headers['www-authenticate'], 'Bearer');
    }
    // 7. Content type before the size cap.
    expectReply(await req(p, { token: t, contentType: 'text/plain', body: 'x'.repeat(300) }), 415,
        'error: content type must be application/json');
    expectReply(await req(p, { token: t, contentType: null }), 415, 'error: content type must be application/json');
    // 8. Size cap (scene 256 B): declared, chunked, and the exact boundary.
    expectReply(await req(p, { token: t, body: 'x'.repeat(257) }), 413, 'error: request body is too large');
    expectReply(await req(p, { token: t, body: 'x'.repeat(400), chunked: true }), 413, 'error: request body is too large');
    const atCap = '{"scene":"idle"}'.padEnd(256, ' ');
    expectReply(await req(p, { token: t, body: atCap }), 202, 'ok');
    expectReply(await req(p, { token: t, body: `${atCap} ` }), 413, 'error: request body is too large');
    // 9. Strict UTF-8.
    for (const bad of [[0xff], [0xed, 0xa0, 0x80], [0xc0, 0xaf], [0xe2, 0x82]])
        expectReply(await req(p, { token: t, body: Buffer.from(bad) }), 400, 'error: body is not valid UTF-8');
    // 10. Validation with the route's own messages.
    expectReply(await req(p, { token: t, body: 'not json' }), 400, 'error: body is not valid JSON');
    expectReply(await req(p, { token: t, body: '{"scene":"video"}' }), 400, `error: ${UNKNOWN}`);
    expectReply(await req(p, { token: t, body: '{"scene":"idle","mode":"scene"}' }), 400, "error: unknown field 'mode'");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(switches().length, before + 1, 'only the at-cap request reached the delegate');
});

test('server: alerts route runs the same gates with its 1024 B cap, then hands the translated command over', async () => {
    const p = server.port, t = server.token;
    const path = '/v1/alerts';
    expectReply(await req(p, { path, method: 'GET' }), 405, 'error: method not allowed');
    expectReply(await req(p, { path }), 401, 'error: missing or invalid bearer token');
    expectReply(await req(p, { path, token: t, contentType: 'text/plain' }), 415, 'error: content type must be application/json');
    expectReply(await req(p, { path, token: t, body: 'x'.repeat(1025) }), 413, 'error: request body is too large');
    expectReply(await req(p, { path, token: t, body: 'x'.repeat(2000), chunked: true }), 413, 'error: request body is too large');
    expectReply(await req(p, { path, token: t, body: Buffer.from([0xff]) }), 400, 'error: body is not valid UTF-8');
    // Between the scene cap and the alert cap: 413 on the scene route only.
    const between = `{"warning":1}${' '.repeat(300)}`;
    expectReply(await req(p, { token: t, body: between }), 413, 'error: request body is too large');
    // A4: 10/11 translate the body (CielWin AlertHttpProtocol) and answer with the handler's reply.
    expectReply(await req(p, { path, token: t, body: between }), 202, 'ok');
    expectReply(await req(p, { path, token: t, body: '{"warning":1}'.padEnd(1024, ' ') }), 202, 'ok');
    expectReply(await req(p, { path, token: t, body: '{"failed":2,"duration":7}' }), 202, 'ok');
    expectReply(await req(p, { path, token: t, body: '{"info":1}' }), 400, "error: unknown field 'info'");
    expectReply(await req(p, { path, token: t, body: 'not json' }), 400, 'error: body is not valid JSON');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(server.stdout, /ALERT warning:1\nALERT warning:1\nALERT failed:2 duration:7\n/);
});

test('server: an alert handler answering "alerts are disabled" maps to 503 (CielWin status table)', async () => {
    const refusing = await startServer(['0', 'refuse']);
    try {
        expectReply(await req(refusing.port, { path: '/v1/alerts', token: refusing.token, body: '{"warning":1}' }), 503,
            'error: alerts are disabled');
    } finally { refusing.child.kill('SIGKILL'); }
});

test('server: a refused switch answers 503 with the not-available error', async () => {
    const refusing = await startServer(['0', 'refuse']);
    try {
        expectReply(await req(refusing.port, { token: refusing.token, body: '{"scene":"idle"}' }), 503,
            'error: wallpaper scene switching is not available');
    } finally { refusing.child.kill('SIGKILL'); }
});

test('server: limits (header size, request timeout, connection cap) and malformed framing', async () => {
    const p = server.port, t = server.token;
    const big = await req(p, { token: t, body: '{"scene":"idle"}', headers: { 'X-Pad': 'a'.repeat(9000) } });
    expectReply(big, 431, 'error: request header is too large');
    expectReply(await send(p, 'GARBAGE\r\n\r\n'), 400, 'error: malformed request');
    expectReply(await send(p, `POST /v1/wallpaper/scene HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\n folded: x\r\n\r\n`), 400,
        'error: malformed request');
    expectReply(await send(p, `POST /v1/wallpaper/scene HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nHost: 127.0.0.1:${p}\r\n\r\n`), 400,
        'error: malformed request');
    expectReply(await send(p, `POST /v1/wallpaper/scene HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n`),
        400, 'error: malformed request');
    // A silent client is cut off after the request timeout (2 s), with 408.
    const started = Date.now();
    const slow = await send(p, `POST /v1/wallpaper/scene HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\n`, { timeout: 6000 });
    assert.ok(Date.now() - started >= 1500 && Date.now() - started < 5000, `${Date.now() - started} ms`);
    expectReply(slow, 408, 'error: request timed out');
    // A declared body that never arrives is cut off the same way.
    const partial = await send(p, `POST /v1/wallpaper/scene HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nAuthorization: Bearer ${t}\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{"sc`, { timeout: 6000 });
    expectReply(partial, 408, 'error: request timed out');
    // At most 8 connections at once: the 9th is closed without a reply.
    const idle = await Promise.all(Array.from({ length: 8 }, () => new Promise(resolve => {
        const socket = connect({ port: p, host: '127.0.0.1' }, () => resolve(socket));
        socket.on('error', () => {});
    })));
    await new Promise(resolve => setTimeout(resolve, 100));
    const ninth = await send(p, '', { timeout: 1500 });
    assert.equal(ninth.text, '');
    idle.forEach(socket => socket.destroy());
    await new Promise(resolve => setTimeout(resolve, 200));
    expectReply(await req(p, { token: t, body: '{"scene":"idle"}' }), 202, 'ok');
});

test('server: a busy port is reported once and the host keeps running without HTTP', async () => {
    const second = await startServer([String(server.port)]);
    try {
        assert.match(second.stdout, /UNAVAILABLE/);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(second.stderr.match(/CIELINUX_HTTP unavailable/g)?.length, 1, second.stderr);
        assert.equal(second.child.exitCode, null);
    } finally { second.child.kill('SIGKILL'); }
    // The first server is unaffected.
    expectReply(await req(server.port, { token: server.token, body: '{"scene":"idle"}' }), 202, 'ok');
});

test('server: the IPv6 loopback answers too (localhost may resolve to ::1)', async () => {
    let reply;
    try { reply = await send(server.port, `POST /v1/wallpaper/scene HTTP/1.1\r\nHost: localhost:${server.port}\r\nAuthorization: Bearer ${server.token}\r\nContent-Type: application/json\r\nContent-Length: 16\r\n\r\n{"scene":"idle"}`, { host: '::1' }); }
    catch { return; } // IPv6 disabled on this machine: the IPv4 fallback is the contract.
    expectReply(reply, 202, 'ok');
});

test('server: the token and Authorization header never reach the log', () => {
    assert.ok(server.stderr.length > 0, 'rejections are logged');
    assert.match(server.stderr, /CIELINUX_HTTP rejected 401 missing or invalid bearer token/);
    assert.ok(!server.stderr.includes(server.token));
    assert.ok(!server.stdout.includes(server.token));
    assert.doesNotMatch(server.stderr, /Bearer [A-Za-z0-9_-]/);
});

// ---- host wiring ----

test('host wiring: settings-gated server on the GUI thread, scene route through SceneHost', () => {
    const cpp = read('main.cpp');
    const main = cpp.slice(cpp.indexOf('int main('));
    assert.match(cpp, /#include "http-server\.h"/);
    assert.match(cpp, /#include "http-token\.h"/);
    assert.match(main, /if \(stored\.settings\.httpServerEnabled\)/);
    assert.match(main, /HttpToken::loadOrCreate\(HttpToken::resolvePath\(\)/);
    assert.match(main, /stored\.settings\.httpServerPort/);
    assert.match(main, /return sceneHost\.setScene\(scene\);/);
    // A4: the alert route hands the translated command to the alert driver on this thread.
    assert.match(main, /const QString reply = alertDriver\.accept\(command\);/);
    assert.ok(main.indexOf('SceneHost sceneHost(') < main.indexOf('HttpServer>('));
    assert.ok(main.indexOf('HttpServer>(') < main.indexOf('app.exec()'));
    const server = read('http-server.cpp');
    assert.match(server, /QHostAddress::LocalHost\b/);
    assert.match(server, /QHostAddress::LocalHostIPv6/);
    assert.doesNotMatch(server, /QHostAddress::Any|AnyIPv4|AnyIPv6/);
    assert.doesNotMatch(server, /qrc:\/|retarget/);
    const tokenSource = read('http-token.cpp');
    assert.match(tokenSource, /QRandomGenerator::system\(\)/);
    assert.match(tokenSource, /Base64UrlEncoding/);
    const cmake = read('CMakeLists.txt');
    assert.match(cmake, /find_package\(Qt6 REQUIRED COMPONENTS [^)]*\bNetwork\b/);
    assert.match(cmake, /qt_add_executable\(cielinux src\/main\.cpp src\/settings\.cpp src\/scene-host\.cpp src\/tray\.cpp src\/http-server\.cpp src\/http-token\.cpp src\/alerts\.cpp src\/alert-sounds\.cpp\)/); // A4 adds src/alerts.cpp, A5 src/alert-sounds.cpp
    assert.match(cmake, /target_link_libraries\(cielinux PRIVATE [^)]*Qt6::Network/);
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /## HTTP/);
    assert.match(readme, /curl [^\n]*\/v1\/wallpaper\/scene/);
    assert.match(readme, /http\.token/);
});
