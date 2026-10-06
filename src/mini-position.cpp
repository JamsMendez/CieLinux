#include "mini-position.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <cmath>

namespace MiniPosition {

const QStringList &names() {
    static const QStringList order{
        QStringLiteral("top-left"), QStringLiteral("top-center"), QStringLiteral("top-right"),
        QStringLiteral("right-center"), QStringLiteral("bottom-right"), QStringLiteral("bottom-center"),
        QStringLiteral("bottom-left"), QStringLiteral("left-center")};
    return order;
}

bool isValid(const QString &name) { return names().contains(name); }

QString next(const QString &name) {
    const int i = names().indexOf(name);
    return i < 0 ? names().first() : names().at((i + 1) % names().size());
}

QString previous(const QString &name) {
    const int i = names().indexOf(name);
    return i < 0 ? names().first() : names().at((i + names().size() - 1) % names().size());
}

} // namespace MiniPosition

namespace MiniPlacement {
namespace {

// Which edges a position touches; an unknown name rests at the default, top-right.
unsigned edgesOf(const QString &position) {
    static const unsigned table[] = {Top | Left, Top, Top | Right, Right,
                                     Bottom | Right, Bottom, Bottom | Left, Left};
    const int i = MiniPosition::names().indexOf(position);
    return i < 0 ? (Top | Right) : table[i];
}

// One axis: `start`/`end` say which edges are anchored.
int place(bool start, bool end, int marginStart, int marginEnd, int usable, int size) {
    if (start && !end) return marginStart;
    if (end && !start) return usable - size - marginEnd;
    const int centred = (usable - size) / 2;
    return start ? centred + (marginStart - marginEnd) / 2 : centred;
}

int lerp(int from, int to, double e) {
    return int(std::round(from + (to - from) * e)); // std::round: halves away from zero
}

} // namespace

QRect rect(const QString &position, QSize usable, int side, int inset) {
    const unsigned edges = edgesOf(position);
    const int x = place(edges & Left, edges & Right, inset, inset, usable.width(), side);
    const int y = place(edges & Top, edges & Bottom, inset, inset, usable.height(), side);
    return QRect(x, y, side, side);
}

Layer resting(const QString &position, int inset) {
    const unsigned edges = edgesOf(position);
    return {edges, QMargins(edges & Left ? inset : 0, edges & Top ? inset : 0,
                            edges & Right ? inset : 0, edges & Bottom ? inset : 0)};
}

Layer gliding(const QRect &frame) { return {Top | Left, QMargins(frame.x(), frame.y(), 0, 0)}; }

QPoint resolve(const Layer &layer, QSize usable, int side) {
    const QMargins &m = layer.margins;
    return QPoint(place(layer.anchors & Left, layer.anchors & Right, m.left(), m.right(), usable.width(), side),
                  place(layer.anchors & Top, layer.anchors & Bottom, m.top(), m.bottom(), usable.height(), side));
}

double ease(double t) { return 1 - std::pow(1 - t, 3); }

QRect glideAt(const QRect &from, const QRect &to, qint64 elapsedMs, qint64 durationMs) {
    if (elapsedMs >= durationMs) return to;
    if (elapsedMs <= 0) return from;
    const double e = ease(double(elapsedMs) / double(durationMs));
    return QRect(lerp(from.x(), to.x(), e), lerp(from.y(), to.y(), e),
                 lerp(from.width(), to.width(), e), lerp(from.height(), to.height(), e));
}

std::optional<QMargins> parseHyprlandReserved(const QByteArray &json, const QString &monitor) {
    const QJsonDocument doc = QJsonDocument::fromJson(json);
    if (!doc.isArray()) return std::nullopt;
    for (const QJsonValue &value : doc.array()) {
        const QJsonObject object = value.toObject();
        if (object.value(QStringLiteral("name")).toString() != monitor) continue;
        const QJsonArray reserved = object.value(QStringLiteral("reserved")).toArray();
        if (reserved.size() != 4) return std::nullopt;
        int v[4];
        for (int i = 0; i < 4; ++i) {
            if (!reserved.at(i).isDouble()) return std::nullopt;
            v[i] = reserved.at(i).toInt(-1);
            if (v[i] < 0 || v[i] > 100000) return std::nullopt;
        }
        return QMargins(v[0], v[1], v[2], v[3]);
    }
    return std::nullopt;
}

} // namespace MiniPlacement

using namespace MiniPlacement;

MiniGlider::MiniGlider(std::function<qint64()> clockMs, std::function<QSize()> usableSize, QObject *parent)
    : QObject(parent), m_clock(std::move(clockMs)), m_usableSize(std::move(usableSize)) {
    m_timer.setTimerType(Qt::PreciseTimer);
    m_timer.setInterval(16);
    connect(&m_timer, &QTimer::timeout, this, &MiniGlider::tick);
}

void MiniGlider::attach(Sink sink, const QString &position) {
    m_timer.stop();
    m_gliding = m_aside = false;
    m_sink = std::move(sink);
    m_position = MiniPosition::isValid(position) ? position : QStringLiteral("top-right");
    // A fresh surface: send the whole resting state.
    m_applied = resting(m_position);
    m_sink.setMargins(m_applied.margins);
    m_sink.setAnchors(m_applied.anchors);
}

void MiniGlider::detach() {
    m_timer.stop();
    m_gliding = m_aside = false;
    m_sink = {};
}

bool MiniGlider::glideTo(const QString &position) {
    if (!attached() || !MiniPosition::isValid(position)) return false;
    if (!m_gliding && !m_aside && position == m_position) return true;
    const QSize usable = m_usableSize();
    m_position = position;
    m_aside = false;
    if (!usable.isValid() || usable.width() < side || usable.height() < side) {
        // No reliable frame to glide through: go straight to the resting place.
        m_timer.stop();
        m_gliding = false;
        apply(resting(position));
        return true;
    }
    start(usable, rect(position, usable));
    return true;
}

bool MiniGlider::glideToRect(const QRect &frame) {
    if (!attached()) return false;
    if (m_aside && !m_gliding && frame == m_to) return true;
    const QSize usable = m_usableSize();
    if (!usable.isValid() || usable.width() < side || usable.height() < side) return false;
    m_aside = true;
    start(usable, frame);
    return true;
}

void MiniGlider::start(QSize usable, const QRect &to) {
    // A retarget starts from the frame last placed; otherwise from where the surface
    // rests now (its resting or dodge layer resolved in this usable area).
    m_from = m_gliding ? m_frame : QRect(resolve(m_applied, usable, side), QSize(side, side));
    m_to = to;
    m_frame = m_from;
    m_start = m_clock();
    m_gliding = true;
    apply(MiniPlacement::gliding(m_frame));
    m_timer.start();
}

void MiniGlider::tick() {
    if (!m_gliding || !attached()) {
        m_timer.stop();
        m_gliding = false;
        return;
    }
    const qint64 elapsed = m_clock() - m_start;
    if (elapsed >= glideMs) {
        m_timer.stop();
        m_gliding = false;
        m_frame = m_to;
        // A dodge rests on its glide frame; a position on its anchors.
        apply(m_aside ? MiniPlacement::gliding(m_to) : resting(m_position));
        return;
    }
    m_frame = glideAt(m_from, m_to, elapsed, glideMs);
    apply(MiniPlacement::gliding(m_frame));
}

void MiniGlider::apply(const Layer &target) {
    if (target == m_applied) return;
    if (target.anchors != m_applied.anchors) {
        // Margins first: edges anchored now keep theirs, the others take the target's
        // (ignored until anchored). Then the anchors switch frames in place.
        QMargins bridge;
        const auto pick = [&](unsigned edge, int now, int next) { return (m_applied.anchors & edge) ? now : next; };
        bridge.setLeft(pick(Left, m_applied.margins.left(), target.margins.left()));
        bridge.setTop(pick(Top, m_applied.margins.top(), target.margins.top()));
        bridge.setRight(pick(Right, m_applied.margins.right(), target.margins.right()));
        bridge.setBottom(pick(Bottom, m_applied.margins.bottom(), target.margins.bottom()));
        if (bridge != m_applied.margins) {
            m_applied.margins = bridge;
            m_sink.setMargins(bridge);
        }
        m_applied.anchors = target.anchors;
        m_sink.setAnchors(target.anchors);
    }
    if (target.margins != m_applied.margins) {
        m_applied.margins = target.margins;
        m_sink.setMargins(target.margins);
    }
}
