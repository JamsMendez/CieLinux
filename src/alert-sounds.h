#pragma once

#include "settings.h"
#include "tray.h"

#include <QByteArray>
#include <QHash>
#include <QObject>
#include <QString>
#include <QStringList>
#include <functional>
#include <memory>

// Alert sounds (A5), CielWin parity: CielWin/CielWin.App/Alerts/AlertSoundLibrary.cs,
// MediaAlertSoundPlayer.cs and AppComposition.cs (Toggle/Import/RemoveAlertSound). Kinds are
// the AlertDriver::alertShown names, "failed" and "warning". No sound ships with CieLinux: a
// kind is silent until the user imports one. Trace lines carry kinds and reason codes, never a
// path (a path can hold the user's name).
namespace AlertSoundLibrary {
// The formats the import accepts, in dialog order.
QStringList extensions();
// The import dialog's name filter: exactly extensions().
QString fileDialogFilter();
// $XDG_DATA_HOME/cielinux/sounds; a relative or empty XDG_DATA_HOME is ignored (XDG spec) in
// favour of $HOME/.local/share.
QString resolveDirectory(const QByteArray &xdgDataHome, const QByteArray &home);
QString resolveDirectory(); // From the process environment.
QString kindName(bool failed);
// Ends in one of extensions(), any case.
bool isSupported(const QString &path);
// A bare file name (no folder, no `..`, non-empty stem) of a supported format: the only shape a
// sound setting may take, so a hand-edited value can never point outside the folder.
bool isSoundFileName(const QString &name);
}

// The folder of imported sounds: one file per kind, named for it (`failed.wav`, `warning.m4a`).
class SoundLibrary {
public:
    explicit SoundLibrary(QString directory) : dir(std::move(directory)) {}
    QString directory() const { return dir; }
    QString pathOf(const QString &fileName) const { return dir + QLatin1Char('/') + fileName; }
    // COPIES `source` in as `kind`'s sound (so moving the original later does not break it),
    // replacing the previous one whatever its extension, and returns the copy's file name. Empty
    // on failure with `*error` set to a reason code; a failed copy leaves the previous sound whole.
    QString importSound(const QString &kind, const QString &source, QString *error) const;
    // Deletes `kind`'s sound, whatever its extension. Nothing there is fine.
    bool remove(const QString &kind, QString *error) const;
private:
    QString dir;
};

// Where a sound goes; a seam so the decisions are tested without audio.
class AlertSoundOutput {
public:
    virtual ~AlertSoundOutput() = default;
    // Starts playing the file and returns at once.
    virtual void play(const QString &path) = 0;
    // Raised later when the file turns out unplayable, with the error's NAME only.
    std::function<void(const QString &error)> failed;
};
// QMediaPlayer + QAudioOutput at full volume on the default device (PipeWire through Qt's
// ffmpeg backend). The file is released once the sound ends or fails.
std::unique_ptr<AlertSoundOutput> createMediaOutput();

// Plays a kind's file (looked up on every play, so an import or removal applies to the next
// alert); one output per kind for the life of the process. Nothing escapes.
class AlertSoundPlayer {
public:
    using Resolve = std::function<QString(const QString &kind)>; // empty = no sound
    using OutputFactory = std::function<std::unique_ptr<AlertSoundOutput>()>;
    using Trace = std::function<void(const QString &)>;
    AlertSoundPlayer(Resolve resolve, OutputFactory createOutput, Trace trace);
    void play(const QString &kind);
private:
    AlertSoundOutput *outputFor(const QString &kind);
    Resolve resolve;
    OutputFactory createOutput;
    Trace trace;
    QHash<QString, std::shared_ptr<AlertSoundOutput>> outputs;
};

// The tray's sound actions and the alert hook over the host's one Settings object. `persist`
// saves that object (atomically, settings.cpp); `pick` asks for a file (empty = cancelled).
class AlertSounds final : public QObject {
    Q_OBJECT
public:
    using Persist = std::function<void()>;
    using Picker = std::function<QString(const QString &kind)>;
    AlertSounds(Settings &settings, Persist persist, SoundLibrary library, Picker pick,
                AlertSoundPlayer::OutputFactory outputs, AlertSoundPlayer::Trace trace,
                QObject *parent = nullptr);
    bool enabled() const { return settings.alertSoundsEnabled; }
    bool hasSound(const QString &kind) const { return !soundFor(kind).isEmpty(); }
    void toggle();
    void importSound(const QString &kind);
    void removeSound(const QString &kind);
    TraySounds trayControls();
    // The modal "Import <kind> sound" dialog, filtered to fileDialogFilter().
    static QString pickWithDialog(const QString &kind);
public slots:
    // AlertDriver::alertShown: once per newly shown alert (failed wins); silent when muted/unset.
    void onAlertShown(const QString &kind);
private:
    QString soundFor(const QString &kind) const;
    void setSound(const QString &kind, const QString &fileName);
    void log(const QString &line) const;
    Settings &settings;
    Persist persist;
    SoundLibrary library;
    Picker pick;
    AlertSoundPlayer::Trace trace;
    AlertSoundPlayer player;
};
