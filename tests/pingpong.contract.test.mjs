// Ping-pong scene slots: one window per mode holds two persistent scene slots (view.qml). A live
// switch that keeps the mode navigates one of them instead of building a new window, web profile
// and web view; only a mode switch (scene-mini <-> scene) still rebuilds the window. Creating and
// destroying views on every switch deadlocks Qt WebEngine's compositor (odd/tasks/pingpong-views.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Script, createContext } from 'node:vm';
import { SRC, source } from './paths.mjs';

const cpp = readFileSync(source('main.cpp'), 'utf8');
const qml = readFileSync(source('view.qml'), 'utf8');
const block = (pattern, name) => {
    const match = cpp.match(pattern)?.[0];
    assert.ok(match, name);
    return match;
};
const reconstruction = () => block(/    policy\.bindReconstruction\(\[&\]\(int generation\) \{[\s\S]*?\n    \}\);/, 'bindReconstruction block');
const navigateSlot = () => block(/    auto navigateSlot = \[&\]\(int generation\) \{[\s\S]*?\n    \};/, 'navigateSlot lambda');
const revealCurrent = () => block(/    auto revealCurrent = \[&\] \{[\s\S]*?\n    \};/, 'revealCurrent lambda');
const parkCovered = () => block(/    auto parkCovered = \[&\] \{[\s\S]*?\n    \};/, 'parkCovered lambda');
const sceneSlots = () => block(/    struct \{\n[\s\S]*?\n    \} sceneSlots;/, 'sceneSlots state');

test('S1: a same-mode switch navigates a persistent slot and builds nothing', () => {
    const queue = reconstruction();
    // The same-mode branch comes first and returns before any hand-over or window build.
    assert.match(queue, /if \(attachment\.view && windowMode == sceneHost\.mode\(\)\) \{\s*try \{\s*navigateSlot\(generation\);\s*\} catch \(\.\.\.\) \{\s*policy\.constructionFailed\(generation\);\s*\}\s*return;\s*\}/);
    assert.ok(queue.indexOf('navigateSlot(generation)') < queue.indexOf('handOver()'));
    assert.ok(queue.indexOf('navigateSlot(generation)') < queue.indexOf('prepareAttachment(generation)'));
    const navigate = navigateSlot();
    assert.doesNotMatch(navigate, /make_unique|QQuickView|QQuickWebEngineProfile|prepareAttachment|reset\(\)|handOver|setSource/);
    assert.match(navigate, /QMetaObject::invokeMethod\(attachment\.view->rootObject\(\), "navigate"/);
    // S3: alerts follow the new generation; the mini glide/dodge stay attached to the same surface.
    assert.match(navigate, /alertBridge\.attach\(generation\);/);
    assert.doesNotMatch(navigate, /miniGlider|miniDodger/);
    // The only window, profile and web view constructions live in the window build.
    assert.equal((cpp.match(/make_unique<QQuickView>/g) || []).length, 1);
    assert.equal((cpp.match(/make_unique<QQuickWebEngineProfile>/g) || []).length, 1);
    assert.equal((qml.match(/^\s*WebEngineView \{/gm) || []).length, 1);
    // The window build records which mode it was built for.
    const prepare = cpp.slice(cpp.indexOf('auto prepareAttachment'), cpp.indexOf('policy.bindReconstruction'));
    assert.match(prepare, /windowMode = sceneHost\.mode\(\);/);
});

test('S4: a mode switch still rebuilds the window through prepareAttachment', () => {
    const queue = reconstruction();
    const modeSwitch = queue.slice(queue.indexOf('// A mode switch builds a new window'));
    assert.ok(queue.indexOf('navigateSlot(generation)') < queue.indexOf('// A mode switch builds a new window'));
    assert.match(modeSwitch, /replacementResult = prepareAttachment\(generation\);/);
    assert.match(modeSwitch, /if \(retireTimer\.isActive\(\) && retiring\.view\) retireTimer\.stop\(\);\s*else if \(attachment\.view && windowShowsPage\(\)\) handOver\(\);/);
    assert.match(modeSwitch, /if \(retiring\.view\) revealDeadline\.start\(revealDeadlineMs\);/);
});

test('S2: view.qml holds two slots of one scene component; a parked slot stops rendering', () => {
    assert.match(qml, /^    component SceneSlot: Item \{\n        id: sceneRoot$/m);
    assert.equal((qml.match(/^    SceneSlot \{/gm) || []).length, 2);
    assert.match(qml, /SceneSlot \{\s*id: firstSlot[\s\S]*?sceneAttachment: sceneWindow\.sceneAttachment[\s\S]*?live: true/);
    assert.match(qml, /SceneSlot \{\s*id: secondSlot[\s\S]*?sceneAttachment: sceneWindow\.sceneIdleAttachment[\s\S]*?live: false/);
    assert.match(qml, /required property SceneAttachment sceneIdleAttachment/);
    // The slot's web view renders only while the slot is live; its disc follows it.
    const view = qml.slice(qml.search(/^\s*WebEngineView \{/m));
    assert.match(view, /^\s*visible: sceneRoot\.live$/m);
    assert.match(qml, /visible: sceneRoot\.sceneMode === "scene-mini" && sceneRoot\.sceneDisc\.radius > 0 && sceneRoot\.live/);
    // Fade in on reveal, with a Behavior the host can bypass when it reuses a slot.
    assert.match(qml, /opacity: sceneRoot\.sceneAttachment\.revealed \? 1 : 0/);
    assert.match(qml, /Behavior on opacity \{\s*id: fade\s*NumberAnimation \{ duration: 300;/);
    assert.match(qml, /function navigate\(index, attachment, url, name\) \{/);
    assert.match(qml, /function park\(index\) \{/);
    // Every callback keeps its own slot's generation.
    for (const call of ['loadSucceededFor', 'consoleMessageFor', 'incident', 'rendererTerminatedFor'])
        assert.match(qml, new RegExp(`sceneRoot\\.scenePolicy\\.${call}\\(sceneRoot\\.sceneAttachment\\.generation`), call);
    assert.match(qml, /if \(generation !== sceneRoot\.sceneAttachment\.generation \|\| typeof json !== "string"\)/);
    // The host gives the idle slot generation 0, which the policy never admits.
    assert.match(cpp, /new AttachmentToken\(0, false, &view\)/);
    assert.match(cpp, /\{QStringLiteral\("sceneIdleAttachment"\), QVariant::fromValue\(idle\)\}/);
});

// Runs the actual QML slot functions in a VM: navigate() stacks the incoming slot, load()
// bypasses the fade while it hands over the new generation, and a same URL reloads.
function qmlFunction(name, params) {
    const match = qml.match(new RegExp(`^( *)function ${name}\\(${params}\\) \\{\\n([\\s\\S]*?)^\\1\\}`, 'm'));
    assert.ok(match, `view.qml function ${name}`);
    return new Script(`(function(${params}) {\n${match[2]}\n})`, { filename: `view.qml:${name}` });
}

test('S2: the actual QML slot functions reuse a slot without fading out stale content', () => {
    const events = [];
    const makeSlot = label => {
        const slot = { label, z: 0, live: false, sceneUrl: 'qrc:/a', sceneName: 'a', reloads: 0 };
        let attachment = { generation: 1 };
        const fade = { enabled: true };
        Object.defineProperty(slot, 'sceneAttachment', {
            get: () => attachment,
            set: value => { events.push([label, 'attach', value.generation, fade.enabled]); attachment = value; },
        });
        const context = createContext({ sceneRoot: slot, fade, sceneView: { reload: () => { ++slot.reloads; } }, String });
        slot.load = qmlFunction('load', 'attachment, url, name').runInContext(context);
        slot.fade = fade;
        return slot;
    };
    const firstSlot = makeSlot('first'), secondSlot = makeSlot('second');
    firstSlot.live = true;
    const context = createContext({ firstSlot, secondSlot });
    const navigate = qmlFunction('navigate', 'index, attachment, url, name').runInContext(context);
    const park = qmlFunction('park', 'index').runInContext(context);
    assert.equal(navigate(1, { generation: 2 }, 'qrc:/b', 'b'), true);
    assert.deepEqual(events, [['second', 'attach', 2, false]]);
    assert.ok(secondSlot.fade.enabled && secondSlot.live && secondSlot.z > firstSlot.z);
    assert.equal(secondSlot.sceneUrl, 'qrc:/b');
    assert.equal(secondSlot.sceneName, 'b');
    assert.equal(firstSlot.live, true); // The page on screen stays until the host parks it.
    assert.equal(park(0), true);
    assert.equal(firstSlot.live, false);
    // Reusing the parked slot for the URL it last showed reloads it (a new document, a new load).
    assert.equal(navigate(0, { generation: 3 }, 'qrc:/a', 'a'), true);
    assert.equal(firstSlot.reloads, 1);
    assert.ok(firstSlot.live && firstSlot.z > secondSlot.z);
});

// Compiles the actual native slot lambdas against the real Policy and AttachmentToken, with a
// fake window whose root object records the QML calls.
test('S1/S2/S3: actual native slot switching keeps the crossfade and rapid-switch rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cielinux-pingpong-contract.'));
    writeFileSync(join(dir, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(PingPongContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Qml)
add_executable(pingpong harness.cpp fake-root.h "${SRC}/policy.h")
target_include_directories(pingpong PRIVATE "${SRC}" "${dir}")
target_link_libraries(pingpong PRIVATE Qt6::Core Qt6::Qml)
`);
    writeFileSync(join(dir, 'fake-root.h'), `#pragma once
#include "policy.h"
#include <QObject>
#include <QStringList>
#include <QVariant>
class FakeRoot : public QObject {
    Q_OBJECT
public:
    QStringList calls;
    Q_INVOKABLE QVariant navigate(const QVariant &index, const QVariant &attachment, const QVariant &url,
                                  const QVariant &name) {
        auto *token = attachment.value<AttachmentToken *>();
        calls << QStringLiteral("navigate %1 gen=%2 revealed=%3 %4 %5").arg(index.toInt())
                     .arg(token ? token->generation() : -1).arg(token && token->revealed())
                     .arg(url.toUrl().toString(), name.toString());
        return true;
    }
    Q_INVOKABLE QVariant park(const QVariant &index) {
        calls << QStringLiteral("park %1").arg(index.toInt());
        return true;
    }
};
`);
    writeFileSync(join(dir, 'harness.cpp'), `
#include "fake-root.h"
#include <QCoreApplication>
#include <QPointer>
#include <QTimer>
#include <cstdio>
#include <cstdlib>
#include <memory>
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr, "CHECK %d: %s\\n", __LINE__, #x); std::abort(); } } while (false)
struct FakeView : QObject { FakeRoot root; QObject *rootObject() { return &root; } };
struct { std::unique_ptr<FakeView> view = std::make_unique<FakeView>(); int generation = 1; } attachment;
struct { std::unique_ptr<FakeView> view; } retiring;
struct { int attached = 0; void attach(int generation) { attached = generation; } } alertBridge;
struct FakeHost { QString name = "processing"; QUrl address; QString scene() const { return name; } QUrl url() const { return address; } };
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    Policy policy(QUrl("qrc:/processing/index.html?variant=mini&fps=30"));
    policy.lifecycleDiagnostics().enable();
    CHECK(policy.bindReconstruction([](int) {}));
    FakeHost sceneHost;
    constexpr int crossfadeMs = 300;
    constexpr int revealDeadlineMs = 2000;
    QTimer revealDeadline, retireTimer;
    revealDeadline.setSingleShot(true);
    retireTimer.setSingleShot(true);
${sceneSlots()}
    sceneSlots.token[0] = new AttachmentToken(1, true, attachment.view.get());
    sceneSlots.token[1] = new AttachmentToken(0, false, attachment.view.get());
    sceneSlots.live[0] = true;
${parkCovered()}
${revealCurrent()}
${navigateSlot()}
    auto &calls = attachment.view->root.calls;
    auto retarget = [&](const char *url) {
        sceneHost.address = QUrl(url);
        CHECK(policy.retarget(sceneHost.address));
        navigateSlot(policy.generation());
    };
    // Steady state -> switch: the parked slot gets the new generation hidden; the page on screen stays.
    retarget("qrc:/idle/index.html?variant=mini&fps=30");
    CHECK(calls == QStringList{"navigate 1 gen=2 revealed=0 qrc:/idle/index.html?variant=mini&fps=30 processing"});
    CHECK(sceneSlots.current == 1 && sceneSlots.live[0] && sceneSlots.live[1]);
    CHECK(revealDeadline.isActive() && !retireTimer.isActive() && alertBridge.attached == 2);
    CHECK(attachment.generation == 2);
    // A switch before the incoming slot revealed re-navigates that same slot; the old token goes.
    QPointer<AttachmentToken> replaced = sceneSlots.token[1];
    retarget("qrc:/raphael/index.html?variant=mini&fps=30");
    CHECK(calls.size() == 2 && calls[1].startsWith("navigate 1 gen=3 revealed=0"));
    CHECK(sceneSlots.current == 1 && sceneSlots.live[0]);
    QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
    CHECK(!replaced);
    // A stale reveal (between a retarget and its rebuild) never reveals the replaced generation.
    CHECK(policy.retarget(QUrl("qrc:/explorer/index.html?variant=mini&fps=30")));
    revealCurrent();
    CHECK(!sceneSlots.token[1]->revealed() && !retireTimer.isActive());
    navigateSlot(policy.generation());
    CHECK(calls.size() == 3 && calls[2].startsWith("navigate 1 gen=4 revealed=0"));
    // Ready (or the deadline): reveal, then park the covered slot once the fade has finished.
    revealCurrent();
    CHECK(sceneSlots.token[1]->revealed() && retireTimer.isActive() && !revealDeadline.isActive());
    CHECK(sceneSlots.live[0]);
    retireTimer.stop(); // The retire timeout: its connection runs parkCovered().
    parkCovered();
    CHECK(calls.size() == 4 && calls[3] == "park 0" && !sceneSlots.live[0]);
    parkCovered(); // Idempotent: nothing left to park.
    CHECK(calls.size() == 4);
    // The next switch reuses the parked slot.
    retarget("qrc:/processing/index.html?variant=mini&fps=60");
    CHECK(calls.size() == 5 && calls[4].startsWith("navigate 0 gen=5 revealed=0"));
    CHECK(sceneSlots.current == 0 && sceneSlots.live[0] && sceneSlots.live[1]);
    revealCurrent();
    CHECK(retireTimer.isActive());
    // Mid-fade: the fully drawn predecessor stays and the fading slot is dropped (reused).
    retarget("qrc:/idle/index.html?variant=mini&fps=60");
    CHECK(!retireTimer.isActive() && calls.size() == 6 && calls[5].startsWith("navigate 0 gen=6 revealed=0"));
    CHECK(sceneSlots.current == 0 && sceneSlots.live[1]);
    // Stale QML callbacks of the predecessor slot are dropped; the incoming slot's own count.
    CHECK(!policy.admits(sceneSlots.token[1]->generation()) && policy.admits(sceneSlots.token[0]->generation()));
    // A predecessor window (after a mode switch) also keeps the retire timer for its fade.
    revealCurrent();
    retireTimer.stop();
    parkCovered();
    retiring.view = std::make_unique<FakeView>();
    retarget("qrc:/raphael/index.html?variant=mini&fps=60");
    CHECK(sceneSlots.current == 1);
    revealCurrent();
    CHECK(retireTimer.isActive());
    std::puts("PINGPONG_CONTRACT_PASS");
    return 0;
}
`);
    for (const args of [['-S', dir, '-B', join(dir, 'build')], ['--build', join(dir, 'build'), '-j2']]) {
        const run = spawnSync('cmake', args, { encoding: 'utf8', timeout: 120000 });
        assert.ifError(run.error);
        assert.equal(run.status, 0, run.stdout + run.stderr);
    }
    const run = spawnSync(join(dir, 'build', 'pingpong'), [], { encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /PINGPONG_CONTRACT_PASS/);
    // Each navigated generation is prepared and mapped; a same-mode switch retires no view or profile.
    const records = run.stderr.split('\n').filter(line => line.startsWith('CIELINUX_LIFECYCLE_V1'));
    for (const generation of [2, 3, 4, 5, 6, 7]) {
        assert.ok(records.some(line => / event=prepared gen=(\d+) /.exec(line)?.[1] === String(generation)), `prepared ${generation}`);
        assert.ok(records.some(line => / event=mapped gen=(\d+) /.exec(line)?.[1] === String(generation)), `mapped ${generation}`);
    }
    assert.ok(!records.some(line => /event=(view|profile)_retired/.test(line)));
}, { timeout: 130000 });
