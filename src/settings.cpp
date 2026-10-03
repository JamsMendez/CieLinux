#include "settings.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSaveFile>
#include <QStringList>
#include <QtGlobal>
#include <optional>

namespace {

struct Name { const char *text; const char *value; };

// Closed name sets; the stored value is always the canonical lowercase name.
constexpr Name modeNames[] = {{"scene", "scene"}, {"scene-mini", "scene-mini"}};
constexpr Name legacyModeNames[] = {{"html", "scene"}, {"html-mini", "scene-mini"}, {"mini", "scene-mini"}};
constexpr Name sceneNames[] = {{"processing", "processing"}, {"explorer", "explorer"},
                               {"idle", "idle"}, {"raphael", "raphael"}};
constexpr Name miniPositionNames[] = {
    {"top-left", "top-left"}, {"top-center", "top-center"}, {"top-right", "top-right"},
    {"right-center", "right-center"}, {"bottom-right", "bottom-right"},
    {"bottom-center", "bottom-center"}, {"bottom-left", "bottom-left"}, {"left-center", "left-center"}};

template <size_t N>
std::optional<QString> readName(const QString &text, const Name (&names)[N]) {
    for (const Name &name : names)
        if (text.compare(QLatin1String(name.text), Qt::CaseInsensitive) == 0)
            return QString::fromLatin1(name.value);
    return std::nullopt;
}

// on/true/1 and off/false/0, case-insensitive; anything else is no reading.
std::optional<bool> readFlag(const QString &value) {
    const QString v = value.toLower();
    if (v == QLatin1String("on") || v == QLatin1String("true") || v == QLatin1String("1")) return true;
    if (v == QLatin1String("off") || v == QLatin1String("false") || v == QLatin1String("0")) return false;
    return std::nullopt;
}

// A whole decimal number 1-65535 (an optional leading '+' as in .NET int.TryParse).
std::optional<int> readPort(const QString &value) {
    QString digits = value;
    if (digits.startsWith(QLatin1Char('+'))) digits.remove(0, 1);
    if (digits.isEmpty() || digits.size() > 5) return std::nullopt;
    int port = 0;
    for (const QChar c : digits) {
        if (c < QLatin1Char('0') || c > QLatin1Char('9')) return std::nullopt;
        port = port * 10 + (c.unicode() - '0');
    }
    if (port < 1 || port > 65535) return std::nullopt;
    return port;
}

// A bare .wav/.mp3/.m4a file name with a non-empty stem; anything else is silence.
QString readSound(const QString &value) {
    if (value.isEmpty() || value.contains(QLatin1Char('/')) || value.contains(QLatin1Char('\\')) ||
        value.contains(QChar(0)))
        return {};
    const int dot = value.lastIndexOf(QLatin1Char('.'));
    if (dot <= 0) return {};
    const QString extension = value.mid(dot).toLower();
    if (extension != QLatin1String(".wav") && extension != QLatin1String(".mp3") &&
        extension != QLatin1String(".m4a"))
        return {};
    return value;
}

QString flag(bool value) { return value ? QStringLiteral("on") : QStringLiteral("off"); }

} // namespace

Settings Settings::parse(const QString &content) {
    const Settings defaults;
    Settings result;
    std::optional<QString> scene, legacyScene, miniPosition, legacyMiniPosition;
    std::optional<bool> httpServer, legacyHttpServer;
    std::optional<int> port, legacyPort;
    for (const QString &rawLine : content.split(QLatin1Char('\n'))) {
        const QString line = rawLine.trimmed();
        if (line.isEmpty() || line.startsWith(QLatin1Char('#'))) continue;
        const int separator = line.indexOf(QLatin1Char('='));
        if (separator <= 0) continue;
        const QString key = line.left(separator).trimmed().toLower();
        const QString value = line.mid(separator + 1).trimmed();
        // Only a value we recognise moves a setting: guessing what a typo meant is
        // worse than leaving the default alone.
        if (key == QLatin1String("wallpaper-mode")) {
            if (auto mode = readName(value, modeNames)) result.wallpaperMode = *mode;
            else if (auto legacy = readName(value, legacyModeNames)) result.wallpaperMode = *legacy;
        } else if (key == QLatin1String("http-server")) {
            if (auto v = readFlag(value)) httpServer = v;
        } else if (key == QLatin1String("alert-http")) {
            if (auto v = readFlag(value)) legacyHttpServer = v;
        } else if (key == QLatin1String("http-server-port")) {
            if (auto v = readPort(value)) port = v;
        } else if (key == QLatin1String("alert-http-port")) {
            if (auto v = readPort(value)) legacyPort = v;
        } else if (key == QLatin1String("scene")) {
            if (auto v = readName(value, sceneNames)) scene = v;
        } else if (key == QLatin1String("wallpaper-scene")) {
            if (auto v = readName(value, sceneNames)) legacyScene = v;
        } else if (key == QLatin1String("mini-position")) {
            if (auto v = readName(value, miniPositionNames)) miniPosition = v;
        } else if (key == QLatin1String("mini-corner")) {
            if (auto v = readName(value, miniPositionNames)) legacyMiniPosition = v;
        } else if (key == QLatin1String("alert-sounds")) {
            if (auto v = readFlag(value)) result.alertSoundsEnabled = *v;
        } else if (key == QLatin1String("failed-sound")) {
            // Unlike other keys an unusable value clears the sound: silence is safe.
            result.failedSound = readSound(value);
        } else if (key == QLatin1String("warning-sound")) {
            result.warningSound = readSound(value);
        }
    }
    result.httpServerEnabled = httpServer.value_or(legacyHttpServer.value_or(defaults.httpServerEnabled));
    result.httpServerPort = port.value_or(legacyPort.value_or(defaults.httpServerPort));
    result.scene = scene.value_or(legacyScene.value_or(defaults.scene));
    result.miniPosition = miniPosition.value_or(legacyMiniPosition.value_or(defaults.miniPosition));
    return result;
}

QString Settings::serialize() const {
    QStringList lines{
        QStringLiteral("# CieLinux settings (same keys as CielWin). Edited by hand or by the app."),
        QStringLiteral("# wallpaper-mode: `scene-mini` (default) shows a small always-on-top scene window"),
        QStringLiteral("# (mini-position); `scene` shows the animated scene as the desktop wallpaper."),
        QStringLiteral("# The tray's Wallpaper mode menu switches between them live."),
        QStringLiteral("wallpaper-mode = ") + wallpaperMode,
        QString(),
        QStringLiteral("# http-server: on (default) runs the local HTTP server for scene switching and alerts;"),
        QStringLiteral("# off closes the port and disables both. Loopback-only; its bearer token lives in"),
        QStringLiteral("# $XDG_STATE_HOME/cielinux/http.token, created the first time the server starts."),
        QStringLiteral("http-server = ") + flag(httpServerEnabled),
        QString(),
        QStringLiteral("# http-server-port: the loopback TCP port the HTTP server listens on, 1-65535."),
        QStringLiteral("http-server-port = ") + QString::number(httpServerPort),
        QString(),
        QStringLiteral("# scene: the current scene: `processing` (default), `explorer`, `idle` or `raphael`."),
        QStringLiteral("# Updated whenever the scene is switched, so it survives restarts."),
        QStringLiteral("scene = ") + scene,
        QString(),
        QStringLiteral("# mini-position: where the `scene-mini` window sits: a corner (`top-left`,"),
        QStringLiteral("# `top-right` (default), `bottom-left`, `bottom-right`) or a side midpoint"),
        QStringLiteral("# (`top-center`, `right-center`, `bottom-center`, `left-center`)."),
        QStringLiteral("mini-position = ") + miniPosition,
        QString(),
        QStringLiteral("# alert-sounds: on (default) plays a sound when an alert appears (the failed sound when"),
        QStringLiteral("# it has any failed tile, otherwise the warning sound); off keeps alerts silent."),
        QStringLiteral("alert-sounds = ") + flag(alertSoundsEnabled),
        QString(),
        QStringLiteral("# failed-sound / warning-sound: the sound each alert kind plays (a .wav, .mp3 or .m4a"),
        QStringLiteral("# imported into $XDG_DATA_HOME/cielinux/sounds/). Empty (default): that kind is silent."),
        QStringLiteral("failed-sound = ") + failedSound,
        QStringLiteral("warning-sound = ") + warningSound,
        QString(),
    };
    return lines.join(QLatin1Char('\n'));
}

bool Settings::operator==(const Settings &o) const {
    return httpServerEnabled == o.httpServerEnabled && httpServerPort == o.httpServerPort &&
           wallpaperMode == o.wallpaperMode && scene == o.scene && miniPosition == o.miniPosition &&
           alertSoundsEnabled == o.alertSoundsEnabled && failedSound == o.failedSound &&
           warningSound == o.warningSound;
}

namespace SettingsFile {

QString resolvePath(const QByteArray &xdgConfigHome, const QByteArray &home) {
    const QString xdg = QFile::decodeName(xdgConfigHome);
    const QString base = xdg.startsWith(QLatin1Char('/')) ? xdg
                         : QFile::decodeName(home) + QStringLiteral("/.config");
    return base + QStringLiteral("/cielinux/settings.conf");
}

QString resolvePath() {
    QByteArray home = qgetenv("HOME");
    if (home.isEmpty()) home = QDir::homePath().toLocal8Bit();
    return resolvePath(qgetenv("XDG_CONFIG_HOME"), home);
}

SettingsLoadResult tryLoad(const QString &path) {
    const QFileInfo info(path);
    if (!info.exists() && !info.isSymLink()) return {Settings(), SettingsLoadStatus::Missing};
    QFile file(path);
    if (!info.isFile() || info.size() > maxBytes || !file.open(QIODevice::ReadOnly))
        return {Settings(), SettingsLoadStatus::Unreadable};
    const QByteArray bytes = file.read(maxBytes + 1);
    if (file.error() != QFileDevice::NoError || bytes.size() > maxBytes)
        return {Settings(), SettingsLoadStatus::Unreadable};
    return {Settings::parse(QString::fromUtf8(bytes)), SettingsLoadStatus::Loaded};
}

SettingsLoadResult loadOrCreate(const QString &path) {
    SettingsLoadResult result = tryLoad(path);
    if (result.status == SettingsLoadStatus::Missing) save(path, Settings());
    return result;
}

bool save(const QString &path, const Settings &settings) {
    const QFileInfo info(path);
    if (!QDir().mkpath(info.absolutePath())) return false;
    QSaveFile file(path); // Temp file beside the target, renamed over it on commit.
    if (!file.open(QIODevice::WriteOnly)) return false;
    const QByteArray bytes = settings.serialize().toUtf8();
    if (file.write(bytes) != bytes.size()) { file.cancelWriting(); return false; }
    return file.commit();
}

} // namespace SettingsFile
