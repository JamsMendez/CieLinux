#include "fullscreen-watch.h"

#include "mini-position.h"

#include <QDateTime>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QStringList>
#include <algorithm>
#include <memory>
#include <unistd.h>

namespace {
// One event line or one request answer larger than this is not Hyprland talking.
constexpr qsizetype maxEventLine = 64 * 1024;
constexpr qsizetype maxAnswer = 4 * 1024 * 1024;
// A request socket that has not answered in this long counts as a failed query. Only time the event
// loop actually ran counts (B12): the answer is read on loop turns, so a loop blocked for seconds
// (a scene page being built) says nothing about Hyprland. The command itself goes out at connect
// time (B13, see request()). It is measured in ticks; a tick that arrives much later than due marks
// a stall and is not counted.
constexpr int requestTimeoutMs = 1000;
constexpr int requestTickMs = 250;
// Bounds the wait even on a loop that keeps stalling.
constexpr int requestWallLimitMs = 10000;
// Events arrive in bursts (a workspace switch sends workspace, workspacev2, focusedmon, ...): one
// query per burst. Also lets Hyprland finish the state change the event announced.
constexpr int coalesceMs = 50;
// Hyprland's internal fullscreen state: 1 = maximised, 2 = fullscreen, 3 = both.
constexpr int fullscreenBit = 2;
}

namespace HyprlandIpc {

QStringList instanceDirs() {
    // An instance directory is usable when its event socket exists and belongs to this user.
    auto usable = [](const QString &dir) {
        const QFileInfo socket(dir + QStringLiteral("/.socket2.sock"));
        return socket.exists() && !socket.isDir() && socket.ownerId() == getuid();
    };
    QStringList roots;
    const QByteArray runtime = qgetenv("XDG_RUNTIME_DIR");
    if (runtime.startsWith('/')) roots << QFile::decodeName(runtime);
    roots << QStringLiteral("/run/user/%1").arg(getuid());
    QStringList dirs;
    const QByteArray signature = qgetenv("HYPRLAND_INSTANCE_SIGNATURE");
    if (!signature.isEmpty() && !signature.contains('/') && !signature.startsWith('.')) {
        for (const QString &root : roots) {
            const QString dir = root + QStringLiteral("/hypr/") + QString::fromLatin1(signature);
            if (usable(dir)) { dirs << dir; break; }
        }
    }
    // Discovery stays in the session's own runtime dir: the instance Hyprland runs for it.
    const QString hypr = roots.first() + QStringLiteral("/hypr");
    QList<QPair<QDateTime, QString>> found;
    // Hidden entries (a leading ".") are not listed.
    for (const QFileInfo &entry : QDir(hypr).entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot)) {
        const QString dir = hypr + u'/' + entry.fileName();
        if (dirs.contains(dir) || entry.ownerId() != getuid() || !usable(dir)) continue;
        found.append({QFileInfo(dir + QStringLiteral("/.socket2.sock")).lastModified(), dir});
    }
    std::sort(found.begin(), found.end(), [](const auto &a, const auto &b) {
        return a.first != b.first ? a.first > b.first : a.second > b.second;
    });
    for (const auto &entry : found) dirs << entry.second;
    return dirs;
}

std::optional<bool> fullscreenCovers(const QByteArray &monitorsJson, const QByteArray &clientsJson,
                                     const QString &monitor) {
    const QJsonDocument monitors = QJsonDocument::fromJson(monitorsJson);
    const QJsonDocument clients = QJsonDocument::fromJson(clientsJson);
    if (!monitors.isArray() || !clients.isArray()) return std::nullopt;
    QSet<int> shown;
    bool found = false;
    for (const QJsonValue &value : monitors.array()) {
        const QJsonObject object = value.toObject();
        if (object.value(QStringLiteral("name")).toString() != monitor) continue;
        const QJsonValue active = object.value(QStringLiteral("activeWorkspace")).toObject().value(QStringLiteral("id"));
        if (!active.isDouble()) return std::nullopt;
        shown.insert(active.toInt());
        // Special workspace id 0 means none is shown on this monitor.
        const int special = object.value(QStringLiteral("specialWorkspace")).toObject().value(QStringLiteral("id")).toInt(0);
        if (special != 0) shown.insert(special);
        found = true;
        break;
    }
    if (!found) return std::nullopt;
    for (const QJsonValue &value : clients.array()) {
        const QJsonObject client = value.toObject();
        if (!client.value(QStringLiteral("mapped")).toBool(false) || client.value(QStringLiteral("hidden")).toBool(false))
            continue;
        if (!(client.value(QStringLiteral("fullscreen")).toInt(0) & fullscreenBit)) continue;
        const QJsonValue workspace = client.value(QStringLiteral("workspace")).toObject().value(QStringLiteral("id"));
        if (workspace.isDouble() && shown.contains(workspace.toInt())) return true;
    }
    return false;
}

bool triggersQuery(const QByteArray &eventName) {
    static const QSet<QByteArray> names{
        "fullscreen", "workspace", "workspacev2", "focusedmon", "focusedmonv2", "activespecial", "activespecialv2",
        "moveworkspace", "moveworkspacev2", "movewindow", "movewindowv2", "openwindow", "closewindow",
        "monitoradded", "monitoraddedv2", "monitorremoved", "monitorremovedv2", "destroyworkspace", "destroyworkspacev2",
        // B9: a bar (layer surface) opening or closing, or a config reload, moves the reserved zones.
        "openlayer", "closelayer", "configreloaded"};
    return names.contains(eventName);
}

bool affectsReserved(const QByteArray &eventName) {
    static const QSet<QByteArray> names{"openlayer", "closelayer", "configreloaded", "monitoradded",
                                        "monitoraddedv2", "monitorremoved", "monitorremovedv2"};
    return names.contains(eventName);
}

std::optional<QPoint> monitorOrigin(const QByteArray &monitorsJson, const QString &monitor) {
    const QJsonDocument doc = QJsonDocument::fromJson(monitorsJson);
    if (!doc.isArray()) return std::nullopt;
    for (const QJsonValue &value : doc.array()) {
        const QJsonObject object = value.toObject();
        if (object.value(QStringLiteral("name")).toString() != monitor) continue;
        const QJsonValue x = object.value(QStringLiteral("x")), y = object.value(QStringLiteral("y"));
        if (!x.isDouble() || !y.isDouble()) return std::nullopt;
        return QPoint(x.toInt(), y.toInt());
    }
    return std::nullopt;
}

std::optional<QPoint> cursorPosition(const QByteArray &cursorJson) {
    const QJsonObject object = QJsonDocument::fromJson(cursorJson).object();
    const QJsonValue x = object.value(QStringLiteral("x")), y = object.value(QStringLiteral("y"));
    if (!x.isDouble() || !y.isDouble()) return std::nullopt;
    // Hyprland may report sub-pixel positions; the mini's geometry is whole logical px.
    return QPoint(qRound(x.toDouble()), qRound(y.toDouble()));
}

} // namespace HyprlandIpc

FullscreenWatch::FullscreenWatch(QString monitor, Trace trace, QObject *parent)
    : QObject(parent), m_monitor(std::move(monitor)), m_trace(std::move(trace)) {
    if (!m_trace) m_trace = [](const QString &) {};
    m_coalesce.setSingleShot(true);
    m_coalesce.setInterval(coalesceMs);
    connect(&m_coalesce, &QTimer::timeout, this, &FullscreenWatch::runQuery);
    m_retry.setSingleShot(true);
    connect(&m_retry, &QTimer::timeout, this, &FullscreenWatch::tryConnect);
    m_queryRetry.setSingleShot(true);
    connect(&m_queryRetry, &QTimer::timeout, this, &FullscreenWatch::runQuery);
    connect(&m_events, &QLocalSocket::connected, this, [this] {
        if (!m_connecting) return;
        m_connecting = false;
        m_connected = true;
        m_delay = m_firstDelay;
        m_buffer.clear();
        m_trace(QStringLiteral("fullscreen-watch %1 monitor=%2")
                    .arg(m_reconnecting ? QStringLiteral("reconnected") : QStringLiteral("started"), m_monitor));
        m_outageLogged = m_reconnecting = false;
        runQuery(); // the state right now, before any event
    });
    connect(&m_events, &QLocalSocket::readyRead, this, &FullscreenWatch::onEvents);
    connect(&m_events, &QLocalSocket::errorOccurred, this, [this](QLocalSocket::LocalSocketError) {
        if (!m_connecting) return; // a drop after the start is reported once by `disconnected`
        m_connecting = false;
        // The next candidate on the next loop turn, outside this socket's signal.
        QTimer::singleShot(0, this, [this, generation = m_generation] {
            if (generation == m_generation) connectNext();
        });
    });
    connect(&m_events, &QLocalSocket::disconnected, this, [this] {
        if (!m_connected) return;
        m_connected = false;
        ++m_generation;
        m_querying = m_dirty = false;
        m_coalesce.stop();
        // The reconnect path asks again once connected; a failure streak ends with the connection.
        m_queryRetry.stop();
        m_queryDelay = m_queryFirstDelay;
        m_queryFailing = false;
        // Hyprland exited or restarted: the wallpaper reads as visible meanwhile, as CielWin's
        // failed check does, and the watch looks for it again.
        m_trace(QStringLiteral("fullscreen-watch lost"));
        m_outageLogged = m_reconnecting = true;
        setCovered(false);
        m_delay = m_firstDelay;
        scheduleRetry();
    });
}

FullscreenWatch::~FullscreenWatch() {
    // The sockets would otherwise report their own abort while this object's members are already
    // gone (`disconnected` -> `lost`, uncovered, a retry on a destroyed timer) and late answers
    // would still reach the query callbacks.
    ++m_generation;
    m_started = false;
    m_retry.stop();
    m_coalesce.stop();
    m_queryRetry.stop();
    m_events.disconnect(this);
    m_events.abort();
    for (QLocalSocket *socket : findChildren<QLocalSocket *>(Qt::FindDirectChildrenOnly)) {
        socket->disconnect();
        socket->abort();
    }
}

void FullscreenWatch::setRetryDelays(int firstMs, int maxMs) {
    m_firstDelay = m_delay = qMax(1, firstMs);
    m_maxDelay = qMax(m_firstDelay, maxMs);
}

void FullscreenWatch::setQueryRetryDelays(int firstMs, int maxMs) {
    m_queryFirstDelay = m_queryDelay = qMax(1, firstMs);
    m_queryMaxDelay = qMax(m_queryFirstDelay, maxMs);
}

void FullscreenWatch::start() {
    if (m_started) return;
    m_started = true;
    tryConnect();
}

const char *FullscreenWatch::logPrefix(const QString &line) {
    return line.startsWith(QLatin1String("fullscreen-watch ")) ? "CIELINUX_HYPRLAND" : "CIELINUX_WALLPAPER";
}

void FullscreenWatch::setCoverage(bool enabled) {
    if (enabled == m_coverage) return;
    m_coverage = enabled;
    m_trace(QStringLiteral("fullscreen-watch coverage %1 monitor=%2")
                .arg(enabled ? QStringLiteral("on") : QStringLiteral("off"), m_monitor));
    if (!enabled) {
        // Quietly: the mode switch re-evaluates pause and alerts itself, and an update from inside
        // the switch would run before the new surface is in place.
        m_covered = false;
        m_queryFailing = false;
        return;
    }
    // The state right now, as on (re)connect; a running query is asked again once answered.
    if (m_querying) m_dirty = true;
    else if (m_connected) runQuery();
}

void FullscreenWatch::tryConnect() {
    if (!m_started || m_connected || m_connecting) return;
    m_candidates = HyprlandIpc::instanceDirs();
    if (m_candidates.isEmpty()) {
        if (!m_outageLogged) m_trace(QStringLiteral("fullscreen-watch unavailable reason=no-hyprland-socket"));
        connectFailed();
        return;
    }
    connectNext();
}

void FullscreenWatch::connectNext() {
    if (!m_started || m_connected) return;
    if (m_candidates.isEmpty()) {
        if (!m_outageLogged) m_trace(QStringLiteral("fullscreen-watch unavailable reason=connect-failed"));
        connectFailed();
        return;
    }
    m_instance = m_candidates.takeFirst();
    m_events.abort();
    m_connecting = true;
    m_events.connectToServer(m_instance + QStringLiteral("/.socket2.sock"), QIODevice::ReadOnly);
}

void FullscreenWatch::connectFailed() {
    // The outage is logged once (`unavailable` at start, `lost` later); retries are silent.
    m_outageLogged = true;
    scheduleRetry();
}

void FullscreenWatch::scheduleRetry() {
    m_retry.start(m_delay);
    m_delay = qMin(m_delay * 2, m_maxDelay);
}

void FullscreenWatch::onEvents() {
    m_buffer += m_events.readAll();
    bool relevant = false;
    for (qsizetype end = m_buffer.indexOf('\n'); end >= 0; end = m_buffer.indexOf('\n')) {
        const QByteArray line = m_buffer.left(end);
        m_buffer.remove(0, end + 1);
        const qsizetype separator = line.indexOf(">>");
        if (separator <= 0) continue;
        const QByteArray name = line.left(separator);
        // Coverage off (mini): only what can move the reserved zones is worth a query.
        if (m_coverage ? HyprlandIpc::triggersQuery(name) : HyprlandIpc::affectsReserved(name)) relevant = true;
    }
    if (m_buffer.size() > maxEventLine) m_buffer.clear();
    if (relevant) scheduleQuery();
}

void FullscreenWatch::scheduleQuery() {
    if (m_querying) {
        m_dirty = true; // asked again once the running query is answered
        return;
    }
    if (!m_coalesce.isActive()) m_coalesce.start();
}

void FullscreenWatch::runQuery() {
    if (m_querying || !m_connected) return;
    m_queryRetry.stop(); // this query is the retry
    m_querying = true;
    m_dirty = false;
    const quint64 generation = m_generation;
    request("j/monitors", [this, generation](std::optional<QByteArray> monitors) {
        if (generation != m_generation) return; // a dropped connection's answer
        if (!monitors) { finishQuery(std::nullopt); return; }
        // B9: the reserved zones ride along; an unreadable answer keeps the last known ones.
        const auto reserved = MiniPlacement::parseHyprlandReserved(*monitors, m_monitor);
        if (reserved) m_reserved = reserved;
        // The hover dodge maps the cursor onto this output with the origin from the same answer.
        if (const auto origin = HyprlandIpc::monitorOrigin(*monitors, m_monitor)) m_origin = origin;
        // B10: coverage off (mini) needs the reserved zones only, and is never covered. B12: an
        // unreadable answer is a failed query there too (logged once, retried).
        if (!m_coverage) { finishQuery(reserved ? std::optional<bool>(false) : std::nullopt); return; }
        request("j/clients", [this, monitors, generation](std::optional<QByteArray> clients) {
            if (generation != m_generation) return;
            if (!m_coverage) { finishQuery(false); return; } // switched to the mini meanwhile
            finishQuery(clients ? HyprlandIpc::fullscreenCovers(*monitors, *clients, m_monitor) : std::nullopt);
        });
    });
}

bool FullscreenWatch::queryCursor(std::function<void(std::optional<QPoint>)> done) {
    if (!m_connected || !m_origin) return false;
    request("j/cursorpos", [this, done = std::move(done), generation = m_generation](std::optional<QByteArray> answer) {
        // A dropped connection's answer (and the origin it was meant for) says nothing.
        const auto cursor = answer && generation == m_generation ? HyprlandIpc::cursorPosition(*answer) : std::nullopt;
        done(cursor && m_origin ? std::optional<QPoint>(*cursor - *m_origin) : std::nullopt);
    });
    return true;
}

void FullscreenWatch::request(const QByteArray &command, std::function<void(std::optional<QByteArray>)> done) {
    // The instance the event socket is connected to, which may not be the one in the environment.
    const QString path = m_instance + QStringLiteral("/.socket.sock");
    // Hyprland reads the command, writes the answer and closes the connection.
    auto *socket = new QLocalSocket(this);
    auto *timeout = new QTimer(socket);
    auto answer = std::make_shared<QByteArray>();
    auto finished = std::make_shared<bool>(false);
    auto finish = [socket, done, finished](std::optional<QByteArray> result) {
        if (*finished) return;
        *finished = true;
        socket->disconnect();
        socket->abort();
        socket->deleteLater();
        done(std::move(result));
    };
    // B12: the timeout counts loop-running time only (see requestTimeoutMs).
    auto wall = std::make_shared<QElapsedTimer>();
    auto sinceTick = std::make_shared<QElapsedTimer>();
    auto counted = std::make_shared<qint64>(0);
    wall->start();
    sinceTick->start();
    timeout->setTimerType(Qt::PreciseTimer);
    connect(timeout, &QTimer::timeout, socket, [finish, wall, sinceTick, counted] {
        const qint64 gap = sinceTick->restart();
        // A late tick means the loop was blocked: the socket's pending work runs on the next turns.
        if (gap <= 2 * requestTickMs) *counted += gap;
        if (*counted >= requestTimeoutMs || wall->elapsed() >= requestWallLimitMs) finish(std::nullopt);
    });
    // B13: Hyprland reads the command synchronously on its main thread right after accepting the
    // connection (and waits up to 5 s for it), so the whole compositor waits until it arrives. Hand
    // it to the kernel now (flush() does not block), not on a later loop turn: a GUI thread busy
    // with a Wayland roundtrip (QtWebEngine's first EGL init) would otherwise deadlock with it.
    connect(socket, &QLocalSocket::connected, socket, [socket, command] {
        socket->write(command);
        socket->flush();
    });
    connect(socket, &QLocalSocket::readyRead, socket, [socket, answer, finish] {
        *answer += socket->readAll();
        if (answer->size() > maxAnswer) finish(std::nullopt);
    });
    connect(socket, &QLocalSocket::disconnected, socket, [socket, answer, finish] {
        *answer += socket->readAll();
        finish(*answer);
    });
    connect(socket, &QLocalSocket::errorOccurred, socket, [finish](QLocalSocket::LocalSocketError error) {
        // The peer closing after its answer is the normal end; `disconnected` delivers it.
        if (error == QLocalSocket::PeerClosedError) return;
        finish(std::nullopt);
    });
    timeout->start(requestTickMs);
    socket->connectToServer(path);
}

void FullscreenWatch::finishQuery(std::optional<bool> covered) {
    m_querying = false;
    if (!m_connected) return; // the event socket went away meanwhile: already uncovered
    if (covered) {
        m_queryRetry.stop();
        m_queryDelay = m_queryFirstDelay;
        if (m_queryFailing) m_trace(QStringLiteral("fullscreen-watch query-recovered"));
        m_queryFailing = false;
        setCovered(*covered);
    } else {
        // A failed check reads as "not covered"; only the first failure of a streak is logged.
        if (!m_queryFailing) m_trace(QStringLiteral("fullscreen-watch query-failed"));
        m_queryFailing = true;
        setCovered(false);
        // B12: asked again soon (bounded backoff, silent) rather than at the next Hyprland event,
        // which may be minutes away while a fullscreen window sits still.
        if (!m_dirty) {
            m_queryRetry.start(m_queryDelay);
            m_queryDelay = qMin(m_queryDelay * 2, m_queryMaxDelay);
        }
    }
    if (m_dirty) scheduleQuery();
}

void FullscreenWatch::setCovered(bool covered) {
    if (covered == m_covered) return;
    m_covered = covered;
    m_trace(QStringLiteral("%1 monitor=%2").arg(covered ? QStringLiteral("covered") : QStringLiteral("uncovered"), m_monitor));
    emit coveredChanged(covered);
}
