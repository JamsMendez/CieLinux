#include "tray.h"

#include "scene-host.h"

#include <QAction>
#include <QActionGroup>
#include <QDBusConnection>
#include <QDBusConnectionInterface>
#include <QDBusServiceWatcher>
#include <QMenu>
#include <exception>
#include <utility>

namespace {
const QString watcherService = QStringLiteral("org.kde.StatusNotifierWatcher");

// CielWin's SceneLabel is the enum name: the scene name, capitalized.
QString sceneLabel(const QString &scene) {
    return scene.isEmpty() ? scene : scene.left(1).toUpper() + scene.mid(1);
}

// CielWin TrayMenuController.Modes (WallpaperMode declaration order) with
// TrayIconHost.ModeLabel; the settings value (`wallpaper-mode`) each one selects.
struct ModeEntry { const char *mode, *label; };
constexpr ModeEntry modeEntries[] = {{"scene", "Scene wallpaper"}, {"scene-mini", "Mini window"}};
} // namespace

Tray::Tray(SceneHost &host, std::function<void()> exit, TraySounds sounds, QObject *parent)
    : QObject(parent), host(host), exitHost(std::move(exit)), rootMenu(std::make_unique<QMenu>()),
      sounds(std::move(sounds)) {
    // Wallpaper mode (B1): exactly one mode at a time; a click switches live through
    // SceneHost::setMode (the host rebuilds the surface without spending recovery).
    QMenu *modeMenu = rootMenu->addMenu(QStringLiteral("Wallpaper mode"));
    modeGroup = new QActionGroup(modeMenu);
    modeGroup->setExclusive(true);
    for (const ModeEntry &entry : modeEntries) {
        const QString mode = QString::fromLatin1(entry.mode);
        QAction *action = modeMenu->addAction(QString::fromLatin1(entry.label));
        action->setCheckable(true);
        modeGroup->addAction(action);
        connect(action, &QAction::triggered, this, [this, mode] {
            guarded("mode", [this, &mode] { this->host.setMode(mode); });
            // A refused switch must not leave the clicked item checked.
            refreshChecks();
        });
        modeActions.append({mode, action});
    }
    QMenu *sceneMenu = rootMenu->addMenu(QStringLiteral("Scene"));
    sceneGroup = new QActionGroup(sceneMenu);
    sceneGroup->setExclusive(true);
    for (const QString &scene : switchableScenes()) {
        QAction *action = sceneMenu->addAction(sceneLabel(scene));
        action->setCheckable(true);
        sceneGroup->addAction(action);
        connect(action, &QAction::triggered, this, [this, scene] {
            guarded("scene", [this, &scene] { this->host.setScene(scene); });
            // A refused switch must not leave the clicked item checked.
            refreshChecks();
        });
        sceneActions.append({scene, action});
    }
    // Sound group (A5, CielWin MenuOrder/SoundEntryLabel): the imports always, each
    // remove only while its kind has a sound, the toggle only while either has one.
    rootMenu->addSeparator();
    auto soundItem = [this](const QString &label, const char *item, std::function<void()> click) {
        QAction *action = rootMenu->addAction(label);
        connect(action, &QAction::triggered, this, [this, item, click] {
            guarded(item, click);
            refreshChecks();
        });
        return action;
    };
    auto withKind = [this](std::function<void(const QString &)> TraySounds::*member, const char *kind) {
        return [this, member, kind] {
            if (this->sounds.*member) (this->sounds.*member)(QString::fromLatin1(kind));
        };
    };
    soundItem(QStringLiteral("Import failed sound…"), "import-failed-sound",
              withKind(&TraySounds::importSound, "failed"));
    soundItem(QStringLiteral("Import warning sound…"), "import-warning-sound",
              withKind(&TraySounds::importSound, "warning"));
    removeFailedAction = soundItem(QStringLiteral("Remove failed sound"), "remove-failed-sound",
                                   withKind(&TraySounds::removeSound, "failed"));
    removeWarningAction = soundItem(QStringLiteral("Remove warning sound"), "remove-warning-sound",
                                    withKind(&TraySounds::removeSound, "warning"));
    alertSoundsAction = soundItem(QStringLiteral("Alert sounds"), "alert-sounds", [this] {
        if (this->sounds.toggle) this->sounds.toggle();
    });
    // Checked state comes from the controls on every refresh, never from Qt's own flip.
    alertSoundsAction->setCheckable(true);
    rootMenu->addSeparator();
    QAction *exitAction = rootMenu->addAction(QStringLiteral("Exit"));
    connect(exitAction, &QAction::triggered, this, [this] { guarded("exit", exitHost); });

    // Re-read on every open (CielWin parity) and whenever the target changes, so a
    // D-Bus menu host that lays out before AboutToShow is answered still sees it.
    connect(rootMenu.get(), &QMenu::aboutToShow, this, &Tray::refreshChecks);
    connect(modeMenu, &QMenu::aboutToShow, this, &Tray::refreshChecks);
    connect(sceneMenu, &QMenu::aboutToShow, this, &Tray::refreshChecks);
    connect(&host, &SceneHost::changed, this, &Tray::refreshChecks);
    refreshChecks();

    // CielWin's tray icon, byte for byte (CielWin.App/Assets/raphael-mini.ico, TrayIconHost.cs:108-122,
    // 198-204): the Raphael mini figure on a transparent background, frames 16/20/24 (with CielWin's
    // small-size contrast pass), 32, 48 and 256. QIcon loads every frame (qt6-base ICO plugin) and the
    // StatusNotifierItem sends the ones up to 64 px, so the tray host picks a frame drawn for its size.
    iconImage = QIcon(QStringLiteral(":/raphael-mini.ico"));
    iconToolTip = QStringLiteral("CieLinux");
    QDBusConnection bus = QDBusConnection::sessionBus();
    if (!bus.isConnected() || !bus.interface()) {
        qWarning("CIELINUX_TRAY unavailable: no D-Bus session bus; running without a tray");
        return;
    }
    // Qt snapshots tray availability when an icon is created, so the icon follows the
    // host instead: watch first, then look, so an appearance in between is not lost.
    hostWatcher = new QDBusServiceWatcher(watcherService, bus,
                                          QDBusServiceWatcher::WatchForRegistration
                                              | QDBusServiceWatcher::WatchForUnregistration,
                                          this);
    connect(hostWatcher, &QDBusServiceWatcher::serviceRegistered, this, &Tray::hostAppeared);
    connect(hostWatcher, &QDBusServiceWatcher::serviceUnregistered, this, &Tray::hostVanished);
    if (bus.interface()->isServiceRegistered(watcherService).value()) {
        createIcon();
        qWarning("CIELINUX_TRAY available");
    } else {
        qWarning("CIELINUX_TRAY unavailable: no StatusNotifier host; waiting for one");
    }
}

Tray::~Tray() {
    // The icon references the menu: retire it first.
    if (trayIcon) trayIcon->hide();
    trayIcon.reset();
}

void Tray::createIcon() {
    trayIcon = std::make_unique<QSystemTrayIcon>(iconImage);
    trayIcon->setToolTip(iconToolTip);
    trayIcon->setContextMenu(rootMenu.get());
    connect(trayIcon.get(), &QSystemTrayIcon::activated, this, &Tray::activate);
    trayIcon->show();
}

void Tray::hostAppeared() {
    // An owner change arrives as vanish + appear, so an existing icon means nothing to do.
    if (trayIcon) return;
    refreshChecks();
    createIcon();
    qWarning("CIELINUX_TRAY recreated");
}

void Tray::hostVanished() {
    if (!trayIcon) return;
    trayIcon->hide();
    trayIcon.reset();
    qWarning("CIELINUX_TRAY unavailable: StatusNotifier host gone; waiting for it to return");
}

void Tray::activate(QSystemTrayIcon::ActivationReason) {
    // CielWin parity: only the context menu acts; a click on the icon does nothing.
}

void Tray::refreshChecks() {
    const QString currentMode = host.mode();
    for (const auto &[mode, action] : std::as_const(modeActions))
        action->setChecked(mode == currentMode);
    const QString current = host.scene();
    for (const auto &[scene, action] : std::as_const(sceneActions))
        action->setChecked(scene == current);
    auto has = [this](const char *kind) {
        try {
            return sounds.hasSound && sounds.hasSound(QString::fromLatin1(kind));
        } catch (...) {
            return false;
        }
    };
    const bool failed = has("failed"), warning = has("warning");
    bool enabled = false;
    try { enabled = sounds.enabled && sounds.enabled(); } catch (...) {}
    removeFailedAction->setVisible(failed);
    removeWarningAction->setVisible(warning);
    alertSoundsAction->setVisible(failed || warning);
    alertSoundsAction->setChecked(enabled);
}

void Tray::guarded(const char *item, const std::function<void()> &click) {
    // Never let a click escape into the event loop; log the item only.
    try {
        if (click) click();
    } catch (...) {
        qWarning("CIELINUX_TRAY click-failed item=%s", item);
    }
}
