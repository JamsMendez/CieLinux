// A1 host foundation: settings file, live scene switching and the scene-mini <-> scene
// (wallpaper) mode switch inside one host process. The native parts run as a real
// headless Qt Core harness compiled from the shipped sources, never a copied model.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SRC, source } from './paths.mjs';

const root = SRC;
const read = name => readFileSync(source(name), 'utf8');
let binary, fixture;

const run = (program, args) => {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
};

after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

before(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cielinux-a1-contract.'));
    binary = join(fixture, 'build', 'scenes-contract');
    writeFileSync(join(fixture, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(ScenesContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Qml)
add_executable(scenes-contract harness.cpp "${root}/settings.cpp" "${root}/scene-host.cpp"
    "${root}/scene-host.h" "${root}/policy.h")
target_include_directories(scenes-contract PRIVATE "${root}")
target_link_libraries(scenes-contract PRIVATE Qt6::Core Qt6::Qml)
`);
    writeFileSync(join(fixture, 'harness.cpp'), String.raw`
#include "settings.h"
#include "scene-host.h"
#include "policy.h"
#include "resident-control.h"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QList>
#include <QPair>
#include <cstring>
#include <iostream>
#define CHECK(x) do { if (!(x)) { std::cerr << "CHECK " << __LINE__ << ": " #x "\n"; return 3; } } while (false)

static int parseCases() {
    const Settings d;
    // Stage 1 is mini-only: the default mode is scene-mini (CielWin defaults to scene).
    CHECK(d.wallpaperMode == "scene-mini" && d.scene == "processing");
    CHECK(d.httpServerEnabled && d.httpServerPort == 43811 && d.miniPosition == "top-right");
    CHECK(d.alertSoundsEnabled && d.failedSound.isEmpty() && d.warningSound.isEmpty());
    CHECK(Settings::parse(QString()) == d);
    // Malformed content never throws and keeps every default.
    CHECK(Settings::parse(QString::fromUtf8("\x01\x02 = = =\n=scene\nscene\n# scene = idle\n   \n\xff\xfe")) == d);
    Settings s = Settings::parse("Wallpaper-Mode = SCENE-MINI\r\nscene = Idle\nmini-position = bottom-left\n"
        "http-server = off\nhttp-server-port = 8080\nalert-sounds = 0\nfailed-sound = failed.WAV\n"
        "warning-sound = ../x.mp3\n");
    CHECK(s.wallpaperMode == "scene-mini" && s.scene == "idle" && s.miniPosition == "bottom-left");
    CHECK(!s.httpServerEnabled && s.httpServerPort == 8080 && !s.alertSoundsEnabled);
    CHECK(s.failedSound == "failed.WAV" && s.warningSound.isEmpty());
    // Unrecognised values keep the default.
    CHECK(Settings::parse("scene = other\nwallpaper-mode = wallpaper\nhttp-server-port = 0\n"
        "http-server-port = 70000\nhttp-server-port = 12x\nhttp-server = maybe\nmini-position = middle\n") == d);
    // The last recognised assignment wins.
    CHECK(Settings::parse("scene = idle\nscene = raphael\nscene = bogus\n").scene == "raphael");
    // Legacy CielWin spellings are read; the new key wins whatever the order.
    s = Settings::parse("scene = explorer\nwallpaper-scene = idle\nwallpaper-mode = html-mini\n"
        "alert-http = off\nalert-http-port = 9000\nmini-corner = top-left\n");
    CHECK(s.scene == "explorer" && s.wallpaperMode == "scene-mini" && !s.httpServerEnabled);
    CHECK(s.httpServerPort == 9000 && s.miniPosition == "top-left");
    CHECK(Settings::parse("wallpaper-scene = idle\n").scene == "idle");
    CHECK(Settings::parse("http-server = on\nalert-http = off\n").httpServerEnabled);
    CHECK(Settings::parse("wallpaper-mode = mini\n").wallpaperMode == "scene-mini");
    CHECK(Settings::parse("wallpaper-mode = html\nwallpaper-mode = bogus\n").wallpaperMode == "scene");
    for (const char *bad : {"", ".wav", "a/b.wav", "a\\b.wav", "x.ogg", "..", "noext"})
        CHECK(Settings::parse(QStringLiteral("failed-sound = ") + QString::fromUtf8(bad)).failedSound.isEmpty());
    // A later unusable sound clears an earlier one (silence is the safe reading).
    CHECK(Settings::parse("failed-sound = a.wav\nfailed-sound = nope\n").failedSound.isEmpty());
    Settings custom;
    custom.wallpaperMode = "scene-mini"; custom.scene = "explorer"; custom.httpServerEnabled = false;
    custom.httpServerPort = 1; custom.miniPosition = "left-center"; custom.alertSoundsEnabled = false;
    custom.failedSound = "failed.m4a"; custom.warningSound = "warning.mp3";
    CHECK(Settings::parse(custom.serialize()) == custom);
    CHECK(Settings::parse(d.serialize()) == d);
    for (const char *line : {"\nwallpaper-mode = scene-mini\n", "\nscene = processing\n", "\nhttp-server = on\n",
                             "\nhttp-server-port = 43811\n", "\nmini-position = top-right\n",
                             "\nalert-sounds = on\n", "\nfailed-sound = \n", "\nwarning-sound = \n"})
        CHECK(d.serialize().contains(QString::fromUtf8(line)));
    std::cout << "PARSE_OK";
    return 0;
}

static int fileCases(const QString &dir) {
    CHECK(SettingsFile::resolvePath("/x/cfg", "/home/u") == "/x/cfg/cielinux/settings.conf");
    CHECK(SettingsFile::resolvePath("", "/home/u") == "/home/u/.config/cielinux/settings.conf");
    CHECK(SettingsFile::resolvePath("relative", "/home/u") == "/home/u/.config/cielinux/settings.conf");
    const QString folder = dir + "/nested/cielinux", path = folder + "/settings.conf";
    SettingsLoadResult r = SettingsFile::tryLoad(path);
    CHECK(r.status == SettingsLoadStatus::Missing && r.canSave() && r.settings == Settings());
    r = SettingsFile::loadOrCreate(path); // First run writes the commented defaults.
    CHECK(r.status == SettingsLoadStatus::Missing && QFile::exists(path));
    r = SettingsFile::tryLoad(path);
    CHECK(r.status == SettingsLoadStatus::Loaded && r.settings == Settings());
    Settings s; s.scene = "idle"; s.wallpaperMode = "scene-mini";
    CHECK(SettingsFile::save(path, s));
    CHECK(SettingsFile::tryLoad(path).settings == s);
    CHECK(QDir(folder).entryList(QDir::Files | QDir::Hidden) == QStringList{QStringLiteral("settings.conf")});
    { QFile f(path); CHECK(f.open(QIODevice::WriteOnly)); f.write("scene = raphael\n# hand edit\n"); }
    r = SettingsFile::loadOrCreate(path); // An existing file is read, never rewritten.
    CHECK(r.status == SettingsLoadStatus::Loaded && r.settings.scene == "raphael");
    { QFile f(path); CHECK(f.open(QIODevice::ReadOnly)); CHECK(f.readAll() == "scene = raphael\n# hand edit\n"); }
    { QFile f(path); CHECK(f.open(QIODevice::WriteOnly)); f.write(QByteArray("\x00\xff\x01scene=idle\0", 11)); }
    CHECK(SettingsFile::tryLoad(path).status == SettingsLoadStatus::Loaded);
    // An existing but unreadable path must never be overwritten with defaults.
    const QString blocked = dir + "/blocked/settings.conf";
    CHECK(QDir().mkpath(blocked));
    r = SettingsFile::tryLoad(blocked);
    CHECK(r.status == SettingsLoadStatus::Unreadable && !r.canSave() && r.settings == Settings());
    r = SettingsFile::loadOrCreate(blocked);
    CHECK(r.status == SettingsLoadStatus::Unreadable && QFileInfo(blocked).isDir());
    CHECK(!SettingsFile::save(blocked, s));
    // An oversized file is treated as unreadable instead of being slurped.
    const QString huge = dir + "/huge.conf";
    { QFile f(huge); CHECK(f.open(QIODevice::WriteOnly)); f.write(QByteArray(2 * 1024 * 1024, 'x')); }
    CHECK(SettingsFile::tryLoad(huge).status == SettingsLoadStatus::Unreadable);
    // A parent that is a file fails the save quietly.
    CHECK(!SettingsFile::save(huge + "/settings.conf", s));
    std::cout << "FILE_OK";
    return 0;
}

static int hostCases() {
    CHECK(sceneUrlFor("other", "scene-mini").isEmpty() && sceneUrlFor("idle", "wallpaper").isEmpty());
    for (const char *name : {"processing", "raphael", "idle", "explorer"}) {
        const QString scene = QString::fromUtf8(name);
        CHECK(isSwitchableScene(scene));
        CHECK(sceneUrlFor(scene, "scene-mini") == QUrl("qrc:/" + scene + "/index.html?variant=mini&fps=30"));
        CHECK(sceneUrlFor(scene, "scene") == QUrl("qrc:/" + scene + "/index.html?fps=60"));
        CHECK(effectiveMode(scene, "scene") == "scene" && effectiveMode(scene, "scene-mini") == "scene-mini");
    }
    for (const char *name : {"other", "IDLE", "", "../idle", "idle ", "shared"})
        CHECK(!isSwitchableScene(QString::fromUtf8(name)));
    CHECK(effectiveMode("other", "scene") == "scene-mini");
    QStringList switched;
    bool allow = true;
    QList<QPair<QString, QString>> saved;
    SceneHost host("idle", "scene-mini", [&](const QUrl &url) { switched << url.toString(); return allow; },
                   [&](const QString &scene, const QString &mode) { saved.append(qMakePair(scene, mode)); });
    CHECK(host.scene() == "idle" && host.mode() == "scene-mini");
    CHECK(host.url() == QUrl("qrc:/idle/index.html?variant=mini&fps=30"));
    for (const char *name : {"other", "IDLE", "", "../idle"}) CHECK(!host.setScene(QString::fromUtf8(name)));
    CHECK(switched.isEmpty());
    CHECK(host.setScene("idle") && switched.isEmpty()); // Already shown: no switch, no save.
    host.confirmReady();
    CHECK(saved.isEmpty());
    CHECK(host.setScene("raphael"));
    CHECK(switched == QStringList{"qrc:/raphael/index.html?variant=mini&fps=30"} && host.scene() == "raphael");
    CHECK(saved.isEmpty()); // Persist only once the switched scene is ready.
    host.confirmReady();
    for (const auto &p : saved) std::cerr << "SAVED " << p.first.toStdString() << "/" << p.second.toStdString() << "\n";
    CHECK(saved.size() == 1 && saved[0] == qMakePair(QStringLiteral("raphael"), QStringLiteral("scene-mini")));
    host.confirmReady();
    CHECK(saved.size() == 1);
    allow = false; // A refused switch leaves the shown target untouched and saves nothing.
    CHECK(!host.setScene("explorer"));
    CHECK(host.scene() == "raphael" && host.url() == QUrl("qrc:/raphael/index.html?variant=mini&fps=30"));
    CHECK(!host.setMode("scene") && host.mode() == "scene-mini");
    host.confirmReady();
    CHECK(saved.size() == 1);
    allow = true;
    CHECK(!host.setMode("wallpaper") && !host.setMode("SCENE") && !host.setMode(""));
    CHECK(host.setMode("scene-mini") && switched.size() == 3);
    CHECK(host.setMode("scene") && host.mode() == "scene");
    CHECK(switched.last() == "qrc:/raphael/index.html?fps=60" && host.url() == QUrl(switched.last()));
    CHECK(host.setScene("explorer") && switched.last() == "qrc:/explorer/index.html?fps=60");
    host.confirmReady();
    CHECK(saved.size() == 2 && saved[1] == qMakePair(QStringLiteral("explorer"), QStringLiteral("scene")));
    std::cout << "HOST_OK";
    return 0;
}

static int policyCases() {
    const QUrl mini("qrc:/idle/index.html?variant=mini&fps=30"), full("qrc:/idle/index.html?fps=60");
    Policy policy(mini);
    CHECK(!policy.retarget(full)); // No reconstruction bound yet.
    int rebuilt = 0, lastGeneration = 0;
    policy.bindReconstruction([&](int generation) { ++rebuilt; lastGeneration = generation; });
    policy.loadSucceededFor(1, mini);
    policy.consoleMessageFor(1, 0, "CIELINUX_SCENE_DRAW_READY_V1 idle", 1, "qrc:/idle/js/animate.js");
    CHECK(policy.ready());
    CHECK(!policy.retarget(QUrl()));
    CHECK(policy.retarget(full));
    CHECK(rebuilt == 1 && lastGeneration == 2 && policy.generation() == 2 && !policy.ready());
    CHECK(policy.allowed(full) && !policy.allowed(mini));
    policy.loadSucceededFor(1, mini); // A retired generation cannot report readiness.
    CHECK(!policy.ready());
    policy.loadSucceededFor(2, full);
    policy.consoleMessageFor(2, 0, "CIELINUX_SCENE_DRAW_READY_V1 idle", 1, "qrc:/idle/js/animate.js");
    CHECK(policy.ready());
    struct Full { const char *url, *source, *message; };
    for (const Full &entry : {Full{"qrc:/processing/index.html?fps=60", "qrc:/processing/js/main.js", "CIELINUX_SCENE_DRAW_READY_V1 processing"},
                              Full{"qrc:/raphael/index.html?fps=60", "qrc:/raphael/js/main.js", "CIELINUX_SCENE_DRAW_READY_V1 raphael"},
                              Full{"qrc:/explorer/index.html?fps=60", "qrc:/explorer/js/animate.js", "CIELINUX_SCENE_DRAW_READY_V1 explorer"}}) {
        CHECK(policy.retarget(QUrl(entry.url)));
        const int generation = policy.generation();
        policy.loadSucceededFor(generation, QUrl(entry.url));
        policy.consoleMessageFor(generation, 0, entry.message, 1, entry.source);
        CHECK(policy.ready());
    }
    // Live switches never spend the (default single) recovery budget.
    CHECK(rebuilt == 4);
    policy.incident(policy.generation(), 0);
    CHECK(rebuilt == 5 && !policy.closed());
    policy.closeNormally();
    CHECK(!policy.retarget(mini) && rebuilt == 5);
    std::cout << "POLICY_OK";
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 2 && std::strcmp(argv[1], "args") == 0) {
        HostOptions options;
        if (!parseHostOptions(argc - 1, argv + 1, options)) return 2;
        std::cout << options.scene.toStdString() << ' ' << options.sceneGiven << ' '
                  << options.mode.toStdString() << ' ' << options.modeGiven << ' ' << options.resident;
        return 0;
    }
    QCoreApplication app(argc, argv);
    if (argc >= 2 && std::strcmp(argv[1], "parse") == 0) return parseCases();
    if (argc >= 3 && std::strcmp(argv[1], "file") == 0) return fileCases(QString::fromLocal8Bit(argv[2]));
    if (argc >= 2 && std::strcmp(argv[1], "host") == 0) return hostCases();
    if (argc >= 2 && std::strcmp(argv[1], "policy") == 0) return policyCases();
    return 4;
}
`);
    for (const args of [['-S', fixture, '-B', join(fixture, 'build')], ['--build', join(fixture, 'build'), '-j2']]) {
        const result = run('cmake', args);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
});

test('settings parse matches the CielWin key = value contract and round-trips', () => {
    const result = run(binary, ['parse']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'PARSE_OK');
});

test('settings file: XDG path, first-run create, atomic save, unreadable never overwritten', () => {
    const result = run(binary, ['file', join(fixture, 'files')]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'FILE_OK');
});

test('scene host: closed allowlist, mini/full URLs, persist only after the switch is ready', () => {
    const result = run(binary, ['host']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'HOST_OK');
});

test('policy retarget: new generation and selected URL without spending the recovery budget', () => {
    const result = run(binary, ['policy']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'POLICY_OK');
});

test('parser: --mode is a closed optional flag and records which flags were given', () => {
    for (const [args, expected] of [
        [['--resident'], 'processing 0 scene-mini 0 1'],
        [['--scene', 'idle', '--resident'], 'idle 1 scene-mini 0 1'],
        [['--mode', 'scene', '--scene', 'raphael'], 'raphael 1 scene 1 0'],
        [['--mode', 'scene-mini'], 'processing 0 scene-mini 1 0']
    ]) {
        const result = run(binary, ['args', ...args]);
        assert.equal(result.status, 0, `${args}: ${result.stderr}`);
        assert.equal(result.stdout, expected);
    }
    for (const args of [['--mode'], ['--mode', 'wallpaper'], ['--mode', 'Scene'],
        ['--mode', 'scene', '--mode', 'scene'], ['--mode', '--resident']]) {
        assert.notEqual(run(binary, ['args', ...args]).status, 0, args.join(' '));
    }
});

test('host wiring: settings defaults under flags, live retarget, persist on ready, wallpaper layer', () => {
    const cpp = read('main.cpp');
    const main = cpp.slice(cpp.indexOf('int main('));
    assert.match(cpp, /#include "settings\.h"/);
    assert.match(cpp, /#include "scene-host\.h"/);
    assert.match(main, /\[--mode scene-mini\|scene\]/);
    assert.match(main, /SettingsFile::loadOrCreate\(settingsPath\)/);
    assert.match(main, /if \(!options\.sceneGiven\) options\.scene = stored\.settings\.scene;/);
    assert.match(main, /if \(!options\.modeGiven\) options\.mode = stored\.settings\.wallpaperMode;/);
    assert.match(main, /const QUrl sceneUrl\(sceneUrlFor\(scene, mode\)\);/);
    // Settings are resolved before any Wayland/Qt side effect, after the closed parser.
    assert.ok(main.indexOf('parseHostOptions(argc, argv, options)') < main.indexOf('SettingsFile::loadOrCreate'));
    assert.ok(main.indexOf('SettingsFile::loadOrCreate') < main.indexOf('const QUrl sceneUrl'));
    // A switch updates both URL gates before the policy replaces the attachment.
    assert.match(main, /interceptor\.select\(url\);\s*return policy\.retarget\(url\);/);
    assert.match(main, /&Policy::readyChanged, &sceneHost, \[&\] \{\s*if \(policy\.ready\(\)\) sceneHost\.confirmReady\(\);\s*\}/);
    assert.match(main, /if \(stored\.canSave\(\)\) SettingsFile::save\(settingsPath, stored\.settings\);/);
    // Each attachment reads the CURRENT target from the scene host.
    const prepare = main.slice(main.indexOf('auto prepareAttachment'), main.indexOf('policy.bindReconstruction'));
    assert.match(prepare, /const QString scene = sceneHost\.scene\(\);/);
    assert.match(prepare, /const QUrl sceneUrl = sceneHost\.url\(\);/);
    assert.match(prepare, /const bool wallpaper = sceneHost\.mode\(\) == QStringLiteral\("scene"\);/);
    assert.match(prepare, /layer->setLayer\(LayerShellQt::Window::LayerBackground\);/);
    for (const edge of ['AnchorTop', 'AnchorBottom', 'AnchorLeft', 'AnchorRight'])
        assert.ok(prepare.slice(prepare.indexOf('if (wallpaper) {')).includes(edge), edge);
    assert.match(prepare, /layer->setExclusiveZone\(-1\);/);
    assert.match(prepare, /\{QStringLiteral\("sceneMode"\), sceneHost\.mode\(\)\}/);
    const qml = read('view.qml');
    assert.match(qml, /required property string sceneMode/);
    assert.match(qml, /layer\.enabled: sceneRoot\.sceneMode === "scene-mini"/);
    assert.match(qml, /visible: sceneRoot\.sceneMode === "scene-mini" && sceneRoot\.sceneDisc\.radius > 0/);
    const cmake = read('CMakeLists.txt');
    assert.match(cmake, /qt_add_executable\(cielinux src\/main\.cpp src\/settings\.cpp src\/scene-host\.cpp src\/tray\.cpp src\/http-server\.cpp src\/http-token\.cpp src\/alerts\.cpp src\/alert-sounds\.cpp\)/); // A4 adds src/alerts.cpp, A5 src/alert-sounds.cpp
    // Scene names reach URLs only through the closed literal table.
    const host = read('scene-host.cpp');
    assert.doesNotMatch(host, /QStringLiteral\("qrc:\/"\)\s*\+|"qrc:\/" \+|arg\(/);
});
