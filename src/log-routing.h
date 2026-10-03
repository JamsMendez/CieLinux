#pragma once

#include <QByteArray>
#include <QtGlobal>

// One log stream. CieLinux's own diagnostics, lifecycle and IPC lines fwrite to stderr, but a
// Qt built with journald support (Arch's qt6-base) sends qInfo/qWarning to the journal instead
// whenever the process has no controlling terminal (scripts, agents, the user unit). The host
// log then splits: `CIELINUX_MODE switched`, `CIELINUX_HTTP listening` and the tray lines go
// missing from a captured stderr. Forcing Qt's stderr route keeps every line in one ordered
// stream; under the user unit that stream still lands in the journal. Qt decides once, on the
// first message, so main() calls this before anything can log. An explicit value set by the
// user (e.g. QT_FORCE_STDERR_LOGGING=0) is kept.
namespace LogRouting {
inline void toStderr() {
    if (!qEnvironmentVariableIsSet("QT_FORCE_STDERR_LOGGING"))
        qputenv("QT_FORCE_STDERR_LOGGING", "1");
}
} // namespace LogRouting
