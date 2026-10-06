#include "diagnostics.h"
#include "log-routing.h"
#include "resident-control.h"
#include "output-policy.h"
#include <QApplication>
#include "policy.h"
#include "scene-host.h"
#include "settings.h"
#include "tray.h"
#include "http-server.h"
#include "http-token.h"
#include "alerts.h"
#include "alert-bridge.h"
#include "alert-sounds.h"
#include "mini-dodge.h"
#include "mini-position.h"
#include "instance-control.h"
#include "fullscreen-watch.h"
#include <QPointer>
#include <QVariantMap>
#include <QElapsedTimer>
#include <QQuickView>
#include <QColor>
#include <QScreen>
#include <QTimer>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>
#include <QQuickWebEngineProfile>
#include <QQuickWebEngineDownloadRequest>
#include <QWebEngineUrlRequestInterceptor>
#include <QWebEngineUrlRequestInfo>
#include <LayerShellQt/Window>
#include <wayland-client.h>
#include <cstring>
#include <iostream>
#include <memory>

// Browser resources and top-level navigation are deliberately separate policies.
static const QList<QByteArray> resourceUrls = {
    "qrc:/processing/index.html", "qrc:/processing/styles.css",
    "qrc:/processing/js/config.js", "qrc:/processing/js/math.js",
    "qrc:/processing/js/nebula.js", "qrc:/processing/js/sphere.js",
    "qrc:/processing/js/scene-data.js", "qrc:/processing/js/sprites.js",
    "qrc:/processing/js/layers.js", "qrc:/processing/js/see-through-hook.js",
    "qrc:/processing/js/render-loop.js",
    "qrc:/processing/js/main.js",
    "qrc:/raphael/index.html", "qrc:/raphael/styles.css",
    "qrc:/raphael/js/config.js", "qrc:/raphael/js/math.js",
    "qrc:/raphael/js/hexadecagon.js", "qrc:/raphael/js/nebula.js",
    "qrc:/raphael/js/sphere.js", "qrc:/raphael/js/scene-data.js",
    "qrc:/raphael/js/feathers.js", "qrc:/raphael/js/glyphs.js",
    "qrc:/raphael/js/glyph-rings.js", "qrc:/raphael/js/digits.js",
    "qrc:/raphael/js/central-core.js", "qrc:/raphael/js/sprites.js",
    "qrc:/raphael/js/layers.js", "qrc:/raphael/js/see-through-hook.js",
    "qrc:/raphael/js/render-loop.js",
    "qrc:/raphael/js/main.js",
    "qrc:/idle/index.html", "qrc:/idle/styles.css",
    "qrc:/idle/js/config.js", "qrc:/idle/js/math.js",
    "qrc:/idle/js/glyphs.js", "qrc:/idle/js/earth.js",
    "qrc:/idle/js/rings.js", "qrc:/idle/js/see-through-hook.js",
    "qrc:/idle/js/render-loop.js",
    "qrc:/idle/js/animate.js", "qrc:/idle/js/main.js",
    "qrc:/explorer/index.html", "qrc:/explorer/styles.css",
    "qrc:/explorer/js/config.js", "qrc:/explorer/js/math.js",
    "qrc:/explorer/js/glyphs.js", "qrc:/explorer/js/earth.js",
    "qrc:/explorer/js/rings.js", "qrc:/explorer/js/rising-sparks.js",
    "qrc:/explorer/js/see-through-hook.js",
    "qrc:/explorer/js/render-loop.js", "qrc:/explorer/js/animate.js",
    "qrc:/explorer/js/main.js",
    // A4: the alert overlay every scene page loads, and its bundled title face.
    "qrc:/shared/js/alert-overlay.js", "qrc:/shared/fonts/ArchivoBlack-Regular.ttf"
};

class LocalOnly final : public QWebEngineUrlRequestInterceptor {
public:
    explicit LocalOnly(const QUrl &selected) : selectedUrl(selected.toEncoded()) {}
    // Qt 6 runs interception on the UI thread, so a live switch may replace it.
    void select(const QUrl &selected) { selectedUrl = selected.toEncoded(); }
    void interceptRequest(QWebEngineUrlRequestInfo &request) override {
        const auto encoded = request.requestUrl().toEncoded();
        request.block(encoded != selectedUrl && !resourceUrls.contains(encoded));
    }
private:
    QByteArray selectedUrl;
};

// Probe only; do not create a surface on this connection. Qt owns the real role.
static bool hasLayerShell() {
    wl_display *display = wl_display_connect(nullptr);
    if (!display) return false;
    bool found = false;
    wl_registry *registry = wl_display_get_registry(display);
    static const wl_registry_listener listener = {
        [](void *data, wl_registry *, uint32_t, const char *name, uint32_t) {
            if (std::strcmp(name, "zwlr_layer_shell_v1") == 0)
                *static_cast<bool *>(data) = true;
        },
        [](void *, wl_registry *, uint32_t) {}
    };
    wl_registry_add_listener(registry, &listener, &found);
    const bool ok = wl_display_roundtrip(display) >= 0 && found;
    wl_registry_destroy(registry);
    wl_display_disconnect(display);
    return ok;
}

int main(int argc, char **argv) {
    LogRouting::toStderr();
    // No Qt application, platform connection or renderer is needed for help.
    if (argc == 2 && std::strcmp(argv[1], "--help") == 0) {
        std::cout << "CieLinux animated HTML scene host. Usage: " << argv[0]
                  << " [--output NAME] [--scene processing|explorer|idle|raphael] [--mode scene-mini|scene]"
                  << " [--duration 15|120] [--resident]\n"
                  << "       " << argv[0] << " --cycle-position next|prev\n"
                  << "Scene and mode default to settings.conf (scene, wallpaper-mode); flags win.\n"
                  << "Mode scene-mini (default) is the small overlay; scene is the full-screen animated wallpaper\n"
                  << "on the bottom layer. The tray's Wallpaper mode menu switches between them live.\n"
                  << "Duration defaults to 15 seconds; only 15 or 120 accepted.\n"
                  << "Resident omits the deadline; it cannot be paired with --duration.\n"
                  << "No Chromium or Qt override arguments accepted.\n"
                  << "--cycle-position moves the running instance's mini window to the next or previous\n"
                  << "of its eight positions (mini-position) and exits; it never starts a second instance.\n";
        return 0;
    }
    // A6 client mode: hand one command to the running instance over its per-user socket
    // ($XDG_RUNTIME_DIR/cielinux/control.sock) and exit. No Qt application, no Wayland.
    if (argc >= 2 && std::strcmp(argv[1], "--cycle-position") == 0) {
        if (argc != 3 || !InstanceControl::parseCommand(QByteArray(argv[2]))) {
            std::cerr << "Usage: cielinux --cycle-position next|prev\n";
            return 2;
        }
        const QString dir = InstanceControl::directory();
        if (dir.isEmpty()) {
            std::cerr << "XDG_RUNTIME_DIR is unset or not absolute; cannot reach CieLinux\n";
            return 1;
        }
        std::string message;
        const int code = InstanceControl::sendCycle(dir, QByteArray(argv[2]), message);
        if (!message.empty()) std::cerr << message << '\n';
        return code;
    }
    HostOptions options;
    if (!parseHostOptions(argc, argv, options)) {
        std::cerr << "Unsupported, missing or duplicate arguments\n";
        return 2;
    }
    // settings.conf supplies the scene and mode no flag gave (flags win). Read
    // before any Wayland or Qt side effect; an unreadable file is never rewritten.
    const QString settingsPath = SettingsFile::resolvePath();
    SettingsLoadResult stored = SettingsFile::loadOrCreate(settingsPath);
    if (!options.sceneGiven) options.scene = stored.settings.scene;
    if (!options.modeGiven) options.mode = stored.settings.wallpaperMode;
    options.mode = effectiveMode(options.scene, options.mode);
    const QString &output = options.output, &scene = options.scene, &mode = options.mode;
    // The initial target; live switches go through sceneHost below.
    const QUrl sceneUrl(sceneUrlFor(scene, mode, stored.settings.frameRate));
    // Reject inherited Chromium overrides, even apparently harmless ones: this
    // host has one auditable policy and never disables the sandbox.
    for (const char *name : {"QTWEBENGINE_DISABLE_SANDBOX", "QTWEBENGINE_CHROMIUM_FLAGS",
                             "QTWEBENGINE_REMOTE_DEBUGGING"}) {
        if (qEnvironmentVariableIsSet(name)) {
            std::cerr << "Rejected inherited " << name << '\n';
            return 2;
        }
    }
    // One instance per user (CielWin SingleInstanceGuard): decided by a non-blocking lock
    // before any Wayland or Qt work. Without XDG_RUNTIME_DIR it runs unguarded, logged.
    InstanceServer instance(InstanceControl::directory(), [](const QString &line) {
        std::cerr << line.toStdString() << '\n';
    });
    if (instance.acquire() == InstanceServer::Start::AlreadyRunning) {
        std::cerr << "CieLinux is already running for this user (" << instance.socketPath().toStdString()
                  << "); use cielinux --cycle-position next|prev to control it\n";
        return 3;
    }
    if (qEnvironmentVariableIsEmpty("WAYLAND_DISPLAY") || !hasLayerShell()) {
        std::cerr << "Wayland with zwlr_layer_shell_v1 required\n";
        return 2;
    }
    auto pendingControl = std::make_unique<ResidentControl>();
    if (!pendingControl->valid()) { std::cerr << "Stop control unavailable\n"; return 2; }
    Diagnostics::Sink startupDiagnostics;
    startupDiagnostics.startup();
    // Process-local selection; no shell or desktop configuration is changed.
    qputenv("QT_QPA_PLATFORM", "wayland");
    qputenv("QT_WAYLAND_SHELL_INTEGRATION", "layer-shell");
    QtWebEngineQuick::initialize();
    // QApplication (not QGuiApplication): QSystemTrayIcon and its QMenu are QtWidgets.
    QApplication app(argc, argv);
    auto control = std::move(pendingControl); // Retire notifier before the application.
    app.setQuitOnLastWindowClosed(false);
    if (app.platformName() != QStringLiteral("wayland")) return 2;
    QScreen *screen = OutputPolicy::select(app.screens(), output.isEmpty(),
        [&](QScreen *candidate) { return candidate->name() == output; });
    if (!screen) { qCritical("Selected output unavailable"); return 2; }
    qInfo() << "Output" << screen->name() << "DPR" << screen->devicePixelRatio();

    LocalOnly interceptor(sceneUrl);
    // Resident hosts renew recovery over a rolling monotonic hour; timed hosts
    // keep one reconstruction per lifetime. Configured before any incident source.
    QElapsedTimer recoveryClock;
    recoveryClock.start();
    Policy policy(sceneUrl);
    policy.lifecycleDiagnostics().enable();
    if (options.resident && !policy.setRecoveryBudget(3, 3600000,
            [&recoveryClock] { return recoveryClock.elapsed(); })) {
        qCritical("Recovery budget unavailable");
        return 2;
    }
    // Internal control surface for the tray (A2) and HTTP server (A3). A switch
    // updates both URL gates, then replaces the attachment as a new generation;
    // the shown target is persisted only once that generation is ready.
    SceneHost sceneHost(scene, mode, stored.settings.frameRate, [&](const QUrl &url) {
        interceptor.select(url);
        return policy.retarget(url);
    }, [&](const QString &shownScene, const QString &shownMode, int shownFps) {
        stored.settings.scene = shownScene;
        stored.settings.wallpaperMode = shownMode;
        stored.settings.frameRate = shownFps;
        if (stored.canSave()) SettingsFile::save(settingsPath, stored.settings);
    });
    QObject::connect(&policy, &Policy::readyChanged, &sceneHost, [&] {
        if (policy.ready()) sceneHost.confirmReady();
    });
    // Alert sounds (A5): imported per kind into $XDG_DATA_HOME/cielinux/sounds, keys
    // failed-sound / warning-sound / alert-sounds in the same Settings object SceneHost
    // persists, played through QtMultimedia once per newly shown alert.
    AlertSounds alertSounds(stored.settings, [&] {
        if (stored.canSave() && !SettingsFile::save(settingsPath, stored.settings))
            qWarning("CIELINUX_SOUND settings save-failed");
    }, SoundLibrary(AlertSoundLibrary::resolveDirectory()), &AlertSounds::pickWithDialog, createMediaOutput,
        [](const QString &line) { qInfo("CIELINUX_SOUND %s", qPrintable(line)); });
    // Tray (A2, B1): Wallpaper mode ▸ calls sceneHost.setMode, Scene ▸ sceneHost.setScene; Exit
    // takes the normal close path.
    Tray tray(sceneHost, [&] {
        policy.noteCloseReason(Diagnostics::Reason::Normal);
        policy.closeNormally();
    }, alertSounds.trayControls());
    // Alerts (A4, B2): one queue and driver for the host (CielWin AlertDriver); the scene page draws
    // them through the bridge (src/alert-bridge.h, view.qml). Advanced every 400 ms (CielWin's
    // WatchInterval), right after an accepted request and on every coverage change. The mini sits
    // on the top layer, so it is never held for coverage; the wallpaper (B2) holds alerts while a
    // fullscreen window covers its output (canShow honours `covered`), pauses its scene meanwhile
    // and lays the mosaic out in the output's work area (bars excluded).
    AlertBridge alertBridge;
    QElapsedTimer alertClock;
    alertClock.start();
    // H1: a held warning (duration 0) ends by itself alert-hold-max-seconds after it was requested.
    AlertDriver alertDriver([&alertClock] { return alertClock.elapsed(); }, [](const QString &line) {
        qInfo("CIELINUX_ALERT %s", qPrintable(line));
    }, qint64(stored.settings.alertHoldMaxSeconds) * 1000);
    // A5: the sound for a newly shown alert (failed wins) plays once, unless muted or unset.
    QObject::connect(&alertDriver, &AlertDriver::alertShown, &alertDriver, [](const QString &kind) {
        qInfo("CIELINUX_ALERT shown kind=%s", qPrintable(kind));
    });
    QObject::connect(&alertDriver, &AlertDriver::alertShown, &alertSounds, &AlertSounds::onAlertShown);
    // H4: a held warning repeats its sound every 5 s while it shows (same mute and sound checks).
    QObject::connect(&alertDriver, &AlertDriver::alertRepeated, &alertSounds, &AlertSounds::onAlertRepeated);
    QObject::connect(&alertBridge, &AlertBridge::pageDone, &alertBridge, [](int generation) {
        qInfo("CIELINUX_ALERT page-done gen=%d", generation);
    });
    const AlertSurface miniAlerts{
        [&](bool) { return !policy.closed() && sceneHost.mode() == QStringLiteral("scene-mini"); },
        [&](const AlertShowRequest &request) { alertBridge.post(AlertLayerMessages::show(request)); },
        [&] { alertBridge.hide(); }};
    // B2: fullscreen coverage of the wallpaper's own output from Hyprland IPC events (CielWin
    // PrimaryMonitorFullscreenDetector), tracked only while the wallpaper is shown. Without
    // Hyprland it logs one line and the wallpaper is never covered; B8: a restarted Hyprland is
    // found again (bounded backoff). B9: it also caches the output's reserved zones. B10: it runs
    // in both modes so the mini glide reads that cache too; in the mini coverage is off (never
    // covered, no coverage queries or lines). B11: its Hyprland connection lines go out as
    // CIELINUX_HYPRLAND (both modes), its covered/uncovered lines as CIELINUX_WALLPAPER.
    FullscreenWatch fullscreenWatch(screen->name(), [](const QString &line) {
        qInfo("%s %s", FullscreenWatch::logPrefix(line), qPrintable(line));
    });
    // B2 (CielWin WallpaperSceneSurface): seen only while uncovered; the work area is read at show
    // time from the watch's cached reserved zones of this output (B9: no request on this thread;
    // none known yet = the whole output).
    const AlertSurface wallpaperAlerts{
        [&](bool covered) { return !policy.closed() && sceneHost.mode() == QStringLiteral("scene") && !covered; },
        [&](const AlertShowRequest &request) { alertBridge.post(AlertLayerMessages::show(request)); },
        [&] { alertBridge.hide(); },
        [&] {
            return AlertWorkArea::forOutput(screen->size(), fullscreenWatch.reserved().value_or(QMargins()), screen->devicePixelRatio());
        }};
    // The surface alerts go to for the current mode.
    auto alertSurface = [&]() -> const AlertSurface * {
        return sceneHost.mode() == QStringLiteral("scene-mini") ? &miniAlerts : &wallpaperAlerts;
    };
    auto wallpaperCovered = [&] { return sceneHost.mode() == QStringLiteral("scene") && fullscreenWatch.covered(); };
    auto updateAlerts = [&] { alertDriver.update(alertSurface(), wallpaperCovered()); };
    // CielWin UpdatePause: the wallpaper page stops drawing while covered and resumes when
    // uncovered; only a change is sent and logged. The bridge re-tells a page that becomes ready.
    bool scenePaused = false;
    auto updateScenePause = [&] {
        const bool paused = wallpaperCovered();
        if (paused == scenePaused) return;
        scenePaused = paused;
        alertBridge.setScenePaused(paused);
        if (paused) qInfo("CIELINUX_WALLPAPER paused reason=fullscreen");
        else qInfo("CIELINUX_WALLPAPER resumed");
    };
    QObject::connect(&fullscreenWatch, &FullscreenWatch::coveredChanged, &alertDriver, [&] {
        updateScenePause();
        updateAlerts();
    });
    fullscreenWatch.setCoverage(sceneHost.mode() == QStringLiteral("scene"));
    fullscreenWatch.start();
    // Every live retarget replaces the page, including same-mode FPS changes.
    // Invalidate the old channel now, before clearing stale pending content; the
    // reconstruction turn precedes the update and replays only remaining time.
    // Mode-only coverage/logging must not run for scene or rate changes.
    QString alertSurfaceMode = sceneHost.mode();
    QObject::connect(&sceneHost, &SceneHost::changed, &alertDriver, [&] {
        alertBridge.attach(policy.generation());
        alertBridge.hide();
        alertDriver.surfaceReplaced();
        if (sceneHost.mode() != alertSurfaceMode) {
            alertSurfaceMode = sceneHost.mode();
            qInfo("CIELINUX_MODE switched mode=%s", qPrintable(alertSurfaceMode));
            fullscreenWatch.setCoverage(sceneHost.mode() == QStringLiteral("scene"));
            updateScenePause();
        }
        QTimer::singleShot(0, &alertDriver, [&] { updateAlerts(); });
    });
    QTimer alertTick;
    QObject::connect(&alertTick, &QTimer::timeout, &alertDriver, [&] { updateAlerts(); });
    alertTick.start(400);
    // HTTP (A3): loopback server gated by `http-server`; the scene route calls
    // sceneHost.setScene on this (GUI) thread. A missing token or a busy port is
    // logged once and the host keeps running without HTTP. Never logs the token.
    std::unique_ptr<HttpServer> httpServer;
    if (stored.settings.httpServerEnabled) {
        const QByteArray httpToken = HttpToken::loadOrCreate(HttpToken::resolvePath(), [](const QString &line) {
            qWarning("CIELINUX_HTTP %s", qPrintable(line));
        });
        if (httpToken.isEmpty()) {
            qWarning("CIELINUX_HTTP unavailable: no token; running without HTTP");
        } else {
            httpServer = std::make_unique<HttpServer>(quint16(stored.settings.httpServerPort), httpToken,
                [&sceneHost](const QString &scene) {
                    return sceneHost.setScene(scene);
                }, [&](const QString &command) {
                    // A4: queue it, then show it on the next event-loop turn without waiting for
                    // the tick (CielWin HandleAlert posts UpdateAlerts to the UI thread).
                    const QString reply = alertDriver.accept(command);
                    if (AlertHttpProtocol::statusCodeFor(reply) == 202)
                        QTimer::singleShot(0, &alertDriver, [&] { updateAlerts(); });
                    return reply;
                }, [&](quint64 id) {
                    // H1: POST /v1/alerts/clear; the hide (or a resumed held warning) follows the same way.
                    const QString reply = alertDriver.clear(id);
                    QTimer::singleShot(0, &alertDriver, [&] { updateAlerts(); });
                    return reply;
                });
            if (!httpServer->start()) httpServer.reset();
        }
    } else {
        qInfo("CIELINUX_HTTP disabled (http-server = off)");
    }
    // Mini positions (A6): eight CielWin positions (mini-position), placed by layer-shell
    // anchors + margins and glided over 220 ms through the margins. The glide frame is the
    // usable area: the output minus Hyprland's reserved zones (bars), read once per glide from
    // the fullscreen watch's cache (B10: no request on this thread; none known yet = the whole
    // output, the window still comes to rest exactly through its anchors).
    QElapsedTimer glideClock;
    glideClock.start();
    MiniGlider miniGlider([&glideClock] { return glideClock.elapsed(); }, [&] {
        return screen->size().shrunkBy(fullscreenWatch.reserved().value_or(QMargins()));
    });
    // Hover dodge: the mini takes no pointer input, so while it is shown the cursor is polled from
    // Hyprland (j/cursorpos every 100 ms, one request at a time, asynchronous) and the window
    // glides aside when the cursor comes near, back once it has gone. The cursor is mapped onto
    // the output by the watch and into the usable area here (minus the reserved left/top).
    // Without Hyprland there is no cursor and no dodge. The saved position never changes.
    MiniDodger miniDodger(miniGlider, [&glideClock] { return glideClock.elapsed(); }, [&] {
        return screen->size().shrunkBy(fullscreenWatch.reserved().value_or(QMargins()));
    }, [&](MiniDodger::Answer done) {
        return fullscreenWatch.queryCursor([&fullscreenWatch, done](std::optional<QPoint> cursor) {
            const QMargins reserved = fullscreenWatch.reserved().value_or(QMargins());
            done(cursor ? std::optional<QPoint>(*cursor - QPoint(reserved.left(), reserved.top())) : std::nullopt);
        });
    }, [&] { return !policy.closed() && sceneHost.mode() == QStringLiteral("scene-mini"); },
    [](const QString &line) { qInfo("CIELINUX_MINI %s", qPrintable(line)); });
    // SUPER+Z / SUPER+SHIFT+Z run `cielinux --cycle-position next|prev`, which lands here
    // (CielWin OnHotkey): refused outside the mini or before its window exists; a move is
    // persisted at once, atomically.
    instance.setHandler([&](InstanceControl::Command command) -> QByteArray {
        if (policy.closed() || sceneHost.mode() != QStringLiteral("scene-mini")) {
            qInfo("CIELINUX_MINI position ignored reason=not-mini-mode");
            return "ignored: not in mini mode";
        }
        if (!miniGlider.attached()) {
            qInfo("CIELINUX_MINI position ignored reason=window-not-ready");
            return "ignored: window not ready";
        }
        const QString next = command == InstanceControl::Command::Next
            ? MiniPosition::next(stored.settings.miniPosition) : MiniPosition::previous(stored.settings.miniPosition);
        // A dodge in progress is dropped; the glide to the new position starts where the window is.
        miniDodger.cancel();
        miniGlider.glideTo(next);
        stored.settings.miniPosition = next;
        if (stored.canSave() && !SettingsFile::save(settingsPath, stored.settings))
            qWarning("CIELINUX_MINI settings save-failed");
        qInfo("CIELINUX_MINI position=%s", qPrintable(next));
        return "ok";
    });
    instance.listen();
    QTimer lifetime;
    lifetime.setSingleShot(true);
    QMetaObject::Connection removalConnection, timeoutConnection;
    // The attachment is disposable; all captured lifetime objects outlive it.
    struct Attachment {
        std::unique_ptr<QQuickWebEngineProfile> profile;
        std::unique_ptr<QQuickView> view;
        QMetaObject::Connection closingConnection;
        Diagnostics::Lifecycle *diagnostics = nullptr;
        int generation = 0, stage = 0;
        ~Attachment() { reset(); }
        void reset() {
            // Retire only our closing hook; retain Qt/destruction observers.
            QObject::disconnect(closingConnection);
            closingConnection = {};
            const bool hadView = bool(view), hadProfile = bool(profile);
            const int retiredGeneration = generation, retiredStage = stage;
            view.reset();
            if (hadView && diagnostics)
                diagnostics->record(Diagnostics::Event::ViewRetired, retiredGeneration, retiredStage);
            profile.reset();
            if (hadProfile && diagnostics)
                diagnostics->record(Diagnostics::Event::ProfileRetired, retiredGeneration, retiredStage);
            stage = 0;
        }
    } attachment;
    attachment.diagnostics = &policy.lifecycleDiagnostics();
    policy.bindHost([&] { if (attachment.view) attachment.view->hide(); }, [&] {
        lifetime.stop();
        control->cancel();
        QObject::disconnect(removalConnection);
        QObject::disconnect(timeoutConnection);
        // Do not retire QML failure observation or native closing here.
    });
    control->activate(&policy, [&] { policy.closeNormally(); });
    removalConnection = QObject::connect(&app, &QGuiApplication::screenRemoved, &policy,
                     [&](QScreen *removed) {
        OutputPolicy::removed(screen, removed,
            [&] { policy.noteCloseReason(Diagnostics::Reason::Output); policy.closeNormally(); }, [] {});
    });
    // One preparation path for initial and replacement attachments. Every
    // external callback can invalidate this generation, including during reset.
    auto prepareAttachment = [&](int generation) -> int {
        // Always the CURRENT target: live switches rebuild through this path too.
        const QString scene = sceneHost.scene();
        const QUrl sceneUrl = sceneHost.url();
        const bool wallpaper = sceneHost.mode() == QStringLiteral("scene");
        // A6: forget the old mini surface before anything below can destroy it (and stop the
        // hover dodge's cursor polling with it).
        miniDodger.stop();
        miniGlider.detach();
        if (!policy.admits(generation)) return 0;
        attachment.reset();
        if (!policy.admits(generation)) return 0;
        alertBridge.attach(generation); // the new page is not alert-ready until it says so
        attachment.generation = generation;
        attachment.profile = std::make_unique<QQuickWebEngineProfile>();
        attachment.stage = 1;
        auto &profile = *attachment.profile;
        profile.setOffTheRecord(true);
        profile.setHttpCacheType(QQuickWebEngineProfile::NoCache);
        profile.setPersistentCookiesPolicy(QQuickWebEngineProfile::NoPersistentCookies);
        profile.setUrlRequestInterceptor(&interceptor);
        QObject::connect(&profile, &QQuickWebEngineProfile::downloadRequested,
                         &app, [](QQuickWebEngineDownloadRequest *download) { download->cancel(); });
        attachment.view = std::make_unique<QQuickView>();
        attachment.stage = 2;
        auto &view = *attachment.view;
        attachment.closingConnection = QObject::connect(&view, &QQuickWindow::closing, &policy,
                         [&, generation] {
            if (policy.admits(generation)) policy.noteCloseReason(Diagnostics::Reason::Dismissal);
            policy.closeGeneration(generation);
        });
        view.setScreen(screen);
        view.setFlags(Qt::FramelessWindowHint | Qt::WindowTransparentForInput
                      | Qt::WindowDoesNotAcceptFocus);
        // The wallpaper is opaque; the mini is keyed over the desktop.
        view.setColor(wallpaper ? QColor(Qt::black) : QColor(Qt::transparent));
        view.setResizeMode(QQuickView::SizeRootObjectToView);
        if (wallpaper) view.resize(screen->size());
        else view.resize(240, 240);
        auto *layer = LayerShellQt::Window::get(&view);
        if (!layer) { qCritical("LayerShellQt unavailable"); return 2; }
        layer->setScope(QStringLiteral("cielinux"));
        if (wallpaper) {
            // Full-size page on the bottom layer of the same output, anchored to
            // every edge so the compositor sizes it; -1 also extends under bars.
            // Bottom, not Background: the desktop's own wallpaper (omarchy-background)
            // shares the background layer, where stacking order is unspecified.
            layer->setLayer(LayerShellQt::Window::LayerBottom);
            layer->setAnchors(LayerShellQt::Window::Anchors(LayerShellQt::Window::AnchorTop)
                              | LayerShellQt::Window::AnchorBottom | LayerShellQt::Window::AnchorLeft
                              | LayerShellQt::Window::AnchorRight);
            layer->setMargins(QMargins());
            layer->setExclusiveZone(-1);
        } else {
            // Top (not Overlay): Hyprland draws fullscreen windows above it.
            layer->setLayer(LayerShellQt::Window::LayerTop);
            layer->setDesiredSize(QSize(240, 240));
            // Zone 0: the compositor keeps it clear of other surfaces' exclusive zones (bars).
            layer->setExclusiveZone(0);
            // A6: anchors + margins for stored.settings.miniPosition, set (and later glided)
            // only through MiniGlider.
            const QPointer<LayerShellQt::Window> surface(layer);
            miniGlider.attach({[surface](const QMargins &margins) { if (surface) surface->setMargins(margins); },
                               [surface](unsigned anchors) {
                                   if (surface) surface->setAnchors(LayerShellQt::Window::Anchors::fromInt(int(anchors)));
                               }}, stored.settings.miniPosition);
            miniDodger.start();
        }
        layer->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityNone);
        layer->setActivateOnShow(false);
        layer->setScreen(screen);
        layer->setCloseOnDismissed(true);
        view.setInitialProperties(QVariantMap{
            {QStringLiteral("sceneProfile"), QVariant::fromValue(&profile)},
            {QStringLiteral("scenePolicy"), QVariant::fromValue(&policy)},
            {QStringLiteral("sceneUrl"), sceneUrl},
            {QStringLiteral("sceneName"), scene},
            {QStringLiteral("sceneMode"), sceneHost.mode()},
            {QStringLiteral("sceneAlerts"), QVariant::fromValue(&alertBridge)},
            {QStringLiteral("sceneAttachment"), QVariant::fromValue(new AttachmentToken(generation, &view))}
        });
        view.setSource(QUrl(QStringLiteral("qrc:/view.qml")));
        if (view.status() != QQuickView::Ready) { policy.constructionFailed(generation); return 1; }
        attachment.stage = 3;
        policy.lifecycleDiagnostics().record(Diagnostics::Event::Prepared, generation);
        return 0;
    };
    policy.bindReconstruction([&](int generation) {
        // Invalidate/hide immediately, but never destroy a live QML/native sender
        // on its callback stack. Policy-context work expires with the owner.
        if (!policy.admits(generation)) return;
        if (attachment.view) attachment.view->hide();
        if (!policy.admits(generation)) return;
        QTimer::singleShot(0, &policy, [&, generation] {
            if (!policy.admits(generation)) return;
            int replacementResult = 1;
            try {
                replacementResult = prepareAttachment(generation);
            } catch (...) {
                policy.constructionFailed(generation);
                return;
            }
            if (!policy.admits(generation)) return;
            if (replacementResult != 0 || !attachment.view) {
                policy.constructionFailed(generation);
                return;
            }
            if (!policy.admits(generation)) return;
            attachment.view->show();
            attachment.stage = 4;
            policy.lifecycleDiagnostics().record(Diagnostics::Event::Mapped, generation);
        });
    });
    const int initialGeneration = policy.generation();
    int preparationResult = 1;
    try {
        preparationResult = prepareAttachment(initialGeneration);
    } catch (...) {
        policy.fail();
    }
    if (preparationResult != 0) {
        if (preparationResult == 1) policy.fail();
        policy.noteCloseReason(Diagnostics::Reason::Guard, preparationResult);
        policy.closeNormally();
        return policy.terminalResult() == 1 ? 1 : preparationResult;
    }
    if (policy.closed()) return policy.terminalResult();
    timeoutConnection = QObject::connect(&lifetime, &QTimer::timeout, &policy, [&] {
        policy.noteCloseReason(Diagnostics::Reason::Deadline);
        policy.closeNormally();
    });
    configureLifetime(lifetime, options);
    // An incident during initial QML construction must not map the stale view.
    // Timed mode starts once here; resident mode never schedules a deadline.
    if (policy.admits(initialGeneration) && attachment.view) {
        attachment.view->show();
        attachment.stage = 4;
        policy.lifecycleDiagnostics().record(Diagnostics::Event::Mapped, initialGeneration);
    }
    app.exec();
    policy.noteCloseReason(Diagnostics::Reason::Ambient);
    policy.closeNormally();
    return policy.terminalResult();
}
