#pragma once

#include "mini-position.h"

#include <QObject>
#include <QPoint>
#include <QRect>
#include <QSize>
#include <QString>
#include <QTimer>
#include <functional>
#include <optional>

// Hover dodge: the mini takes no pointer input (Qt::WindowTransparentForInput), so it moves aside
// when the cursor comes near and glides back once the cursor has gone. Geometry is in the usable
// area, as MiniPlacement's: the output minus other surfaces' exclusive zones, origin top-left.
namespace MiniDodge {
constexpr int approach = 24;  // px around the window that count as "near"
constexpr int gap = 8;        // px between the dodged window and the zone it left
constexpr int returnMs = 400; // the cursor stays away this long before the window returns
constexpr int pollMs = 100;   // Hyprland cursor poll interval while in the mini

enum class Direction { Left, Right, Up, Down };
QString name(Direction direction);

// The window's rect grown by the approach margin on every side.
QRect zone(const QRect &rect, int margin = approach);

struct Choice {
    Direction direction;
    QRect rect;
};
// Where to dodge from `home` with the cursor at `cursor`: away from it along the dominant axis
// (relative to home's centre), shifted by side + approach + gap so it clears home's approach zone.
// A rect must lie inside the usable area less the inset and keep the cursor out of its own zone;
// when the preferred side fails, the two perpendicular sides are tried (the one farther from the
// cursor first). nullopt: nowhere to go, the window stays.
std::optional<Choice> choose(const QRect &home, QPoint cursor, QSize usable, int inset = MiniPlacement::inset);
}

// Drives the dodge in the mini: polls the cursor every pollMs (one request at a time), glides the
// window aside through MiniGlider::glideToRect when the cursor enters its approach zone, and back
// to its position once the cursor has stayed away from both spots for returnMs. Never writes the
// position. Traces one line per move: `dodge direction=<left|right|up|down>`, `dodge return`.
class MiniDodger : public QObject {
    Q_OBJECT
public:
    using Answer = std::function<void(std::optional<QPoint>)>;
    // Asks for the cursor in usable-area coordinates and answers later (nullopt: unknown). False,
    // and no answer, when there is nobody to ask (no Hyprland).
    using Query = std::function<bool(Answer)>;
    using Trace = std::function<void(const QString &)>;
    // `enabled`: the mini is the mode and the host is not closing; false stops the polling.
    MiniDodger(MiniGlider &glider, std::function<qint64()> clockMs, std::function<QSize()> usableSize,
               Query query, std::function<bool()> enabled, Trace trace, QObject *parent = nullptr);

    // Starts polling (idempotent); a new surface calls it after MiniGlider::attach.
    void start();
    // Stops polling and forgets the dodge (rebuild, mode switch, close); an answer still due is
    // dropped. The glider is left alone.
    void stop();
    // Forgets the dodge and keeps polling: a cycle-position move glides the window itself.
    void cancel();
    bool polling() const { return m_timer.isActive(); }
    bool dodged() const { return m_dodged; }
    // One poll (driven by the timer; public for tests): asks unless an answer is still due.
    void poll();
    // One cursor answer (public for tests).
    void update(std::optional<QPoint> cursor);

private:
    void reset();
    void dodge(const MiniDodge::Choice &choice);
    void returnHome();
    MiniGlider &m_glider;
    std::function<qint64()> m_clock;
    std::function<QSize()> m_usableSize;
    Query m_query;
    std::function<bool()> m_enabled;
    Trace m_trace;
    QTimer m_timer;
    // Bumped by stop() and cancel(): answers asked for before are ignored.
    quint64 m_epoch = 0;
    bool m_asking = false, m_dodged = false;
    QRect m_rect;
    // When the cursor was first seen away from both spots, -1 while it is near one.
    qint64 m_awaySince = -1;
};
