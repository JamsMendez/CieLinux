// A2 tray (stage 1): Scene submenu + Exit, CielWin labels and order, checks re-read
// on open, scene switches through SceneHost. The menu runs as a real QtWidgets
// harness on the offscreen platform, compiled from the shipped sources.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROOT, SRC, ASSETS, source } from './paths.mjs';

const read = name => readFileSync(source(name), 'utf8');
const RAPHAEL_MINI_ICO_SHA256 = 'd4dcf57fb176faf2b40ccbfa30ad17364f41ec4ce718d4c72978c85e7b5e5574';
let binary, fixture;

const run = (program, args, env = process.env) => {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120000, env });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
};

after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

before(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cielinux-a2-contract.'));
    binary = join(fixture, 'build', 'tray-contract');
    writeFileSync(join(fixture, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(TrayContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Gui GuiPrivate Widgets DBus)
add_executable(tray-contract harness.cpp "${SRC}/tray.cpp" "${SRC}/tray.h"
    "${SRC}/scene-host.cpp" "${SRC}/scene-host.h")
qt_add_resources(tray-contract "assets" PREFIX "/" BASE "${ASSETS}" FILES "${ASSETS}/raphael-mini.ico")
target_include_directories(tray-contract PRIVATE "${SRC}")
target_link_libraries(tray-contract PRIVATE Qt6::Core Qt6::Gui Qt6::Widgets Qt6::DBus)
# Late tray host (A7 prep): the same Tray, a fake StatusNotifierWatcher, and a test-only
# platform theme that gives the offscreen platform Qt's generic Unix (D-Bus) tray.
add_executable(tray-late harness-late.cpp "${SRC}/tray.cpp" "${SRC}/tray.h"
    "${SRC}/scene-host.cpp" "${SRC}/scene-host.h")
qt_add_resources(tray-late "assets" PREFIX "/" BASE "${ASSETS}" FILES "${ASSETS}/raphael-mini.ico")
target_include_directories(tray-late PRIVATE "${SRC}")
target_link_libraries(tray-late PRIVATE Qt6::Core Qt6::Gui Qt6::Widgets Qt6::DBus)
add_executable(fake-watcher fake-watcher.cpp)
target_link_libraries(fake-watcher PRIVATE Qt6::Core Qt6::DBus)
add_library(unixtraytheme MODULE unix-tray-theme.cpp)
target_link_libraries(unixtraytheme PRIVATE Qt6::Gui Qt6::GuiPrivate)
set_target_properties(unixtraytheme PROPERTIES LIBRARY_OUTPUT_DIRECTORY "\${CMAKE_BINARY_DIR}/plugins/platformthemes")
`);
    writeFileSync(join(fixture, 'unix-tray-theme.json'), '{ "Keys": [ "cielinux-unix-tray" ] }');
    writeFileSync(join(fixture, 'unix-tray-theme.cpp'), String.raw`
#include <qpa/qplatformthemeplugin.h>
#include <QtGui/private/qgenericunixtheme_p.h>
// Offscreen's own theme has no tray; Wayland sessions get this generic Unix theme,
// whose tray is the D-Bus StatusNotifierItem.
class UnixTrayTheme : public QPlatformThemePlugin {
    Q_OBJECT
    Q_PLUGIN_METADATA(IID QPlatformThemeFactoryInterface_iid FILE "unix-tray-theme.json")
public:
    QPlatformTheme *create(const QString &, const QStringList &) override { return new QGenericUnixTheme; }
};
#include "unix-tray-theme.moc"
`);
    writeFileSync(join(fixture, 'fake-watcher.cpp'), String.raw`
#include <QCoreApplication>
#include <QDBusConnection>
#include <QDBusMessage>
#include <QStringList>
#include <iostream>
// Holds org.kde.StatusNotifierWatcher on the private test bus and prints every item
// that registers with it.
class Watcher : public QObject {
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "org.kde.StatusNotifierWatcher")
    Q_PROPERTY(bool IsStatusNotifierHostRegistered READ hostRegistered)
    Q_PROPERTY(int ProtocolVersion READ protocolVersion)
    Q_PROPERTY(QStringList RegisteredStatusNotifierItems READ items)
public:
    bool hostRegistered() const { return true; }
    int protocolVersion() const { return 0; }
    QStringList items() const { return registered; }
public Q_SLOTS:
    void RegisterStatusNotifierItem(const QString &service, const QDBusMessage &message) {
        registered << service;
        std::cout << "REGISTERED " << service.toStdString() << " SENDER " << message.service().toStdString() << std::endl;
    }
    void RegisterStatusNotifierHost(const QString &) {}
private:
    QStringList registered;
};
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    Watcher watcher;
    QDBusConnection bus = QDBusConnection::sessionBus();
    if (!bus.registerObject("/StatusNotifierWatcher", &watcher,
                            QDBusConnection::ExportAllSlots | QDBusConnection::ExportAllProperties)
        || !bus.registerService("org.kde.StatusNotifierWatcher")) return 2;
    std::cout << "WATCHER_UP" << std::endl;
    return app.exec();
}
#include "fake-watcher.moc"
`);
    writeFileSync(join(fixture, 'harness-late.cpp'), String.raw`
#include "tray.h"
#include "scene-host.h"
#include <QApplication>
#include <iostream>
int main(int argc, char **argv) {
    QApplication app(argc, argv);
    SceneHost host("idle", "scene-mini", [](const QUrl &) { return true; },
                   [](const QString &, const QString &) {});
    TraySounds sounds;
    sounds.enabled = [] { return true; };
    sounds.hasSound = [](const QString &kind) { return kind == "failed"; };
    Tray tray(host, [] {}, sounds);
    // Menu state changes while no tray host is around must show up once one appears.
    host.setScene("raphael");
    host.setFps(60);
    std::cout << "LATE_READY shown=" << tray.shown() << std::endl;
    return app.exec();
}
`);
    writeFileSync(join(fixture, 'harness.cpp'), String.raw`
#include "tray.h"
#include "scene-host.h"
#include <QAction>
#include <QActionGroup>
#include <QApplication>
#include <QMenu>
#include <QSystemTrayIcon>
#include <iostream>
#define CHECK(x) do { if (!(x)) { std::cerr << "CHECK " << __LINE__ << ": " #x "\n"; return 3; } } while (false)

static QAction *sceneAction(QMenu *menu, const QString &label) {
    for (QAction *action : menu->actions()) if (action->text() == label) return action;
    return nullptr;
}
static QString checkedLabels(QMenu *menu) {
    QStringList out;
    for (QAction *action : menu->actions()) if (action->isChecked()) out << action->text();
    return out.join(',');
}

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    QStringList switched;
    int persisted = 0;
    bool allow = true;
    SceneHost host("idle", "scene-mini", [&](const QUrl &url) { switched << url.toString(); return allow; },
                   [&](const QString &, const QString &) { ++persisted; });
    int exits = 0;
    Tray tray(host, [&] { ++exits; });

    // Root order (CielWin MenuOrder): Scene Mode submenu (B1), Scene submenu,
    // separator, the A5 sound group (5 items, see sounds.contract.test.mjs), separator, Exit.
    const QList<QAction *> root = tray.menu()->actions();
    CHECK(root.size() == 11);
    CHECK(root[0]->text() == "Scene Mode" && root[0]->menu() && root[0]->isEnabled() && root[0]->isVisible());
    CHECK(root[1]->text() == "Scene" && root[1]->menu());
    CHECK(root[2]->text() == "Frame rate" && root[2]->menu());
    CHECK(root[3]->isSeparator());
    CHECK(root[9]->isSeparator());
    CHECK(root[10]->text() == "Exit" && !root[10]->isCheckable());
    QMenu *modes = root[0]->menu();
    QMenu *scenes = root[1]->menu();
    QStringList labels;
    for (QAction *action : scenes->actions()) {
        CHECK(action->isCheckable());
        CHECK(action->actionGroup() && action->actionGroup()->isExclusive());
        labels << action->text();
    }
    CHECK(labels == QStringList({"Processing", "Explorer", "Idle", "Raphael"}));
    CHECK(checkedLabels(scenes) == "Idle");

    // A click goes through SceneHost (mini URL, persist only after ready).
    sceneAction(scenes, "Raphael")->trigger();
    CHECK(host.scene() == "raphael");
    CHECK(switched == QStringList({"qrc:/raphael/index.html?variant=mini&fps=30"}));
    CHECK(persisted == 0);
    host.confirmReady();
    CHECK(persisted == 1);
    CHECK(checkedLabels(scenes) == "Raphael");

    // A refused switch leaves the current scene checked.
    allow = false;
    sceneAction(scenes, "Explorer")->trigger();
    CHECK(host.scene() == "raphael");
    CHECK(checkedLabels(scenes) == "Raphael");
    allow = true;

    // Re-selecting the current scene does not retarget.
    sceneAction(scenes, "Raphael")->trigger();
    CHECK(switched.size() == 2);

    // Checks are re-read from SceneHost when the menu opens (scene changed elsewhere).
    sceneAction(scenes, "Processing")->setChecked(true);
    CHECK(checkedLabels(scenes) == "Processing");
    emit tray.menu()->aboutToShow();
    CHECK(checkedLabels(scenes) == "Raphael");
    sceneAction(scenes, "Idle")->setChecked(true);
    emit scenes->aboutToShow();
    CHECK(checkedLabels(scenes) == "Raphael");
    host.setScene("explorer");
    CHECK(checkedLabels(scenes) == "Explorer");

    // B1: Scene Mode submenu (CielWin TrayIconHost.ModeLabel, TrayMenuController.Modes
    // order): exclusive checks re-read on open, every click through SceneHost::setMode.
    QStringList modeLabels;
    for (QAction *action : modes->actions()) {
        CHECK(action->isCheckable());
        CHECK(action->actionGroup() && action->actionGroup()->isExclusive());
        modeLabels << action->text();
    }
    CHECK(modeLabels == QStringList({"Scene Wallpaper", "Scene Mini"}));
    CHECK(checkedLabels(modes) == "Scene Mini");
    const int beforeModes = switched.size();
    sceneAction(modes, "Scene Wallpaper")->trigger();
    CHECK(host.mode() == "scene" && host.scene() == "explorer");
    CHECK(switched.size() == beforeModes + 1 && switched.last() == "qrc:/explorer/index.html?fps=30");
    CHECK(checkedLabels(modes) == "Scene Wallpaper");
    // A scene switch keeps the mode (full-size page, no mini variant).
    sceneAction(scenes, "Idle")->trigger();
    CHECK(host.mode() == "scene" && switched.last() == "qrc:/idle/index.html?fps=30");
    // Re-selecting the current mode does not retarget.
    sceneAction(modes, "Scene Wallpaper")->trigger();
    CHECK(switched.size() == beforeModes + 2);
    // A refused mode switch leaves the current mode checked.
    allow = false;
    sceneAction(modes, "Scene Mini")->trigger();
    CHECK(host.mode() == "scene" && checkedLabels(modes) == "Scene Wallpaper");
    allow = true;
    // Re-read when either menu opens.
    sceneAction(modes, "Scene Mini")->setChecked(true);
    emit modes->aboutToShow();
    CHECK(checkedLabels(modes) == "Scene Wallpaper");
    sceneAction(modes, "Scene Mini")->setChecked(true);
    emit tray.menu()->aboutToShow();
    CHECK(checkedLabels(modes) == "Scene Wallpaper");
    // Changed elsewhere: the checks follow SceneHost.
    CHECK(host.setMode("scene-mini"));
    CHECK(checkedLabels(modes) == "Scene Mini" && checkedLabels(scenes) == "Idle");
    CHECK(switched.last() == "qrc:/idle/index.html?variant=mini&fps=30");

    // Icon and tooltip; no tray host on offscreen -> not shown, logged once.
    // B4: CielWin's tray icon (the Raphael mini figure), every frame of its .ico: the tray-size
    // frames (16, 20, 24) carry CielWin's contrast pass, so they are used as drawn, not scaled.
    CHECK(!tray.icon().isNull() && !tray.icon().pixmap(22, 22).isNull());
    CHECK(tray.icon().availableSizes() == (QList<QSize>{{16, 16}, {20, 20}, {24, 24}, {32, 32}, {48, 48}, {256, 256}}));
    CHECK(tray.icon().pixmap(QSize(16, 16)).size() == QSize(16, 16));
    CHECK(tray.toolTip() == "CieLinux");
    CHECK(!QSystemTrayIcon::isSystemTrayAvailable());
    CHECK(!tray.shown());

    // Left click (Trigger) does nothing; Exit calls the quit path once.
    tray.activate(QSystemTrayIcon::Trigger);
    CHECK(exits == 0 && host.scene() == "idle");
    QMenu *rates = root[2]->menu();
    CHECK(rates->actions().size() == 2 && checkedLabels(rates) == "30 FPS");
    for (QAction *action : rates->actions())
        CHECK(action->isCheckable() && action->actionGroup()->isExclusive());
    sceneAction(rates, "60 FPS")->trigger();
    CHECK(host.fps() == 60 && checkedLabels(rates) == "60 FPS");
    allow = false;
    sceneAction(rates, "30 FPS")->trigger();
    CHECK(host.fps() == 60 && checkedLabels(rates) == "60 FPS");
    allow = true;
    sceneAction(rates, "30 FPS")->trigger();
    CHECK(host.fps() == 30 && checkedLabels(rates) == "30 FPS");
    const int beforeRateNoop = switched.size();
    sceneAction(rates, "30 FPS")->trigger();
    CHECK(switched.size() == beforeRateNoop);
    host.setFps(60);
    CHECK(checkedLabels(rates) == "60 FPS");
    sceneAction(rates, "30 FPS")->setChecked(true);
    emit rates->aboutToShow();
    CHECK(checkedLabels(rates) == "60 FPS");
    root[10]->trigger();
    CHECK(exits == 1);
    std::cout << "TRAY_OK";
    return 0;
}
`);
    for (const args of [['-S', fixture, '-B', join(fixture, 'build')], ['--build', join(fixture, 'build'), '-j2']]) {
        const result = run('cmake', args);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
});

test('tray menu: CielWin labels/order, mode + scene radio checks re-read on open, switches via SceneHost, Exit', () => {
    const env = { ...process.env, QT_QPA_PLATFORM: 'offscreen' };
    delete env.WAYLAND_DISPLAY;
    // Qt logs to the journal when stderr is not a terminal; keep it on stderr here.
    env.QT_FORCE_STDERR_LOGGING = '1';
    delete env.QT_QPA_PLATFORMTHEME;
    // Never reach the real session bus (and its tray host) from a test.
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(fixture, 'no-session-bus')}`;
    const result = run(binary, [], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'TRAY_OK');
    // Missing tray host: one log line, the host keeps running.
    assert.equal(result.stderr.match(/CIELINUX_TRAY unavailable/g)?.length, 1, result.stderr);
});

test('host wiring: QApplication, tray built after SceneHost, Exit closes normally', () => {
    const cpp = read('main.cpp');
    const main = cpp.slice(cpp.indexOf('int main('));
    assert.match(cpp, /#include <QApplication>/);
    assert.match(cpp, /#include "tray\.h"/);
    assert.doesNotMatch(main, /QGuiApplication app\(/);
    assert.ok(main.indexOf('QtWebEngineQuick::initialize()') < main.indexOf('QApplication app(argc, argv)'));
    assert.ok(main.indexOf('SceneHost sceneHost(') < main.indexOf('Tray tray(sceneHost'));
    assert.match(main, /Tray tray\(sceneHost, \[&\] \{\s*policy\.noteCloseReason\(Diagnostics::Reason::Normal\);\s*policy\.closeNormally\(\);\s*\}, alertSounds\.trayControls\(\)\);/); // A5 adds the sound controls
    assert.ok(main.indexOf('Tray tray(sceneHost') < main.indexOf('app.exec()'));
    const tray = read('tray.cpp');
    // Every scene switch goes through SceneHost; the tray builds no URL itself.
    assert.match(tray, /host\.setScene\(/);
    assert.match(tray, /host\.setMode\(/); // B1
    assert.doesNotMatch(tray, /qrc:\/(processing|explorer|idle|raphael)|retarget|interceptor/);
    assert.match(tray, /QStringLiteral\(":\/raphael-mini\.ico"\)/);
    assert.doesNotMatch(tray, /cielinux\.svg/);
    const cmake = read('CMakeLists.txt');
    assert.match(cmake, /find_package\(Qt6 REQUIRED COMPONENTS [^)]*\bWidgets\b/);
    assert.match(cmake, /qt_add_executable\(cielinux src\/main\.cpp src\/settings\.cpp src\/scene-host\.cpp src\/tray\.cpp src\/http-server\.cpp src\/http-token\.cpp src\/alerts\.cpp src\/alert-sounds\.cpp\)/); // A4 adds src/alerts.cpp, A5 src/alert-sounds.cpp
    assert.match(cmake, /qt_add_resources\(cielinux "assets" PREFIX "\/" BASE assets FILES assets\/raphael-mini\.ico\)/);
    assert.match(cmake, /target_link_libraries\(cielinux PRIVATE [^)]*Qt6::Widgets/);
    // B4: byte-identical to CielWin/CielWin.App/Assets/raphael-mini.ico (120cf29, rendered by
    // CielWin/tools/tray-icon/render-raphael-mini.mjs); checked against the sibling copy when present.
    const ico = readFileSync(join(ASSETS, 'raphael-mini.ico'));
    assert.equal(createHash('sha256').update(ico).digest('hex'), RAPHAEL_MINI_ICO_SHA256);
    const cielWinIco = join(ROOT, '..', 'CielWin', 'CielWin.App', 'Assets', 'raphael-mini.ico');
    if (existsSync(cielWinIco)) assert.ok(readFileSync(cielWinIco).equals(ico), 'differs from the CielWin icon');
    assert.ok(!existsSync(join(ASSETS, 'cielinux.svg')), 'the old placeholder icon is gone');
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /## Tray/);
    assert.match(readme, /raphael-mini\.ico/);
    assert.doesNotMatch(readme, /qt6-svg/);
});

// A7 prep: the tray host (Omarchy's quickshell owns org.kde.StatusNotifierWatcher) can
// start after CieLinux or restart under it. Everything runs on a private dbus-daemon
// with no service activation; the real session bus is never reached.
const started = [];
const startProcess = (program, args, env) => {
    const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const proc = { child, out: '', err: '', exited: null };
    child.stdout.on('data', data => { proc.out += data; });
    child.stderr.on('data', data => { proc.err += data; });
    proc.exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    started.push(proc);
    return proc;
};
const stop = async proc => { if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGTERM'); await proc.exited; };
const waitFor = async (predicate, what, proc) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\nstdout:${proc?.out}\nstderr:${proc?.err}`);
        await sleep(20);
    }
};
const count = (text, pattern) => text.match(pattern)?.length ?? 0;
after(async () => { for (const proc of started) await stop(proc); });

async function privateBus(name) {
    const config = join(fixture, `${name}.conf`);
    writeFileSync(config, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:path=${join(fixture, `${name}.socket`)}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>
`);
    const daemon = startProcess('dbus-daemon', ['--config-file', config, '--nofork', '--print-address=1'], { PATH: process.env.PATH });
    await waitFor(() => daemon.out.includes('\n'), 'dbus-daemon address', daemon);
    const env = { PATH: process.env.PATH, HOME: fixture, XDG_RUNTIME_DIR: fixture,
                  DBUS_SESSION_BUS_ADDRESS: daemon.out.trim().split('\n')[0],
                  LANG: 'C.UTF-8', QT_QPA_PLATFORM: 'offscreen', QT_FORCE_STDERR_LOGGING: '1',
                  QT_QPA_PLATFORMTHEME: 'cielinux-unix-tray', QT_PLUGIN_PATH: join(fixture, 'build', 'plugins') };
    return { daemon, env };
}

const watcher = env => {
    const proc = startProcess(join(fixture, 'build', 'fake-watcher'), [], env);
    return proc;
};

// The registered item's menu as the tray host reads it (com.canonical.dbusmenu).
function menuLayout(env, registration) {
    const service = registration.service.startsWith('/') ? registration.sender : registration.service.split('/')[0];
    const gdbus = (...args) => {
        const result = run('gdbus', ['call', '--session', '--dest', service, ...args], env);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    };
    const menuPath = gdbus('--object-path', '/StatusNotifierItem', '--method', 'org.freedesktop.DBus.Properties.Get',
                           'org.kde.StatusNotifierItem', 'Menu').match(/objectpath '([^']+)'/)[1];
    return gdbus('--object-path', menuPath, '--method', 'com.canonical.dbusmenu.GetLayout', '--', '0', '-1', '[]');
}
function iconPixmap(env, registration) {
    const service = registration.service.startsWith('/') ? registration.sender : registration.service.split('/')[0];
    const result = run('gdbus', ['call', '--session', '--dest', service, '--object-path', '/StatusNotifierItem',
                                 '--method', 'org.freedesktop.DBus.Properties.Get', 'org.kde.StatusNotifierItem', 'IconPixmap'], env);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}
const item = (layout, label) => layout.match(new RegExp(`\\{[^{}]*'label': <'${label}'>[^{}]*\\}`))?.[0] ?? '';
const registrations = proc => [...proc.out.matchAll(/REGISTERED (\S+) SENDER (\S+)/g)].map(m => ({ service: m[1], sender: m[2] }));

function assertMenuState(layout) {
    assert.match(item(layout, '60 FPS'), /'toggle-state': <1>/, layout);
    assert.match(item(layout, '30 FPS'), /'toggle-state': <0>/, layout);
    // Scene radio follows SceneHost (switched to Raphael while no host was around).
    assert.match(item(layout, 'Raphael'), /'toggle-state': <1>/, layout);
    assert.match(item(layout, 'Idle'), /'toggle-state': <0>/, layout);
    // B1: Scene Mode radio follows SceneHost (the harness runs in the mini).
    assert.match(item(layout, 'Scene Mini'), /'toggle-state': <1>/, layout);
    assert.match(item(layout, 'Scene Wallpaper'), /'toggle-state': <0>/, layout);
    assert.doesNotMatch(item(layout, 'Scene Wallpaper'), /'visible': <false>|'enabled': <false>/, layout);
    // Sound items: only the kind that has a sound shows its remove entry.
    assert.ok(item(layout, 'Remove failed sound'), layout);
    assert.doesNotMatch(item(layout, 'Remove failed sound'), /'visible': <false>/, layout);
    assert.match(item(layout, 'Remove warning sound'), /'visible': <false>/, layout);
    assert.match(item(layout, 'Alert sounds'), /'toggle-state': <1>/, layout);
    assert.ok(item(layout, 'Exit'), layout);
}

test('late tray host: the icon registers when the watcher appears, and again after it restarts', async () => {
    const { daemon, env } = await privateBus('late-bus');
    const app = startProcess(join(fixture, 'build', 'tray-late'), [], env);
    await waitFor(() => app.out.includes('LATE_READY'), 'harness start', app);
    assert.match(app.out, /LATE_READY shown=0/);
    await waitFor(() => count(app.err, /CIELINUX_TRAY unavailable/g) === 1, 'startup unavailable log', app);

    // The tray host starts after CieLinux.
    const first = watcher(env);
    await waitFor(() => registrations(first).length > 0, 'first registration', first);
    await waitFor(() => count(app.err, /CIELINUX_TRAY recreated/g) === 1, 'recreated log', app);
    assertMenuState(menuLayout(env, registrations(first)[0]));

    // The tray host restarts: it vanishes, then a new one appears.
    await stop(first);
    await waitFor(() => count(app.err, /CIELINUX_TRAY unavailable/g) === 2, 'vanish log', app);
    const second = watcher(env);
    await waitFor(() => registrations(second).length > 0, 'second registration', second);
    await waitFor(() => count(app.err, /CIELINUX_TRAY recreated/g) === 2, 'second recreated log', app);
    assertMenuState(menuLayout(env, registrations(second)[0]));

    await sleep(300);
    // The app goes first, so the second host's exit is not a transition it sees.
    await stop(app);
    await stop(second);
    await stop(daemon);
    // One line per transition, nothing else from the tray.
    assert.equal(count(app.err, /CIELINUX_TRAY /g), 4, app.err);
    assert.equal(count(app.err, /CIELINUX_TRAY available/g), 0, app.err);
});

test('tray host already up: one available log and the icon registers once', async () => {
    const { daemon, env } = await privateBus('early-bus');
    const host = watcher(env);
    await waitFor(() => host.out.includes('WATCHER_UP'), 'watcher start', host);
    const app = startProcess(join(fixture, 'build', 'tray-late'), [], env);
    await waitFor(() => app.out.includes('LATE_READY'), 'harness start', app);
    assert.match(app.out, /LATE_READY shown=1/);
    await waitFor(() => registrations(host).length > 0, 'registration', host);
    assertMenuState(menuLayout(env, registrations(host)[0]));
    // B4: what Waybar receives: IconPixmap with the .ico's tray-size frames (Qt sends sizes
    // up to 64 px, adding 64 from the 256 frame) and no themed IconName.
    const sizes = [...iconPixmap(env, registrations(host)[0]).matchAll(/\((\d+), (\d+), (?:@ay )?\[(?:byte )?0x/g)].map(m => `${m[1]}x${m[2]}`);
    for (const size of ['16x16', '20x20', '24x24', '32x32', '48x48']) assert.ok(sizes.includes(size), `${size} in ${sizes}`);
    assert.ok(sizes.every(size => Number(size.split('x')[0]) <= 64), String(sizes));
    await sleep(300);
    await stop(app);
    await stop(host);
    await stop(daemon);
    assert.equal(count(app.err, /CIELINUX_TRAY /g), 1, app.err);
    assert.equal(count(app.err, /CIELINUX_TRAY available/g), 1, app.err);
});
