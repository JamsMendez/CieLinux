// Repository layout for the contract tests: host sources in src/, scene pages in
// scenes/<scene>/, the build file at the root. Tests name files the way the host
// serves them (`main.cpp`, `processing/js/main.js`, `CMakeLists.txt`).
import { readFileSync } from 'node:fs';
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

// Reads a text file with LF line endings whatever the checkout (core.autocrlf=true gives CRLF
// working files over LF blobs). The source pins hash the LF blobs, and the marked-block strippers
// match `\n`, so they hold on CRLF and LF checkouts alike.
export function readText(path) {
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}
