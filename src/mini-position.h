#pragma once

#include <QByteArray>
#include <QMargins>
#include <QObject>
#include <QRect>
#include <QSize>
#include <QString>
#include <QStringList>
#include <QTimer>
#include <functional>
#include <optional>

// The eight mini window positions, in CielWin's clockwise order and names
// (CielWin/CielWin.App/Settings.cs MiniPosition + MiniPositionNames), and the
// cycle the SUPER+Z / SUPER+SHIFT+Z binds walk (Wallpaper/MiniWindowPlacement.cs
// Next/Previous: an unknown name restarts at top-left).
namespace MiniPosition {
const QStringList &names();
bool isValid(const QString &name);
QString next(const QString &name);
QString previous(const QString &name);
}

// Placement on wlr-layer-shell. A resting window is anchored to its position's
// edges with the inset on those edges, so the compositor places it exactly and
// keeps it clear of other surfaces' exclusive zones (Waybar). Geometry here is in
// the usable area: the output minus those zones, origin at its top-left corner.
namespace MiniPlacement {
constexpr int side = 240;     // logical px, the mini's existing size
constexpr int inset = 16;     // logical px from the anchored edges (CielWin sits flush)
constexpr int glideMs = 220;  // CielWin MiniSceneWindowController.GlideDuration

// Same bit values as zwlr_layer_surface_v1.anchor and LayerShellQt::Window::Anchor.
enum Edge : unsigned { Top = 1, Bottom = 2, Left = 4, Right = 8 };

struct Layer {
    unsigned anchors = 0;
    QMargins margins;
    bool operator==(const Layer &o) const { return anchors == o.anchors && margins == o.margins; }
};

QRect rect(const QString &position, QSize usable, int side = MiniPlacement::side, int inset = MiniPlacement::inset);
Layer resting(const QString &position, int inset = MiniPlacement::inset);
// A glide frame: anchored top-left, margins = the frame's offset in the usable area.
Layer gliding(const QRect &frame);
// Where the compositor puts a surface of `side` px with this layer state (usable-area
// coordinates): an axis anchored on both or neither edge is centred, margins on edges
// the surface is not anchored to are ignored (wlr-layer-shell set_margin).
QPoint resolve(const Layer &layer, QSize usable, int side);
// CielWin MiniGlide: ease-out cubic, frames rounded away from zero, exact at both ends.
double ease(double t);
QRect glideAt(const QRect &from, const QRect &to, qint64 elapsedMs, qint64 durationMs);

// Hyprland's reserved area ([left, top, right, bottom]) of the named monitor from
// `j/monitors` JSON; nullopt when absent or malformed.
// The answer comes from FullscreenWatch's asynchronous query (B9/B10: cached, never a blocking
// request); it only lays out glide frames, never the resting place.
std::optional<QMargins> parseHyprlandReserved(const QByteArray &json, const QString &monitor);
}

// Moves the mini's layer surface: instant on attach, a 220 ms glide through layer
// margins on glideTo (CielWin GlideTo: a retarget starts from the frame last placed).
// Anchor switches between the resting and glide frames send the margins first, which
// the current anchors ignore, so no request ever moves the window by itself.
class MiniGlider : public QObject {
    Q_OBJECT
public:
    struct Sink {
        std::function<void(const QMargins &)> setMargins;
        std::function<void(unsigned)> setAnchors;
    };
    MiniGlider(std::function<qint64()> clockMs, std::function<QSize()> usableSize, QObject *parent = nullptr);

    // Binds a new surface and places it at `position` at once (any glide is dropped).
    void attach(Sink sink, const QString &position);
    // Forgets the surface (before it is destroyed); the target position is kept.
    void detach();
    bool attached() const { return bool(m_sink.setMargins); }
    // False when no surface is attached. Without a usable size the move is instant.
    bool glideTo(const QString &position);
    bool gliding() const { return m_gliding; }
    QString position() const { return m_position; }
    // One frame; driven by a ~60 Hz timer while gliding (public for tests).
    void tick();

private:
    using Layer = MiniPlacement::Layer;
    void apply(const Layer &target);
    std::function<qint64()> m_clock;
    std::function<QSize()> m_usableSize;
    Sink m_sink;
    QString m_position = QStringLiteral("top-right");
    Layer m_applied;
    bool m_gliding = false;
    QRect m_from, m_to, m_frame;
    qint64 m_start = 0;
    QTimer m_timer;
};
