#include "mini-dodge.h"

#include <QList>

namespace MiniDodge {

QString name(Direction direction) {
    switch (direction) {
    case Direction::Left: return QStringLiteral("left");
    case Direction::Right: return QStringLiteral("right");
    case Direction::Up: return QStringLiteral("up");
    case Direction::Down: return QStringLiteral("down");
    }
    return QString();
}

bool contains(const QRect &frame, QPointF cursor) {
    if (!frame.isValid()) return false;
    // QRect::center() rounds down; canvas coordinates instead centre at half the size.
    const double dx = cursor.x() - (frame.x() + frame.width() / 2.0);
    const double dy = cursor.y() - (frame.y() + frame.height() / 2.0);
    const double radius = outerRadius * qMin(frame.width(), frame.height());
    return dx * dx + dy * dy < radius * radius;
}

QRect zone(const QRect &rect, int margin) { return rect.adjusted(-margin, -margin, margin, margin); }

std::optional<Choice> choose(const QRect &home, QPoint cursor, QSize usable, int inset) {
    const QRect area(inset, inset, usable.width() - 2 * inset, usable.height() - 2 * inset);
    const QPoint centre = home.center();
    const int dx = cursor.x() - centre.x(), dy = cursor.y() - centre.y();
    // Preferred side first, then the perpendicular sides, farther from the cursor first.
    QList<Direction> order;
    if (qAbs(dx) >= qAbs(dy)) {
        order << (dx > 0 ? Direction::Left : Direction::Right);
        order << (dy > 0 ? Direction::Up : Direction::Down) << (dy > 0 ? Direction::Down : Direction::Up);
    } else {
        order << (dy < 0 ? Direction::Down : Direction::Up);
        order << (dx > 0 ? Direction::Left : Direction::Right) << (dx > 0 ? Direction::Right : Direction::Left);
    }
    const int sx = home.width() + approach + gap, sy = home.height() + approach + gap;
    for (const Direction direction : order) {
        QRect rect = home;
        switch (direction) {
        case Direction::Left: rect.translate(-sx, 0); break;
        case Direction::Right: rect.translate(sx, 0); break;
        case Direction::Up: rect.translate(0, -sy); break;
        case Direction::Down: rect.translate(0, sy); break;
        }
        if (area.contains(rect) && !zone(rect).contains(cursor)) return Choice{direction, rect};
    }
    return std::nullopt;
}

} // namespace MiniDodge

using namespace MiniDodge;

MiniDodger::MiniDodger(MiniGlider &glider, std::function<qint64()> clockMs, std::function<QSize()> usableSize,
                       Query query, std::function<bool()> enabled, Trace trace, QObject *parent)
    : QObject(parent), m_glider(glider), m_clock(std::move(clockMs)), m_usableSize(std::move(usableSize)),
      m_query(std::move(query)), m_enabled(std::move(enabled)), m_trace(std::move(trace)) {
    if (!m_trace) m_trace = [](const QString &) {};
    m_timer.setInterval(pollMs);
    connect(&m_timer, &QTimer::timeout, this, &MiniDodger::poll);
}

void MiniDodger::start() {
    if (!m_timer.isActive()) m_timer.start();
}

void MiniDodger::stop() {
    m_timer.stop();
    reset();
}

void MiniDodger::cancel() { reset(); }

void MiniDodger::reset() {
    // A request still out keeps m_asking: its answer is dropped by the epoch, and only then may the
    // next poll ask again (one request at a time, across cancels and restarts).
    ++m_epoch;
    m_dodged = false;
    m_awaySince = -1;
}

void MiniDodger::poll() {
    if (!m_enabled() || !m_glider.attached()) {
        stop();
        return;
    }
    // Never two requests at once: this tick is skipped, unless the request out is past askLimitMs.
    const qint64 now = m_clock();
    if (m_asking && now - m_askedAt < askLimitMs) return;
    m_asking = true;
    m_askedAt = now;
    const quint64 epoch = m_epoch, ask = ++m_ask;
    const bool asked = m_query([this, epoch, ask](std::optional<QPoint> cursor) {
        if (ask != m_ask) return; // given up on: a newer request is out
        m_asking = false;
        if (epoch != m_epoch) return;
        update(cursor);
    });
    if (!asked) m_asking = false; // nobody to ask: no cursor, no dodge
}

void MiniDodger::update(std::optional<QPoint> cursor) {
    if (!m_glider.attached()) return;
    const QSize usable = m_usableSize();
    if (!usable.isValid() || usable.width() < MiniPlacement::side || usable.height() < MiniPlacement::side) return;
    const QRect home = MiniPlacement::rect(m_glider.position(), usable);
    const bool nearHome = cursor && contains(home, *cursor);
    const bool overFrame = cursor && contains(m_glider.frame(), *cursor);
    if (!m_dodged) {
        if (!overFrame) return;
        if (const auto choice = choose(home, *cursor, usable)) dodge(*choice);
        return;
    }
    if (overFrame) {
        // Followed to the new spot: another side, chosen from home again; with none left and
        // home clear of the cursor, home.
        m_awaySince = -1;
        if (const auto choice = choose(home, *cursor, usable)) dodge(*choice);
        else if (!nearHome) returnHome();
        return;
    }
    if (nearHome) { // still looking behind the window
        m_awaySince = -1;
        return;
    }
    const qint64 now = m_clock();
    if (m_awaySince < 0) m_awaySince = now;
    if (now - m_awaySince >= returnMs) returnHome();
}

void MiniDodger::returnHome() {
    m_dodged = false;
    m_awaySince = -1;
    m_glider.glideTo(m_glider.position());
    m_trace(QStringLiteral("dodge return"));
}

void MiniDodger::dodge(const Choice &choice) {
    if (!m_glider.glideToRect(choice.rect)) return;
    m_dodged = true;
    m_awaySince = -1;
    m_trace(QStringLiteral("dodge direction=%1").arg(name(choice.direction)));
}
