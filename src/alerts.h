#pragma once

#include <QList>
#include <QMargins>
#include <QObject>
#include <QRect>
#include <QSize>
#include <QString>
#include <QStringList>
#include <functional>
#include <optional>

// Alerts, ported from CielWin (CielWin/CielWin.App/Alerts/AlertCommandParser.cs, AlertQueue.cs,
// AlertTileLayout.cs, AlertLayerMessages.cs, CielWin.Interop/AlertHttpProtocol.cs and
// CielWin.App/Composition/AlertDriver.cs). Pure and clock-free except AlertDriver, which reads an
// injected monotonic millisecond clock. Everything runs on the GUI thread (the HTTP server is
// event driven on that thread too), so nothing here locks.

enum class AlertKind { Warning, Failed };
// The wire name: "warning" / "failed".
QString alertKindName(AlertKind kind);

// One `kind:count` group, in the order it was written.
struct AlertGroup {
    AlertKind kind;
    int count;
};

struct AlertCommand {
    QList<AlertGroup> groups;
    qint64 durationMs = 5000;
    int totalTiles() const;
};

struct AlertParseResult {
    std::optional<AlertCommand> command;
    QString error; // a short message naming the offending token when parsing failed
    bool success() const { return command.has_value(); }
};

// `warning:2 failed:1 duration:5`: whitespace-separated `kind:count` tokens, kind warning|failed
// (case-insensitive), count 1..16, each key at most once, optional `duration:seconds` 1..60
// (default 5), at least one kind, at most 16 tiles in all, at most 256 characters. Never throws.
namespace AlertCommandParser {
AlertParseResult parse(const QString &input); // a null QString is "no command was given"
}

struct AlertTranslation {
    bool ok = false;
    QString command; // the command text when ok
    QString error;   // the reason otherwise
};

namespace AlertHttpProtocol {
inline constexpr char okReply[] = "ok";
QString formatError(const QString &reason); // "error: <reason>"
// `{ "warning": 2, "failed": 1, "duration": 5 }`, every field optional, becomes
// "warning:2 failed:1 duration:5" in the order written (repeats included, for the parser to
// reject). Checks only the JSON shape: counts, ranges and "at least one" stay with the parser.
AlertTranslation translate(const QString &body);
// 202 ok, 503 alerts disabled, 500 internal error or anything unrecognised, 400 other errors.
int statusCodeFor(const QString &reply);
}

struct AlertTileLayout {
    // Physical pixels around and between mosaic tiles (the page converts with devicePixelRatio).
    static constexpr int gapPixels = 8;
    static constexpr int maxTiles = 8;
    QList<AlertKind> tiles; // every failed first, then every warning, capped at maxTiles
    int columns = 1, rows = 1; // 1 -> 1x1, 2 -> 2x1, 3-4 -> 2x2, 5-6 -> 3x2, 7+ -> 4x2
    static AlertTileLayout from(const AlertCommand &command);
};

// The output's work area (bars excluded) relative to the alert surface, physical pixels; all zero
// is "unavailable": lay the mosaic out on the whole canvas (CielWin AlertLayerWorkArea).
struct AlertWorkArea {
    int left = 0, top = 0, width = 0, height = 0;
    // CielWin Resolve: `workArea` clamped to `surface` and made relative to its top-left corner;
    // unavailable when they do not intersect or the surface is degenerate. Right/bottom edges are
    // x + width / y + height (exclusive, like .NET's Rectangle), not QRect::right()/bottom().
    static AlertWorkArea resolve(const QRect &surface, const QRect &workArea);
    // B2 wallpaper: the output (logical size, the surface covers it exactly) minus Hyprland's
    // reserved zones (logical), both scaled to physical pixels by the output's device pixel ratio.
    static AlertWorkArea forOutput(const QSize &logicalSize, const QMargins &reserved, qreal devicePixelRatio);
};

// One host -> page "show" request. Work area: physical pixels relative to the surface, all zero
// meaning "lay the mosaic out on the whole canvas" (always zero for the mini window).
struct AlertShowRequest {
    QStringList tiles;
    int columns = 1, rows = 1, gap = AlertTileLayout::gapPixels, durationMs = 5000;
    int workAreaLeft = 0, workAreaTop = 0, workAreaWidth = 0, workAreaHeight = 0;
};

// The JSON messages the scene pages understand (shared/js/alert-overlay.js handleHostMessage).
namespace AlertLayerMessages {
QString show(const AlertShowRequest &request); // work area clamped to >= 0
QString hide();
QString pause();  // B2: the wallpaper is covered by a fullscreen window; never sent to the mini
QString resume(); // B2: uncovered again
}

struct ActiveAlert {
    AlertCommand command;
    qint64 startedAtMs = 0;
    quint64 serial = 0; // one per promoted command: a re-show of the same alert keeps it
};

// The single slot: at most ONE alert exists, showing or waiting. A request while one is showing
// (now < start + duration) or waiting (not yet older than the max age) is ignored and reported;
// the HTTP reply is still "ok". A waiting alert older than the max age (strictly past it) is
// dropped and reported. Starting needs a visible surface; a showing alert ends on time regardless.
class AlertQueue {
public:
    static constexpr qint64 defaultMaxAgeMs = 5 * 60 * 1000;
    using Diagnostic = std::function<void(const QString &)>;
    // Throws std::invalid_argument for a negative max age.
    explicit AlertQueue(qint64 maxAgeMs = defaultMaxAgeMs, Diagnostic onDiagnostic = {});
    void enqueue(const AlertCommand &command, qint64 nowMs);
    std::optional<ActiveAlert> advance(qint64 nowMs, bool surfaceVisible);

private:
    void dropExpired(qint64 nowMs);
    qint64 maxAgeMs;
    Diagnostic diagnostic;
    std::optional<std::pair<AlertCommand, qint64>> pending; // single slot: (command, enqueuedAt)
    std::optional<ActiveAlert> current;
    quint64 nextSerial = 1;
};

// Where an alert is drawn: the mini or the wallpaper page, both through AlertBridge.
struct AlertSurface {
    std::function<bool(bool covered)> canShow; // the mini ignores `covered`; the wallpaper honours it
    std::function<void(const AlertShowRequest &)> show;
    std::function<void()> hide;
    // Read at show time (bars can change); unset = the whole canvas (the mini). May throw: the
    // alert is then laid out on the whole canvas rather than lost (CielWin BuildRequest).
    std::function<AlertWorkArea()> workArea;
};

// Accepted commands -> show/hide on the active surface, from one AlertQueue. update() runs on
// every watch tick (400 ms, CielWin's WatchInterval) and right after an accepted request.
class AlertDriver final : public QObject {
    Q_OBJECT
public:
    using Clock = std::function<qint64()>; // monotonic milliseconds
    using Trace = std::function<void(const QString &)>;
    AlertDriver(Clock clock, Trace trace, QObject *parent = nullptr);
    // Parses and queues one command; returns the reply for the HTTP caller ("ok" or "error: ...").
    QString accept(const QString &text);
    // The surface was replaced (mode switch): an alert still inside its duration is shown
    // again there for its remaining time by the next update().
    void surfaceReplaced() { displayed.reset(); }
    // `covered`: the wallpaper's output is under a fullscreen window (B2); always false in the mini.
    void update(const AlertSurface *surface, bool covered);
signals:
    // Once per newly shown alert (never on a re-show), "failed" when any failed tile, else
    // "warning". The A5 seam: sounds play from here.
    void alertShown(const QString &kind);

private:
    AlertShowRequest buildRequest(const AlertCommand &command, qint64 remainingMs, const AlertSurface &surface) const;
    Clock clock;
    Trace trace;
    AlertQueue queue;
    std::optional<quint64> displayed, announced;
};
