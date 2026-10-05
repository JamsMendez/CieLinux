import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SRC, source, nativeOutput } from './paths.mjs';

const root = SRC;
const read = name => readFileSync(source(name), 'utf8');

test('real portable sink is bounded, sanitized and writes only direct stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cielinux-diagnostics-sink.'));
    const source = join(dir, 'sink-test.cpp');
    const binary = join(dir, 'sink-test');
    writeFileSync(source, `#include "diagnostics.h"
#include <string>
int main() {
    Diagnostics::Sink sink;
    sink.startup(); sink.startup();
    const char controls[] = {'A', '\\r', '\\n', '\\x1b', '\\0', '\\t', '\\x7f', char(0x85), 'Z'};
    sink.console(2, std::string_view(controls, sizeof(controls)), 42,
                 "qrc:/processing/js/main.js?token=SECRET#fragment");
    sink.console(9, "unknown", -1, "/private/SECRET/file.js?token=SECRET");
    sink.console(1, std::string(2000, 'x'), 2147483647, std::string(2000, 's'));
    sink.console(0, "normal", 999999, "qrc:/processing/js/nebula.js");
    sink.console(0, "traversal", 1, "qrc:/processing/js/../js/main.js");
    for (unsigned i = 5; i < 1000; ++i) sink.console(2, "spam", 1, "qrc:/processing/js/main.js");
    sink.failure(); sink.failure();
}
`);
    const compile = spawnSync('g++', ['-std=c++17', '-I', root, source, '-o', binary], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
    const stderr = nativeOutput(run.stderr);
    const lines = stderr.trimEnd().split('\n');
    assert.equal(lines[0], 'CIELINUX_DIAGNOSTICS_HOST_START');
    assert.equal(lines[1], 'CIELINUX_DIAGNOSTICS_JS severity=error source=qrc:/processing/js/main.js line=42 message=A???????Z');
    assert.match(lines[2], /severity=unknown source=<unknown> line=0 message=unknown$/);
    assert.match(lines[3], /severity=warn source=<unknown> line=0 message=x{512}$/);
    assert.match(lines[4], /severity=info source=qrc:\/processing\/js\/nebula.js line=999999/);
    assert.match(lines[5], /source=<unknown>/);
    assert.equal(lines.filter(line => line.startsWith('CIELINUX_DIAGNOSTICS_JS severity=')).length, 64);
    assert.equal(lines.filter(line => line === 'CIELINUX_DIAGNOSTICS_CONSOLE_CAP').length, 1);
    assert.equal(lines.filter(line => line.startsWith('CIELINUX_DIAGNOSTICS_HOST_FAILURE')).length, 1);
    assert.ok(lines.every(line => Buffer.byteLength(line + '\n') <= 768));
    assert.ok(Buffer.byteLength(stderr) <= 64 * 768 + 256);
    assert.doesNotMatch(stderr, /SECRET|fragment|private|[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
});

test('lifecycle has an independent fixed numeric bounded stderr format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'q27-lifecycle.'));
    writeFileSync(join(dir, 'sink.cpp'), `#include "diagnostics.h"
int main() {
 Diagnostics::Lifecycle sink;
 for (int i = 0; i < 1000; ++i)
  sink.record(Diagnostics::Event::RendererPid, 1, 2147483647, -2147483647, 0);
}`);
    const compile = spawnSync('c++', ['-std=c++17', '-I', root, join(dir, 'sink.cpp'), '-o', join(dir, 'sink')], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(join(dir, 'sink'), [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
    const stderr = nativeOutput(run.stderr);
    const lines = stderr.trimEnd().split('\n');
    assert.equal(lines.length, 49);
    assert.equal(lines.at(-1), 'CIELINUX_LIFECYCLE_CAP');
    lines.slice(0, -1).forEach((line, i) => assert.equal(line,
        `CIELINUX_LIFECYCLE_V1 seq=${i + 1} event=renderer_pid gen=1 a=2147483647 b=-2147483647 c=0`));
    assert.ok(Buffer.byteLength(stderr) <= 48 * 192 + 32);
});

test('production QML forwards actual PID notifier and immutable termination details', () => {
    const qml = read('view.qml');
    assert.match(qml, /onRenderProcessPidChanged:\s*\{\s*sceneRoot.scenePolicy.rendererPidFor\(sceneRoot.sceneAttachment.generation,\s*renderProcessPid\)/);
    assert.match(qml, /onRenderProcessTerminated: function\(status, code\)\s*\{\s*sceneRoot.scenePolicy.rendererTerminatedFor\(sceneRoot.sceneAttachment.generation,\s*status, code\)/);
});

test('Qt signal is explicitly forwarded; startup precedes mapping after prechecks', () => {
    const cpp = read('main.cpp');
    const qml = read('view.qml');
    const policy = read('policy.h');
    // A4: the two alert markers are offered to the bridge first; everything else reaches the policy.
    assert.match(qml, /onJavaScriptConsoleMessage: function\(level, message, lineNumber, sourceID\)\s*\{\s*(?:\/\/[^\n]*\n\s*)?if \(sceneRoot\.sceneAlerts\.pageMessage\(sceneRoot\.sceneAttachment\.generation, level, message, sourceID\)\)\s*return\s*sceneRoot\.scenePolicy.consoleMessageFor\(sceneRoot\.sceneAttachment\.generation,\s*level, message, lineNumber, sourceID\)/);
    assert.match(policy, /Q_INVOKABLE void consoleMessage\(int level, const QString &message, int lineNumber,\s*const QString &sourceID\)/);
    assert.match(policy, /diagnostics.console\(level,/);
    assert.match(policy, /message.left\(Diagnostics::Sink::messageBytes\)/);
    assert.match(policy, /sourceID.left\(Diagnostics::Sink::sourceBytes\)/);
    assert.ok(cpp.indexOf('startupDiagnostics.startup()') > cpp.indexOf('!hasLayerShell()'));
    assert.ok(cpp.indexOf('startupDiagnostics.startup()') > cpp.indexOf('Rejected inherited'));
    assert.ok(cpp.indexOf('startupDiagnostics.startup()') < cpp.indexOf('attachment.view->show()'));
    assert.match(policy, /Q_INVOKABLE void fail\(\)\s*\{\s*finish\(true\);\s*\}/);
    assert.match(policy, /void finish\(bool failure\)\s*\{[\s\S]*?if \(failure\) result = 1;[\s\S]*?if \(failure\) diagnostics.failure\(\);\s*QCoreApplication::exit\(result\);\s*\}/);
    assert.match(policy, /int terminalResult\(\) const \{ return result; \}/);
    assert.match(cpp, /app.exec\(\);\s*policy.noteCloseReason\(Diagnostics::Reason::Ambient\);\s*policy.closeNormally\(\);\s*return policy.terminalResult\(\);/);
    // D2 moved option defaults and deadline scheduling into resident-control.h.
    const header = read('resident-control.h');
    assert.match(header, /int durationMs = 15000;/);
    assert.match(header, /durationMs = std::strcmp\(argv\[i\], "120"\) == 0 \? 120000 : 15000;/);
    assert.match(header, /if \(!options.resident\) lifetime.start\(options.durationMs\);/);
    assert.ok(cpp.indexOf('configureLifetime(lifetime, options)') >= 0);
    assert.ok(cpp.indexOf('configureLifetime(lifetime, options)') < cpp.lastIndexOf('attachment.view->show()'));
    assert.doesNotMatch(qml + cpp + policy, /--diagnostics|--no-sandbox|setDevToolsPage/);
    // A4: the only script the host runs is the fixed alert call, its JSON passed as a string literal.
    assert.equal(qml.match(/runJavaScript/g).length, 1);
    assert.match(qml, /sceneView\.runJavaScript\("window\.cielinuxAlertCommand\(" \+ JSON\.stringify\(json\) \+ "\)"\)/);
    assert.doesNotMatch(cpp + policy, /runJavaScript/);
    const main = read('processing/js/main.js');
    for (const [method, token] of [['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
        assert.equal(main.split(`CIELINUX_DIAGNOSTICS_JS_${token}`).length - 1, 1);
        assert.match(main, new RegExp(`console\\.${method}\\("CIELINUX_DIAGNOSTICS_JS_${token} synthetic transport probe"\\)`));
    }
    assert.ok(main.indexOf('CIELINUX_DIAGNOSTICS_JS_ERROR') < main.indexOf('function render('));
});
