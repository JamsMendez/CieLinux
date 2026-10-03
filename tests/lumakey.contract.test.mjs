import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { SRC, source } from './paths.mjs';
const read = name => readFileSync(source(name), 'utf8');

// Host transparency comes from a luminance key over an opaque black page, not
// from a transparent WebEngine page (which accumulates stale bright content).
test('luminance-key shader derives alpha from max(r,g,b) and emits premultiplied output', () => {
    assert.ok(existsSync(source('lumakey.frag')));
    const frag = read('lumakey.frag');
    assert.match(frag, /^(?:\/\/[^\n]*\n)*#version 440/);
    assert.match(frag, /layout\(std140, binding = 0\) uniform buf \{ mat4 qt_Matrix; float qt_Opacity; \};/);
    assert.match(frag, /layout\(binding = 1\) uniform sampler2D source;/);
    assert.match(frag, /float a = max\(c\.r, max\(c\.g, c\.b\)\);/);
    assert.match(frag, /fragColor = vec4\(c, a\) \* qt_Opacity;/);
});

test('CMake compiles the luminance key with ShaderTools into qrc:/lumakey.frag.qsb', () => {
    const cmake = read('CMakeLists.txt');
    assert.match(cmake, /find_package\(Qt6 REQUIRED COMPONENTS [^)]*\bShaderTools\b/);
    assert.match(cmake, /qt_add_shaders\(cielinux "lumakey" PREFIX "\/" BASE src FILES src\/lumakey\.frag\)/);
});

test('view.qml renders the page opaque on black and keys the mini through the shader layer', () => {
    const qml = read('view.qml');
    assert.match(qml, /backgroundColor: "black"/);
    assert.doesNotMatch(qml, /backgroundColor: "transparent"/);
    // A1: keyed in scene-mini only; the wallpaper (mode scene) is opaque.
    assert.match(qml, /layer\.enabled: sceneRoot\.sceneMode === "scene-mini"/);
    assert.match(qml, /layer\.effect: ShaderEffect \{ fragmentShader: "qrc:\/lumakey\.frag\.qsb" \}/);
});

test('mini processing, raphael, idle, and explorer pages paint an opaque black root', () => {
    for (const css of ['processing/styles.css', 'raphael/styles.css'].map(read)) {
    assert.match(css, /html\.scene-mini \{\s*background: #000;\s*\}/);
    assert.match(css, /html\.scene-mini body,\s*html\.scene-mini #scene,\s*html\.scene-mini #nebula \{\s*background: transparent;\s*\}/);
    assert.doesNotMatch(css, /!important/);
    }
    for (const css of ['idle/styles.css', 'explorer/styles.css'].map(read)) {
    assert.match(css, /html\.scene-mini \{\s*background: #000;\s*\}/);
    assert.match(css, /html\.scene-mini body,\s*html\.scene-mini #scene \{\s*background: transparent;\s*\}/);
    assert.doesNotMatch(css, /!important/);
    }
});
