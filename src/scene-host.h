#pragma once

#include <QObject>
#include <QString>
#include <QStringList>
#include <QUrl>
#include <functional>

// The closed scene/mode -> page URL table. `scene-mini` is the small keyed
// window (`?variant=mini&fps=30`); `scene` is the full-size wallpaper page
// (no variant, 60 fps, as CielWin's WallpaperSceneSurface), shown on the
// layer-shell background layer (B1).
// Returns an empty URL for anything outside the table.
QUrl sceneUrlFor(const QString &scene, const QString &mode);
// The four CielWin scenes, the only names setScene() and settings accept.
bool isSwitchableScene(const QString &scene);
// The same four names in table (CielWin declaration) order, for the tray menu.
QStringList switchableScenes();
// Any scene/mode pair outside the table falls back to scene-mini.
QString effectiveMode(const QString &scene, const QString &mode);

// The internal control surface the tray (A2) and HTTP server (A3) call. It owns
// the CURRENT target (scene, mode) the host attachment is built from; the actual
// replacement is the native host's switcher (interceptor + Policy::retarget).
// A switch is persisted only after the host reports the new page ready.
class SceneHost final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString scene READ scene NOTIFY changed)
    Q_PROPERTY(QString mode READ mode NOTIFY changed)
public:
    using Switcher = std::function<bool(const QUrl &)>;
    using Persister = std::function<void(const QString &scene, const QString &mode)>;
    // `scene`/`mode` must already be validated (sceneUrlFor non-empty).
    SceneHost(const QString &scene, const QString &mode, Switcher switcher, Persister persister,
              QObject *parent = nullptr);
    QString scene() const { return currentScene; }
    QString mode() const { return currentMode; }
    QUrl url() const { return sceneUrlFor(currentScene, currentMode); }
    // True when the scene is (or is now being) shown; false for a name outside
    // the allowlist or a refused switch, which leaves the current target as is.
    Q_INVOKABLE bool setScene(const QString &name);
    // `scene` (wallpaper) or `scene-mini`; same contract as setScene().
    Q_INVOKABLE bool setMode(const QString &mode);
    // The host calls this when the current generation becomes ready; the first
    // call after a successful switch persists the shown target once.
    void confirmReady();
signals:
    void changed();
private:
    // By value: callers pass the current members themselves.
    bool switchTo(QString scene, QString mode);
    QString currentScene, currentMode;
    Switcher switcher;
    Persister persister;
    bool persistPending = false;
};
