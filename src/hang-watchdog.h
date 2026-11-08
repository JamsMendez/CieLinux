#pragma once

#include <QTimer>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <thread>

// Aborts the process when the GUI event loop stops turning. A deadlock inside Qt WebEngine's
// compositor (the scene-graph render thread blocked on a WebEngine mutex while the GUI thread
// waits for it to sync) froze the resident host with its unit still "active" and its control
// socket silent. A QTimer on the GUI thread stamps a heartbeat; a plain thread (no Qt, so it
// keeps running whatever the event loop does) checks it and, past `timeout`, writes one
// `CIELINUX_WATCHDOG hang` line and calls abort(): systemd restarts the unit and
// systemd-coredump keeps a core of the hang. steady_clock (CLOCK_MONOTONIC) does not advance
// during suspend, so sleeping the machine is not a hang.
class HangWatchdog final {
public:
    static constexpr std::chrono::milliseconds defaultTimeout{15000};
    static constexpr std::chrono::milliseconds defaultInterval{1000};

    explicit HangWatchdog(std::chrono::milliseconds timeout = defaultTimeout,
                          std::chrono::milliseconds interval = defaultInterval);
    HangWatchdog(const HangWatchdog &) = delete;
    HangWatchdog &operator=(const HangWatchdog &) = delete;
    ~HangWatchdog();

    // GUI thread only, right before the event loop starts. Idempotent.
    void arm();
    // GUI thread only, once the event loop has returned. Idempotent; joins the checker.
    void stop();

private:
    static std::int64_t nowMs();
    void check();

    const std::chrono::milliseconds timeout;
    const std::chrono::milliseconds interval;
    QTimer heartbeat;
    std::atomic<std::int64_t> lastBeatMs{0};
    std::mutex mutex;
    std::condition_variable wake;
    bool stopping = false;
    std::thread checker;
};
