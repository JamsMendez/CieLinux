#include "http-token.h"

#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QRandomGenerator>
#include <QThread>

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {
constexpr int lockTimeoutMs = 5000;
// A token file larger than this is malformed by definition; never slurped.
constexpr qint64 maxReadBytes = 4096;

using Diagnostic = std::function<void(const QString &)>;

QString errnoText() { return QString::fromLocal8Bit(std::strerror(errno)); }

// Creates every missing directory of `dir` (parents with the default umask, the
// leaf 0700) and makes sure the leaf is a real directory with 0700.
bool ensurePrivateDirectory(const QString &dir, const Diagnostic &report) {
    const QFileInfo parent(QFileInfo(dir).absolutePath());
    if (!parent.exists() && !QDir().mkpath(parent.absoluteFilePath())) {
        report(QStringLiteral("could not create %1").arg(parent.absoluteFilePath()));
        return false;
    }
    const QByteArray native = QFile::encodeName(dir);
    if (::mkdir(native.constData(), 0700) != 0 && errno != EEXIST) {
        report(QStringLiteral("could not create %1: %2").arg(dir, errnoText()));
        return false;
    }
    struct stat info {};
    if (::lstat(native.constData(), &info) != 0 || !S_ISDIR(info.st_mode)) {
        report(QStringLiteral("%1 is not a directory").arg(dir));
        return false;
    }
    if ((info.st_mode & 0777) != 0700 && info.st_uid == ::geteuid() && ::chmod(native.constData(), 0700) != 0) {
        report(QStringLiteral("could not restrict %1: %2").arg(dir, errnoText()));
        return false;
    }
    return true;
}

QByteArray generate() {
    QByteArray bytes(HttpToken::randomBytes, Qt::Uninitialized);
    QRandomGenerator::system()->generate(reinterpret_cast<quint32 *>(bytes.data()),
                                         reinterpret_cast<quint32 *>(bytes.data() + bytes.size()));
    return bytes.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}

bool writeAll(int fd, const QByteArray &bytes) {
    qsizetype done = 0;
    while (done < bytes.size()) {
        const ssize_t n = ::write(fd, bytes.constData() + done, size_t(bytes.size() - done));
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return false;
        done += n;
    }
    return true;
}

// Temp file (O_EXCL, 0600) beside the target, fsync, rename over it.
bool writeToken(const QString &path, const QByteArray &token, const Diagnostic &report) {
    const QByteArray target = QFile::encodeName(path);
    const QByteArray temp = target + ".tmp." + QByteArray::number(::getpid()) + '.'
                            + QByteArray::number(QRandomGenerator::system()->generate(), 16);
    const int fd = ::open(temp.constData(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0) {
        report(QStringLiteral("failed to write %1: %2").arg(path, errnoText()));
        return false;
    }
    const bool written = writeAll(fd, token + '\n') && ::fsync(fd) == 0;
    const int savedErrno = errno;
    ::close(fd);
    if (!written || ::rename(temp.constData(), target.constData()) != 0) {
        if (written) errno = savedErrno;
        report(QStringLiteral("failed to write %1: %2").arg(path, errnoText()));
        ::unlink(temp.constData());
        return false;
    }
    return true;
}

enum class ReadOutcome { Missing, Read, Failed };

// O_NOFOLLOW: a symlink planted at the token path is never read through; it is
// treated as malformed and replaced by the rename.
ReadOutcome readExisting(const QString &path, QByteArray *out, int *fdOut, const Diagnostic &report) {
    const QByteArray native = QFile::encodeName(path);
    const int fd = ::open(native.constData(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) {
        if (errno == ENOENT) return ReadOutcome::Missing;
        if (errno == ELOOP) { out->clear(); *fdOut = -1; return ReadOutcome::Read; }
        report(QStringLiteral("failed to read %1: %2").arg(path, errnoText()));
        return ReadOutcome::Failed;
    }
    struct stat info {};
    if (::fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) {
        ::close(fd);
        report(QStringLiteral("failed to read %1: not a regular file").arg(path));
        return ReadOutcome::Failed;
    }
    QByteArray bytes(maxReadBytes + 1, Qt::Uninitialized);
    qsizetype total = 0;
    while (total < bytes.size()) {
        const ssize_t n = ::read(fd, bytes.data() + total, size_t(bytes.size() - total));
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) {
            ::close(fd);
            report(QStringLiteral("failed to read %1: %2").arg(path, errnoText()));
            return ReadOutcome::Failed;
        }
        if (n == 0) break;
        total += n;
    }
    bytes.truncate(total);
    *out = total > maxReadBytes ? QByteArray() : bytes.trimmed();
    *fdOut = fd;
    return ReadOutcome::Read;
}

QByteArray loadOrCreateLocked(const QString &path, const Diagnostic &report) {
    QByteArray existing;
    int fd = -1;
    const ReadOutcome outcome = readExisting(path, &existing, &fd, report);
    if (outcome == ReadOutcome::Failed) return {};
    if (outcome == ReadOutcome::Read && HttpToken::isValid(existing)) {
        struct stat info {};
        // Kept unchanged; only a too-open mode is tightened.
        if (::fstat(fd, &info) == 0 && (info.st_mode & 0777) != 0600 && ::fchmod(fd, 0600) != 0) {
            report(QStringLiteral("could not restrict %1: %2").arg(path, errnoText()));
            ::close(fd);
            return {};
        }
        ::close(fd);
        return existing;
    }
    if (fd >= 0) ::close(fd);
    if (outcome == ReadOutcome::Read)
        report(QStringLiteral("%1 held an invalid token; replacing it with a freshly generated one.").arg(path));
    const QByteArray token = generate();
    if (!writeToken(path, token, report)) return {};
    return token;
}
} // namespace

namespace HttpToken {
QString resolvePath(const QByteArray &xdgStateHome, const QByteArray &home) {
    const QString xdg = QFile::decodeName(xdgStateHome);
    const QString base = xdg.startsWith(QLatin1Char('/')) ? xdg
                         : QFile::decodeName(home) + QStringLiteral("/.local/state");
    return base + QStringLiteral("/cielinux/http.token");
}

QString resolvePath() {
    QByteArray home = qgetenv("HOME");
    if (home.isEmpty()) home = QDir::homePath().toLocal8Bit();
    return resolvePath(qgetenv("XDG_STATE_HOME"), home);
}

bool isValid(const QByteArray &value) {
    if (value.size() != length) return false;
    for (const char c : value) {
        const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                        || c == '-' || c == '_';
        if (!ok) return false;
    }
    return true;
}

QByteArray loadOrCreate(const QString &path, const std::function<void(const QString &)> &diagnostic) {
    const Diagnostic report = [&](const QString &line) {
        if (diagnostic) diagnostic(QStringLiteral("http token: ") + line);
    };
    if (path.isEmpty() || !path.startsWith(QLatin1Char('/'))) {
        report(QStringLiteral("the token path must be absolute"));
        return {};
    }
    if (!ensurePrivateDirectory(QFileInfo(path).absolutePath(), report)) return {};

    const QByteArray lockPath = QFile::encodeName(path) + ".lock";
    const int lock = ::open(lockPath.constData(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (lock < 0) {
        report(QStringLiteral("could not open the token lock: %1").arg(errnoText()));
        return {};
    }
    QElapsedTimer waited;
    waited.start();
    while (::flock(lock, LOCK_EX | LOCK_NB) != 0) {
        if ((errno != EWOULDBLOCK && errno != EINTR) || waited.elapsed() > lockTimeoutMs) {
            report(QStringLiteral("timed out waiting for the token lock for %1.").arg(path));
            ::close(lock);
            return {};
        }
        QThread::msleep(10);
    }
    const QByteArray token = loadOrCreateLocked(path, report);
    ::flock(lock, LOCK_UN);
    ::close(lock);
    return token;
}
} // namespace HttpToken
