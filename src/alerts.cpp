#include "alerts.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonValue>
#include <QSet>
#include <algorithm>
#include <limits>
#include <stdexcept>

namespace {
// CielWin AlertCommandParser constants.
constexpr int maxInputLength = 256;
constexpr int minTileCount = 1, maxTileCountPerKind = 16, maxTotalTiles = 16;
constexpr int minDurationSeconds = 1, maxDurationSeconds = 60, defaultDurationSeconds = 5;
// .NET JsonDocument's default maximum nesting depth (CielWin parses with the defaults).
constexpr int maxJsonDepth = 64;
const QString invalidJson = QStringLiteral("body is not valid JSON");

// int.TryParse(value, NumberStyles.None, InvariantCulture): ASCII digits only, no sign, no
// separators, no surrounding whitespace, within int range.
bool parsePlainInt(const QString &text, int *value) {
    if (text.isEmpty()) return false;
    qint64 number = 0;
    for (const QChar c : text) {
        if (c < u'0' || c > u'9') return false;
        number = number * 10 + (c.unicode() - u'0');
        if (number > std::numeric_limits<int>::max()) return false;
    }
    *value = int(number);
    return true;
}

// .NET TimeSpan's constant ("c") format: [d.]hh:mm:ss[.fffffff].
QString timeSpanText(qint64 ms) {
    const qint64 days = ms / 86400000, hours = ms / 3600000 % 24, minutes = ms / 60000 % 60,
                 seconds = ms / 1000 % 60, fraction = ms % 1000;
    QString text = days ? QStringLiteral("%1.").arg(days) : QString();
    text += QStringLiteral("%1:%2:%3").arg(hours, 2, 10, QLatin1Char('0')).arg(minutes, 2, 10, QLatin1Char('0'))
                .arg(seconds, 2, 10, QLatin1Char('0'));
    if (fraction) text += QStringLiteral(".%1").arg(fraction * 10000, 7, 10, QLatin1Char('0'));
    return text;
}

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

// Qt's parser accepts an escaped lone surrogate; .NET cannot turn one into a property name and
// CielWin reports the body as invalid JSON when it reaches that key.
bool hasLoneSurrogateEscape(const QByteArray &text) {
    for (qsizetype i = 0; i < text.size(); ++i) {
        if (text[i] != '\\') continue;
        const int value = unicodeEscape(text, i);
        if (value < 0) { ++i; continue; }
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

// Walks an ALREADY VALIDATED JSON text (Qt parsed it) to recover what Qt's QJsonObject loses:
// the top-level member order and repeated names, with each member's raw value text.
class MemberScanner {
public:
    explicit MemberScanner(const QByteArray &text) : text(text) {}
    int maxDepth() {
        int depth = 0, deepest = 0;
        for (qsizetype i = 0; i < text.size(); ++i) {
            const char c = text[i];
            if (c == '"') { i = stringEnd(i) - 1; continue; }
            if (c == '{' || c == '[') deepest = std::max(deepest, ++depth);
            else if (c == '}' || c == ']') --depth;
        }
        return deepest;
    }
    // Positions after the root '{'; false when the object has no (more) members.
    bool begin() { skipSpace(); ++at; skipSpace(); return text[at] != '}'; }
    void member(QByteArray *rawName, QByteArray *rawValue) {
        const qsizetype nameEnd = stringEnd(at);
        *rawName = text.mid(at, nameEnd - at);
        at = nameEnd;
        skipSpace(); ++at; skipSpace(); // ':'
        const qsizetype valueStart = at;
        at = valueEnd(at);
        *rawValue = text.mid(valueStart, at - valueStart);
        skipSpace();
    }
    bool next() { // after a member: ',' -> another member, '}' -> done
        if (text[at] != ',') return false;
        ++at;
        skipSpace();
        return true;
    }

private:
    void skipSpace() { while (at < text.size() && QByteArrayView(" \t\r\n").contains(text[at])) ++at; }
    qsizetype stringEnd(qsizetype open) const { // one past the closing quote
        for (qsizetype i = open + 1; i < text.size(); ++i) {
            if (text[i] == '\\') ++i;
            else if (text[i] == '"') return i + 1;
        }
        return text.size();
    }
    qsizetype valueEnd(qsizetype start) const {
        if (text[start] == '"') return stringEnd(start);
        if (text[start] == '{' || text[start] == '[') {
            int depth = 0;
            for (qsizetype i = start; i < text.size(); ++i) {
                const char c = text[i];
                if (c == '"') { i = stringEnd(i) - 1; continue; }
                if (c == '{' || c == '[') ++depth;
                else if ((c == '}' || c == ']') && --depth == 0) return i + 1;
            }
            return text.size();
        }
        qsizetype i = start;
        while (i < text.size() && !QByteArrayView(",} \t\r\n").contains(text[i])) ++i;
        return i;
    }
    const QByteArray &text;
    qsizetype at = 0;
};

// JsonElement.TryGetInt32: a JSON integer literal (no fraction, no exponent) within int range.
bool jsonInt32(const QByteArray &raw, int *value) {
    QByteArrayView digits(raw);
    const bool negative = digits.startsWith('-');
    if (negative) digits = digits.mid(1);
    if (digits.isEmpty() || digits.size() > 10) return false;
    for (const char c : digits) if (c < '0' || c > '9') return false;
    const qint64 magnitude = QByteArray(digits.data(), digits.size()).toLongLong();
    const qint64 number = negative ? -magnitude : magnitude;
    if (number < std::numeric_limits<int>::min() || number > std::numeric_limits<int>::max()) return false;
    *value = int(number);
    return true;
}

// The checks both alert bodies share: exactly one JSON value, within .NET's depth, an object.
// Empty when the body passes.
QString objectShapeError(const QByteArray &utf8) {
    // Wrapped in an array so any JSON value parses; exactly one element means exactly one value.
    QJsonParseError error {};
    const QJsonDocument document = QJsonDocument::fromJson("[" + utf8 + "]", &error);
    if (error.error != QJsonParseError::NoError || !document.isArray() || document.array().size() != 1)
        return invalidJson;
    if (MemberScanner(utf8).maxDepth() > maxJsonDepth) return invalidJson;
    if (!document.array().at(0).isObject()) return QStringLiteral("body must be a JSON object");
    return {};
}

// A member name as .NET reads it; false for an escaped lone surrogate (invalid JSON to CielWin).
bool memberName(const QByteArray &rawName, QString *name) {
    if (hasLoneSurrogateEscape(rawName)) return false;
    *name = QJsonDocument::fromJson("[" + rawName + "]").array().at(0).toString();
    return true;
}
} // namespace

QString alertKindName(AlertKind kind) {
    return kind == AlertKind::Failed ? QStringLiteral("failed") : QStringLiteral("warning");
}

int AlertCommand::totalTiles() const {
    int total = 0;
    for (const AlertGroup &group : groups) total += group.count;
    return total;
}

bool AlertCommand::hasFailed() const {
    for (const AlertGroup &group : groups)
        if (group.kind == AlertKind::Failed) return true;
    return false;
}

namespace AlertCommandParser {
AlertParseResult parse(const QString &input) {
    AlertParseResult result;
    auto fail = [&result](const QString &error) { result.error = error; return result; };
    if (input.isNull()) return fail(QStringLiteral("no command was given"));
    if (input.size() > maxInputLength)
        return fail(QStringLiteral("command is %1 characters long, past the %2-character limit")
                        .arg(input.size()).arg(maxInputLength));
    AlertCommand command;
    QSet<QString> seenKeys;
    int durationSeconds = defaultDurationSeconds;
    // Any run of whitespace separates tokens (.NET Split(null): char.IsWhiteSpace).
    QStringList tokens;
    QString token;
    for (const QChar c : input) {
        if (c.isSpace()) { if (!token.isEmpty()) tokens << std::exchange(token, QString()); }
        else token += c;
    }
    if (!token.isEmpty()) tokens << token;
    for (const QString &token : tokens) {
        const qsizetype separator = token.indexOf(u':');
        if (separator <= 0 || separator == token.size() - 1)
            return fail(QStringLiteral("'%1' is not a 'key:count' token").arg(token));
        const QString key = token.left(separator), value = token.mid(separator + 1);
        const bool isDuration = key.compare(QLatin1String("duration"), Qt::CaseInsensitive) == 0;
        AlertKind kind = AlertKind::Warning;
        if (key.compare(QLatin1String("failed"), Qt::CaseInsensitive) == 0) kind = AlertKind::Failed;
        else if (!isDuration && key.compare(QLatin1String("warning"), Qt::CaseInsensitive) != 0)
            return fail(QStringLiteral("'%1' names an unknown key '%2'").arg(token, key));
        const QString folded = key.toLower();
        if (seenKeys.contains(folded)) return fail(QStringLiteral("'%1' is repeated in '%2'").arg(key, token));
        seenKeys.insert(folded);
        int number = 0;
        if (!parsePlainInt(value, &number))
            return fail(QStringLiteral("'%1' does not carry a whole number").arg(token));
        if (isDuration) {
            // 0 holds the alert until cleared (checked against the kinds below).
            if (number != 0 && (number < minDurationSeconds || number > maxDurationSeconds))
                return fail(QStringLiteral("'%1' must be %2..%3 seconds").arg(token).arg(minDurationSeconds).arg(maxDurationSeconds));
            durationSeconds = number;
            continue;
        }
        if (number < minTileCount || number > maxTileCountPerKind)
            return fail(QStringLiteral("'%1' must be %2..%3").arg(token).arg(minTileCount).arg(maxTileCountPerKind));
        command.groups << AlertGroup{kind, number};
    }
    if (command.groups.isEmpty()) return fail(QStringLiteral("at least one 'warning:N' or 'failed:N' group is required"));
    if (command.totalTiles() > maxTotalTiles)
        return fail(QStringLiteral("%1 tiles were requested, past the %2-tile limit").arg(command.totalTiles()).arg(maxTotalTiles));
    // A failure has nothing to wait for: only a warning can be held.
    if (durationSeconds == 0 && command.hasFailed()) return fail(QStringLiteral("'duration:0' requires warning only"));
    command.durationMs = qint64(durationSeconds) * 1000;
    result.command = command;
    return result;
}
} // namespace AlertCommandParser

namespace AlertHttpProtocol {
QString formatError(const QString &reason) { return QStringLiteral("error: ") + reason; }

AlertTranslation translate(const QString &body) {
    AlertTranslation result;
    auto fail = [&result](const QString &error) { result.error = error; return result; };
    const QByteArray utf8 = body.toUtf8();
    if (const QString shape = objectShapeError(utf8); !shape.isEmpty()) return fail(shape);
    MemberScanner scanner(utf8);
    static const QStringList knownFields = {QStringLiteral("warning"), QStringLiteral("failed"), QStringLiteral("duration")};
    QStringList tokens;
    if (scanner.begin()) {
        do {
            QByteArray rawName, rawValue;
            scanner.member(&rawName, &rawValue);
            QString name;
            if (!memberName(rawName, &name)) return fail(invalidJson);
            if (!knownFields.contains(name)) return fail(QStringLiteral("unknown field '%1'").arg(name));
            int number = 0;
            if (!jsonInt32(rawValue, &number)) return fail(QStringLiteral("field '%1' must be a whole number").arg(name));
            tokens << QStringLiteral("%1:%2").arg(name).arg(number);
        } while (scanner.next());
    }
    result.ok = true;
    result.command = tokens.join(u' ');
    if (result.command.isNull()) result.command = QStringLiteral(""); // `{}`: an empty, not a missing, command
    return result;
}

AlertClearRequest parseClear(const QString &body) {
    AlertClearRequest result;
    auto fail = [&result](const QString &error) { result.error = error; return result; };
    const QByteArray utf8 = body.toUtf8();
    if (const QString shape = objectShapeError(utf8); !shape.isEmpty()) return fail(shape);
    MemberScanner scanner(utf8);
    bool seen = false;
    if (scanner.begin()) {
        do {
            QByteArray rawName, rawValue;
            scanner.member(&rawName, &rawValue);
            QString name;
            if (!memberName(rawName, &name)) return fail(invalidJson);
            if (name != QLatin1String("id")) return fail(QStringLiteral("unknown field '%1'").arg(name));
            if (seen) return fail(QStringLiteral("field 'id' is repeated"));
            seen = true;
            int number = 0;
            if (!jsonInt32(rawValue, &number) || number < 1)
                return fail(QStringLiteral("field 'id' must be a whole number >= 1"));
            result.id = quint64(number);
        } while (scanner.next());
    }
    result.ok = true;
    return result;
}

QString formatAccepted(quint64 id) { return QStringLiteral("%1 id=%2").arg(QLatin1String(okReply)).arg(id); }

namespace {
// "ok id=<n>": n a positive decimal without a leading zero, nothing after it.
bool isAccepted(const QString &reply) {
    const QString prefix = QLatin1String(okReply) + QStringLiteral(" id=");
    if (!reply.startsWith(prefix) || reply.size() == prefix.size() || reply.at(prefix.size()) == u'0') return false;
    for (qsizetype i = prefix.size(); i < reply.size(); ++i)
        if (reply.at(i) < u'0' || reply.at(i) > u'9') return false;
    return true;
}
} // namespace

int statusCodeFor(const QString &reply) {
    if (reply == QLatin1String(okReply) || isAccepted(reply)) return 202;
    if (reply == formatError(QStringLiteral("alerts are disabled"))) return 503;
    if (reply == formatError(QStringLiteral("internal error"))) return 500;
    if (reply.startsWith(formatError(QString()))) return 400;
    return 500;
}
} // namespace AlertHttpProtocol

AlertTileLayout AlertTileLayout::from(const AlertCommand &command) {
    int failed = 0, warning = 0;
    for (const AlertGroup &group : command.groups) (group.kind == AlertKind::Failed ? failed : warning) += group.count;
    AlertTileLayout layout;
    for (int i = 0; i < failed && layout.tiles.size() < maxTiles; ++i) layout.tiles << AlertKind::Failed;
    for (int i = 0; i < warning && layout.tiles.size() < maxTiles; ++i) layout.tiles << AlertKind::Warning;
    const qsizetype count = layout.tiles.size();
    if (count <= 1) { layout.columns = 1; layout.rows = 1; }
    else if (count == 2) { layout.columns = 2; layout.rows = 1; }
    else if (count <= 4) { layout.columns = 2; layout.rows = 2; }
    else if (count <= 6) { layout.columns = 3; layout.rows = 2; }
    else { layout.columns = 4; layout.rows = 2; }
    return layout;
}

namespace AlertLayerMessages {
QString show(const AlertShowRequest &request) {
    QStringList tiles;
    for (const QString &tile : request.tiles) tiles << QStringLiteral("\"%1\"").arg(tile);
    return QStringLiteral("{\"type\":\"show\",\"tiles\":[%1],\"columns\":%2,\"rows\":%3,\"gap\":%4,"
                          "\"workArea\":{\"left\":%5,\"top\":%6,\"width\":%7,\"height\":%8},\"duration\":%9}")
        .arg(tiles.join(u','))
        .arg(request.columns).arg(request.rows).arg(request.gap)
        .arg(std::max(0, request.workAreaLeft)).arg(std::max(0, request.workAreaTop))
        .arg(std::max(0, request.workAreaWidth)).arg(std::max(0, request.workAreaHeight))
        .arg(request.durationMs);
}
QString hide() { return QStringLiteral("{\"type\":\"hide\"}"); }
QString pause() { return QStringLiteral("{\"type\":\"pause\"}"); }
QString resume() { return QStringLiteral("{\"type\":\"resume\"}"); }
} // namespace AlertLayerMessages

AlertQueue::AlertQueue(qint64 maxAgeMs, Diagnostic onDiagnostic, qint64 holdMaxMs)
    : maxAgeMs(maxAgeMs), holdMaxMs(holdMaxMs), diagnostic(std::move(onDiagnostic)) {
    if (maxAgeMs < 0) throw std::invalid_argument("Max age must not be negative.");
    if (holdMaxMs < 0) throw std::invalid_argument("Hold max must not be negative.");
    if (!diagnostic) diagnostic = [](const QString &) {};
}

quint64 AlertQueue::enqueue(const AlertCommand &command, qint64 nowMs) {
    dropExpired(nowMs);
    const bool showing = current && nowMs < current->endsAtMs;
    if (showing && current->command.held() && command.hasFailed()) {
        // A failure is interesting exactly while a question waits: it takes the held warning's
        // place, which resumes for the rest of its hold once the failed alert ends.
        diagnostic(QStringLiteral("alert %1 suspended: a failed alert preempts it").arg(current->serial));
        suspended = current;
        current.reset();
    } else if (showing && (current->command.held() || !command.held())) {
        diagnostic(QStringLiteral("alert ignored: one is already showing"));
        return 0;
    } else if (pending) {
        // A held warning still waiting to start gives way to a failed request the same way.
        if (!pending->command.held() || !command.hasFailed()) {
            diagnostic(QStringLiteral("alert ignored: one is already waiting to show"));
            return 0;
        }
        suspended = pending;
        pending.reset();
    }
    // A held alert's deadline runs from the request, so it never outlives a crashed caller.
    pending = ActiveAlert{command, 0, nextId, nowMs, command.held() ? nowMs + holdMaxMs : 0};
    return nextId++;
}

void AlertQueue::clear(quint64 id, qint64 nowMs) {
    dropExpired(nowMs);
    for (std::optional<ActiveAlert> *slot : {&current, &suspended, &pending}) {
        if (!*slot || !(id ? (*slot)->serial == id : (*slot)->command.held())) continue;
        diagnostic(QStringLiteral("alert %1 cleared").arg((*slot)->serial));
        slot->reset();
    }
}

std::optional<ActiveAlert> AlertQueue::advance(qint64 nowMs, bool surfaceVisible) {
    if (current && nowMs >= current->endsAtMs) current.reset();
    dropExpired(nowMs);
    if (current) return current;
    if (!surfaceVisible || !(pending || suspended)) return std::nullopt;
    if (pending) {
        current = std::exchange(pending, std::nullopt);
        if (!current->command.held()) current->endsAtMs = nowMs + current->command.durationMs;
    } else {
        current = std::exchange(suspended, std::nullopt); // resumed: same id, same deadline
    }
    current->startedAtMs = nowMs;
    return current;
}

void AlertQueue::dropExpired(qint64 nowMs) {
    const QString heldPast = QStringLiteral("alert dropped: held past the %1 hold max").arg(timeSpanText(holdMaxMs));
    if (pending && pending->command.held() && nowMs >= pending->endsAtMs) {
        pending.reset();
        diagnostic(heldPast);
    }
    if (pending && nowMs - pending->requestedAtMs > maxAgeMs) {
        pending.reset();
        diagnostic(QStringLiteral("alert dropped: waited longer than the %1 max age without starting").arg(timeSpanText(maxAgeMs)));
    }
    if (suspended && nowMs >= suspended->endsAtMs) {
        suspended.reset();
        diagnostic(heldPast);
    }
}

AlertDriver::AlertDriver(Clock clock, Trace trace, qint64 holdMaxMs, QObject *parent)
    : QObject(parent), clock(std::move(clock)), trace(std::move(trace)),
      queue(AlertQueue::defaultMaxAgeMs, [this](const QString &message) { this->trace(message); }, holdMaxMs) {}

QString AlertDriver::accept(const QString &text) {
    const AlertParseResult parsed = AlertCommandParser::parse(text);
    if (!parsed.success()) {
        const QString error = parsed.error.isEmpty() ? QStringLiteral("alert command could not be parsed") : parsed.error;
        trace(QStringLiteral("alert rejected: ") + error);
        return AlertHttpProtocol::formatError(error);
    }
    // An ignored (busy) request keeps today's plain "ok": it has no id to clear.
    const quint64 id = queue.enqueue(*parsed.command, clock());
    return id ? AlertHttpProtocol::formatAccepted(id) : QString::fromLatin1(AlertHttpProtocol::okReply);
}

QString AlertDriver::clear(quint64 id) {
    queue.clear(id, clock());
    return QString::fromLatin1(AlertHttpProtocol::okReply);
}

void AlertDriver::update(const AlertSurface *surface, bool covered) {
    const bool visible = surface && surface->canShow && surface->canShow(covered);
    const qint64 now = clock();
    const std::optional<ActiveAlert> active = queue.advance(now, visible);
    const std::optional<quint64> serial = active ? std::optional<quint64>(active->serial) : std::nullopt;
    if (!surface) return;
    if (serial == displayed) {
        // H4: reuses this tick's clock read. A covered or hidden surface stops the cadence, and
        // showing again restarts it from that tick, with nothing played at once.
        if (!active || !active->command.held()) return;
        if (!visible) repeatAt.reset();
        else if (!repeatAt) repeatAt = now + heldWarningRepeatMs;
        else if (now >= *repeatAt) {
            repeatAt = now + heldWarningRepeatMs;
            emit alertRepeated(alertKindName(AlertKind::Warning));
        }
        return;
    }
    repeatAt.reset();
    if (displayed) {
        // Nothing stays marked displayed until a start below succeeds: a failed start is retried
        // next tick and a failed hide is never repeated.
        displayed.reset();
        try { if (surface->hide) surface->hide(); } catch (...) { trace(QStringLiteral("alert hide-failed")); }
    }
    if (!active) return;
    // The deadline was set by the queue (promotion, or the request for a held alert), not when a
    // page picked it up.
    const qint64 shownAtMs = clock();
    const qint64 remaining = active->endsAtMs - shownAtMs;
    if (remaining <= 0) return;
    try {
        surface->show(buildRequest(active->command, remaining, *surface));
    } catch (...) {
        trace(QStringLiteral("alert start-failed"));
        return;
    }
    displayed = active->serial;
    // H4: a held warning's first repeat comes heldWarningRepeatMs after this show or resume.
    if (active->command.held()) repeatAt = shownAtMs + heldWarningRepeatMs;
    // A re-show, or a held warning resuming after a failed alert, is never announced twice.
    if (announced == active->serial || announcedBefore == active->serial) return;
    announcedBefore = std::exchange(announced, active->serial);
    bool failed = false;
    for (const AlertGroup &group : active->command.groups) failed = failed || group.kind == AlertKind::Failed;
    emit alertShown(alertKindName(failed ? AlertKind::Failed : AlertKind::Warning));
}

AlertShowRequest AlertDriver::buildRequest(const AlertCommand &command, qint64 remainingMs,
                                           const AlertSurface &surface) const {
    const AlertTileLayout layout = AlertTileLayout::from(command);
    AlertShowRequest request;
    for (AlertKind kind : layout.tiles) request.tiles << alertKindName(kind);
    request.columns = layout.columns;
    request.rows = layout.rows;
    request.gap = AlertTileLayout::gapPixels;
    request.durationMs = int(std::max<qint64>(1, remainingMs));
    // The mini window is the whole canvas: no work area (CielWin's MiniSceneWindowController.ShowAlert
    // zeroes it). The wallpaper reads its output's work area now; a failed read keeps the zeros.
    if (surface.workArea) {
        AlertWorkArea area;
        try {
            area = surface.workArea();
        } catch (...) {
            trace(QStringLiteral("alert workarea-failed"));
            area = AlertWorkArea{};
        }
        request.workAreaLeft = area.left;
        request.workAreaTop = area.top;
        request.workAreaWidth = area.width;
        request.workAreaHeight = area.height;
    }
    return request;
}

AlertWorkArea AlertWorkArea::resolve(const QRect &surface, const QRect &workArea) {
    if (surface.width() <= 0 || surface.height() <= 0) return {};
    const int left = std::clamp(workArea.x() - surface.x(), 0, surface.width());
    const int top = std::clamp(workArea.y() - surface.y(), 0, surface.height());
    const int right = std::clamp(workArea.x() + workArea.width() - surface.x(), 0, surface.width());
    const int bottom = std::clamp(workArea.y() + workArea.height() - surface.y(), 0, surface.height());
    if (right <= left || bottom <= top) return {};
    return {left, top, right - left, bottom - top};
}

AlertWorkArea AlertWorkArea::forOutput(const QSize &logicalSize, const QMargins &reserved, qreal devicePixelRatio) {
    const qreal scale = devicePixelRatio > 0 ? devicePixelRatio : 1.0;
    auto px = [scale](int logical) { return int(std::lround(logical * scale)); };
    const QRect surface(0, 0, px(logicalSize.width()), px(logicalSize.height()));
    const int left = px(reserved.left()), top = px(reserved.top());
    const int right = px(logicalSize.width() - reserved.right()), bottom = px(logicalSize.height() - reserved.bottom());
    return resolve(surface, QRect(left, top, right - left, bottom - top));
}
