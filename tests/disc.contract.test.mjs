import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SRC, source } from './paths.mjs';
const read = name => readFileSync(source(name), 'utf8');

// Under the luminance key each scene's in-page near-black base disc (rgba(1,4,10,0.9)) maps to
// ~4% alpha, so it no longer occludes what is behind. The host restores occlusion with a
// QtQuick.Shapes disc drawn behind (before) the keyed WebEngineView, per scene.

// Evaluates the host-owned scene -> disc mapping exactly as written in view.qml.
function discFor() {
    const qml = read('view.qml');
    const match = qml.match(/function discFor\(name, w, h\) \{[\s\S]*?\n    \}/);
    assert.ok(match, 'view.qml declares function discFor(name, w, h)');
    return new Function(`${match[0]}; return discFor;`)();
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9,
    `${actual} != ${expected}`);
const constant = (source, name) => Number(source.match(new RegExp(`const ${name} = ([0-9.]+);`))[1]);

test('view.qml imports QtQuick.Shapes and declares the disc Shape before the WebEngineView', () => {
    const qml = read('view.qml');
    assert.match(qml, /^import QtQuick\.Shapes$/m);
    const shape = qml.search(/^\s*Shape \{/m);
    const view = qml.search(/^\s*WebEngineView \{/m);
    assert.ok(shape > 0 && view > 0 && shape < view, 'Shape precedes (is behind) WebEngineView');
    assert.match(qml, /visible: sceneRoot\.sceneMode === "scene-mini" && sceneRoot\.sceneDisc\.radius > 0/);
    assert.match(qml, /strokeWidth: -1/);
});

test('disc gradient keeps the approved stops: rgb 1,4,10 at alpha 0.9 / 0.6 at 0.9 / 0 at the edge', () => {
    const qml = read('view.qml');
    const stops = [...qml.matchAll(/GradientStop \{ position: ([0-9.]+); color: Qt\.rgba\(([^)]*)\) \}/g)]
        .map(m => [m[1], m[2]]);
    assert.deepEqual(stops, [
        ['0.0', '1/255, 4/255, 10/255, 0.9'],
        ['0.9', '1/255, 4/255, 10/255, 0.6'],
        ['1.0', '1/255, 4/255, 10/255, 0.0'],
    ]);
    assert.match(qml, /fillGradient: RadialGradient \{\s*centerX: sceneRoot\.sceneDisc\.x; centerY: sceneRoot\.sceneDisc\.y; centerRadius: sceneRoot\.sceneDisc\.radius\s*focalX: sceneRoot\.sceneDisc\.x; focalY: sceneRoot\.sceneDisc\.y/);
    assert.match(qml, /PathAngleArc \{ centerX: sceneRoot\.sceneDisc\.x; centerY: sceneRoot\.sceneDisc\.y; radiusX: sceneRoot\.sceneDisc\.radius; radiusY: sceneRoot\.sceneDisc\.radius; startAngle: 0; sweepAngle: 360 \}/);
});

test('per-scene disc geometry at 240x240 matches each scene\'s own drawing geometry', () => {
    const disc = discFor();
    // Anything outside the closed set draws no disc.
    assert.equal(disc('unknown', 240, 240).radius, 0);
    assert.equal(disc('', 240, 240).radius, 0);
    assert.equal(disc('Idle', 240, 240).radius, 0);
    // idle/explorer: mini centre W/2,H/2 (animate.js); r = 0.44 of the short side, inside the
    // 0.41-0.48 edge fade (render-loop.js MINI_EDGE_FADE_INNER/OUTER).
    for (const scene of ['idle', 'explorer']) {
        const animate = read(`${scene}/js/animate.js`);
        assert.match(animate, /const cx = isMiniVariant \? W \/ 2 :/);
        assert.match(animate, /const cy = isMiniVariant \? H \/ 2 :/);
        const loop = read(`${scene}/js/render-loop.js`);
        assert.match(loop, /var MINI_EDGE_FADE_INNER = 0\.41;/);
        assert.match(loop, /var MINI_EDGE_FADE_OUTER = 0\.48;/);
        const d = disc(scene, 240, 240);
        close(d.x, 120); close(d.y, 120); close(d.radius, 105.6);
    }
    // processing: render() centre (W*0.505, H*0.515); in-page base fades out at 0.40 of the short side.
    const processing = read('processing/js/main.js');
    assert.match(processing, /var cx = W \* 0\.505;\s*var cy = H \* 0\.515;/);
    assert.match(processing, /drawMiniSceneBase\(ctx, cx, cy, Math\.min\(W, H\) \* 0\.32, Math\.min\(W, H\) \* 0\.40\)/);
    const p = disc('processing', 240, 240);
    close(p.x, 121.2); close(p.y, 123.6); close(p.radius, 96);
    // raphael: same centre; falloff = rimRadius * 1.06, rimRadius = blue outer radius * MINI_SCENE_ZOOM,
    // blue outer = coreRadius(min) * BLUE_OUTER_FACTOR = min/2 - GLYPH_SYSTEM_OUTER_MARGIN_PX.
    const raphael = read('raphael/js/main.js');
    assert.match(raphael, /var cx = W \* 0\.505;\s*var cy = H \* 0\.515;/);
    assert.match(raphael, /const rimRadius = outermostRing\.outerRadius \* MINI_SCENE_ZOOM;\s*drawMiniSceneBase\(ctx, cx, cy, rimRadius, rimRadius \* 1\.06\);/);
    const config = read('raphael/js/config.js');
    const margin = constant(config, 'GLYPH_SYSTEM_OUTER_MARGIN_PX');
    const zoom = constant(config, 'MINI_SCENE_ZOOM');
    const blueFactor = constant(config, 'GLYPH_RING_BLUE_OUTER_FACTOR');
    assert.deepEqual([margin, zoom, blueFactor], [50, 1.3507, 2.35]); // B6: was 1.2
    const rim = (240 / 2 - margin) / blueFactor * blueFactor * zoom;
    const r = disc('raphael', 240, 240);
    close(r.x, 121.2); close(r.y, 123.6); close(r.radius, rim * 1.06);
    close(r.radius, 100.22194); // B6: was 89.04 at zoom 1.2
});

test('scene -> disc mapping is host-owned: C++ passes the validated scene name, QML never reads the page', () => {
    const qml = read('view.qml');
    assert.match(qml, /required property string sceneName/);
    assert.match(qml, /readonly property var sceneDisc: discFor\(sceneRoot\.sceneName, sceneRoot\.width, sceneRoot\.height\)/);
    assert.doesNotMatch(qml, /webChannel|WebChannel/);
    // A4: one host -> page call exists (alerts); the disc never depends on page data.
    assert.equal(qml.match(/runJavaScript/g).length, 1);
    assert.doesNotMatch(qml.slice(qml.indexOf('function discFor'), qml.indexOf('Shape {')), /runJavaScript|sceneAlerts|pageMessage/);
    const main = read('main.cpp');
    assert.match(main, /\{QStringLiteral\("sceneName"\), scene\}/);
    // The name comes only from parseHostOptions' closed scene set.
    const control = read('resident-control.h');
    assert.match(control, /value == QStringLiteral\("processing"\) \|\| value == QStringLiteral\("raphael"\) \|\|\s*value == QStringLiteral\("idle"\) \|\| value == QStringLiteral\("explorer"\)/);
});

test('B6: raphael mini outer ring matches idle/explorer at 240 px and stays inside the opaque edge-fade radius', () => {
    // idle/explorer fit their disc-border outer radius to MINI_RING_RADIUS_FRACTION of the short side.
    const side = 240;
    const idleRing = side * constant(read('idle/js/config.js'), 'MINI_RING_RADIUS_FRACTION');
    const explorerRing = side * constant(read('explorer/js/config.js'), 'MINI_RING_RADIUS_FRACTION');
    close(idleRing, 96); close(explorerRing, 96);
    // raphael: blue outer ring = (side/2 - margin) * MINI_SCENE_ZOOM about its centre (0.505W, 0.515H).
    const config = read('raphael/js/config.js');
    const ring = (side / 2 - constant(config, 'GLYPH_SYSTEM_OUTER_MARGIN_PX')) * constant(config, 'MINI_SCENE_ZOOM');
    const offset = Math.hypot(side * 0.005, side * 0.015);
    const opaque = side * 0.41; // render-loop.js MINI_EDGE_FADE_INNER
    // Tolerance: the exact 96 px does not fit with the 3.79 px centre offset, so the ring must be
    // >= 94 px (within 2 px of idle) and its far edge must stay <= the 98.4 px opaque radius.
    assert.ok(ring >= 94 && Math.abs(ring - idleRing) <= 2, `raphael ring ${ring} px vs idle ${idleRing} px`);
    assert.ok(ring + offset <= opaque, `raphael ring far edge ${ring + offset} px > ${opaque} px`);
});
