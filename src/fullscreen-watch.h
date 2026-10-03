#pragma once

#include <QByteArray>
#include <QLocalSocket>
#include <QMargins>
#include <QObject>
#include <QString>
#include <QStringList>
#include <QTimer>
#include <functional>
#include <optional>

// B2: "is the wallpaper's output covered by a fullscreen window right now", so the wallpaper scene
// pauses and alerts wait while nobody can see them (CielWin PrimaryMonitorFullscreenDetector and
// AppComposition.IsCovered, CielWin.Interop/Win32/PrimaryMonitorFullscreenDetector.cs).
//
// On Linux the answer comes from Hyprland IPC, event driven (never polled): the event socket
// ($XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock) says WHEN coverage may have
// changed (fullscreen>>, workspace>>, focusedmon>>, window open/close/move, ...); each burst of
// such events then costs one query over the request socket (.socket.sock: j/monitors + j/clients)
// that says WHAT the output shows. One query also runs when the watch (re)connects.
//
// B8: Hyprland may restart (or its event socket drop) while CieLinux runs. The watch then retries
// with bounded backoff (1 s doubling to 30 s), re-resolving the instance on each attempt: a
// restarted Hyprland has a new signature that this process's environment does not know.
// B9: the same j/monitors answer also keeps the output's reserved zones (bars) cached, so the
// wallpaper alerts read their work area without a blocking request on the GUI thread.
// B10: the watch runs in both modes. In the mini coverage is off (the mini sits on the top layer and
// is never covered): no j/clients query, no coverage line, only the events that can move the reserved
// zones trigger a (j/monitors) query, so the mini's glide frame reads the same cache.
// B12: a failed query (reads as uncovered, CielWin parity) is retried with a short bounded backoff
// instead of waiting for the next event, and a request's timeout only counts time the event loop
// was actually running: the GUI loop stalls for seconds while QtWebEngine starts, which used to
// fail the first query on every start and leave a fullscreen window present then unnoticed.
namespace HyprlandIpc {
// The Hyprland instance directories to try, best first. The one named by
// $HYPRLAND_INSTANCE_SIGNATURE ($XDG_RUNTIME_DIR first, then /run/user/<uid>, so a host started
// with a private XDG_RUNTIME_DIR still finds it), then every other instance under the session's
// runtime dir ($XDG_RUNTIME_DIR, else /run/user/<uid>)/hypr/, newest event socket first (Hyprland
// creates hypr/<signature>/.socket.sock + .socket2.sock and removes the directory on a clean exit;
// a crash leaves a stale one behind, which a failed connect skips). Only directories whose event
// socket exists and is owned by this user; signatures with "/" or a leading "." are never used.
QStringList instanceDirs();
// Covered = a true fullscreen window (Hyprland's internal fullscreen state has the fullscreen bit,
// 2; a maximised-only window, state 1, keeps the bars and is not fullscreen, as CielWin's "not
// maximised" rule) that is mapped and not hidden, on the monitor's active workspace or its shown
// special workspace. nullopt when either answer is unreadable or the monitor is not listed.
std::optional<bool> fullscreenCovers(const QByteArray &monitorsJson, const QByteArray &clientsJson,
                                     const QString &monitor);
// The event names (text before ">>") after which coverage or the reserved zones may differ.
bool triggersQuery(const QByteArray &eventName);
// The subset after which the reserved zones may differ (bars, config, monitors): enough with coverage off.
bool affectsReserved(const QByteArray &eventName);
}

class FullscreenWatch final : public QObject {
    Q_OBJECT
public:
    using Trace = std::function<void(const QString &)>;
    // `monitor` is the wallpaper's output name (QScreen::name(), e.g. "HDMI-A-2").
    FullscreenWatch(QString monitor, Trace trace, QObject *parent = nullptr);
    // B11: quiet teardown at app exit: no `lost` line, no coveredChanged, no retry.
    ~FullscreenWatch() override;
    // Connects to the event socket and runs the first query. Idempotent. Without Hyprland it logs
    // one line, stays uncovered and keeps retrying (silently) until one shows up.
    void start();
    // B10: coverage tracking (on for the wallpaper, off for the mini; on by default). Off reads
    // uncovered at once, quietly (the mode switch re-evaluates); on asks Hyprland at once. A change
    // logs `fullscreen-watch coverage on|off monitor=<out>`; the connection and the reserved zones
    // cache are kept either way.
    void setCoverage(bool enabled);
    bool coverage() const { return m_coverage; }
    bool covered() const { return m_covered; }
    // The output's last known reserved zones [left, top, right, bottom]; nullopt until the first
    // readable j/monitors answer. Kept across an outage (bars rarely change with a restart).
    std::optional<QMargins> reserved() const { return m_reserved; }
    // Retry delays: the first one, doubled after each failed attempt up to `maxMs`.
    void setRetryDelays(int firstMs, int maxMs);
    // B12: a failed query is retried after `firstMs` (default 250), doubled after each failure up to
    // `maxMs` (default 4000), until one succeeds; a success restarts at `firstMs`.
    void setQueryRetryDelays(int firstMs, int maxMs);
    // B11: the log prefix for one of this watch's trace lines. The Hyprland connection lines
    // (`fullscreen-watch ...`: started, lost, reconnected, unavailable, coverage, query-failed,
    // query-recovered) show
    // in both modes and go out as CIELINUX_HYPRLAND; `covered|uncovered monitor=` are about the
    // wallpaper and go out as CIELINUX_WALLPAPER.
    static const char *logPrefix(const QString &line);
signals:
    void coveredChanged(bool covered);

private:
    void tryConnect();
    void connectNext();
    void connectFailed();
    void scheduleRetry();
    void onEvents();
    void scheduleQuery();
    void runQuery();
    void request(const QByteArray &command, std::function<void(std::optional<QByteArray>)> done);
    void finishQuery(std::optional<bool> covered);
    void setCovered(bool covered);

    QString m_monitor;
    Trace m_trace;
    QLocalSocket m_events;
    QTimer m_coalesce, m_retry, m_queryRetry;
    QByteArray m_buffer;
    // The instance in use (its .socket.sock answers the queries) and the ones left to try.
    QString m_instance;
    QStringList m_candidates;
    std::optional<QMargins> m_reserved;
    int m_firstDelay = 1000, m_maxDelay = 30000, m_delay = 1000;
    int m_queryFirstDelay = 250, m_queryMaxDelay = 4000, m_queryDelay = 250;
    // Bumped on every disconnect: answers of an older connection are ignored.
    quint64 m_generation = 0;
    bool m_started = false, m_connecting = false, m_connected = false, m_querying = false, m_dirty = false;
    // One log line per outage: `unavailable` or `lost` when it starts, `reconnected` when it ends.
    bool m_outageLogged = false, m_reconnecting = false;
    bool m_queryFailing = false, m_covered = false, m_coverage = true;
};
