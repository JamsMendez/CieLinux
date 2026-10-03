#pragma once

#include <QIcon>
#include <QList>
#include <QObject>
#include <QPair>
#include <QString>
#include <QSystemTrayIcon>
#include <functional>
#include <memory>

class QAction;
class QActionGroup;
class QDBusServiceWatcher;
class QMenu;
class SceneHost;

// The sound group's actions (A5, CielWin TrayMenuController): kinds are "failed" and
// "warning". An unset function reads as false / does nothing.
struct TraySounds {
    std::function<bool()> enabled;                          // the "Alert sounds" check
    std::function<void()> toggle;                           // mute on/off
    std::function<bool(const QString &kind)> hasSound;      // shows that kind's remove entry
    std::function<void(const QString &kind)> importSound;   // opens the file dialog
    std::function<void(const QString &kind)> removeSound;
};

// The tray icon (StatusNotifierItem through Qt's D-Bus tray; Waybar shows it) and
// its menu, CielWin's TrayIconHost order: Wallpaper mode ▸ (Scene wallpaper, Mini
// window), Scene ▸, separator, sound group (imports, removes, "Alert sounds" toggle),
// separator, Exit. It owns no state: the checks and the shown sound entries are re-read
// from SceneHost and TraySounds when a menu opens (the scene also changes over HTTP),
// and every mode or scene click goes through SceneHost::setMode / setScene. Left click
// does nothing.
//
// The tray host (org.kde.StatusNotifierWatcher; on Omarchy the shell owns it) may start
// after CieLinux or restart under it, so the icon exists only while the host does: a
// QDBusServiceWatcher creates it when the host appears and drops it when the host
// goes, one CIELINUX_TRAY available|unavailable|recreated line per transition. The
// menu outlives the icon, so its state carries over. Without a session bus there is
// no tray at all (logged once).
class Tray final : public QObject {
    Q_OBJECT
public:
    // `exit` runs the host's normal close path.
    Tray(SceneHost &host, std::function<void()> exit, TraySounds sounds = {}, QObject *parent = nullptr);
    ~Tray() override;
    QMenu *menu() const { return rootMenu.get(); }
    QIcon icon() const { return iconImage; }
    QString toolTip() const { return iconToolTip; }
    // True while an icon is up for a present tray host.
    bool shown() const { return trayIcon && trayIcon->isVisible(); }
    // What a click on the icon itself does (nothing, for every reason).
    void activate(QSystemTrayIcon::ActivationReason reason);
    void refreshChecks();
private:
    void guarded(const char *item, const std::function<void()> &click);
    void createIcon();
    void hostAppeared();
    void hostVanished();
    SceneHost &host;
    std::function<void()> exitHost;
    std::unique_ptr<QMenu> rootMenu;
    QActionGroup *modeGroup = nullptr, *sceneGroup = nullptr;
    QList<QPair<QString, QAction *>> modeActions;
    QList<QPair<QString, QAction *>> sceneActions;
    TraySounds sounds;
    QAction *removeFailedAction = nullptr, *removeWarningAction = nullptr, *alertSoundsAction = nullptr;
    QIcon iconImage;
    QString iconToolTip;
    QDBusServiceWatcher *hostWatcher = nullptr;
    std::unique_ptr<QSystemTrayIcon> trayIcon; // null while no tray host is present
};
