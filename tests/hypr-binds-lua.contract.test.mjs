// A7 Hyprland binds for Lua configs (Hyprland 0.56+ `hyprland.lua`, Omarchy's `o.bind`):
// install.sh writes the managed block into hypr/bindings.lua (Lua comment markers),
// migrates away an old hyprlang block from hypr/bindings.conf, and keeps the hyprlang
// path for hyprlang configs; uninstall.sh removes the block from both files. Runs the
// scripts' own functions (sourced via $1, main not run) against temp directories only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './paths.mjs';

const install = join(ROOT, 'install.sh');
const uninstall = join(ROOT, 'uninstall.sh');
let fixture;
before(() => { fixture = mkdtempSync(join(tmpdir(), 'cielinux-a7-binds.')); });
after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

const bash = (script, body, ...args) => {
    // The script path goes in $1, not $0: $0 == BASH_SOURCE[0] is the scripts' "run main" test.
    const result = spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; shift; ${body}`, 'bash', script, ...args],
        { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(fixture, 'no-home') } });
    assert.ifError(result.error);
    return result;
};
const installBinds = (dir, bin) => bash(install, 'hypr_binds_install "$1" "$2"', dir, bin);
const uninstallBinds = dir => bash(uninstall, 'hypr_binds_uninstall "$1"', dir);

const LUA_BEGIN = '-- >>> cielinux mini position binds (managed by CieLinux install.sh) >>>';
const LUA_END = '-- <<< cielinux mini position binds <<<';
const CONF_BEGIN = '# >>> cielinux mini position binds (managed by CieLinux install.sh) >>>';
const CONF_END = '# <<< cielinux mini position binds <<<';
const count = (text, needle) => text.split(needle).length - 1;

const luaDir = (bindings) => {
    const dir = mkdtempSync(join(fixture, 'hypr-lua.'));
    writeFileSync(join(dir, 'hyprland.lua'), 'require("default.hypr.omarchy")\nrequire("hypr.bindings")\n');
    if (bindings !== undefined) writeFileSync(join(dir, 'bindings.lua'), bindings);
    return dir;
};

const haveLua = spawnSync('lua', ['-v']).status === 0;
const haveLuac = spawnSync('luac', ['-v']).status === 0;

// Loads the file in Lua with stub `o`/`hl` and returns what o.bind received.
const runLua = file => {
    const result = spawnSync('lua', ['-', file], {
        encoding: 'utf8',
        input: 'o = { bind = function(k, d, c) io.write(k, "\\t", d, "\\t", c, "\\n") end }\nhl = { unbind = function() end }\ndofile(arg[1])\n',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').filter(Boolean).map(line => line.split('\t'));
};

test('flavour: hyprland.lua means Lua mode, else hyprlang', () => {
    const dir = mkdtempSync(join(fixture, 'flavour.'));
    const flavour = () => bash(install, 'hypr_binds_flavour "$1"', dir).stdout.trim();
    writeFileSync(join(dir, 'hyprland.conf'), '');
    assert.equal(flavour(), 'hyprlang');
    writeFileSync(join(dir, 'hyprland.lua'), 'require("hypr.bindings")\n');
    assert.equal(flavour(), 'lua');
});

test('Lua mode: insert, idempotent refresh, user lines and mode kept, uninstall restores exactly', () => {
    const original = '-- user binds\nhl.unbind("SUPER + ALT + SPACE")\no.bind("SUPER + Y", "Apps menu", "omarchy-menu toggle apps")'; // no final newline
    const dir = luaDir(original);
    const file = join(dir, 'bindings.lua');
    chmodSync(file, 0o640);
    for (let i = 0; i < 3; i++) {
        const result = installBinds(dir, '/home/me/.local/bin');
        assert.equal(result.status, 0, result.stderr);
    }
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith(original + '\n'));
    assert.equal(count(text, LUA_BEGIN), 1);
    assert.equal(count(text, LUA_END), 1);
    assert.ok(text.includes(`${LUA_BEGIN}\no.bind("SUPER + Z", "CieLinux mini: next position", "'/home/me/.local/bin/cielinux' --cycle-position next")\no.bind("SUPER + SHIFT + Z", "CieLinux mini: previous position", "'/home/me/.local/bin/cielinux' --cycle-position prev")\n${LUA_END}\n`), text);
    assert.equal(statSync(file).mode & 0o777, 0o640);
    assert.ok(!existsSync(join(dir, 'bindings.conf')));
    const removed = uninstallBinds(dir);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(readFileSync(file, 'utf8'), original + '\n');
    assert.equal(uninstallBinds(dir).status, 0);
    assert.equal(readFileSync(file, 'utf8'), original + '\n');
});

test('Lua mode: migration removes the old hyprlang block from bindings.conf', () => {
    const dir = luaDir('o.bind("SUPER + Y", "Apps menu", "omarchy-menu toggle apps")\n');
    const conf = join(dir, 'bindings.conf');
    const confUser = 'bindd = SUPER, RETURN, Terminal, exec, $terminal\n';
    writeFileSync(conf, confUser + CONF_BEGIN + "\nbindd = SUPER, Z, CieLinux mini: next position, exec, '/x/cielinux' --cycle-position next\n" + CONF_END + '\n');
    chmodSync(conf, 0o600);
    const result = installBinds(dir, '/usr/bin');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(conf, 'utf8'), confUser);
    assert.equal(statSync(conf).mode & 0o777, 0o600);
    assert.equal(count(readFileSync(join(dir, 'bindings.lua'), 'utf8'), LUA_BEGIN), 1);
    // Both files carry a block: uninstall clears both.
    writeFileSync(conf, confUser + CONF_BEGIN + '\nx\n' + CONF_END + '\n');
    assert.equal(uninstallBinds(dir).status, 0);
    assert.equal(readFileSync(conf, 'utf8'), confUser);
    assert.equal(count(readFileSync(join(dir, 'bindings.lua'), 'utf8'), LUA_BEGIN), 0);
});

test('Lua mode: bindings.lua is created only when hyprland.lua requires it', () => {
    const dir = luaDir();
    const result = installBinds(dir, '/usr/bin');
    assert.equal(result.status, 0, result.stderr);
    const file = join(dir, 'bindings.lua');
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file, 'utf8').startsWith(LUA_BEGIN + '\n'), true);
    assert.equal(statSync(file).mode & 0o777, 0o644);

    const bare = mkdtempSync(join(fixture, 'hypr-lua-bare.'));
    writeFileSync(join(bare, 'hyprland.lua'), 'require("default.hypr.omarchy")\n');
    const skipped = installBinds(bare, '/usr/bin');
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.ok(!existsSync(join(bare, 'bindings.lua')));
    assert.match(skipped.stdout + skipped.stderr, /not added/);
});

test('Lua mode: a broken (unterminated) block is refused and nothing is written', () => {
    const broken = 'o.bind("SUPER + Y", "Apps menu", "x")\n' + LUA_BEGIN + '\no.bind("SUPER + Z", "a", "b")\n';
    const dir = luaDir(broken);
    const result = installBinds(dir, '/usr/bin');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unterminated/);
    assert.equal(readFileSync(join(dir, 'bindings.lua'), 'utf8'), broken);
    const removed = uninstallBinds(dir);
    assert.notEqual(removed.status, 0);
    assert.equal(readFileSync(join(dir, 'bindings.lua'), 'utf8'), broken);
});

test('Lua mode: a path with a space, quotes and a backslash survives Lua and sh quoting', () => {
    const dir = luaDir('');
    const bindir = join(fixture, `it's "here" \\ now`, 'bin');
    mkdirSync(bindir, { recursive: true });
    const out = join(fixture, 'argv.txt');
    writeFileSync(join(bindir, 'cielinux'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n`);
    chmodSync(join(bindir, 'cielinux'), 0o755);
    const result = installBinds(dir, bindir);
    assert.equal(result.status, 0, result.stderr);
    const file = join(dir, 'bindings.lua');
    if (haveLuac) assert.equal(spawnSync('luac', ['-p', file]).status, 0, 'luac -p rejects the generated block');
    if (!haveLua) return; // lua missing: the luac parse check above is all we can do
    const binds = runLua(file);
    assert.deepEqual(binds.map(b => b.slice(0, 2)), [
        ['SUPER + Z', 'CieLinux mini: next position'],
        ['SUPER + SHIFT + Z', 'CieLinux mini: previous position'],
    ]);
    for (const [i, dir_] of [[0, 'next'], [1, 'prev']]) {
        const sh = spawnSync('sh', ['-c', binds[i][2]], { encoding: 'utf8' });
        assert.equal(sh.status, 0, sh.stderr);
        assert.equal(readFileSync(out, 'utf8'), `--cycle-position\n${dir_}\n`);
    }
});

test('hyprlang mode is unchanged: block goes into bindings.conf', () => {
    const dir = mkdtempSync(join(fixture, 'hypr-conf.'));
    writeFileSync(join(dir, 'hyprland.conf'), 'source = ~/.config/hypr/bindings.conf\n');
    const conf = join(dir, 'bindings.conf');
    writeFileSync(conf, 'bind = SUPER, Q, killactive,\n');
    for (let i = 0; i < 2; i++) assert.equal(installBinds(dir, '/home/me/.local/bin').status, 0);
    const text = readFileSync(conf, 'utf8');
    assert.equal(count(text, CONF_BEGIN), 1);
    assert.match(text, /^bindd = SUPER, Z, CieLinux mini: next position, exec, '\/home\/me\/\.local\/bin\/cielinux' --cycle-position next$/m);
    assert.ok(!existsSync(join(dir, 'bindings.lua')));
    assert.equal(uninstallBinds(dir).status, 0);
    assert.equal(readFileSync(conf, 'utf8'), 'bind = SUPER, Q, killactive,\n');
});

test('no Hyprland config at all: nothing written, message printed', () => {
    const dir = mkdtempSync(join(fixture, 'hypr-none.'));
    const result = installBinds(dir, '/usr/bin');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not added/);
});

test('main uses hypr_binds_install', () => {
    assert.match(readFileSync(install, 'utf8'), /hypr_binds_install "\$\{XDG_CONFIG_HOME:-\$HOME\/\.config\}\/hypr" "\$prefix\/bin"/);
    assert.match(readFileSync(uninstall, 'utf8'), /hypr_binds_uninstall "\$\{XDG_CONFIG_HOME:-\$HOME\/\.config\}\/hypr"/);
});
