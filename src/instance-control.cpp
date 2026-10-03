#include "instance-control.h"

#include <QFile>
#include <QLocalServer>
#include <QLocalSocket>
#include <QTimer>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

namespace {

constexpr int maxLine = 64;          // `cycle-position prev\n` is 20 bytes
constexpr int maxConnections = 4;
constexpr int requestTimeoutMs = 1000;
constexpr int replyTimeoutMs = 2000;

QString lockPath(const QString &dir) { return dir + QStringLiteral("/instance.lock"); }
QString sockPath(const QString &dir) { return dir + QStringLiteral("/control.sock"); }

// The uid at the other end of a connected Unix socket, or -1.
long peerUid(int fd) {
    ucred cred{};
    socklen_t size = sizeof cred;
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &size) != 0 || size != sizeof cred) return -1;
    return long(cred.uid);
}

// A real directory (not a symlink) owned by us with no group/other access.
bool privateDirectory(const QByteArray &path, bool tighten) {
    struct stat st {};
    if (lstat(path.constData(), &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != getuid()) return false;
    if ((st.st_mode & 077) == 0) return true;
    return tighten && chmod(path.constData(), 0700) == 0;
}

} // namespace

namespace InstanceControl {

std::optional<Command> parseCommand(const QByteArray &word) {
    if (word == "next") return Command::Next;
    if (word == "prev") return Command::Prev;
    return std::nullopt;
}

QString directory(const QByteArray &xdgRuntimeDir) {
    if (!xdgRuntimeDir.startsWith('/')) return {};
    return QFile::decodeName(xdgRuntimeDir) + QStringLiteral("/cielinux");
}

QString directory() { return directory(qgetenv("XDG_RUNTIME_DIR")); }

int sendCycle(const QString &dir, const QByteArray &word, std::string &message) {
    message.clear();
    if (!parseCommand(word)) { message = "Usage: cielinux --cycle-position next|prev"; return 2; }
    const QByteArray path = QFile::encodeName(sockPath(dir));
    const std::string where = " (" + path.toStdString() + ")";
    const QByteArray dirBytes = QFile::encodeName(dir);
    struct stat st {};
    if (dir.isEmpty() || lstat(dirBytes.constData(), &st) != 0) {
        message = "no running CieLinux instance" + where;
        return 1;
    }
    if (!privateDirectory(dirBytes, false)) {
        message = "refused: " + dirBytes.toStdString() + " is not a private directory owned by you";
        return 1;
    }
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    if (size_t(path.size()) >= sizeof address.sun_path) { message = "control socket path too long" + where; return 1; }
    std::memcpy(address.sun_path, path.constData(), size_t(path.size()));
    const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { message = std::string("cannot create a socket: ") + std::strerror(errno); return 1; }
    struct Closer { int fd; ~Closer() { close(fd); } } closer{fd};
    if (connect(fd, reinterpret_cast<const sockaddr *>(&address), sizeof address) != 0) {
        message = (errno == ENOENT || errno == ECONNREFUSED)
            ? "no running CieLinux instance" + where
            : std::string("cannot reach CieLinux: ") + std::strerror(errno) + where;
        return 1;
    }
    if (peerUid(fd) != long(getuid())) { message = "refused: the control socket belongs to another user" + where; return 1; }
    const QByteArray line = "cycle-position " + word + "\n";
    if (send(fd, line.constData(), size_t(line.size()), MSG_NOSIGNAL) != line.size()) {
        message = std::string("cannot send to CieLinux: ") + std::strerror(errno);
        return 1;
    }
    std::string reply;
    int waited = 0;
    char buffer[256];
    while (reply.find('\n') == std::string::npos && reply.size() < 256 && waited < replyTimeoutMs) {
        pollfd p{fd, POLLIN, 0};
        const int ready = poll(&p, 1, 100);
        if (ready < 0 && errno != EINTR) break;
        if (ready <= 0) { waited += 100; continue; }
        const ssize_t n = read(fd, buffer, sizeof buffer);
        if (n <= 0) break;
        reply.append(buffer, size_t(n));
    }
    const size_t end = reply.find('\n');
    if (end == std::string::npos) { message = "no reply from CieLinux" + where; return 1; }
    reply.resize(end);
    if (reply == "ok") return 0;
    message = reply;
    return reply.rfind("ignored: ", 0) == 0 ? 0 : 1;
}

} // namespace InstanceControl

InstanceServer::InstanceServer(QString dir, std::function<void(const QString &)> log, QObject *parent)
    : QObject(parent), m_dir(std::move(dir)), m_log(std::move(log)) {}

InstanceServer::~InstanceServer() {
    delete m_server; // closes and removes the socket before the lock is released
    if (m_lockFd >= 0) close(m_lockFd);
}

QString InstanceServer::socketPath() const { return sockPath(m_dir); }

InstanceServer::Start InstanceServer::acquire() {
    if (m_lockFd >= 0) return Start::Acquired;
    if (m_dir.isEmpty()) {
        m_log(QStringLiteral("CIELINUX_IPC unavailable: XDG_RUNTIME_DIR is unset or not absolute"));
        return Start::Unavailable;
    }
    const QByteArray dir = QFile::encodeName(m_dir);
    if (mkdir(dir.constData(), 0700) != 0 && errno != EEXIST) {
        m_log(QStringLiteral("CIELINUX_IPC unavailable: cannot create %1: %2").arg(m_dir, QString::fromLocal8Bit(std::strerror(errno))));
        return Start::Unavailable;
    }
    if (!privateDirectory(dir, true)) {
        m_log(QStringLiteral("CIELINUX_IPC unavailable: %1 is not a private directory owned by this user").arg(m_dir));
        return Start::Unavailable;
    }
    const QByteArray lock = QFile::encodeName(lockPath(m_dir));
    const int fd = open(lock.constData(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0) {
        m_log(QStringLiteral("CIELINUX_IPC unavailable: cannot open the instance lock: %1").arg(QString::fromLocal8Bit(std::strerror(errno))));
        return Start::Unavailable;
    }
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        const int error = errno;
        close(fd);
        if (error == EWOULDBLOCK) return Start::AlreadyRunning;
        m_log(QStringLiteral("CIELINUX_IPC unavailable: cannot lock: %1").arg(QString::fromLocal8Bit(std::strerror(error))));
        return Start::Unavailable;
    }
    fchmod(fd, 0600);
    m_lockFd = fd;
    return Start::Acquired;
}

bool InstanceServer::listen() {
    if (m_lockFd < 0) return false;
    if (m_server) return m_server->isListening();
    // We hold the lock, so any socket file left here belongs to a dead instance.
    QLocalServer::removeServer(socketPath());
    m_server = new QLocalServer;
    m_server->setSocketOptions(QLocalServer::UserAccessOption);
    m_server->setMaxPendingConnections(maxConnections);
    if (!m_server->listen(socketPath())) {
        m_log(QStringLiteral("CIELINUX_IPC unavailable: cannot listen: %1").arg(m_server->errorString()));
        delete m_server;
        m_server = nullptr;
        return false;
    }
    const QByteArray path = QFile::encodeName(socketPath());
    chmod(path.constData(), 0600);
    connect(m_server, &QLocalServer::newConnection, this, &InstanceServer::onConnection);
    m_log(QStringLiteral("CIELINUX_IPC listening"));
    return true;
}

void InstanceServer::onConnection() {
    while (QLocalSocket *socket = m_server->nextPendingConnection()) {
        connect(socket, &QLocalSocket::disconnected, socket, &QObject::deleteLater);
        const long uid = peerUid(int(socket->socketDescriptor()));
        if (uid != long(getuid())) {
            m_log(QStringLiteral("CIELINUX_IPC rejected peer-uid=%1").arg(uid));
            socket->abort();
            socket->deleteLater();
            continue;
        }
        if (m_open >= maxConnections) {
            m_log(QStringLiteral("CIELINUX_IPC rejected busy"));
            socket->abort();
            socket->deleteLater();
            continue;
        }
        ++m_open;
        connect(socket, &QObject::destroyed, this, [this] { --m_open; });
        auto buffer = std::make_shared<QByteArray>();
        auto done = std::make_shared<bool>(false);
        const auto reply = [socket, done](const QByteArray &line) {
            *done = true;
            socket->write(line + '\n');
            socket->disconnectFromServer(); // flushes, then closes
        };
        QTimer::singleShot(requestTimeoutMs, socket, [socket] { socket->abort(); socket->deleteLater(); });
        connect(socket, &QLocalSocket::readyRead, this, [this, socket, buffer, done, reply] {
            if (*done) { socket->readAll(); return; }
            *buffer += socket->read(maxLine + 2);
            const int newline = buffer->indexOf('\n');
            if (newline < 0) {
                if (buffer->size() > maxLine) reply("error: request too long");
                return;
            }
            if (newline != buffer->size() - 1 || socket->bytesAvailable()) {
                m_log(QStringLiteral("CIELINUX_IPC rejected extra-data"));
                reply("error: one command per connection");
                return;
            }
            const QByteArray line = buffer->left(newline);
            const QByteArray prefix = "cycle-position ";
            const auto command = line.startsWith(prefix)
                ? InstanceControl::parseCommand(line.mid(prefix.size())) : std::nullopt;
            if (!command) {
                m_log(QStringLiteral("CIELINUX_IPC rejected unknown-command"));
                reply("error: unknown command (expected `cycle-position next` or `cycle-position prev`)");
                return;
            }
            reply(m_handler ? m_handler(*command) : QByteArray("ignored: starting"));
        });
    }
}
