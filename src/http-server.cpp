#include "http-server.h"
#include "alerts.h"

#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QPair>
#include <QStringDecoder>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>

#include <sys/socket.h>

namespace {
const QString invalidJson = QStringLiteral("body is not valid JSON");
const QString sceneUnknown = QStringLiteral("field 'scene' must be one of: processing, explorer, idle, raphael");
const QStringList allowedScenes = {QStringLiteral("processing"), QStringLiteral("explorer"),
                                   QStringLiteral("idle"), QStringLiteral("raphael")};
// After the reply, unread request bytes are drained (never a reset that could
// discard the reply in flight) for at most this long / this much.
constexpr int drainTimeoutMs = 1000;
constexpr qint64 drainMaxBytes = 64 * 1024;
constexpr qint64 socketReadBuffer = 64 * 1024;

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int unicodeEscape(const QByteArray &text, qsizetype at) { // `\uXXXX` at `at`, or -1
    if (at + 6 > text.size() || text[at] != '\\' || text[at + 1] != 'u') return -1;
    int value = 0;
    for (int i = 2; i < 6; ++i) {
        const int digit = hexValue(text[at + i]);
        if (digit < 0) return -1;
        value = value * 16 + digit;
    }
    return value;
}

// Qt's JSON parser silently accepts an escaped lone surrogate ("\uD800");
// .NET's JsonDocument (CielWin) cannot turn one into a string and rejects it.
bool hasLoneSurrogateEscape(const QByteArray &text) {
    for (qsizetype i = 0; i < text.size(); ++i) {
        if (text[i] != '\\') continue;
        const int value = unicodeEscape(text, i);
        if (value < 0) { ++i; continue; } // `\"`, `\\` ...: skip the escaped character
        if (value >= 0xDC00 && value <= 0xDFFF) return true;
        if (value >= 0xD800 && value <= 0xDBFF) {
            const int low = unicodeEscape(text, i + 6);
            if (low < 0xDC00 || low > 0xDFFF) return true;
            i += 11;
            continue;
        }
        i += 5;
    }
    return false;
}

bool isTokenChar(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
           || QByteArrayView("!#$%&'*+-.^_`|~").contains(c);
}

const char *reasonPhrase(int status) {
    switch (status) {
    case 100: return "Continue";
    case 202: return "Accepted";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 408: return "Request Timeout";
    case 413: return "Content Too Large";
    case 415: return "Unsupported Media Type";
    case 431: return "Request Header Fields Too Large";
    case 501: return "Not Implemented";
    case 503: return "Service Unavailable";
    case 505: return "HTTP Version Not Supported";
    default: return "Internal Server Error";
    }
}

struct RequestHead {
    QByteArray method, path, version;
    QList<QPair<QByteArray, QByteArray>> headers; // names lowercased, values trimmed

    int count(const char *name) const {
        int n = 0;
        for (const auto &header : headers) n += header.first == name;
        return n;
    }
    // Repeated headers are joined with ", " (RFC 9110 5.3), so a repeated
    // Authorization or Content-Type simply fails its gate.
    QByteArray value(const char *name) const {
        QByteArray joined;
        bool first = true;
        for (const auto &header : headers) {
            if (header.first != name) continue;
            if (!first) joined += ", ";
            joined += header.second;
            first = false;
        }
        return joined;
    }
};

enum class ParseResult { Ok, Malformed, BadVersion };

ParseResult parseHead(const QByteArray &head, RequestHead *out) {
    const QList<QByteArray> lines = head.split('\n');
    for (qsizetype i = 0; i < lines.size(); ++i) // every line ends in CRLF (the last one's CRLF was cut)
        if ((i + 1 < lines.size()) != lines[i].endsWith('\r')) return ParseResult::Malformed;
    const QByteArray requestLine = lines[0].chopped(lines.size() > 1 ? 1 : 0);
    const QList<QByteArray> parts = requestLine.split(' ');
    if (parts.size() != 3 || parts[0].isEmpty() || parts[1].isEmpty()) return ParseResult::Malformed;
    for (const char c : parts[0]) if (!isTokenChar(c)) return ParseResult::Malformed;
    for (const char c : parts[1]) if (uchar(c) <= 0x20 || c == 0x7f) return ParseResult::Malformed;
    if (!parts[2].startsWith("HTTP/")) return ParseResult::Malformed;
    if (parts[2] != "HTTP/1.1" && parts[2] != "HTTP/1.0") return ParseResult::BadVersion;
    out->method = parts[0];
    QByteArray target = parts[1];
    const qsizetype cut = target.indexOf('?') >= 0 ? target.indexOf('?') : target.indexOf('#');
    if (cut >= 0) target.truncate(cut);
    out->path = target;
    out->version = parts[2];
    for (qsizetype i = 1; i < lines.size(); ++i) {
        const QByteArray line = lines[i].chopped(i + 1 < lines.size() ? 1 : 0);
        if (line.isEmpty() || line[0] == ' ' || line[0] == '\t') return ParseResult::Malformed; // obs-fold
        const qsizetype colon = line.indexOf(':');
        if (colon <= 0) return ParseResult::Malformed;
        const QByteArray name = line.left(colon).toLower();
        for (const char c : name) if (!isTokenChar(c)) return ParseResult::Malformed;
        const QByteArray value = line.mid(colon + 1).trimmed();
        for (const char c : value) if ((uchar(c) < 0x20 && c != '\t') || c == 0x7f) return ParseResult::Malformed;
        out->headers.append({name, value});
    }
    return ParseResult::Ok;
}

enum class ChunkResult { NeedMore, Done, TooLarge, Malformed };

// Decodes a whole chunked body from the start of `raw`; trailers are skipped.
ChunkResult decodeChunked(const QByteArray &raw, int cap, QByteArray *body) {
    body->clear();
    qsizetype at = 0;
    while (true) {
        const qsizetype lineEnd = raw.indexOf("\r\n", at);
        if (lineEnd < 0) return raw.size() - at > 256 ? ChunkResult::Malformed : ChunkResult::NeedMore;
        if (lineEnd - at > 256) return ChunkResult::Malformed;
        QByteArray sizeText = raw.mid(at, lineEnd - at);
        if (const qsizetype ext = sizeText.indexOf(';'); ext >= 0) sizeText.truncate(ext);
        sizeText = sizeText.trimmed();
        if (sizeText.isEmpty() || sizeText.size() > 8) return ChunkResult::Malformed;
        qint64 size = 0;
        for (const char c : sizeText) {
            const int digit = hexValue(c);
            if (digit < 0) return ChunkResult::Malformed;
            size = size * 16 + digit;
        }
        at = lineEnd + 2;
        if (size == 0) {
            while (true) { // trailer section, ends with an empty line
                const qsizetype end = raw.indexOf("\r\n", at);
                if (end < 0) return raw.size() - at > 1024 ? ChunkResult::Malformed : ChunkResult::NeedMore;
                if (end == at) return ChunkResult::Done;
                at = end + 2;
            }
        }
        if (body->size() + size > cap) return ChunkResult::TooLarge;
        if (raw.size() < at + size + 2) {
            // Count what has arrived so far against the cap as well.
            if (body->size() + (raw.size() - at) > cap) return ChunkResult::TooLarge;
            return ChunkResult::NeedMore;
        }
        if (raw.mid(at + size, 2) != "\r\n") return ChunkResult::Malformed;
        body->append(raw.mid(at, size));
        at += size + 2;
    }
}
} // namespace

namespace HttpProtocol {
SceneBodyResult validateSceneBody(const QString &body) {
    SceneBodyResult result;
    const QByteArray utf8 = body.toUtf8();
    if (hasLoneSurrogateEscape(utf8)) { result.error = invalidJson; return result; }
    // Wrapped in an array so any JSON value (not only an object or array) parses;
    // exactly one element means the body was exactly one value.
    QJsonParseError error {};
    const QJsonDocument document = QJsonDocument::fromJson("[" + utf8 + "]", &error);
    if (error.error != QJsonParseError::NoError || !document.isArray() || document.array().size() != 1) {
        result.error = invalidJson;
        return result;
    }
    const QJsonValue root = document.array().at(0);
    if (!root.isObject()) { result.error = QStringLiteral("body must be a JSON object"); return result; }
    const QJsonObject object = root.toObject();
    // A duplicate "scene" key: the last one wins (Qt and CielWin alike).
    for (const QString &key : object.keys())
        if (key != QLatin1String("scene")) { result.error = QStringLiteral("unknown field '%1'").arg(key); return result; }
    if (!object.contains(QLatin1String("scene"))) { result.error = QStringLiteral("field 'scene' is required"); return result; }
    const QJsonValue scene = object.value(QLatin1String("scene"));
    if (!scene.isString()) { result.error = QStringLiteral("field 'scene' must be a string"); return result; }
    if (scene.toString().isEmpty()) { result.error = QStringLiteral("field 'scene' must not be empty"); return result; }
    const QString normalized = scene.toString().toLower();
    if (!allowedScenes.contains(normalized)) { result.error = sceneUnknown; return result; }
    result.accepted = true;
    result.scene = normalized;
    return result;
}

bool isLoopbackPeer(const QHostAddress &address) {
    if (address.isNull()) return false;
    if (address.protocol() == QAbstractSocket::IPv6Protocol && address == QHostAddress(QHostAddress::LocalHostIPv6))
        return true;
    bool isV4 = false;
    const quint32 v4 = address.toIPv4Address(&isV4); // also unwraps ::ffff:a.b.c.d
    return isV4 && (v4 >> 24) == 127;
}

bool tokenEquals(const QByteArray &provided, const QByteArray &expected) {
    if (provided.size() != expected.size()) return false;
    uchar difference = 0;
    for (qsizetype i = 0; i < provided.size(); ++i) difference |= uchar(provided[i]) ^ uchar(expected[i]);
    return difference == 0;
}
} // namespace HttpProtocol

// One accepted socket: reads the head, runs the gate, reads the body, replies
// once, then drains and closes. Deletes itself.
class HttpConnection final : public QObject {
public:
    HttpConnection(QTcpSocket *socket, HttpServer *server)
        : QObject(server), socket(socket), server(server) {
        socket->setParent(this);
        socket->setReadBufferSize(socketReadBuffer);
        ++server->activeConnections;
        timer.setSingleShot(true);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (state == State::Closing) close();
            else reject(408, "request timed out");
        });
        connect(socket, &QTcpSocket::readyRead, this, [this] { onReadyRead(); });
        connect(socket, &QTcpSocket::bytesWritten, this, [this] { maybeShutdownWrite(); });
        connect(socket, &QTcpSocket::disconnected, this, [this] { close(); });
        connect(socket, &QTcpSocket::errorOccurred, this, [this](QAbstractSocket::SocketError error) {
            if (error != QAbstractSocket::RemoteHostClosedError) close();
        });
        timer.start(HttpProtocol::requestTimeoutMs);
        if (socket->bytesAvailable() > 0) onReadyRead();
    }
    ~HttpConnection() override { --server->activeConnections; }

private:
    enum class State { Head, Body, Closing, Closed };
    struct Route { const char *path; int cap; bool scene; };

    void onReadyRead() {
        if (state == State::Closed) return;
        const QByteArray data = socket->readAll();
        if (state == State::Closing) {
            drained += data.size();
            if (drained > drainMaxBytes) close();
            return;
        }
        buffer += data;
        if (state == State::Head) readHead();
        if (state == State::Body) readBody();
    }

    void readHead() {
        const qsizetype end = buffer.indexOf("\r\n\r\n");
        if (end < 0 ? buffer.size() > HttpProtocol::maxHeaderBytes : end + 4 > HttpProtocol::maxHeaderBytes) {
            reject(431, "request header is too large");
            return;
        }
        if (end < 0) return;
        const ParseResult parsed = parseHead(buffer.left(end), &head);
        buffer.remove(0, end + 4);
        if (parsed == ParseResult::BadVersion) { reject(505, "http version not supported"); return; }
        if (parsed != ParseResult::Ok || !framingOk()) { reject(400, "malformed request"); return; }
        if (head.count("transfer-encoding") == 1 && head.value("transfer-encoding").toLower() != "chunked") {
            reject(501, "transfer encoding not supported");
            return;
        }
        if (!runGate()) return;
        state = State::Body;
        if (head.value("expect").toLower() == "100-continue" && (chunked || contentLength > buffer.size()))
            socket->write("HTTP/1.1 100 Continue\r\n\r\n");
    }

    // Ambiguous framing is a request-smuggling vector: refuse it outright.
    bool framingOk() {
        if (head.count("host") > 1 || head.count("content-length") > 1 || head.count("transfer-encoding") > 1)
            return false;
        if (head.count("content-length") && head.count("transfer-encoding")) return false;
        chunked = head.count("transfer-encoding") == 1;
        if (head.count("content-length")) {
            const QByteArray text = head.value("content-length");
            if (text.isEmpty() || text.size() > 10) return false;
            for (const char c : text) if (c < '0' || c > '9') return false;
            contentLength = text.toLongLong();
        }
        return true;
    }

    // Gate steps 1-8 (the declared size); first failing check wins.
    bool runGate() {
        // 1. The peer must be loopback (only loopback is ever bound; this is our own line).
        if (!HttpProtocol::isLoopbackPeer(socket->peerAddress()))
            return reject(403, "remote endpoint is not loopback");
        // 2. Any Origin header at all means a browser sent this.
        if (!head.value("origin").isEmpty()) return reject(403, "browser requests are not accepted");
        // 3. Host must be exactly 127.0.0.1:port or localhost:port (DNS rebinding).
        const QByteArray host = head.value("host").toLower();
        const QByteArray port = QByteArray::number(server->boundPort);
        if (head.count("host") != 1 || (host != "127.0.0.1:" + port && host != "localhost:" + port))
            return reject(403, "unexpected host header");
        // 4. Path.
        static constexpr Route routes[] = {
            {HttpProtocol::scenePath, HttpProtocol::sceneMaxBodyBytes, true},
            {HttpProtocol::alertsPath, HttpProtocol::alertsMaxBodyBytes, false},
        };
        for (const Route &candidate : routes)
            if (head.path == candidate.path && (candidate.scene || server->handleAlert)) route = &candidate;
        if (!route) return reject(404, "no such route");
        // 5. Method: POST only. OPTIONS (a CORS preflight) too, never with Access-Control-*.
        if (head.method.toUpper() != "POST") return reject(405, "method not allowed", "Allow: POST\r\n");
        // 6. Bearer token, scheme case-insensitive, token constant-time.
        const QByteArray authorization = head.value("authorization");
        const qsizetype space = authorization.indexOf(' ');
        if (space < 0 || authorization.left(space).toLower() != "bearer"
            || !HttpProtocol::tokenEquals(authorization.mid(space + 1), server->token))
            return reject(401, "missing or invalid bearer token", "WWW-Authenticate: Bearer\r\n");
        // 7. Content-Type, ignoring parameters such as ;charset=utf-8.
        if (head.value("content-type").split(';').first().trimmed().toLower() != "application/json")
            return reject(415, "content type must be application/json");
        // 8. A declared size past the route's cap is refused before a byte is read.
        if (contentLength > route->cap) return reject(413, "request body is too large");
        return true;
    }

    void readBody() {
        QByteArray body;
        if (chunked) {
            switch (decodeChunked(buffer, route->cap, &body)) {
            case ChunkResult::NeedMore: return;
            case ChunkResult::TooLarge: reject(413, "request body is too large"); return;
            case ChunkResult::Malformed: reject(400, "malformed request"); return;
            case ChunkResult::Done: break;
            }
        } else {
            if (buffer.size() < contentLength) return;
            body = buffer.left(contentLength);
        }
        // 9. Strict UTF-8 (an initial BOM is kept, so it then fails as JSON, as in CielWin).
        QStringDecoder decoder(QStringDecoder::Utf8,
                               QStringDecoder::Flag::Stateless | QStringDecoder::Flag::ConvertInitialBom);
        const QString text = decoder.decode(body);
        if (decoder.hasError()) { reject(400, "body is not valid UTF-8"); return; }
        if (route->scene) dispatchScene(text);
        else dispatchAlert(text);
    }

    // 10/11 for the alerts route (CielWin LocalHttpCommandServer.HandleAlertBody).
    void dispatchAlert(const QString &text) {
        // 10. Translate to the command grammar.
        const AlertTranslation translated = AlertHttpProtocol::translate(text);
        if (!translated.ok) { reject(400, translated.error.toUtf8()); return; }
        // 11. Hand the command to the handler; its reply is the body, its status the mapping.
        QString answer;
        try {
            answer = server->handleAlert(translated.command);
        } catch (...) {
            qWarning("CIELINUX_HTTP the alert command handler threw");
            reply(500, "error: internal error");
            return;
        }
        reply(AlertHttpProtocol::statusCodeFor(answer), answer.toUtf8());
    }

    // 10/11 for the scene route.
    void dispatchScene(const QString &text) {
        const SceneBodyResult validated = HttpProtocol::validateSceneBody(text);
        if (!validated.accepted) { reject(400, validated.error.toUtf8()); return; }
        bool accepted = false;
        try {
            accepted = server->switchScene && server->switchScene(validated.scene);
        } catch (...) {
            qWarning("CIELINUX_HTTP the scene switch handler threw");
            reply(500, "error: internal error");
            return;
        }
        if (!accepted) { reject(503, "wallpaper scene switching is not available"); return; }
        reply(202, "ok");
    }

    bool reject(int status, const QByteArray &reason, const QByteArray &extraHeaders = {}) {
        qInfo("CIELINUX_HTTP rejected %d %s", status, reason.constData());
        reply(status, "error: " + reason, extraHeaders);
        return false;
    }

    void reply(int status, const QByteArray &body, const QByteArray &extraHeaders = {}) {
        if (state == State::Closing || state == State::Closed) return;
        QByteArray out = "HTTP/1.1 " + QByteArray::number(status) + ' ' + reasonPhrase(status) + "\r\n";
        out += "Content-Type: text/plain; charset=utf-8\r\n";
        out += "Content-Length: " + QByteArray::number(body.size()) + "\r\n";
        out += "Connection: close\r\n";
        out += extraHeaders;
        out += "\r\n";
        out += body;
        state = State::Closing;
        buffer.clear();
        socket->write(out);
        timer.start(drainTimeoutMs);
        maybeShutdownWrite();
    }

    // Once the reply is flushed: send FIN, keep reading (and discarding) until
    // the client closes, so unread request bytes never turn into a reset.
    void maybeShutdownWrite() {
        if (state != State::Closing || shutDown || socket->bytesToWrite() > 0) return;
        shutDown = true;
        ::shutdown(int(socket->socketDescriptor()), SHUT_WR);
    }

    void close() {
        if (state == State::Closed) return;
        state = State::Closed;
        timer.stop();
        socket->abort();
        deleteLater();
    }

    QTcpSocket *socket;
    HttpServer *server;
    QTimer timer;
    State state = State::Head;
    QByteArray buffer;
    RequestHead head;
    const Route *route = nullptr;
    bool chunked = false, shutDown = false;
    qint64 contentLength = 0, drained = 0;
};

HttpServer::HttpServer(quint16 port, QByteArray token, SceneSwitch switchScene, AlertHandler handleAlert,
                       QObject *parent)
    : QObject(parent), requestedPort(port), token(std::move(token)), switchScene(std::move(switchScene)),
      handleAlert(std::move(handleAlert)) {}

HttpServer::~HttpServer() {
    // Connections are children; they decrement the counter while being deleted.
    const QObjectList owned = children();
    for (QObject *child : owned)
        if (auto *connection = dynamic_cast<HttpConnection *>(child)) delete connection;
}

bool HttpServer::start() {
    if (ipv4) return true;
    if (token.isEmpty()) return false;
    auto *v4 = new QTcpServer(this);
    if (!v4->listen(QHostAddress::LocalHost, requestedPort)) {
        qWarning("CIELINUX_HTTP unavailable: could not listen on 127.0.0.1:%u (%s); running without HTTP",
                 unsigned(requestedPort), qPrintable(v4->errorString()));
        delete v4;
        return false;
    }
    ipv4 = v4;
    boundPort = v4->serverPort();
    connect(v4, &QTcpServer::newConnection, this, [this, v4] { acceptFrom(v4); });
    auto *v6 = new QTcpServer(this);
    if (v6->listen(QHostAddress::LocalHostIPv6, boundPort)) {
        ipv6 = v6;
        connect(v6, &QTcpServer::newConnection, this, [this, v6] { acceptFrom(v6); });
    } else {
        // CielWin's fallback: IPv4 loopback alone rather than no server at all.
        qInfo("CIELINUX_HTTP ::1 unavailable (%s); serving 127.0.0.1 only", qPrintable(v6->errorString()));
        delete v6;
    }
    qInfo("CIELINUX_HTTP listening port=%u", unsigned(boundPort));
    return true;
}

void HttpServer::acceptFrom(QTcpServer *listener) {
    while (QTcpSocket *socket = listener->nextPendingConnection()) {
        if (activeConnections >= HttpProtocol::maxConnections) {
            socket->abort();
            socket->deleteLater();
            continue;
        }
        new HttpConnection(socket, this);
    }
}
