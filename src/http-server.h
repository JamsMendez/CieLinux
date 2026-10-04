#pragma once

#include <QByteArray>
#include <QObject>
#include <QString>
#include <functional>

class QHostAddress;
class QTcpServer;

// The local HTTP server, ported from CielWin's LocalHttpCommandServer
// (CielWin/CielWin.Interop/LocalHttpCommandServer.cs) with its route rules
// (WallpaperSceneHttpProtocol.cs, AlertHttpProtocol.cs, AlertReplyProtocol.cs).
//
// Loopback only: 127.0.0.1, plus ::1 when available (CielWin's `localhost`
// prefix, which may resolve to the IPv6 loopback). Every reply is plain text,
// `ok` (`ok id=<n>` for an accepted alert) or `error: <reason>`, and closes the
// connection. Every request runs the
// same gate, first failing check wins:
//   1 loopback peer (403)  2 no Origin header (403)  3 Host is 127.0.0.1:<port>
//   or localhost:<port> (403)  4 known route (404)  5 POST (405 + Allow: POST)
//   6 Bearer token, constant time (401 + WWW-Authenticate: Bearer)
//   7 Content-Type application/json (415)  8 body cap of the route (413)
//   9 strict UTF-8 (400)  10 route validation (400)  11 dispatch.
// Malformed or ambiguous HTTP framing is refused before the gate (400, like
// http.sys does for CielWin), as are oversized headers (431).
//
// Runs on the thread that owns it (the GUI thread in the host): sockets are
// event driven, so a slow client never blocks the scene. Limits: 8 KiB of
// request head, 2 s per request (CielWin's RequestTimeout), 8 connections at
// once (CielWin serves one at a time; extra ones are closed unanswered).
// The token and the Authorization header are never logged.
struct SceneBodyResult {
    bool accepted = false;
    QString scene; // canonical lowercase name when accepted
    QString error; // reason when rejected
};

namespace HttpProtocol {
inline constexpr quint16 defaultPort = 43811;
inline constexpr char scenePath[] = "/v1/wallpaper/scene";
inline constexpr int sceneMaxBodyBytes = 256;
inline constexpr char alertsPath[] = "/v1/alerts";
inline constexpr int alertsMaxBodyBytes = 1024;
inline constexpr char alertsClearPath[] = "/v1/alerts/clear";
inline constexpr int alertsClearMaxBodyBytes = 64;
inline constexpr int maxHeaderBytes = 8 * 1024;
inline constexpr int requestTimeoutMs = 2000;
inline constexpr int maxConnections = 8;
// `{ "scene": "<name>" }`, exactly one field, one of the four scenes matched
// case-insensitively. Anything else (a `mode` field included) is rejected with
// CielWin's message.
SceneBodyResult validateSceneBody(const QString &body);
// 127.0.0.0/8, ::1, and IPv4-mapped 127.0.0.0/8.
bool isLoopbackPeer(const QHostAddress &address);
// Constant time over equal lengths; a length mismatch returns early (as
// CielWin's FixedTimeEquals: the length is not the secret).
bool tokenEquals(const QByteArray &provided, const QByteArray &expected);
}

class HttpServer final : public QObject {
public:
    // Called on the owning thread with a validated canonical scene name; returns
    // whether the switch was accepted (false answers 503).
    using SceneSwitch = std::function<bool(const QString &scene)>;
    // Called on the owning thread with the translated alert command text ("warning:2 failed:1");
    // returns the reply ("ok" or "error: <reason>", mapped by AlertHttpProtocol::statusCodeFor).
    // Empty means the alert route is off: it answers exactly like an unknown path (CielWin).
    using AlertHandler = std::function<QString(const QString &command)>;
    // POST /v1/alerts/clear with the validated id (0: the held alert); the reply maps like the
    // alert handler's. Empty means the clear route answers exactly like an unknown path.
    using AlertClearHandler = std::function<QString(quint64 id)>;
    // Port 0 picks an ephemeral port (tests); the host passes the settings port.
    HttpServer(quint16 port, QByteArray token, SceneSwitch switchScene, AlertHandler handleAlert = {},
               AlertClearHandler clearAlert = {}, QObject *parent = nullptr);
    ~HttpServer() override;
    // Binds and starts serving. False (one log line, nothing bound) when the
    // IPv4 loopback port is busy; the host then keeps running without HTTP.
    bool start();
    quint16 port() const { return boundPort; }

private:
    friend class HttpConnection;
    void acceptFrom(QTcpServer *listener);

    quint16 requestedPort, boundPort = 0;
    QByteArray token;
    SceneSwitch switchScene;
    AlertHandler handleAlert;
    AlertClearHandler clearAlert;
    QTcpServer *ipv4 = nullptr, *ipv6 = nullptr;
    int activeConnections = 0;
};
