// R1 alert title reach (odd/tasks/alert-title-reach.md): the WARNING/FAILED letters reach each scene's
// reference ring (sceneAlertTitleLimits in its see-through hook) without touching it and without being
// stretched. The change is additive: stripping its blocks restores the pre-R1 files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import vm from 'node:vm';
import { SCENES, readText } from './paths.mjs';

const read = name => readText(join(SCENES, name));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const R1_BLOCK = /(?:\n(?=\/\/ Linux port begin \(R1\)))?^[ \t]*\/\/ Linux port begin \(R1\)[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux port end\.\n/gm;
const R1_HOOK_BLOCK = /^\/\/ Linux port begin \(R1\)[^\n]*\n[\s\S]*?^\/\/ Linux port end\.\n\n/gm;

const PRE_R1 = {
    'shared/js/alert-overlay.js': '103022454cca637f575d8d8ea4ed4207e3ba3bc50c513ebaa69e30c8d516ae24',
    'raphael/js/see-through-hook.js': 'd6f6c34f4af60e7fb5b1566393d5a347b303639796fe87d54fb13961af9f1720',
    'processing/js/see-through-hook.js': 'ff0dc530ca117e5cda5849ebb2b0520b7517dd0385fcf27c7c2f30558037bd05',
    'explorer/js/see-through-hook.js': '4ee5d0bfe8a7d148f411842c48eaf25517f12f3270f91a3d298b7c12df9e62f2',
    'idle/js/see-through-hook.js': 'c6a9268440bd2bcee2e657319e3636f9ee88baaad324994d03bdd1782a384d0d',
};

test('R1 blocks only add lines: stripping them restores the pre-R1 files', () => {
    for (const [name, hash] of Object.entries(PRE_R1)) {
        const text = read(name);
        assert.match(text, /^[ \t]*\/\/ Linux port begin \(R1\)/m, `${name} marks R1`);
        const strip = name.startsWith('shared/') ? R1_BLOCK : R1_HOOK_BLOCK;
        assert.equal(sha256(text.replace(strip, '')), hash, name);
    }
    for (const scene of ['raphael', 'processing', 'explorer', 'idle']) {
        assert.match(read(`${scene}/js/see-through-hook.js`), /^function sceneAlertTitleLimits\(sceneW, sceneH\) \{/m, scene);
    }
});

// The overlay's R1 helper block, run alone against a measuring stub (advance 0.6 em per glyph, ascent 0.7 em).
function reach({ tiles = ['warning'], limits = null, W = 240, H = 240 } = {}) {
    const helpers = read('shared/js/alert-overlay.js').match(R1_BLOCK)
        .find(block => block.includes('function failureTitleLayout'));
    const sandbox = { W, H, tiles, FAILURE_TITLE_FONT: 'stub', Math };
    if (limits) sandbox.sceneAlertTitleLimits = () => limits;
    vm.createContext(sandbox);
    vm.runInContext(helpers, sandbox);
    const g = {
        font: '',
        measureText(text) {
            const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)[1]);
            return { width: text.length * px * 0.6, actualBoundingBoxAscent: px * 0.7 };
        },
    };
    const frame = { x: W * 0.038, y: H * 0.064 };
    frame.w = W - frame.x * 2;
    frame.h = H - frame.y * 2;
    return { sandbox, g, frame };
}

test('R1 reach applies to a single tile with a scene hook only', () => {
    assert.equal(reach().sandbox.failureTitleLimits(), null);
    assert.equal(reach({ tiles: ['failed', 'warning'], limits: { top: 50, bottom: 190 } }).sandbox.failureTitleLimits(), null);
    assert.deepEqual({ ...reach({ limits: { top: 50, bottom: 190 } }).sandbox.failureTitleLimits() }, { top: 50, bottom: 190 });
});

test('R1 title layout: the font size never depends on the limits; the reveal stops at the limit or the whole glyph', () => {
    const shallow = reach({ limits: { top: 30, bottom: 200 } });
    const deep = reach({ limits: { top: 120, bottom: 120 } });
    const a = shallow.sandbox.failureTitleLayout(shallow.g, shallow.frame, 'WARNING', { top: 30, bottom: 200 });
    const b = deep.sandbox.failureTitleLayout(deep.g, deep.frame, 'WARNING', { top: 120, bottom: 120 });
    assert.equal(a.fontSize, b.fontSize, 'no vertical stretch: size comes from the frame width');
    const ascent = a.fontSize * 0.7;
    // Shallow: the inner glyph edge lands exactly on each limit.
    assert.ok(Math.abs(shallow.frame.y - a.topOffset + ascent - 30) < 1e-9);
    assert.ok(Math.abs(shallow.frame.y + shallow.frame.h + a.bottomOffset - ascent - 200) < 1e-9);
    // Deep: the glyph shows whole, never past its own ascent.
    assert.equal(b.topOffset, 0);
    assert.equal(b.bottomOffset, 0);
    assert.ok(b.topBand >= ascent && b.bottomBand >= ascent);
    assert.ok(a.topBand >= 240 * 0.23 && a.bottomBand >= 240 * 0.23, 'bands never shrink below the reference');
});

test('R1 letter bands reach the limit but never cross the tile middle', () => {
    const { sandbox, frame } = reach({ limits: { top: 80, bottom: 160 } });
    const bands = sandbox.failureTitleReachBands(frame, { top: 80, bottom: 160 });
    assert.ok(Math.abs(bands.top - (80 - frame.y)) < 1e-9);
    assert.ok(Math.abs(bands.bottom - (frame.y + frame.h - 160)) < 1e-9);
    const reference = sandbox.failureTitleReachBands(frame, { top: 20, bottom: 220 });
    assert.equal(reference.top, 240 * 0.23, 'a shallow limit keeps the reference band');
    const capped = sandbox.failureTitleReachBands(frame, { top: 400, bottom: -100 });
    assert.equal(capped.top, frame.h * 0.5);
    assert.equal(capped.bottom, frame.h * 0.5);
});

// The raphael hook, run alone against stubs: it stamps the scene's own gold outline-glyph sprites, one per
// ring slot, and falls back to the stroke ring until those sprites are baked.
function raphaelHook(sprites) {
    const calls = { images: [], strokes: 0 };
    const g = {
        save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
        drawImage(canvas, x, y, w, h) { calls.images.push({ canvas, x, y, w, h }); },
    };
    const sandbox = {
        Math, TAU: Math.PI * 2, sprites, isMiniVariant: false, MINI_SCENE_ZOOM: 1.3507,
        goldGlyphRingDrawParams: () => ({ radius: 100, rotation: 0, pool: [], count: 3, glyphSize: 4, lineWidth: 1 }),
        glyphRingOrientationAngle: angle => angle - Math.PI / 2,
        drawGlyphRing: () => { calls.strokes++; },
    };
    vm.createContext(sandbox);
    vm.runInContext(read('raphael/js/see-through-hook.js'), sandbox);
    sandbox.sceneSeeThroughLayer(g, 1920, 1080, 0.25);
    return calls;
}

test('R1 raphael see-through stamps the gold ring sprites the scene draws', () => {
    const set = [{ canvas: 'a', hw: 3, hh: 5 }, { canvas: 'b', hw: 4, hh: 6 }];
    const stamped = raphaelHook({ outlineGlyphsGold: set });
    assert.equal(stamped.strokes, 0);
    assert.deepEqual(stamped.images.map(i => [i.canvas, i.x, i.y, i.w, i.h]), [['a', -3, -5, 6, 10], ['b', -4, -6, 8, 12]]);
    const fallback = raphaelHook(null);
    assert.equal(fallback.strokes, 1);
    assert.equal(fallback.images.length, 0);
});
