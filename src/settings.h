#pragma once

#include <QByteArray>
#include <QString>

// The preferences kept between runs, in CielWin's flat `key = value` format and
// with CielWin's key names and defaults (CielWin/CielWin.App/Settings.cs), so one
// hand-edited file reads the same on both apps. Names are stored lowercase and
// only ever hold a value from the closed sets parse() recognises.
//
// Blank lines and `#` comments are ignored, unknown keys are skipped, and an
// unrecognised value keeps the default: a typo costs one setting, never startup.
// The LAST recognised assignment of a key wins. Legacy key spellings
// (`wallpaper-mode = html|html-mini|mini`, `wallpaper-scene`, `mini-corner`,
// `alert-http`, `alert-http-port`) are read; the new key wins whatever the line
// order. Only the new names are ever written.
struct Settings {
    bool httpServerEnabled = true;               // http-server
    int httpServerPort = 43811;                  // http-server-port, 1-65535
    // Stage 1 is mini-only: CielWin defaults to `scene`, CieLinux to `scene-mini`.
    QString wallpaperMode = QStringLiteral("scene-mini"); // scene-mini | scene
    QString scene = QStringLiteral("processing");        // processing | explorer | idle | raphael
    QString miniPosition = QStringLiteral("top-right");  // four corners + four side midpoints
    int frameRate = 30;                          // frame-rate: global 30 | 60
    bool alertSoundsEnabled = true;              // alert-sounds
    QString failedSound, warningSound;           // bare .wav/.mp3/.m4a file name; empty = silent
    int alertHoldMaxSeconds = 600;               // alert-hold-max-seconds, 10-3600 (CieLinux only)

    static Settings parse(const QString &content);
    // The whole file, comments included, as a save writes it.
    QString serialize() const;
    bool operator==(const Settings &other) const;
    bool operator!=(const Settings &other) const { return !(*this == other); }
};

enum class SettingsLoadStatus {
    Loaded,     // The file was read and parsed.
    Missing,    // No file yet (first run): the defaults are the real answer.
    Unreadable, // A file exists but could not be read: the defaults are only a stand-in.
};

struct SettingsLoadResult {
    Settings settings;
    SettingsLoadStatus status = SettingsLoadStatus::Missing;
    // False when saving could destroy the user's data: the file exists but was
    // not read, so anything written would replace it with defaults.
    bool canSave() const { return status != SettingsLoadStatus::Unreadable; }
};

// On-disk read and write. Every failure degrades to the defaults or a false
// return; nothing here throws or aborts the host.
namespace SettingsFile {
// Files larger than this are refused as unreadable rather than slurped.
constexpr qint64 maxBytes = 64 * 1024;
// $XDG_CONFIG_HOME/cielinux/settings.conf; a relative or empty
// XDG_CONFIG_HOME is ignored (XDG spec) in favour of $HOME/.config.
QString resolvePath(const QByteArray &xdgConfigHome, const QByteArray &home);
QString resolvePath(); // From the process environment.
SettingsLoadResult tryLoad(const QString &path);
// tryLoad(), and when the file is missing also write the commented defaults so a
// fresh machine gets a real file to hand-edit. An existing file is never rewritten.
SettingsLoadResult loadOrCreate(const QString &path);
// Atomic: written beside the target and renamed over it, so a crash mid-write
// leaves the previous file intact. Creates the directory. False on any failure.
bool save(const QString &path, const Settings &settings);
}
