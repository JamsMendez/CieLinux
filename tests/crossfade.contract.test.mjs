// Crossfade on a live scene/mode switch: the page being replaced stays on screen until its
// successor has drawn its first frame and faded in, so a switch never uncovers the desktop.
// The token latch itself is compiled and exercised in reconstruction.contract.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { source } from './paths.mjs';

const cpp = readFileSync(source('main.cpp'), 'utf8');
const qml = readFileSync(source('view.qml'), 'utf8');
const reconstruction = cpp.match(/    policy\.bindReconstruction\(\[&\]\(int generation\) \{[\s\S]*?\n    \}\);/)?.[0] ?? '';

test('replacement keeps the replaced view mapped instead of hiding it first', () => {
    assert.ok(reconstruction, 'bindReconstruction block');
    assert.doesNotMatch(reconstruction, /->hide\(\)/);
    // Only a page that was actually revealed is kept; a still-hidden one is simply replaced.
    // Mid-fade (retire pending) the fully drawn predecessor stays and the fading page is dropped.
    assert.match(reconstruction, /if \(retireTimer\.isActive\(\)\) retireTimer\.stop\(\);\s*else if \(attachment\.view && currentToken && currentToken->revealed\(\)\) handOver\(\);\s*if \(!policy\.admits\(generation\)\) return;\s*int replacementResult = 1;/);
    // The deadline starts only when there is a predecessor to fade over.
    assert.match(reconstruction, /record\(Diagnostics::Event::Mapped, generation\);\s*if \(retiring\.view\) revealDeadline\.start\(revealDeadlineMs\);/);
});

test('hand-over moves ownership into one retiring slot and retires the previous one first', () => {
    assert.match(cpp, /    Attachment retiring;\s*retiring\.diagnostics = &policy\.lifecycleDiagnostics\(\);/);
    assert.match(cpp, /auto handOver = \[&\] \{\s*retireTimer\.stop\(\);\s*retiring\.reset\(\);\s*std::swap\(retiring\.profile, attachment\.profile\);\s*std::swap\(retiring\.view, attachment\.view\);\s*std::swap\(retiring\.closingConnection, attachment\.closingConnection\);/);
});

test('the new page is revealed on its first drawn frame or at the deadline, then the old one retires', () => {
    assert.match(cpp, /QObject::connect\(&policy, &Policy::readyChanged, &policy, \[&\] \{\s*if \(policy\.ready\(\)\) revealCurrent\(\);\s*\}\);/);
    assert.match(cpp, /QObject::connect\(&revealDeadline, &QTimer::timeout, &policy, revealCurrent\);/);
    // A deadline firing before the queued rebuild never reveals a replaced generation.
    assert.match(cpp, /if \(!currentToken \|\| currentToken->revealed\(\) \|\| !policy\.admits\(currentToken->generation\(\)\)\) return;/);
    assert.match(cpp, /currentToken->reveal\(\);\s*if \(retiring\.view\) retireTimer\.start\(crossfadeMs \+ 100\);/);
    assert.match(cpp, /QObject::connect\(&retireTimer, &QTimer::timeout, &policy, \[&\] \{ retiring\.reset\(\); \}\);/);
});

test('a terminal close hides both the current and the retiring view', () => {
    assert.match(cpp, /policy\.bindHost\(\[&\] \{\s*if \(attachment\.view\) attachment\.view->hide\(\);\s*if \(retiring\.view\) retiring\.view->hide\(\);\s*\}/);
});

test('view.qml fades in on reveal with the host crossfade duration', () => {
    const ms = Number(cpp.match(/constexpr int crossfadeMs = (\d+);/)?.[1]);
    assert.ok(ms > 0, 'crossfadeMs');
    assert.match(qml, /opacity: sceneRoot\.sceneAttachment\.revealed \? 1 : 0/);
    assert.match(qml, new RegExp(`Behavior on opacity \\{ NumberAnimation \\{ duration: ${ms};`));
});
