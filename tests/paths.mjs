// Repository layout for the contract tests: host sources in src/, scene pages in
// scenes/<scene>/, the build file at the root. Tests name files the way the host
// serves them (`main.cpp`, `processing/js/main.js`, `CMakeLists.txt`).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = join(ROOT, 'src');
export const SCENES = join(ROOT, 'scenes');
export const ASSETS = join(ROOT, 'assets');
// `shared/` holds the alert overlay every scene page loads (A4).
const sceneDirs = new Set(['processing', 'explorer', 'idle', 'raphael', 'shared']);

export function source(name) {
    const relative = String(name).replace(/^\.\//, '');
    if (relative === 'CMakeLists.txt') return join(ROOT, relative);
    if (sceneDirs.has(relative.split('/')[0])) return join(SCENES, relative);
    return join(SRC, relative);
}
