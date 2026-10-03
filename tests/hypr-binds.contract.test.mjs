// A6 Hyprland binds: install.sh appends SUPER+Z / SUPER+SHIFT+Z (calling
// `cielinux --cycle-position next|prev`) in one marked block, idempotently; uninstall.sh
// removes exactly that block. Runs the scripts' own functions (sourced, main not run)
// against temp copies only; never the real Hyprland config.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './paths.mjs';

const install = join(ROOT, 'install.sh');
const uninstall = join(ROOT, 'uninstall.sh');
let fixture;
before(() => { fixture = mkdtempSync(join(tmpdir(), 'cielinux-a6-binds.')); });
after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

const bash = (script, body, ...args) => {
    // The script path goes in $1, not $0: $0 == BASH_SOURCE[0] is the scripts' "run main" test.
    const result = spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; shift; ${body}`, 'bash', script, ...args],
        { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(fixture, 'no-home') } });
    assert.ifError(result.error);
    return result;
};
const add = (file, bin) => bash(install, 'hypr_binds_add "$1" "$2"', file, bin);
const remove = file => bash(uninstall, 'hypr_binds_remove "$1"', file);
const BEGIN = '# >>> cielinux mini position binds (managed by CieLinux install.sh) >>>';
const END = '# <<< cielinux mini position binds <<<';

test('sourcing the scripts runs nothing (main is guarded)', () => {
    for (const script of [install, uninstall]) {
        const result = bash(script, 'echo SOURCED');
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), 'SOURCED');
    }
});

test('target: Omarchy bindings.conf first, else hyprland.conf, else none', () => {
    const dir = mkdtempSync(join(fixture, 'hypr.'));
    const target = () => bash(install, 'hypr_binds_target "$1"', dir).stdout.trim();
    assert.equal(target(), '');
    writeFileSync(join(dir, 'hyprland.conf'), 'source = ~/.config/hypr/bindings.conf\n');
    assert.equal(target(), join(dir, 'hyprland.conf'));
    writeFileSync(join(dir, 'bindings.conf'), 'bindd = SUPER, RETURN, Terminal, exec, $terminal\n');
    assert.equal(target(), join(dir, 'bindings.conf'));
});

test('add is idempotent, keeps the user lines and mode, and remove restores the file exactly', () => {
    const file = join(fixture, 'bindings.conf');
    const original = '# user binds\nbindd = SUPER, RETURN, Terminal, exec, $terminal\nbind = SUPER, Q, killactive,'; // no final newline
    writeFileSync(file, original);
    chmodSync(file, 0o640);
    const bin = '/home/me/.local/bin';
    for (let i = 0; i < 3; i++) assert.equal(add(file, bin).status, 0);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith(original + '\n'));
    assert.equal(text.split(BEGIN).length - 1, 1);
    assert.equal(text.split(END).length - 1, 1);
    assert.match(text, /^bindd = SUPER, Z, CieLinux mini: next position, exec, '\/home\/me\/\.local\/bin\/cielinux' --cycle-position next$/m);
    assert.match(text, /^bindd = SUPER SHIFT, Z, CieLinux mini: previous position, exec, '\/home\/me\/\.local\/bin\/cielinux' --cycle-position prev$/m);
    assert.equal(statSync(file).mode & 0o777, 0o640);
    // A new prefix replaces the block rather than adding a second one.
    assert.equal(add(file, "/opt/it's here/bin").status, 0);
    const moved = readFileSync(file, 'utf8');
    assert.equal(moved.split(BEGIN).length - 1, 1);
    assert.match(moved, /exec, '\/opt\/it'\\''s here\/bin\/cielinux' --cycle-position next$/m);
    assert.equal(remove(file).status, 0);
    assert.equal(readFileSync(file, 'utf8'), original + '\n');
    assert.equal(remove(file).status, 0); // nothing to remove: unchanged
    assert.equal(readFileSync(file, 'utf8'), original + '\n');
});

test('remove deletes only the marked block; an unterminated block is left alone', () => {
    const file = join(fixture, 'hyprland.conf');
    const before = 'monitor = ,preferred,auto,1\n';
    const after = 'bind = SUPER, Z, exec, my-own-z-thing\n';
    writeFileSync(file, before + BEGIN + '\nbindd = SUPER, Z, x, exec, y\n' + END + '\n' + after);
    assert.equal(remove(file).status, 0);
    assert.equal(readFileSync(file, 'utf8'), before + after);
    const broken = before + BEGIN + '\nbindd = SUPER, Z, x, exec, y\n' + after;
    writeFileSync(file, broken);
    const result = remove(file);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unterminated/);
    assert.equal(readFileSync(file, 'utf8'), broken);
    assert.notEqual(add(file, '/usr/bin').status, 0);
    assert.equal(readFileSync(file, 'utf8'), broken);
});

test('a symlinked config is edited through the link, which stays a link', () => {
    const real = join(fixture, 'dotfiles-bindings.conf');
    const link = join(fixture, 'link-bindings.conf');
    writeFileSync(real, 'bind = SUPER, Q, killactive,\n');
    symlinkSync(real, link);
    assert.equal(add(link, '/usr/bin').status, 0);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.match(readFileSync(real, 'utf8'), /--cycle-position next/);
    assert.equal(remove(link).status, 0);
    assert.equal(readFileSync(real, 'utf8'), 'bind = SUPER, Q, killactive,\n');
});

test('scripts: default on with --no-hypr-binds opt-out, same markers in both', () => {
    const inst = readFileSync(install, 'utf8');
    const uninst = readFileSync(uninstall, 'utf8');
    assert.match(inst, /--no-hypr-binds\)/);
    assert.match(inst, /hypr_binds=1/);
    for (const text of [inst, uninst]) {
        assert.ok(text.includes(BEGIN.replace(/^# /, '')) || text.includes(BEGIN));
        assert.ok(text.includes(END.replace(/^# /, '')) || text.includes(END));
        assert.match(text, /if \[\[ \$\{BASH_SOURCE\[0\]\} == "\$0" \]\]; then\s+main "\$@"\s+fi/);
    }
    for (const script of [install, uninstall])
        assert.equal(spawnSync('bash', ['-n', script]).status, 0);
});
