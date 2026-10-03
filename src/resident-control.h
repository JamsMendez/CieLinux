#pragma once

#include <QSocketNotifier>
#include <QString>
#include <QThread>
#include <QTimer>
#include <atomic>
#include <cerrno>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <functional>
#include <memory>
#include <unistd.h>

struct HostOptions {
    QString output;
    QString scene = QStringLiteral("processing");
    // scene-mini (keyed top-layer window) or scene (full-size wallpaper).
    QString mode = QStringLiteral("scene-mini");
    int durationMs = 15000;
    bool resident = false;
    // Which flags were given: settings.conf supplies the others (flags win).
    bool sceneGiven = false, modeGiven = false;
};

inline bool parseHostOptions(int argc, char **argv, HostOptions &options) {
    bool outputSeen = false, sceneSeen = false, modeSeen = false, durationSeen = false;
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--resident") == 0) {
            if (options.resident || durationSeen) return false;
            options.resident = true;
            continue;
        }
        if (i + 1 >= argc) return false;
        const QString value = QString::fromLocal8Bit(argv[++i]);
        if (std::strcmp(argv[i - 1], "--output") == 0 && !outputSeen &&
            !value.isEmpty() && !value.startsWith(QStringLiteral("--"))) {
            options.output = value;
            outputSeen = true;
        } else if (std::strcmp(argv[i - 1], "--scene") == 0 && !sceneSeen &&
                   (value == QStringLiteral("processing") || value == QStringLiteral("raphael") ||
                    value == QStringLiteral("idle") || value == QStringLiteral("explorer"))) {
            options.scene = value;
            sceneSeen = options.sceneGiven = true;
        } else if (std::strcmp(argv[i - 1], "--mode") == 0 && !modeSeen &&
                   (value == QStringLiteral("scene") || value == QStringLiteral("scene-mini"))) {
            options.mode = value;
            modeSeen = options.modeGiven = true;
        } else if (std::strcmp(argv[i - 1], "--duration") == 0 && !durationSeen && !options.resident &&
                   (std::strcmp(argv[i], "15") == 0 || std::strcmp(argv[i], "120") == 0)) {
            options.durationMs = std::strcmp(argv[i], "120") == 0 ? 120000 : 15000;
            durationSeen = true;
        } else return false;
    }
    return true;
}

inline void configureLifetime(QTimer &lifetime, const HostOptions &options) {
    lifetime.setSingleShot(true);
    if (!options.resident) lifetime.start(options.durationMs);
}

// Process-local host notification only. D3 must authenticate containment first.
// Lock-free atomics are required in the raw handler; Qt runs only in activate().
class ResidentControl final {
public:
    ResidentControl() {
        if (published.load() != -1 || ::pipe2(pipe, O_NONBLOCK | O_CLOEXEC) != 0) return;
        struct sigaction action{};
        action.sa_handler = notify;
        ::sigemptyset(&action.sa_mask);
        published.store(pipe[1]); // Queue stops even before notifier attachment.
        if (::sigaction(SIGTERM, &action, &oldTerm) != 0) {
            published.store(-1);
            return;
        }
        termInstalled = true;
        if (::sigaction(SIGINT, &action, &oldInt) != 0) return;
        intInstalled = true;
        installed = true;
    }
    ResidentControl(const ResidentControl &) = delete;
    ResidentControl &operator=(const ResidentControl &) = delete;
    ~ResidentControl() {
        notifier.reset(); // Disconnect before releasing its descriptor.
        if (termInstalled) {
            published.store(-1);
            // A handler that already read the FD must finish before close.
            // Later handlers see -1, including ones racing this wait.
            while (active.load() != 0) QThread::yieldCurrentThread();
            ::sigaction(SIGTERM, &oldTerm, nullptr);
        }
        if (intInstalled) ::sigaction(SIGINT, &oldInt, nullptr);
        for (int fd : pipe) if (fd != -1) ::close(fd);
    }
    bool valid() const { return installed; }
    void cancel() { if (notifier) notifier->setEnabled(false); }
    void activate(QObject *context, std::function<void()> stop) {
        notifier = std::make_unique<QSocketNotifier>(pipe[0], QSocketNotifier::Read);
        QObject::connect(notifier.get(), &QSocketNotifier::activated, context,
                         [this, stop = std::move(stop)] {
            if (delivered) return;
            delivered = true;
            cancel(); // One notification; no unbounded drain under a signal flood.
            stop();
        });
    }
private:
    static_assert(std::atomic<int>::is_always_lock_free);
    inline static std::atomic<int> published{-1}, active{0};
    int pipe[2] = {-1, -1};
    struct sigaction oldTerm{}, oldInt{};
    bool termInstalled = false, intInstalled = false, installed = false, delivered = false;
    std::unique_ptr<QSocketNotifier> notifier;
    static void notify(int) noexcept {
        const int savedErrno = errno;
        active.fetch_add(1);
        const int fd = published.load();
        if (fd != -1) {
            const char byte = 1;
            ssize_t result;
            do { result = ::write(fd, &byte, 1); } while (result == -1 && errno == EINTR);
            // EAGAIN means an earlier stop is already queued on the owned pipe.
        }
        active.fetch_sub(1);
        errno = savedErrno;
    }
};
