// A5 alert sounds: CielWin parity for the sound library (one file per kind, `failed.wav` /
// `warning.m4a`, .wav/.mp3/.m4a only, copy-then-replace, other extensions cleared), the bare
// file name a setting may hold, the import/remove/mute actions (settings keys `failed-sound`,
// `warning-sound`, `alert-sounds`, atomic save), playback once per shown alert (silent when muted
// or unset, a missing file skipped and traced) and the tray sound group (labels, order,
// visibility and the mute check re-read on open).
// Sources of truth: CielWin/CielWin.App/Alerts/{AlertSoundLibrary,MediaAlertSoundPlayer}.cs,
// CielWin/CielWin.App/AppComposition.cs (Toggle/Import/RemoveAlertSound), CielWin/CielWin.App/
// Tray/{TrayIconHost,TrayMenuController}.cs and their tests (AlertSoundLibraryTests,
// MediaAlertSoundPlayerTests, AlertSoundImportWiringTests, TrayIconHostTests).
// No test makes a sound: playback decisions run against a fake output, and the one real
// QtMultimedia check plays an undecodable file with every audio server unreachable.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, SRC, ASSETS, source } from './paths.mjs';

const read = name => readFileSync(source(name), 'utf8');
let binary, fixture;

const harnessEnv = () => {
    const env = { ...process.env, QT_QPA_PLATFORM: 'offscreen', QT_FORCE_STDERR_LOGGING: '1' };
    delete env.WAYLAND_DISPLAY;
    delete env.QT_QPA_PLATFORMTHEME;
    env.XDG_CONFIG_HOME = join(fixture, 'config');
    env.XDG_DATA_HOME = join(fixture, 'data');
    env.XDG_STATE_HOME = join(fixture, 'state');
    env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent';
    // No audio server is reachable: nothing can be heard even if a decoder accepted the file.
    env.PIPEWIRE_REMOTE = join(fixture, 'no-pipewire');
    env.PULSE_SERVER = `unix:${join(fixture, 'no-pulse')}`;
    env.QT_MEDIA_BACKEND = 'ffmpeg';
    return env;
};

const run = (args) => {
    const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 60000, env: harnessEnv(), cwd: fixture });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
};

after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

before(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cielinux-a5-contract.'));
    binary = join(fixture, 'build', 'sounds-contract');
    writeFileSync(join(fixture, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(SoundsContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets DBus Multimedia)
add_executable(sounds-contract harness.cpp "${SRC}/alert-sounds.cpp" "${SRC}/alert-sounds.h"
    "${SRC}/settings.cpp" "${SRC}/settings.h" "${SRC}/tray.cpp" "${SRC}/tray.h"
    "${SRC}/scene-host.cpp" "${SRC}/scene-host.h")
qt_add_resources(sounds-contract "assets" PREFIX "/" BASE "${ASSETS}" FILES "${ASSETS}/raphael-mini.ico")
target_include_directories(sounds-contract PRIVATE "${SRC}")
target_link_libraries(sounds-contract PRIVATE Qt6::Core Qt6::Gui Qt6::Widgets Qt6::DBus Qt6::Multimedia)
`);
    writeFileSync(join(fixture, 'harness.cpp'), String.raw`
#include "alert-sounds.h"
#include "scene-host.h"
#include "settings.h"
#include "tray.h"
#include <QAction>
#include <QApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QMenu>
#include <QThread>
#include <iostream>
#include <memory>
#define CHECK(x) do { if (!(x)) { std::cerr << "CHECK " << __LINE__ << ": " #x "\n"; return 3; } } while (false)

static bool write(const QString &path, const QByteArray &bytes) {
    QDir().mkpath(QFileInfo(path).absolutePath());
    QFile file(path);
    return file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size();
}
static QByteArray slurp(const QString &path) {
    QFile file(path);
    return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray("<missing>");
}
static QStringList entries(const QString &dir) {
    return QDir(dir).entryList(QDir::Files | QDir::Hidden | QDir::System, QDir::Name);
}

// Records what would have been played; never touches audio.
struct FakeOutput final : AlertSoundOutput {
    QStringList *played;
    explicit FakeOutput(QStringList *log) : played(log) {}
    void play(const QString &path) override { played->append(path); }
};

static int library(const QString &root) {
    using namespace AlertSoundLibrary;
    CHECK(extensions() == QStringList({".wav", ".mp3", ".m4a"}));
    CHECK(fileDialogFilter() == "Sound files (*.wav *.mp3 *.m4a)");
    CHECK(resolveDirectory("/xdg/data", "/home/u") == "/xdg/data/cielinux/sounds");
    CHECK(resolveDirectory("relative", "/home/u") == "/home/u/.local/share/cielinux/sounds");
    CHECK(resolveDirectory("", "/home/u") == "/home/u/.local/share/cielinux/sounds");
    CHECK(resolveDirectory() == qEnvironmentVariable("XDG_DATA_HOME") + "/cielinux/sounds");
    CHECK(isSupported("/a/b.WAV") && isSupported("x.mp3") && isSupported("x.M4a"));
    CHECK(!isSupported("x.ogg") && !isSupported("wav") && !isSupported("x.wav.txt"));
    CHECK(isSoundFileName("failed.wav") && isSoundFileName("warning.m4a"));
    for (const char *bad : {"", ".wav", "a/failed.wav", "../failed.wav", "/abs/failed.wav", "failed.ogg", "failed"})
        CHECK(!isSoundFileName(QString::fromUtf8(bad)));
    CHECK(kindName(true) == "failed" && kindName(false) == "warning");

    const QString dir = root + "/lib/sounds";
    SoundLibrary lib(dir);
    CHECK(lib.directory() == dir && lib.pathOf("failed.wav") == dir + "/failed.wav");
    QString error;
    // Removing with no folder yet is fine.
    CHECK(lib.remove("failed", &error) && !QFileInfo::exists(dir));
    // Unsupported formats and non-files are refused before anything is created.
    CHECK(write(root + "/in/song.ogg", "OGG"));
    CHECK(lib.importSound("failed", root + "/in/song.ogg", &error).isEmpty() && error == "unsupported-format");
    CHECK(!QFileInfo::exists(dir));
    QDir().mkpath(root + "/in/folder.wav");
    CHECK(lib.importSound("failed", root + "/in/folder.wav", &error).isEmpty() && error == "not-a-file");
    CHECK(lib.importSound("failed", root + "/in/missing.wav", &error).isEmpty() && error == "not-a-file");
    // A copy named for the kind, extension lowercased; the original is untouched.
    CHECK(write(root + "/in/Beep.WAV", "RIFF-one"));
    CHECK(lib.importSound("failed", root + "/in/Beep.WAV", &error) == "failed.wav");
    CHECK(slurp(dir + "/failed.wav") == "RIFF-one" && slurp(root + "/in/Beep.WAV") == "RIFF-one");
    // Re-import of another format replaces the previous sound whatever its extension.
    CHECK(write(root + "/in/tone.mp3", "ID3-two"));
    CHECK(lib.importSound("failed", root + "/in/tone.mp3", &error) == "failed.mp3");
    CHECK(entries(dir) == QStringList({"failed.mp3"}));
    // Same format replaces in place; kinds are independent.
    CHECK(write(root + "/in/other.mp3", "ID3-three"));
    CHECK(lib.importSound("failed", root + "/in/other.mp3", &error) == "failed.mp3");
    CHECK(slurp(dir + "/failed.mp3") == "ID3-three");
    CHECK(write(root + "/in/w.m4a", "M4A"));
    CHECK(lib.importSound("warning", root + "/in/w.m4a", &error) == "warning.m4a");
    CHECK(entries(dir) == QStringList({"failed.mp3", "warning.m4a"}));
    // Picking the imported copy itself keeps it.
    CHECK(lib.importSound("failed", dir + "/failed.mp3", &error) == "failed.mp3");
    CHECK(slurp(dir + "/failed.mp3") == "ID3-three" && entries(dir).size() == 2);
    // Remove deletes every extension of that kind only.
    CHECK(write(dir + "/warning.wav", "stale"));
    CHECK(lib.remove("warning", &error));
    CHECK(entries(dir) == QStringList({"failed.mp3"}));
    std::cout << "LIBRARY_OK\n";
    return 0;
}

static int controller(const QString &root) {
    const QString settingsPath = root + "/config/cielinux/settings.conf";
    const QString dir = root + "/data/cielinux/sounds";
    Settings settings;
    int saves = 0;
    QStringList traces, played, picks;
    QString pick;
    int outputs = 0;
    AlertSounds sounds(settings, [&] { ++saves; SettingsFile::save(settingsPath, settings); },
        SoundLibrary(dir), [&](const QString &kind) { picks << kind; return pick; },
        [&]() -> std::unique_ptr<AlertSoundOutput> { ++outputs; return std::make_unique<FakeOutput>(&played); },
        [&](const QString &line) { traces << line; });

    // Fresh: on, nothing imported, every alert silent.
    CHECK(sounds.enabled() && !sounds.hasSound("failed") && !sounds.hasSound("warning"));
    sounds.onAlertShown("failed");
    sounds.onAlertShown("warning");
    CHECK(played.isEmpty() && traces.isEmpty() && outputs == 0);

    // A cancelled dialog changes nothing.
    sounds.importSound("failed");
    CHECK(picks == QStringList({"failed"}) && saves == 0 && traces.isEmpty());
    // An unsupported pick is rejected with a reason code, never a path.
    CHECK(write(root + "/in/x.ogg", "OGG"));
    pick = root + "/in/x.ogg";
    sounds.importSound("failed");
    CHECK(saves == 0 && traces.last() == "alert-sound import-rejected kind=failed reason=unsupported-format");

    // Import: copied into the sounds folder, the bare name persisted atomically.
    CHECK(write(root + "/in/alarm.wav", "RIFF"));
    pick = root + "/in/alarm.wav";
    sounds.importSound("failed");
    CHECK(traces.last() == "alert-sound imported kind=failed" && saves == 1);
    CHECK(settings.failedSound == "failed.wav" && sounds.hasSound("failed") && !sounds.hasSound("warning"));
    CHECK(Settings::parse(QString::fromUtf8(slurp(settingsPath))).failedSound == "failed.wav");
    CHECK(slurp(dir + "/failed.wav") == "RIFF");
    CHECK(entries(root + "/config/cielinux") == QStringList({"settings.conf"})); // no temp left

    // Playback: once per call, the file inside the sounds folder; no fallback across kinds.
    sounds.onAlertShown("failed");
    CHECK(played == QStringList({dir + "/failed.wav"}) && traces.last() == "alert sound-played kind=failed");
    sounds.onAlertShown("warning");
    CHECK(played.size() == 1);
    sounds.onAlertShown("failed");
    CHECK(played.size() == 2 && outputs == 1); // one output per kind for the process
    // H4: a held warning's repeat is silent without a sound for its kind.
    sounds.onAlertRepeated("warning");
    CHECK(played.size() == 2);

    // Mute: persisted as alert-sounds = off; shown alerts stay silent.
    sounds.toggle();
    CHECK(!sounds.enabled() && saves == 2 && traces.last() == "alert-sounds toggled enabled=off");
    CHECK(slurp(settingsPath).contains("alert-sounds = off"));
    sounds.onAlertShown("failed");
    CHECK(played.size() == 2 && traces.last() == "alert sound-muted kind=failed");
    // H4: a repeat while muted is silent and not traced (it comes every 5 s).
    const qsizetype tracesBefore = traces.size();
    sounds.onAlertRepeated("failed");
    CHECK(played.size() == 2 && traces.size() == tracesBefore);
    sounds.toggle();
    CHECK(sounds.enabled() && slurp(settingsPath).contains("alert-sounds = on"));
    // H4: unmuted, a repeat plays the kind's sound like a shown alert.
    sounds.onAlertRepeated("failed");
    CHECK(played.size() == 3 && traces.last() == "alert sound-played kind=failed");

    // A missing file is skipped and traced, no crash.
    QFile::remove(dir + "/failed.wav");
    sounds.onAlertShown("failed");
    CHECK(played.size() == 3 && traces.last() == "alert sound-skipped kind=failed reason=missing-file");
    // A symlink planted in the folder is never followed outside it.
    CHECK(QFile::link(root + "/in/alarm.wav", dir + "/failed.wav"));
    sounds.onAlertShown("failed");
    CHECK(played.size() == 3 && traces.last() == "alert sound-skipped kind=failed reason=missing-file");
    QFile::remove(dir + "/failed.wav");
    // A hand-edited value can never reach outside the folder (settings drop it on read).
    CHECK(Settings::parse("failed-sound = ../../in/alarm.wav\n").failedSound.isEmpty());

    // Remove: file deleted, key cleared, saved.
    CHECK(write(dir + "/failed.wav", "RIFF"));
    sounds.removeSound("failed");
    CHECK(traces.last() == "alert-sound removed kind=failed" && settings.failedSound.isEmpty());
    CHECK(!QFileInfo::exists(dir + "/failed.wav") && !sounds.hasSound("failed"));
    CHECK(slurp(settingsPath).contains("failed-sound = \n") || slurp(settingsPath).endsWith("failed-sound = "));

    // Tray controls go to the same actions.
    const TraySounds controls = sounds.trayControls();
    CHECK(write(root + "/in/w.mp3", "ID3"));
    pick = root + "/in/w.mp3";
    controls.importSound("warning");
    CHECK(settings.warningSound == "warning.mp3" && controls.hasSound("warning") && !controls.hasSound("failed"));
    controls.toggle();
    CHECK(!controls.enabled());
    controls.removeSound("warning");
    CHECK(settings.warningSound.isEmpty() && entries(dir).isEmpty());
    std::cout << "CONTROLLER_OK\n";
    return 0;
}

static QAction *byText(QMenu *menu, const QString &text) {
    for (QAction *action : menu->actions()) if (action->text() == text) return action;
    return nullptr;
}

static int tray() {
    SceneHost host("idle", "scene-mini", [](const QUrl &) { return true; }, [](const QString &, const QString &) {});
    bool enabled = true;
    QStringList has, calls;
    TraySounds controls{
        [&] { return enabled; },
        [&] { calls << "toggle"; enabled = !enabled; },
        [&](const QString &kind) { return has.contains(kind); },
        [&](const QString &kind) { calls << "import " + kind; },
        [&](const QString &kind) { calls << "remove " + kind; }};
    int exits = 0;
    Tray tray(host, [&] { ++exits; }, controls);
    const QList<QAction *> root = tray.menu()->actions();
    QStringList layout;
    for (QAction *action : root) layout << (action->isSeparator() ? QString("---") : action->text());
    // CielWin MenuOrder: Scene Mode, Scene, separator, sound group, separator, Exit.
    CHECK(layout == QStringList({"Scene Mode", "Scene", "Frame rate", "---", QString::fromUtf8("Import failed sound…"),
        QString::fromUtf8("Import warning sound…"), "Remove failed sound", "Remove warning sound",
        "Alert sounds", "---", "Exit"}));
    QMenu *menu = tray.menu();
    QAction *importFailed = byText(menu, QString::fromUtf8("Import failed sound…"));
    QAction *importWarning = byText(menu, QString::fromUtf8("Import warning sound…"));
    QAction *removeFailed = byText(menu, "Remove failed sound");
    QAction *removeWarning = byText(menu, "Remove warning sound");
    QAction *mute = byText(menu, "Alert sounds");
    CHECK(!importFailed->isCheckable() && !removeFailed->isCheckable() && mute->isCheckable());
    // Nothing imported: removes and the toggle are hidden; imports always shown.
    CHECK(importFailed->isVisible() && importWarning->isVisible());
    CHECK(!removeFailed->isVisible() && !removeWarning->isVisible() && !mute->isVisible());
    // Re-read when the menu opens.
    has << "warning";
    emit menu->aboutToShow();
    CHECK(!removeFailed->isVisible() && removeWarning->isVisible() && mute->isVisible() && mute->isChecked());
    enabled = false;
    emit menu->aboutToShow();
    CHECK(!mute->isChecked());
    // Clicks forward to the controls; the toggle's check follows the controls, not Qt.
    mute->trigger();
    CHECK(calls == QStringList({"toggle"}) && enabled && mute->isChecked());
    importFailed->trigger();
    importWarning->trigger();
    removeWarning->trigger();
    CHECK(calls == QStringList({"toggle", "import failed", "import warning", "remove warning"}));
    // A throwing action is contained and logged with the item only.
    TraySounds throwing = controls;
    throwing.importSound = [](const QString &) { throw 1; };
    Tray guardedTray(host, [] {}, throwing);
    byText(guardedTray.menu(), QString::fromUtf8("Import failed sound…"))->trigger();
    CHECK(exits == 0);
    std::cout << "TRAY_SOUNDS_OK\n";
    return 0;
}

// Real QtMultimedia output on an undecodable file: one media-failed trace, no crash, no sound.
static int media(const QString &root) {
    const QString dir = root + "/media/sounds";
    CHECK(write(dir + "/failed.wav", QByteArray("not a sound at all ").repeated(64)));
    QStringList traces;
    AlertSoundPlayer player([&](const QString &kind) { return kind == "failed" ? dir + "/failed.wav" : QString(); },
        createMediaOutput, [&](const QString &line) { traces << line; });
    player.play("failed");
    QElapsedTimer waited;
    waited.start();
    while (traces.filter("sound-failed").isEmpty() && waited.elapsed() < 10000) {
        QCoreApplication::processEvents(QEventLoop::AllEvents, 50);
        QThread::msleep(10);
    }
    for (int i = 0; i < 50; ++i) { QCoreApplication::processEvents(QEventLoop::AllEvents, 10); QThread::msleep(10); }
    CHECK(traces.filter("sound-failed").size() == 1);
    CHECK(traces.filter("sound-failed").first().startsWith("alert sound-failed kind=failed reason=media-failed error="));
    CHECK(!traces.join('\n').contains(root)); // never a path
    std::cout << "MEDIA_OK\n";
    return 0;
}

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    const QString mode = argc > 1 ? QString::fromUtf8(argv[1]) : QString();
    const QString root = QDir::currentPath();
    if (mode == "library") return library(root);
    if (mode == "controller") return controller(root);
    if (mode == "tray") return tray();
    if (mode == "media") return media(root);
    return 2;
}
`);
    for (const args of [['-S', fixture, '-B', join(fixture, 'build')], ['--build', join(fixture, 'build'), '-j2']]) {
        const result = spawnSync('cmake', args, { encoding: 'utf8', timeout: 180000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
});

test('sound library: kind-named copies, .wav/.mp3/.m4a only, replace across extensions, remove (CielWin AlertSoundLibrary)', () => {
    assert.equal(run(['library']).stdout, 'LIBRARY_OK\n');
});

test('sound actions: import/remove/mute persist settings keys atomically; playback once per shown alert, silent when muted/unset/missing', () => {
    assert.equal(run(['controller']).stdout, 'CONTROLLER_OK\n');
});

test('tray sound group: CielWin labels and order, removes/toggle shown only with a sound, mute check re-read on open', () => {
    const result = run(['tray']);
    assert.equal(result.stdout, 'TRAY_SOUNDS_OK\n');
    assert.match(result.stderr, /CIELINUX_TRAY click-failed item=import-failed-sound/);
});

test('QtMultimedia output: an undecodable file traces media-failed once and the host keeps running', () => {
    assert.equal(run(['media']).stdout, 'MEDIA_OK\n');
});

test('host wiring: alertShown plays through AlertSounds; tray gets its controls; build and README', () => {
    const cpp = read('main.cpp');
    const main = cpp.slice(cpp.indexOf('int main('));
    assert.match(cpp, /#include "alert-sounds\.h"/);
    assert.match(main, /AlertSounds alertSounds\(stored\.settings,/);
    assert.match(main, /SoundLibrary\(AlertSoundLibrary::resolveDirectory\(\)\)/);
    assert.match(main, /AlertSounds::pickWithDialog/);
    assert.match(main, /createMediaOutput/);
    assert.ok(main.indexOf('AlertSounds alertSounds(') < main.indexOf('Tray tray(sceneHost'));
    assert.match(main, /alertSounds\.trayControls\(\)\);/);
    assert.match(main, /QObject::connect\(&alertDriver, &AlertDriver::alertShown, &alertSounds, &AlertSounds::onAlertShown\);/);
    assert.match(main, /QObject::connect\(&alertDriver, &AlertDriver::alertRepeated, &alertSounds, &AlertSounds::onAlertRepeated\);/);
    const sounds = read('alert-sounds.cpp');
    assert.match(sounds, /QMediaPlayer/);
    assert.match(sounds, /QAudioOutput/);
    assert.match(sounds, /QFileDialog/);
    // Logs carry reason codes and kinds, never paths.
    assert.doesNotMatch(sounds, /qPrintable\((path|source|target)/);
    const cmake = read('CMakeLists.txt');
    assert.match(cmake, /find_package\(Qt6 REQUIRED COMPONENTS [^)]*\bMultimedia\b/);
    assert.match(cmake, /qt_add_executable\(cielinux [^)]*src\/alert-sounds\.cpp\)/);
    assert.match(cmake, /target_link_libraries\(cielinux PRIVATE [^)]*Qt6::Multimedia/);
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /## Sounds/);
    assert.match(readme, /qt6-multimedia/);
    assert.ok(ASSETS && SRC);
});
