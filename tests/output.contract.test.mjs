import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SRC, source } from './paths.mjs';

const root = SRC;
const cpp = readFileSync(source('main.cpp'), 'utf8');

// Fake identities test only the portable decisions, never Qt or a compositor.
const harness = `
#include "output-policy.h"
#include <cassert>
#include <string>
#include <vector>

struct Screen { std::string name; };

int main() {
    Screen first{"HDMI-A-2"}, second{"DP-1"}, duplicate{"DP-1"};
    const std::vector<Screen *> empty;
    const std::vector<Screen *> screens{&first, &second, &duplicate};
    auto select = [](const auto &items, const std::string &name) {
        return OutputPolicy::select(items, name.empty(),
            [&](Screen *candidate) { return candidate->name == name; });
    };
    assert(select(empty, "") == nullptr);
    assert(select(empty, "DP-1") == nullptr);
    assert(select(screens, "") == &first);
    const std::vector<Screen *> reversed{&second, &first};
    assert(select(reversed, "") == &second);
    assert(select(screens, "HDMI-A-2") == &first);
    assert(select(screens, "DP-1") == &second);
    assert(select(screens, "dp-1") == nullptr);
    assert(select(screens, "DP") == nullptr);
    assert(select(screens, "missing") == nullptr);
    bool compared = false;
    assert(OutputPolicy::select(screens, true, [&](Screen *) {
        compared = true;
        return false;
    }) == &first);
    assert(!compared);

    std::vector<std::string> actions;
    const auto hide = [&] { actions.push_back("hide"); };
    const auto quit = [&] { actions.push_back("quit"); };
    // Same-name foreign identity must not trigger shutdown.
    OutputPolicy::removed(&second, &duplicate, hide, quit);
    OutputPolicy::removed(&second, &first, hide, quit);
    assert(actions.empty());
    OutputPolicy::removed(&second, &second, hide, quit);
    assert((actions == std::vector<std::string>{"hide", "quit"}));
}
`;

test('portable output selection and removal preserve ordered identity contracts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cielinux-output-contract.'));
    const source = join(directory, 'output.cpp');
    const binary = join(directory, 'output-test');
    writeFileSync(source, harness);
    const compile = spawnSync('g++', ['-std=c++17', '-Wall', '-Wextra', '-pedantic',
        '-I', root, source, '-o', binary], { encoding: 'utf8' });
    assert.equal(compile.error, undefined);
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
});

test('native wiring uses the portable decisions before view construction', () => {
    assert.match(cpp, /#include "output-policy\.h"/);
    const selection = 'OutputPolicy::select(app.screens(), output.isEmpty(),';
    assert.ok(cpp.includes(selection));
    assert.match(cpp, /\[&\]\(QScreen \*candidate\) \{ return candidate->name\(\) == output; \}/);
    const failure = 'if (!screen) { qCritical("Selected output unavailable"); return 2; }';
    assert.ok(cpp.indexOf(selection) < cpp.indexOf(failure));
    assert.ok(cpp.indexOf(failure) < cpp.indexOf('attachment.view = std::make_unique<QQuickView>();'));
    assert.match(cpp, /screenRemoved, &policy,\s*\[&\]\(QScreen \*removed\) \{\s*OutputPolicy::removed\(screen, removed,\s*\[&\] \{ policy.noteCloseReason\(Diagnostics::Reason::Output\); policy.closeNormally\(\); \}, \[\] \{\}\);/);
    assert.equal((cpp.match(/OutputPolicy::select\(/g) || []).length, 1);
    assert.equal((cpp.match(/OutputPolicy::removed\(/g) || []).length, 1);
    assert.doesNotMatch(cpp, /primaryScreen|availableGeometry|setPosition|removed->/);
    assert.ok(cpp.includes('view.setScreen(screen);'));
    assert.ok(cpp.includes('layer->setScreen(screen);'));
});
