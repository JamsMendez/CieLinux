import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Script, createContext } from 'node:vm';
import { SRC, source } from './paths.mjs';
const cpp = readFileSync(source('main.cpp'), 'utf8');

// Compile the actual Policy, without a GUI or a copied state machine.
test('generation admission, shared recovery allowance and reentrant terminal cancellation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cielinux-recovery-contract.'));
    const root = SRC;
    writeFileSync(join(dir, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(RecoveryContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Qml)
add_executable(recovery harness.cpp "${root}/policy.h")
target_include_directories(recovery PRIVATE "${root}")
target_link_libraries(recovery PRIVATE Qt6::Core Qt6::Qml)
`);
    const nativeQueue = cpp.match(/    policy\.bindReconstruction\(\[&\]\(int generation\) \{[\s\S]*?\n    \}\);/)?.[0];
    // Before implementation this is absent; missing Policy APIs still exercise
    // the tests-first compile failure. Afterwards compile the exact native queue.
    writeFileSync(join(dir, 'harness.cpp'), `
#include "policy.h"
#include <QTimer>
#include <cassert>
#include <memory>
struct FakeView {
 int shows = 0;
 std::function<void()> onHide;
 void hide() { if (onHide) onHide(); }
 void show() { ++shows; }
};
void queuedScenario(int scenario) {
 Policy policy(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
 struct { std::unique_ptr<FakeView> view = std::make_unique<FakeView>(); int stage = 0; } attachment;
 int preparations = 0;
 auto prepareAttachment = [&](int generation) {
  ++preparations; assert(policy.admits(generation));
  if (scenario == 3) { policy.closeNormally(); return 0; }
  if (scenario == 4) throw 1; // Native allocation/construction exception.
  if (scenario == 6) attachment.view = std::make_unique<FakeView>();
  return scenario == 2 ? 1 : 0;
 };
 if (scenario == 5) attachment.view->onHide = [&] { policy.closeNormally(); };
 if (scenario == 6) attachment.view.reset(); // Initial construction can report before a view is available.
 ${nativeQueue || ''}
 policy.incident(1, 0);
 if (scenario == 1) policy.closeNormally();
 QCoreApplication::processEvents(); // Deliver the actual queued native callback.
 if (scenario == 0) assert(preparations == 1 && attachment.view->shows == 1 && !policy.closed());
 if (scenario == 1) assert(preparations == 0 && attachment.view->shows == 0 && policy.closed());
 if (scenario == 2) assert(preparations == 1 && attachment.view->shows == 0 && policy.terminalResult() == 1);
 if (scenario == 3) assert(preparations == 1 && attachment.view->shows == 0 && policy.closed());
 if (scenario == 4) assert(preparations == 1 && attachment.view->shows == 0 && policy.terminalResult() == 1);
 if (scenario == 5) assert(preparations == 0 && attachment.view->shows == 0 && policy.closed());
 if (scenario == 6) assert(preparations == 1 && attachment.view->shows == 1 && !policy.closed());
 policy.closeNormally();
}
void load(Policy &p, int g) { p.loadSucceededFor(g, QUrl("qrc:/processing/index.html?variant=mini&fps=30")); }
void draw(Policy &p, int g) { p.consoleMessageFor(g, 0, "CIELINUX_SCENE_DRAW_READY_V1 processing", 1, "qrc:/processing/js/main.js"); }
int main(int argc, char **argv) {
 QCoreApplication app(argc, argv);
 if (argc == 2 && QString(argv[1]) == "observe") {
  Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); p.lifecycleDiagnostics().enable();
  p.bindReconstruction([](int) {});
  QTimer::singleShot(0, &app, [&] {
   p.loadSucceededFor(1, QUrl("qrc:/other.html"));
   p.consoleMessageFor(1, 1, "CIELINUX_SCENE_DRAW_READY_V1 processing", 1, "qrc:/processing/js/main.js");
   assert(!p.ready());
   load(p, 1); load(p, 1); draw(p, 1); draw(p, 1);
   p.rendererPidFor(1, 0); p.rendererPidFor(1, 0); assert(p.ready() && p.generation() == 1);
   p.rendererPidFor(1, 101); p.rendererPidFor(1, 101); p.rendererPidFor(1, 102);
   p.rendererTerminatedFor(1, 2, 9); assert(p.generation() == 2 && !p.ready());
   load(p, 1); draw(p, 1); p.incident(1, 0); p.closeGeneration(1);
   p.rendererTerminatedFor(1, 3, -7); // Observe stale termination, never admit it.
   for (int i = 0; i < 70; ++i) p.consoleMessageFor(2, 0, "noise", 1, "qrc:/processing/js/main.js");
   draw(p, 2); draw(p, 2); load(p, 2); load(p, 2); assert(p.ready());
   p.rendererPidFor(2, 0); p.rendererPidFor(2, 0); assert(p.ready() && !p.closed());
   p.rendererPidFor(2, 102); p.rendererPidFor(2, 102); // Same OS PID is permitted.
   p.noteCloseReason(Diagnostics::Reason::Deadline); p.closeNormally(); p.closeNormally();
   p.noteCloseReason(Diagnostics::Reason::Ambient); p.fail(); p.fail();
   load(p, 2); draw(p, 2); assert(!p.ready());
  });
  app.exec(); return p.terminalResult();
 }
 if (argc == 2 && QString(argv[1]) == "capped") {
  Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); p.lifecycleDiagnostics().enable();
  p.bindReconstruction([](int) {});
  QTimer::singleShot(0, &app, [&] {
   for (int i = 0; i < 100; ++i) p.rendererPidFor(1, i);
   p.incident(1, 0); load(p, 2); draw(p, 2); assert(p.ready());
   p.closeNormally(); assert(p.closed() && p.terminalResult() == 0);
  });
  app.exec(); return p.terminalResult();
 }
 if (argc == 2 && QString(argv[1]).startsWith("reason-")) {
  Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); p.lifecycleDiagnostics().enable();
  const QString mode(argv[1]);
  p.bindHost([&] { if (mode == "reason-nested") p.fail(); }, [] {});
  QTimer::singleShot(0, &app, [&] {
   const auto reason = mode == "reason-output" ? Diagnostics::Reason::Output :
    mode == "reason-dismissal" ? Diagnostics::Reason::Dismissal :
    mode == "reason-ambient" ? Diagnostics::Reason::Ambient :
    mode == "reason-guard" ? Diagnostics::Reason::Guard : Diagnostics::Reason::Deadline;
   p.noteCloseReason(reason, 2); p.closeNormally(); p.closeNormally();
   p.noteCloseReason(Diagnostics::Reason::Ambient); // Cannot relabel an established close.
  });
  app.exec(); return p.terminalResult();
 }
 if (argc == 2) {
  Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
  p.bindReconstruction([](int) {});
  QTimer::singleShot(0, &app, [&] {
   p.incident(1, 0); load(p, 2); draw(p, 2); assert(p.ready());
   const QString mode(argv[1]);
   if (mode == "second") p.incident(2, 1);
   if (mode == "construction") p.constructionFailed(2);
   p.closeNormally();
  });
  return app.exec();
 }
 QTimer::singleShot(0, &app, [&] {
  for (int status = 0; status < 4; ++status) {
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); p.bindReconstruction([](int) {});
   p.rendererTerminatedFor(1, status, -19); assert(p.admits(2) && !p.closed());
   p.rendererTerminatedFor(1, status, -19); assert(p.admits(2) && !p.closed());
   p.rendererTerminatedFor(2, status, -19); assert(p.closed() && p.terminalResult() == 1);
  }
  for (int first = 0; first < 2; ++first) for (int second = 0; second < 2; ++second) {
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); int queued = 0, hides = 0;
   p.bindHost([&] { ++hides; }, [] {});
   p.bindReconstruction([&](int g) { ++queued; assert(g == 2); assert(!p.ready()); });
   load(p, 1); draw(p, 1); assert(p.ready());
   p.incident(1, first); assert(!p.closed() && !p.ready() && queued == 1);
   load(p, 1); draw(p, 1); p.incident(1, second); p.closeGeneration(1);
   assert(!p.closed() && !p.ready() && p.admits(2));
   draw(p, 2); assert(!p.ready()); load(p, 2); assert(p.ready());
   p.incident(2, second); assert(p.closed() && p.terminalResult() == 1 && hides == 1);
   p.closeNormally(); assert(p.terminalResult() == 1 && !p.admits(2));
  }
  {
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); int generation = 0;
   p.bindReconstruction([&](int g) { generation = g; });
   p.incident(1, 1); load(p, 2); assert(!p.ready()); draw(p, 2); assert(p.ready());
   p.closeNormally(); assert(generation == 2 && p.terminalResult() == 0 && !p.admits(2));
  }
  {
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); p.bindReconstruction([](int) {});
   p.incident(1, 0); p.constructionFailed(1); assert(!p.closed());
   p.constructionFailed(2); assert(p.closed() && p.terminalResult() == 1);
  }
  for (int failure = 0; failure < 2; ++failure) {
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); int callbacks = 0;
   p.bindReconstruction([&](int) { ++callbacks; }); load(p, 1); draw(p, 1);
   QObject::connect(&p, &Policy::readyChanged, [&] { if (!p.ready()) { if (failure) p.fail(); else p.closeNormally(); } });
   p.incident(1, 0); assert(p.closed() && callbacks == 0 && !p.admits(2));
   assert(p.terminalResult() == failure);
  }
  {
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); int queued = 0;
   p.bindReconstruction([&](int g) { queued = g; });
   p.incident(1, 0); p.closeGeneration(2);
   assert(queued == 2 && !p.admits(queued));
   p.fail(); assert(p.terminalResult() == 1);
  }
  {
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
   p.incident(0, 0); p.incident(1, 9); assert(!p.closed());
   p.incident(1, 0); assert(p.closed() && p.terminalResult() == 1); // No native reconstruction binding.
   assert(!p.bindReconstruction([](int) {}));
  }
  for (int scenario = 0; scenario < 7; ++scenario) queuedScenario(scenario);
  std::puts("GENERATION_CONTRACT_PASS");
  QCoreApplication::exit(0);
 });
 return app.exec();
}
`);
    for (const [program, args] of [['cmake', ['-S', dir, '-B', join(dir, 'build')]],
        ['cmake', ['--build', join(dir, 'build'), '-j2']],
        [join(dir, 'build/recovery'), []]]) {
        const run = spawnSync(program, args, { encoding: 'utf8', timeout: 120000 });
        assert.ifError(run.error);
        assert.equal(run.status, 0, run.stdout + run.stderr);
        if (program.endsWith('/recovery')) assert.match(run.stdout, /GENERATION_CONTRACT_PASS/);
    }
    const observed = spawnSync(join(dir, 'build/recovery'), ['observe'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(observed.status, 1, observed.stderr);
    const records = observed.stderr.split('\n').filter(line => line.startsWith('CIELINUX_LIFECYCLE_V1'));
    const expected = [
        ['load', 1, 0, 0, 0], ['draw', 1, 0, 0, 0], ['ready', 1, 0, 0, 0],
        ['renderer_pid', 1, 0, 0, 0], ['renderer_pid', 1, 101, 0, 0], ['renderer_pid', 1, 102, 0, 0],
        ['terminated', 1, 2, 9, 0], ['incident', 1, 2, 1, 1], ['terminated', 1, 3, -7, 0],
        ['draw', 2, 0, 0, 0], ['load', 2, 0, 0, 0], ['ready', 2, 0, 0, 0],
        ['renderer_pid', 2, 0, 0, 0], ['renderer_pid', 2, 102, 0, 0],
        ['terminal', 2, 0, 1, 0], ['terminal', 2, 1, 5, 0],
    ].map(([event, gen, a, b, c], i) => `CIELINUX_LIFECYCLE_V1 seq=${i + 1} event=${event} gen=${gen} a=${a} b=${b} c=${c}`);
    assert.deepEqual(records, expected);
    assert.equal(observed.stderr.split('\n').filter(line => line === 'CIELINUX_DIAGNOSTICS_CONSOLE_CAP').length, 1);
    assert.ok(observed.stderr.indexOf('CIELINUX_DIAGNOSTICS_CONSOLE_CAP') < observed.stderr.indexOf('event=draw gen=2'));
    const capped = spawnSync(join(dir, 'build/recovery'), ['capped'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(capped.status, 0, capped.stderr);
    const cappedLines = capped.stderr.split('\n');
    const cappedRecords = cappedLines.filter(line => line.startsWith('CIELINUX_LIFECYCLE_V1'));
    assert.equal(cappedRecords.length, 49);
    assert.equal(cappedLines.filter(line => line === 'CIELINUX_LIFECYCLE_CAP').length, 1);
    // The terminal record bypasses the cap so a long resident session still reports its close.
    assert.equal(cappedRecords[48], 'CIELINUX_LIFECYCLE_V1 seq=49 event=terminal gen=2 a=0 b=0 c=0');
    assert.ok(cappedLines.indexOf('CIELINUX_LIFECYCLE_CAP') < cappedLines.indexOf(cappedRecords[48]));
    for (const [mode, result, reason] of [['output', 0, 2], ['dismissal', 0, 3],
        ['ambient', 0, 4], ['guard', 2, 6], ['nested', 1, 5]]) {
        const run = spawnSync(join(dir, 'build/recovery'), [`reason-${mode}`], { encoding: 'utf8', timeout: 5000 });
        assert.equal(run.status, mode === 'guard' ? 0 : result, run.stderr); // Guard return2 is native-only.
        assert.deepEqual(run.stderr.split('\n').filter(line => line.startsWith('CIELINUX_LIFECYCLE_V1')),
            [`CIELINUX_LIFECYCLE_V1 seq=1 event=terminal gen=1 a=${result} b=${reason} c=0`]);
    }
    for (const [mode, status] of [['recovered', 0], ['second', 1], ['construction', 1]]) {
        const run = spawnSync(join(dir, 'build/recovery'), [mode], { encoding: 'utf8', timeout: 5000 });
        assert.ifError(run.error);
        assert.equal(run.status, status, run.stdout + run.stderr);
        assert.equal(run.stderr.split('\n').filter(line => line.startsWith('CIELINUX_DIAGNOSTICS_HOST_FAILURE')).length, status);
    }
});

// Compile the actual Policy with an injected monotonic clock; no GUI, no real time.
test('resident rolling recovery budget, aged-out renewal and generalized renderer PID records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cielinux-budget-contract.'));
    const root = SRC;
    writeFileSync(join(dir, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(BudgetContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Qml)
add_executable(budget harness.cpp "${root}/policy.h")
target_include_directories(budget PRIVATE "${root}")
target_link_libraries(budget PRIVATE Qt6::Core Qt6::Qml)
`);
    writeFileSync(join(dir, 'harness.cpp'), `
#include "policy.h"
#include <QTimer>
#include <cassert>
#include <cstdio>
qint64 now = 0;
int clockCalls = 0;
const std::function<qint64()> fakeClock = [] { ++clockCalls; return now; };
constexpr qint64 hour = 3600000;
void load(Policy &p, int g) { p.loadSucceededFor(g, QUrl("qrc:/processing/index.html?variant=mini&fps=30")); }
void draw(Policy &p, int g) { p.consoleMessageFor(g, 0, "CIELINUX_SCENE_DRAW_READY_V1 processing", 1, "qrc:/processing/js/main.js"); }
void recover(Policy &p, int from, qint64 at) {
 now = at; p.incident(from, from % 2);
 assert(!p.closed() && p.generation() == from + 1 && !p.admits(from) && !p.ready());
 load(p, from + 1); draw(p, from + 1); assert(p.ready());
}
int main(int argc, char **argv) {
 QCoreApplication app(argc, argv);
 if (argc == 2 && QString(argv[1]) == "exhausted") {
  Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); p.lifecycleDiagnostics().enable();
  p.bindReconstruction([](int) {});
  QTimer::singleShot(0, &app, [&] {
   assert(p.setRecoveryBudget(3, hour, fakeClock));
   load(p, 1); draw(p, 1);
   recover(p, 1, 0); recover(p, 2, 1000); recover(p, 3, hour - 1);
   p.rendererPidFor(4, 404); p.rendererPidFor(4, 404); // Deduplicated beyond generation 2.
   p.rendererPidFor(2, 202); // Superseded by generation 4; never recorded.
   p.rendererTerminatedFor(4, 2, 9); // Fourth incident inside the window.
   assert(p.closed() && p.terminalResult() == 1 && !p.admits(4) && p.generation() == 4);
  });
  app.exec(); return p.terminalResult();
 }
 QTimer::singleShot(0, &app, [&] {
  { // Oldest recoveries age out of the rolling window and renew the budget.
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); int last = 0;
   p.bindReconstruction([&](int g) { last = g; });
   assert(p.setRecoveryBudget(3, hour, fakeClock));
   load(p, 1); draw(p, 1);
   recover(p, 1, 0); recover(p, 2, 1000); recover(p, 3, 2000);
   recover(p, 4, hour); recover(p, 5, hour + 1000); assert(last == 6);
   now = hour + 1999; p.incident(6, 1);
   assert(p.closed() && p.terminalResult() == 1 && last == 6 && !p.admits(7));
  }
  { // A clock that moves backwards never ages an entry out.
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); p.bindReconstruction([](int) {});
   assert(p.setRecoveryBudget(3, hour, fakeClock));
   recover(p, 1, 5000); recover(p, 2, 5000); recover(p, 3, 5000);
   now = 0; p.incident(4, 0); assert(p.closed() && p.terminalResult() == 1);
  }
  { // Default stays one allowance per lifetime and never consults a clock.
   clockCalls = 0;
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); p.bindReconstruction([](int) {});
   recover(p, 1, 0); now = 10 * hour; p.incident(2, 1);
   assert(p.closed() && p.terminalResult() == 1 && clockCalls == 0);
  }
  { // Stale or invalid incidents are rejected before the clock is consulted.
   clockCalls = 0;
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); p.bindReconstruction([](int) {});
   assert(p.setRecoveryBudget(3, hour, fakeClock));
   p.incident(0, 0); p.incident(2, 0); p.incident(1, 9);
   assert(clockCalls == 0 && p.generation() == 1 && !p.closed());
   p.closeNormally();
  }
  { // Invalid or late configuration is refused and keeps the default.
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); p.bindReconstruction([](int) {});
   assert(!p.setRecoveryBudget(0, hour, fakeClock));
   assert(!p.setRecoveryBudget(Policy::maxRecoveryBudget + 1, hour, fakeClock));
   assert(!p.setRecoveryBudget(3, 0, fakeClock));
   assert(!p.setRecoveryBudget(3, hour, {}));
   assert(p.setRecoveryBudget(3, hour, fakeClock));
   assert(!p.setRecoveryBudget(2, hour, fakeClock)); // Configured once.
   Policy late(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); late.bindReconstruction([](int) {});
   late.incident(1, 0); assert(!late.setRecoveryBudget(3, hour, fakeClock));
   late.incident(2, 0); assert(late.closed() && late.terminalResult() == 1);
   Policy closed(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); closed.closeNormally();
   assert(!closed.setRecoveryBudget(3, hour, fakeClock));
   p.closeNormally();
  }
  for (int failure = 0; failure < 2; ++failure) { // Notification reentrancy on a later recovery.
   Policy p(QUrl("qrc:/processing/index.html?variant=mini&fps=30")); int callbacks = 0;
   p.bindReconstruction([&](int) { ++callbacks; });
   assert(p.setRecoveryBudget(3, hour, fakeClock));
   load(p, 1); draw(p, 1); recover(p, 1, 0); assert(callbacks == 1);
   QObject::connect(&p, &Policy::readyChanged, [&] { if (!p.ready()) { if (failure) p.fail(); else p.closeNormally(); } });
   now = 1; p.incident(2, 0);
   assert(p.closed() && callbacks == 1 && !p.admits(3) && p.terminalResult() == failure);
  }
  std::puts("BUDGET_CONTRACT_PASS");
  QCoreApplication::exit(0);
 });
 return app.exec();
}
`);
    for (const [program, args] of [['cmake', ['-S', dir, '-B', join(dir, 'build')]],
        ['cmake', ['--build', join(dir, 'build'), '-j2']],
        [join(dir, 'build/budget'), []]]) {
        const run = spawnSync(program, args, { encoding: 'utf8', timeout: 120000 });
        assert.ifError(run.error);
        assert.equal(run.status, 0, run.stdout + run.stderr);
        if (program.endsWith('/budget')) assert.match(run.stdout, /BUDGET_CONTRACT_PASS/);
    }
    const exhausted = spawnSync(join(dir, 'build/budget'), ['exhausted'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(exhausted.status, 1, exhausted.stderr);
    const expected = [
        ['load', 1, 0, 0, 0], ['draw', 1, 0, 0, 0], ['ready', 1, 0, 0, 0],
        ['incident', 1, 2, 1, 1], ['load', 2, 0, 0, 0], ['draw', 2, 0, 0, 0], ['ready', 2, 0, 0, 0],
        ['incident', 2, 3, 2, 0], ['load', 3, 0, 0, 0], ['draw', 3, 0, 0, 0], ['ready', 3, 0, 0, 0],
        ['incident', 3, 4, 3, 1], ['load', 4, 0, 0, 0], ['draw', 4, 0, 0, 0], ['ready', 4, 0, 0, 0],
        ['renderer_pid', 4, 404, 0, 0], ['terminated', 4, 2, 9, 0], ['incident', 4, 4, 3, 1],
        ['terminal', 4, 1, 5, 0],
    ].map(([event, gen, a, b, c], i) => `CIELINUX_LIFECYCLE_V1 seq=${i + 1} event=${event} gen=${gen} a=${a} b=${b} c=${c}`);
    assert.deepEqual(exhausted.stderr.split('\n').filter(line => line.startsWith('CIELINUX_LIFECYCLE_V1')), expected);
    assert.equal(exhausted.stderr.split('\n').filter(line => line.startsWith('CIELINUX_DIAGNOSTICS_HOST_FAILURE')).length, 1);
});

test('production configures the rolling recovery budget only for resident hosts', () => {
    assert.equal((cpp.match(/setRecoveryBudget\(/g) || []).length, 1);
    assert.match(cpp, /QElapsedTimer recoveryClock;\s*recoveryClock\.start\(\);\s*Policy policy\(sceneUrl\);/);
    assert.match(cpp, /if \(options\.resident && !policy\.setRecoveryBudget\(3, 3600000,\s*\[&recoveryClock\] \{ return recoveryClock\.elapsed\(\); \}\)\) \{/);
    const configured = cpp.indexOf('setRecoveryBudget(');
    // Configured before any QML, renderer or control callback can report an incident.
    for (const later of ['control->activate(', 'policy.bindReconstruction(', 'prepareAttachment(initialGeneration)'])
        assert.ok(configured < cpp.indexOf(later), later);
});

test('actual QML snapshots use the getter and immutable attachment without changing load admission', () => {
    const qml = readFileSync(source('view.qml'), 'utf8');
    assert.match(qml, /Component\.onCompleted: \{\s*sceneRoot\.scenePolicy\.rendererPidFor\(sceneRoot\.sceneAttachment\.generation,\s*renderProcessPid\)\s*\}/);
    assert.match(qml, /onLoadingChanged: function\(info\) \{\s*if \(info.status === WebEngineView.LoadSucceededStatus\) \{\s*sceneRoot\.scenePolicy\.loadSucceededFor\(sceneRoot\.sceneAttachment\.generation, info.url\)\s*if \(sceneRoot\.scenePolicy\.allowed\(info.url\)\)\s*sceneRoot\.scenePolicy\.rendererPidFor\(sceneRoot\.sceneAttachment\.generation,\s*renderProcessPid\)\s*\}\s*if \(info.status === WebEngineView.LoadFailedStatus\)\s*sceneRoot\.scenePolicy\.incident\(sceneRoot\.sceneAttachment\.generation, 0\)/);
    assert.match(qml, /onRenderProcessPidChanged: \{\s*sceneRoot\.scenePolicy\.rendererPidFor\(sceneRoot\.sceneAttachment\.generation,\s*renderProcessPid\)\s*\}/);
    assert.equal((qml.match(/\.rendererPidFor\(/g) || []).length, 3);
    assert.doesNotMatch(qml, /Timer\s*\{|onReadyChanged|Qt\.callLater|setInterval/);
    // Source wiring and compiled Policy assertions do not prove WebEngine getter delivery.
});

// Deliberately require the current line-delimited QML handler shape: fail closed
// on ambiguity instead of matching comments or stopping at a nested branch.
function loadingHandlerScript(qml) {
    const handlers = [...qml.matchAll(/^([ \t]*)onLoadingChanged: function\(info\) \{\r?\n([\s\S]*?)^\1\}/gm)];
    assert.equal(handlers.length, 1, 'one complete line-delimited loading handler');
    return new Script(`(function(info) {\n${handlers[0][2]}\n})(info)`, { filename: 'view.qml:onLoadingChanged' });
}

test('synthetic Node VM executes actual QML loading handler routing, not WebEngine delivery', () => {
    const script = loadingHandlerScript(readFileSync(source('view.qml'), 'utf8'));
    const WebEngineView = Object.freeze({ LoadStartedStatus: 0, LoadStoppedStatus: 1,
        LoadSucceededStatus: 2, LoadFailedStatus: 3 });
    const selected = 'qrc:/processing/index.html?variant=mini&fps=30';
    for (const generation of [1, 2]) {
        for (const url of [selected, 'qrc:/wrong.html']) {
            for (const status of Object.values(WebEngineView)) {
                const calls = [];
                const sceneAttachment = Object.freeze({ generation });
                const sceneRoot = {
                    sceneAttachment,
                    scenePolicy: {
                        loadSucceededFor: (...args) => calls.push(['load', ...args]),
                        allowed: value => { calls.push(['allowed', value]); return value === selected; },
                        rendererPidFor: (...args) => calls.push(['pid', ...args]),
                        incident: (...args) => calls.push(['incident', ...args]),
                    },
                };
                const context = createContext({ sceneRoot, WebEngineView,
                    renderProcessPid: 731, info: Object.freeze({ status, url }) });
                script.runInContext(context, { timeout: 1000 });
                const expected = status === WebEngineView.LoadSucceededStatus
                    ? [['load', generation, url], ['allowed', url],
                        ...(url === selected ? [['pid', generation, 731]] : [])]
                    : status === WebEngineView.LoadFailedStatus ? [['incident', generation, 0]] : [];
                assert.deepEqual(calls, expected, `generation=${generation}, status=${status}, url=${url}`);
                assert.equal(sceneAttachment.generation, generation);
                // Failed loads currently ignore URL admission; this pins a fact,
                // not a demonstrated defect. Policy stale rejection is tested separately.
            }
        }
    }
});

test('synthetic QML handler extraction rejects ambiguous or malformed boundaries', () => {
    const qml = readFileSync(source('view.qml'), 'utf8');
    const marker = '        onLoadingChanged: function(info) {';
    assert.throws(() => loadingHandlerScript(qml.replace(marker, '        // onLoadingChanged: function(info) {')),
        /one complete line-delimited loading handler/);
    assert.throws(() => loadingHandlerScript(qml + '\n' + qml), /one complete line-delimited loading handler/);
    assert.throws(() => loadingHandlerScript(`${marker}\n            if (true) {\n            }\n`),
        /one complete line-delimited loading handler/);
    assert.throws(() => loadingHandlerScript(`${marker}\n            if (\n        }\n`), SyntaxError);
    // A comment decoy and nested block must not replace or truncate the real body.
    assert.doesNotThrow(() => loadingHandlerScript('// onLoadingChanged: function(info) {}\n' + qml));
    const nested = `${marker}\n            if (true) {\n                record("nested")\n            }\n            record("tail")\n        }\n`;
    const calls = [];
    loadingHandlerScript(nested).runInContext(createContext({ info: {}, record: value => calls.push(value) }),
        { timeout: 1000 });
    assert.deepEqual(calls, ['nested', 'tail']);
});

test('production attachment owns both objects and retires view before profile', () => {
    assert.match(cpp, /struct Attachment\s*\{/);
    assert.match(cpp, /std::unique_ptr<QQuickWebEngineProfile> profile;/);
    assert.match(cpp, /std::unique_ptr<QQuickView> view;/);
    assert.match(cpp, /view.reset\(\);\s*if \(hadView && diagnostics\)\s*diagnostics->record\(Diagnostics::Event::ViewRetired, retiredGeneration, retiredStage\);\s*profile.reset\(\);\s*if \(hadProfile && diagnostics\)\s*diagnostics->record\(Diagnostics::Event::ProfileRetired, retiredGeneration, retiredStage\);/);
    assert.match(cpp, /QMetaObject::Connection closingConnection;/);
    assert.match(cpp, /QObject::disconnect\(closingConnection\);\s*closingConnection = \{\};\s*const bool hadView = bool\(view\), hadProfile = bool\(profile\);\s*const int retiredGeneration = generation, retiredStage = stage;\s*view.reset\(\);/);
    assert.match(cpp, /attachment\.closingConnection = QObject::connect\(&view, &QQuickWindow::closing, &policy,/);
    assert.doesNotMatch(cpp, /QObject::disconnect\(view\.get\(\),/);
});

test('one actually-used fresh construction path preserves lifetime wiring', () => {
    assert.match(cpp, /auto prepareAttachment = \[&\]\(int generation\) -> int/);
    assert.equal((cpp.match(/make_unique<QQuickWebEngineProfile>/g) || []).length, 1);
    assert.equal((cpp.match(/make_unique<QQuickView>/g) || []).length, 1);
    assert.match(cpp, /if \(!policy\.admits\(generation\)\) return 0;\s*attachment\.reset\(\);\s*if \(!policy\.admits\(generation\)\) return 0;/);
    assert.match(cpp, /preparationResult = prepareAttachment\(initialGeneration\);/);
    assert.match(cpp, /return policy\.terminalResult\(\) == 1 \? 1 : preparationResult;/);
    assert.match(cpp, /screenRemoved, &policy,/);
    assert.match(cpp, /if \(attachment\.view\) attachment\.view->hide\(\)/);
    assert.match(cpp, /configureLifetime\(lifetime, options\);[\s\S]*if \(policy.admits\(initialGeneration\) && attachment.view\) \{\s*attachment.view->show\(\);[\s\S]*app\.exec\(\);\s*policy.noteCloseReason\(Diagnostics::Reason::Ambient\);\s*policy.closeNormally\(\);/);
    assert.match(cpp, /QTimer::singleShot\(0, &policy, \[&, generation\] \{\s*if \(!policy\.admits\(generation\)\) return;[\s\S]*?replacementResult = prepareAttachment\(generation\);[\s\S]*?if \(!policy\.admits\(generation\)\) return;/);
    assert.match(cpp, /catch \(\.\.\.\) \{\s*policy\.constructionFailed\(generation\);\s*return;/);
    assert.match(cpp, /\[&, generation\] \{\s*if \(policy.admits\(generation\)\) policy.noteCloseReason\(Diagnostics::Reason::Dismissal\);\s*policy.closeGeneration\(generation\);\s*\}/);
    assert.match(cpp, /new AttachmentToken\(generation, &view\)/);
    assert.equal((cpp.match(/configureLifetime\(lifetime, options\)/g) || []).length, 1);
    assert.equal((cpp.match(/lifetime\.start\(/g) || []).length, 0);
    const scheduler = readFileSync(source('resident-control.h'), 'utf8');
    assert.equal((scheduler.match(/lifetime\.start\(/g) || []).length, 1);
    assert.match(scheduler, /inline void configureLifetime\(QTimer &lifetime, const HostOptions &options\) \{\s*lifetime.setSingleShot\(true\);\s*if \(!options.resident\) lifetime.start\(options.durationMs\);\s*\}/);
    assert.doesNotMatch(cpp, /reload\(/i);
    assert.match(cpp, /if \(view.status\(\) != QQuickView::Ready\) \{ policy.constructionFailed\(generation\); return 1; \}\s*attachment.stage = 3;\s*policy.lifecycleDiagnostics\(\).record\(Diagnostics::Event::Prepared, generation\);/);
    assert.match(cpp, /attachment.view->show\(\);\s*attachment.stage = 4;\s*policy.lifecycleDiagnostics\(\).record\(Diagnostics::Event::Mapped, generation\);/);
    assert.match(cpp, /attachment.generation = generation;\s*attachment.profile = std::make_unique<QQuickWebEngineProfile>\(\);\s*attachment.stage = 1;/);
    assert.match(cpp, /attachment.view = std::make_unique<QQuickView>\(\);\s*attachment.stage = 2;/);
});

test('extracted actual ownership destructor with fake objects: order, partial construction and disconnect', () => {
    // Compile the production ownership block, not a copied implementation.
    // Fake objects prove C++ ownership ordering only, NOT Qt/browser teardown.
    const block = cpp.match(/    struct Attachment \{[\s\S]*?    \} attachment;/)?.[0];
    assert.ok(block, 'actual inline ownership block');
    const dir = mkdtempSync(join(tmpdir(), 'cielinux-attachment-contract.'));
    const source = join(dir, 'ownership.cpp');
    const observedBlock = block.replace('} attachment;', '} attachment; attachment.diagnostics = &diagnostics; attachment.generation = 1;');
    writeFileSync(source, `#include "diagnostics.h"
#include <memory>
#include <cstdio>
#include <string>
#include <cassert>
#include <functional>
std::string events;
Diagnostics::Lifecycle diagnostics;
std::function<void()> onViewDestruction;
struct QMetaObject { struct Connection { int id = 0; }; };
bool closingConnected = false, observerConnected = true;
struct QObject {
    static void disconnect(QMetaObject::Connection connection) {
        if (!connection.id) return;
        assert(connection.id == 1); // Only the application-owned closing hook.
        assert(closingConnected);
        closingConnected = false;
        events += "disconnect;";
    }
};
struct QQuickView {
    ~QQuickView() {
        assert(!closingConnected);
        assert(observerConnected); // An unrelated destruction observer survives.
        if (onViewDestruction) {
            auto callback = std::move(onViewDestruction);
            callback(); // Reentrant hooks must see a cleared current view pointer.
        }
        events += "view;observer;";
        std::fputs("FAKE_VIEW_COMPLETE\\n", stderr);
    }
};
struct QQuickWebEngineProfile { ~QQuickWebEngineProfile() { events += "profile;"; std::fputs("FAKE_PROFILE_COMPLETE\\n", stderr); } };
void run(bool withView) {
${observedBlock}
attachment.profile = std::make_unique<QQuickWebEngineProfile>(); attachment.stage = 1;
if (withView) {
    attachment.stage = 2;
    attachment.view = std::make_unique<QQuickView>();
    attachment.closingConnection = {1}; closingConnected = true;
    onViewDestruction = [&] {
        assert(!attachment.view && attachment.profile);
        attachment.generation = 99; attachment.stage = 99; // Record the immutable retired values.
    };
}
}
int main() {
    run(true); assert(events == "disconnect;view;observer;profile;");
    events.clear(); run(false); assert(events == "profile;");
    events.clear(); { ${observedBlock} } assert(events.empty());
    { ${observedBlock}
      attachment.profile = std::make_unique<QQuickWebEngineProfile>();
      attachment.view = std::make_unique<QQuickView>();
      attachment.closingConnection = {1}; closingConnected = true; attachment.stage = 3;
      attachment.reset(); attachment.reset();
      assert(events == "disconnect;view;observer;profile;");
      attachment.profile = std::make_unique<QQuickWebEngineProfile>();
      attachment.view = std::make_unique<QQuickView>();
      attachment.closingConnection = {1}; closingConnected = true; attachment.stage = 4;
    }
    assert(events == "disconnect;view;observer;profile;disconnect;view;observer;profile;");
}
`);
    const binary = join(dir, 'ownership');
    const compile = spawnSync('c++', ['-std=c++17', '-I', SRC, source, '-o', binary], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stderr.trimEnd().split('\n');
    let sequence = 0;
    const stages = [2, 2, 1, 3, 3, 4, 4];
    for (let i = 0; i < lines.length; i += 2) {
        const event = lines[i] === 'FAKE_VIEW_COMPLETE' ? 'view_retired' : 'profile_retired';
        assert.match(lines[i], /^FAKE_(VIEW|PROFILE)_COMPLETE$/);
        assert.equal(lines[i + 1], `CIELINUX_LIFECYCLE_V1 seq=${++sequence} event=${event} gen=1 a=${stages[sequence - 1]} b=0 c=0`);
        if (event === 'view_retired') assert.equal(lines[i + 2], 'FAKE_PROFILE_COMPLETE');
    }
    assert.equal(sequence, 7);
});
