#include "scene-host.h"

#include <utility>

namespace {
struct SceneEntry { const char *name, *mini, *full; };
// Literal URLs only: no scene name is ever concatenated into a URL.
constexpr SceneEntry sceneTable[] = {
    {"processing", "qrc:/processing/index.html?variant=mini&fps=30", "qrc:/processing/index.html?fps=60"},
    {"explorer", "qrc:/explorer/index.html?variant=mini&fps=30", "qrc:/explorer/index.html?fps=60"},
    {"idle", "qrc:/idle/index.html?variant=mini&fps=30", "qrc:/idle/index.html?fps=60"},
    {"raphael", "qrc:/raphael/index.html?variant=mini&fps=30", "qrc:/raphael/index.html?fps=60"},
};

const SceneEntry *entryFor(const QString &scene) {
    for (const SceneEntry &entry : sceneTable)
        if (scene == QLatin1String(entry.name)) return &entry;
    return nullptr;
}
} // namespace

QUrl sceneUrlFor(const QString &scene, const QString &mode) {
    const SceneEntry *entry = entryFor(scene);
    if (!entry) return {};
    if (mode == QStringLiteral("scene-mini")) return QUrl(QString::fromLatin1(entry->mini));
    if (mode == QStringLiteral("scene") && entry->full) return QUrl(QString::fromLatin1(entry->full));
    return {};
}

bool isSwitchableScene(const QString &scene) {
    const SceneEntry *entry = entryFor(scene);
    return entry && entry->full;
}

QStringList switchableScenes() {
    QStringList names;
    for (const SceneEntry &entry : sceneTable)
        if (entry.full) names << QString::fromLatin1(entry.name);
    return names;
}

QString effectiveMode(const QString &scene, const QString &mode) {
    return sceneUrlFor(scene, mode).isEmpty() ? QStringLiteral("scene-mini") : mode;
}

SceneHost::SceneHost(const QString &scene, const QString &mode, Switcher switcher,
                     Persister persister, QObject *parent)
    : QObject(parent), currentScene(scene), currentMode(mode),
      switcher(std::move(switcher)), persister(std::move(persister)) {}

bool SceneHost::setScene(const QString &name) {
    if (!isSwitchableScene(name)) return false;
    return switchTo(name, currentMode);
}

bool SceneHost::setMode(const QString &mode) {
    if (mode != QStringLiteral("scene") && mode != QStringLiteral("scene-mini")) return false;
    return switchTo(currentScene, mode);
}

bool SceneHost::switchTo(QString scene, QString mode) {
    const QUrl target = sceneUrlFor(scene, mode);
    if (target.isEmpty()) return false;
    if (scene == currentScene && mode == currentMode) return true;
    // Publish the new target first: the attachment rebuilt by the switcher reads
    // it (on a later event-loop turn). Roll back if the switch was refused.
    QString oldScene = std::exchange(currentScene, std::move(scene));
    QString oldMode = std::exchange(currentMode, std::move(mode));
    if (!switcher || !switcher(target)) {
        currentScene = std::move(oldScene);
        currentMode = std::move(oldMode);
        return false;
    }
    persistPending = true;
    emit changed();
    return true;
}

void SceneHost::confirmReady() {
    if (!persistPending) return;
    persistPending = false;
    if (persister) persister(currentScene, currentMode);
}
