import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { source } from './paths.mjs';

// NEB-1 (odd/tasks/wallpaper-microstutters.md): Mesa radeonsi exposes WebGL mediump as fp16
// (10-bit mantissa, range 2^15). The nebula hash multiplies by 43758.5453, which overflows fp16,
// so the value noise collapses and only the analytic spiral arms remain. Windows/ANGLE-D3D runs
// mediump at fp32, which is the reference look. The fragment shader must request highp.

for (const scene of ['processing', 'raphael']) {
    test(`${scene} nebula fragment shader requests highp float`, () => {
        const text = readFileSync(source(`${scene}/js/nebula.js`), 'utf8');
        const fragment = text.match(/const NEBULA_FRAGMENT_SHADER = `([\s\S]*?)`;/);
        assert.ok(fragment, 'fragment shader source found');
        assert.match(fragment[1], /^\s*precision highp float;/m);
        assert.doesNotMatch(fragment[1], /precision mediump float;/);
    });
}
