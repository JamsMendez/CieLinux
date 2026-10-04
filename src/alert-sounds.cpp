#include "alert-sounds.h"

#include <QAudioOutput>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QMediaPlayer>
#include <QMetaEnum>
#include <QUrl>
#include <QUuid>
#include <cstdio>

namespace AlertSoundLibrary {

QStringList extensions() {
    return {QStringLiteral(".wav"), QStringLiteral(".mp3"), QStringLiteral(".m4a")};
}

QString fileDialogFilter() {
    QStringList patterns;
    for (const QString &extension : extensions()) patterns << QLatin1Char('*') + extension;
    return QStringLiteral("Sound files (%1)").arg(patterns.join(QLatin1Char(' ')));
}

QString resolveDirectory(const QByteArray &xdgDataHome, const QByteArray &home) {
    const QString xdg = QFile::decodeName(xdgDataHome);
    const QString base = xdg.startsWith(QLatin1Char('/')) ? xdg
                         : QFile::decodeName(home) + QStringLiteral("/.local/share");
    return base + QStringLiteral("/cielinux/sounds");
}

QString resolveDirectory() {
    QByteArray home = qgetenv("HOME");
    if (home.isEmpty()) home = QDir::homePath().toLocal8Bit();
    return resolveDirectory(qgetenv("XDG_DATA_HOME"), home);
}

QString kindName(bool failed) { return failed ? QStringLiteral("failed") : QStringLiteral("warning"); }

static QString extensionOf(const QString &path) {
    const QString name = path.mid(path.lastIndexOf(QLatin1Char('/')) + 1);
    const int dot = name.lastIndexOf(QLatin1Char('.'));
    return dot < 0 ? QString() : name.mid(dot);
}

bool isSupported(const QString &path) {
    return extensions().contains(extensionOf(path), Qt::CaseInsensitive);
}

bool isSoundFileName(const QString &name) {
    if (name.isEmpty() || name.contains(QLatin1Char('/')) || name.contains(QChar(0)) ||
        name == QLatin1String(".") || name == QLatin1String(".."))
        return false;
    const int dot = name.lastIndexOf(QLatin1Char('.'));
    return dot > 0 && isSupported(name);
}

} // namespace AlertSoundLibrary

namespace {
bool isKind(const QString &kind) {
    return kind == QLatin1String("failed") || kind == QLatin1String("warning");
}
} // namespace

QString SoundLibrary::importSound(const QString &kind, const QString &source, QString *error) const {
    QString ignored;
    QString &reason = error ? *error : ignored;
    if (!isKind(kind)) { reason = QStringLiteral("unknown-kind"); return {}; }
    if (!AlertSoundLibrary::isSupported(source)) { reason = QStringLiteral("unsupported-format"); return {}; }
    const QFileInfo sourceInfo(source);
    if (!sourceInfo.isFile()) { reason = QStringLiteral("not-a-file"); return {}; }
    const QString name = kind + AlertSoundLibrary::extensionOf(source).toLower();
    const QString target = pathOf(name);
    if (!QDir().mkpath(dir)) { reason = QStringLiteral("folder-unavailable"); return {}; }

    // Picking the already-imported copy itself keeps it: copying a file onto itself fails.
    const QString targetCanonical = QFileInfo(target).canonicalFilePath();
    if (targetCanonical.isEmpty() || targetCanonical != sourceInfo.canonicalFilePath() ||
        QFileInfo(target).isSymLink()) {
        // Copied beside the target and renamed over it (rename(2) replaces atomically and never
        // follows a planted symlink), so a failed copy leaves the previous sound whole.
        const QString temp = target + QLatin1Char('.') + QUuid::createUuid().toString(QUuid::Id128) +
                             QStringLiteral(".tmp");
        if (!QFile::copy(source, temp)) {
            QFile::remove(temp);
            reason = QStringLiteral("copy-failed");
            return {};
        }
        if (std::rename(QFile::encodeName(temp).constData(), QFile::encodeName(target).constData()) != 0) {
            QFile::remove(temp);
            reason = QStringLiteral("replace-failed");
            return {};
        }
    }

    // The new sound is in place: a stale file of another extension that cannot be deleted must
    // not fail the import; the next import or remove clears it.
    for (const QString &extension : AlertSoundLibrary::extensions()) {
        const QString other = pathOf(kind + extension);
        if (other != target) QFile::remove(other);
    }
    return name;
}

bool SoundLibrary::remove(const QString &kind, QString *error) const {
    if (!isKind(kind) || !QFileInfo::exists(dir)) return true;
    bool removed = true;
    for (const QString &extension : AlertSoundLibrary::extensions()) {
        const QString path = pathOf(kind + extension);
        const QFileInfo info(path);
        if ((info.exists() || info.isSymLink()) && !QFile::remove(path)) removed = false;
    }
    if (!removed && error) *error = QStringLiteral("delete-failed");
    return removed;
}

namespace {
class MediaOutput final : public AlertSoundOutput {
public:
    MediaOutput() {
        audio.setVolume(1.0f); // full volume, as CielWin's MediaPlayer output
        player.setAudioOutput(&audio);
        QObject::connect(&player, &QMediaPlayer::mediaStatusChanged, &player, [this](QMediaPlayer::MediaStatus status) {
            if (status == QMediaPlayer::EndOfMedia) player.setSource(QUrl()); // release the file
        });
        QObject::connect(&player, &QMediaPlayer::errorOccurred, &player, [this](QMediaPlayer::Error error, const QString &) {
            player.stop();
            player.setSource(QUrl());
            const char *name = QMetaEnum::fromType<QMediaPlayer::Error>().valueToKey(error);
            if (failed) failed(QString::fromLatin1(name ? name : "Unknown"));
        });
    }
    void play(const QString &path) override {
        player.stop();
        player.setSource(QUrl::fromLocalFile(path));
        player.play();
    }
private:
    QAudioOutput audio;
    QMediaPlayer player;
};
} // namespace

std::unique_ptr<AlertSoundOutput> createMediaOutput() { return std::make_unique<MediaOutput>(); }

AlertSoundPlayer::AlertSoundPlayer(Resolve resolve, OutputFactory createOutput, Trace trace)
    : resolve(std::move(resolve)), createOutput(std::move(createOutput)), trace(std::move(trace)) {}

void AlertSoundPlayer::play(const QString &kind) {
    auto emitTrace = [this](const QString &line) {
        try { if (trace) trace(line); } catch (...) {}
    };
    try {
        const QString path = resolve ? resolve(kind) : QString();
        if (path.isEmpty()) return;
        // Only a regular file inside the folder plays; a symlink planted there is never followed.
        const QFileInfo info(path);
        if (info.isSymLink() || !info.isFile()) {
            emitTrace(QStringLiteral("alert sound-skipped kind=%1 reason=missing-file").arg(kind));
            return;
        }
        AlertSoundOutput *output = outputFor(kind);
        if (!output) {
            emitTrace(QStringLiteral("alert sound-failed kind=%1 reason=no-output").arg(kind));
            return;
        }
        output->play(path);
        emitTrace(QStringLiteral("alert sound-played kind=%1").arg(kind));
    } catch (...) {
        emitTrace(QStringLiteral("alert sound-failed kind=%1 reason=exception").arg(kind));
    }
}

AlertSoundOutput *AlertSoundPlayer::outputFor(const QString &kind) {
    if (auto found = outputs.constFind(kind); found != outputs.constEnd()) return found->get();
    std::shared_ptr<AlertSoundOutput> output(createOutput ? createOutput() : nullptr);
    if (!output) return nullptr;
    output->failed = [this, kind](const QString &error) {
        try {
            if (trace) trace(QStringLiteral("alert sound-failed kind=%1 reason=media-failed error=%2").arg(kind, error));
        } catch (...) {}
    };
    outputs.insert(kind, output);
    return output.get();
}

AlertSounds::AlertSounds(Settings &settings, Persist persist, SoundLibrary library, Picker pick,
                         AlertSoundPlayer::OutputFactory outputs, AlertSoundPlayer::Trace trace, QObject *parent)
    : QObject(parent), settings(settings), persist(std::move(persist)), library(std::move(library)),
      pick(std::move(pick)), trace(trace),
      player([this](const QString &kind) {
          const QString name = soundFor(kind);
          return AlertSoundLibrary::isSoundFileName(name) ? this->library.pathOf(name) : QString();
      }, std::move(outputs), trace) {}

QString AlertSounds::soundFor(const QString &kind) const {
    if (kind == QLatin1String("failed")) return settings.failedSound;
    if (kind == QLatin1String("warning")) return settings.warningSound;
    return {};
}

void AlertSounds::setSound(const QString &kind, const QString &fileName) {
    if (kind == QLatin1String("failed")) settings.failedSound = fileName;
    else if (kind == QLatin1String("warning")) settings.warningSound = fileName;
}

void AlertSounds::log(const QString &line) const {
    try { if (trace) trace(line); } catch (...) {}
}

void AlertSounds::toggle() {
    settings.alertSoundsEnabled = !settings.alertSoundsEnabled;
    if (persist) persist();
    log(QStringLiteral("alert-sounds toggled enabled=%1")
            .arg(settings.alertSoundsEnabled ? QStringLiteral("on") : QStringLiteral("off")));
}

void AlertSounds::importSound(const QString &kind) {
    if (!isKind(kind)) return;
    QString source;
    try {
        source = pick ? pick(kind) : QString();
    } catch (...) {
        log(QStringLiteral("alert-sound pick-failed kind=%1").arg(kind));
        return;
    }
    if (source.isEmpty()) return; // cancelled
    if (!AlertSoundLibrary::isSupported(source)) {
        log(QStringLiteral("alert-sound import-rejected kind=%1 reason=unsupported-format").arg(kind));
        return;
    }
    QString error;
    const QString fileName = library.importSound(kind, source, &error);
    if (fileName.isEmpty()) {
        log(QStringLiteral("alert-sound import-failed kind=%1 reason=%2").arg(kind, error));
        return;
    }
    setSound(kind, fileName);
    if (persist) persist();
    log(QStringLiteral("alert-sound imported kind=%1").arg(kind));
}

void AlertSounds::removeSound(const QString &kind) {
    if (!isKind(kind)) return;
    // The setting is cleared even when the delete fails: the kind is silent either way, and the
    // next import replaces the stray file.
    QString error;
    if (!library.remove(kind, &error))
        log(QStringLiteral("alert-sound remove-failed kind=%1 reason=%2").arg(kind, error));
    setSound(kind, QString());
    if (persist) persist();
    log(QStringLiteral("alert-sound removed kind=%1").arg(kind));
}

void AlertSounds::onAlertShown(const QString &kind) {
    if (!enabled()) {
        if (hasSound(kind)) log(QStringLiteral("alert sound-muted kind=%1").arg(kind));
        return;
    }
    player.play(kind);
}

void AlertSounds::onAlertRepeated(const QString &kind) {
    if (enabled()) player.play(kind);
}

TraySounds AlertSounds::trayControls() {
    return TraySounds{
        [this] { return enabled(); },
        [this] { toggle(); },
        [this](const QString &kind) { return hasSound(kind); },
        [this](const QString &kind) { importSound(kind); },
        [this](const QString &kind) { removeSound(kind); }};
}

QString AlertSounds::pickWithDialog(const QString &kind) {
    QFileDialog dialog(nullptr, QStringLiteral("Import %1 sound").arg(kind), QString(),
                       AlertSoundLibrary::fileDialogFilter());
    dialog.setFileMode(QFileDialog::ExistingFile);
    dialog.setAcceptMode(QFileDialog::AcceptOpen);
    if (dialog.exec() != QDialog::Accepted) return {};
    return dialog.selectedFiles().value(0);
}
