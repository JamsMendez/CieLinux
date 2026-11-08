#include "hang-watchdog.h"

#include <cstdio>
#include <cstdlib>
#include <unistd.h>

HangWatchdog::HangWatchdog(std::chrono::milliseconds timeout, std::chrono::milliseconds interval)
    : timeout(timeout), interval(interval) {
    heartbeat.setInterval(int(interval.count()));
    QObject::connect(&heartbeat, &QTimer::timeout, [this] { lastBeatMs.store(nowMs()); });
}

HangWatchdog::~HangWatchdog() { stop(); }

std::int64_t HangWatchdog::nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch()).count();
}

void HangWatchdog::arm() {
    if (checker.joinable()) return;
    lastBeatMs.store(nowMs());
    heartbeat.start();
    checker = std::thread([this] { check(); });
}

void HangWatchdog::stop() {
    heartbeat.stop();
    {
        std::lock_guard<std::mutex> lock(mutex);
        stopping = true;
    }
    wake.notify_all();
    if (checker.joinable()) checker.join();
}

void HangWatchdog::check() {
    std::unique_lock<std::mutex> lock(mutex);
    while (!wake.wait_for(lock, interval, [this] { return stopping; })) {
        const auto stalled = nowMs() - lastBeatMs.load();
        if (stalled <= timeout.count()) continue;
        // Async-signal-safe output only: the GUI thread may hold any Qt or stdio lock.
        char line[128];
        const int length = std::snprintf(line, sizeof line,
            "CIELINUX_WATCHDOG hang stalled_ms=%lld timeout_ms=%lld; aborting\n",
            static_cast<long long>(stalled), static_cast<long long>(timeout.count()));
        if (length > 0) (void)!::write(STDERR_FILENO, line, std::size_t(length));
        std::abort();
    }
}
