#pragma once

#include <QByteArray>
#include <QObject>
#include <QString>
#include <functional>
#include <optional>
#include <string>

class QLocalServer;

// Local control of the running host, per user: `$XDG_RUNTIME_DIR/cielinux/` (mode 0700,
// owned by the user) holds `instance.lock` and `control.sock`.
//
// - Single instance (CielWin SingleInstanceGuard): a normal start takes an exclusive
//   non-blocking flock on instance.lock and holds it for its lifetime; the kernel drops
//   it when the process dies, so a crash never leaves a stale guard.
// - Commands: `cielinux --cycle-position next|prev` connects to control.sock, sends one
//   line `cycle-position next|prev`, prints nothing on `ok`, the reason on `ignored: …`,
//   and exits 0 (delivered); 1 when no instance answers or the reply is an error.
//   Both ends check the peer's uid (SO_PEERCRED); the socket is owner-only.
namespace InstanceControl {
enum class Command { Next, Prev };
// Exactly `next` or `prev`; anything else (case, spaces, aliases) is refused.
std::optional<Command> parseCommand(const QByteArray &word);
// `<xdgRuntimeDir>/cielinux`; empty when XDG_RUNTIME_DIR is unset or not absolute.
QString directory(const QByteArray &xdgRuntimeDir);
QString directory(); // From the process environment.
// Client side, plain POSIX (no Qt event loop): exit code as described above; `message`
// receives what to print on stderr (empty for a plain `ok`).
int sendCycle(const QString &dir, const QByteArray &word, std::string &message);
}

class InstanceServer : public QObject {
    Q_OBJECT
public:
    enum class Start { Acquired, AlreadyRunning, Unavailable };
    // The reply line for a command (without the newline): `ok`, `ignored: …` or `error: …`.
    using Handler = std::function<QByteArray(InstanceControl::Command)>;
    InstanceServer(QString dir, std::function<void(const QString &)> log, QObject *parent = nullptr);
    ~InstanceServer() override;

    // Prepares the directory and takes the lock. Usable before any Qt application exists.
    Start acquire();
    void setHandler(Handler handler) { m_handler = std::move(handler); }
    // Replaces a stale socket and listens; needs the lock (acquire() == Acquired).
    bool listen();
    QString socketPath() const;

private:
    void onConnection();
    QString m_dir;
    std::function<void(const QString &)> m_log;
    Handler m_handler;
    int m_lockFd = -1;
    QLocalServer *m_server = nullptr;
    int m_open = 0;
};
