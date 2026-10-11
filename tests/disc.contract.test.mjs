import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
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
    // raphael (odd/tasks/scene-wallpaper-scaling.md T3): mini centre W/2,H/2 like idle/explorer; falloff =
    // rimRadius * 1.06, rimRadius = blue outer radius * MINI_SCENE_ZOOM = MINI_RING_RADIUS_FRACTION * short side.
    const raphael = read('raphael/js/main.js');
    assert.match(raphael, /var cx = isMiniVariant \? W \/ 2 : W \* 0\.505;\s*var cy = isMiniVariant \? H \/ 2 : H \* 0\.515;/);
    assert.match(raphael, /const rimRadius = outermostRing\.outerRadius \* MINI_SCENE_ZOOM;\s*drawMiniSceneBase\(ctx, cx, cy, rimRadius, rimRadius \* 1\.06\);/);
    for (const side of [240, 200, 180]) {
        const r = disc('raphael', side, side);
        close(r.x, side / 2); close(r.y, side / 2);
        close(r.radius, raphaelMiniRing(side) * 1.06);
        close(r.radius, side * 0.40 * 1.06);
    }
});

// The raphael mini's outer ring (blue outer radius, magnified by MINI_SCENE_ZOOM) as the page computes it:
// hexadecagon.js's coreRadius evaluated in mini with config.js's constants.
function raphaelMiniRing(side) {
    const config = read('raphael/js/config.js');
    const names = ['MINI_RING_RADIUS_FRACTION', 'MINI_SCENE_ZOOM', 'GLYPH_RING_BLUE_OUTER_FACTOR',
        'GLYPH_SYSTEM_OUTER_MARGIN_PX', 'HEXADECAGON_FALLBACK_RADIUS_FACTOR'];
    const sandbox = vm.createContext({ isMiniVariant: true, Math,
        ...Object.fromEntries(names.map(name => [name, constant(config, name)])) });
    vm.runInContext(read('raphael/js/hexadecagon.js'), sandbox, { filename: 'raphael/js/hexadecagon.js' });
    return vm.runInContext(`coreRadius(${side}) * GLYPH_RING_BLUE_OUTER_FACTOR * MINI_SCENE_ZOOM`, sandbox);
}

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

test('B6/T3: raphael mini outer ring matches idle/explorer at every size and stays inside the opaque edge-fade radius', () => {
    // idle/explorer fit their disc-border outer radius to MINI_RING_RADIUS_FRACTION of the short side.
    const fraction = constant(read('idle/js/config.js'), 'MINI_RING_RADIUS_FRACTION');
    assert.equal(constant(read('explorer/js/config.js'), 'MINI_RING_RADIUS_FRACTION'), fraction);
    assert.equal(constant(read('raphael/js/config.js'), 'MINI_RING_RADIUS_FRACTION'), fraction);
    // T3 (odd/tasks/scene-wallpaper-scaling.md): raphael is centred at (W/2, H/2) and its outer ring is
    // proportional (no 50 px margin in mini), so it is exactly idle's 0.40 * side at every size, and its
    // far edge (ring + half the 2 px delimiter, magnified) stays inside the 0.41 opaque radius.
    for (const side of [288, 240, 200, 180]) {
        const ring = raphaelMiniRing(side);
        close(ring, side * fraction);
        const delimiter = constant(read('raphael/js/config.js'), 'GLYPH_RING_DELIMITER_WIDTH') / 2
            * constant(read('raphael/js/config.js'), 'MINI_SCENE_ZOOM');
        const opaque = side * 0.41; // render-loop.js MINI_EDGE_FADE_INNER
        assert.ok(ring + delimiter <= opaque, `raphael ring far edge ${ring + delimiter} px > ${opaque} px at ${side}`);
    }
});
