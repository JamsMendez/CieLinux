#pragma once
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <string_view>

// Process-local, allocation-free diagnostics; independent of Qt logging rules.
namespace Diagnostics {
// Closed vocabulary and numeric payloads: no untrusted string reaches this route.
enum class Event { Load, Draw, Ready, RendererPid, Terminated, Incident,
                   ViewRetired, ProfileRetired, Prepared, Mapped, Terminal };
enum class Reason { Normal, Deadline, Output, Dismissal, Ambient, Failure, Guard };
class Lifecycle {
public:
    static constexpr unsigned limit = 48;
    explicit Lifecycle(bool enabled = true) noexcept : enabled(enabled) {}
    void enable() noexcept { enabled = true; }
    void record(Event event, int generation, long long a = 0,
                long long b = 0, long long c = 0) noexcept {
        if (!enabled) return;
        // Terminal records (at most a close and one failure upgrade) bypass the cap.
        const bool reserved = event == Event::Terminal && terminals < terminalReserve;
        if (reserved) ++terminals;
        if (count >= limit && !reserved) {
            if (!capped) { write("CIELINUX_LIFECYCLE_CAP\n"); capped = true; }
            return;
        }
        static constexpr const char *names[] = {"load", "draw", "ready", "renderer_pid",
            "terminated", "incident", "view_retired", "profile_retired", "prepared",
            "mapped", "terminal"};
        const auto index = static_cast<unsigned>(event);
        if (index >= sizeof(names) / sizeof(names[0])) return;
        char record[192];
        std::snprintf(record, sizeof(record),
            "CIELINUX_LIFECYCLE_V1 seq=%u event=%s gen=%d a=%lld b=%lld c=%lld\n",
            ++count, names[index], generation, a, b, c);
        write(record);
    }
private:
    static constexpr unsigned terminalReserve = 2;
    unsigned count = 0;
    unsigned terminals = 0;
    bool capped = false;
    bool enabled;
    static void write(const char *record) noexcept {
        std::fwrite(record, 1, std::strlen(record), stderr);
        std::fflush(stderr);
    }
};
class Sink {
public:
    static constexpr unsigned messageLimit = 64;
    static constexpr unsigned messageBytes = 512;
    static constexpr unsigned sourceBytes = 96;
    static constexpr unsigned recordBytes = 768;
    static constexpr unsigned outputBytes = messageLimit * recordBytes + 256;

    void startup() noexcept {
        if (!started) { direct("CIELINUX_DIAGNOSTICS_HOST_START\n"); started = true; }
    }
    void failure() noexcept {
        // Reserved fixed failure record remains visible even after the console cap.
        if (!failed) {
            direct("CIELINUX_DIAGNOSTICS_HOST_FAILURE HTML load or renderer failed; closing host\n");
            failed = true;
        }
    }
    void console(int level, std::string_view message, int line,
                 std::string_view source) noexcept {
        if (count >= messageLimit) {
            if (!capped) { direct("CIELINUX_DIAGNOSTICS_CONSOLE_CAP\n"); capped = true; }
            return;
        }
        ++count;
        char text[messageBytes + 1];
        sanitize(message, text, messageBytes);
        const auto end = source.find_first_of("?#");
        source = source.substr(0, end);
        const char *safeSource = "<unknown>";
        for (const char *path : {"qrc:/processing/index.html",
             "qrc:/processing/styles.css", "qrc:/processing/js/config.js",
             "qrc:/processing/js/math.js", "qrc:/processing/js/nebula.js",
             "qrc:/processing/js/sphere.js", "qrc:/processing/js/scene-data.js",
             "qrc:/processing/js/sprites.js", "qrc:/processing/js/layers.js",
             "qrc:/processing/js/see-through-hook.js",
             "qrc:/processing/js/render-loop.js", "qrc:/processing/js/main.js",
             "qrc:/raphael/index.html", "qrc:/raphael/styles.css",
             "qrc:/raphael/js/config.js", "qrc:/raphael/js/math.js",
             "qrc:/raphael/js/hexadecagon.js", "qrc:/raphael/js/nebula.js",
             "qrc:/raphael/js/sphere.js", "qrc:/raphael/js/scene-data.js",
             "qrc:/raphael/js/feathers.js", "qrc:/raphael/js/glyphs.js",
             "qrc:/raphael/js/glyph-rings.js", "qrc:/raphael/js/digits.js",
             "qrc:/raphael/js/central-core.js", "qrc:/raphael/js/sprites.js",
             "qrc:/raphael/js/layers.js", "qrc:/raphael/js/see-through-hook.js",
             "qrc:/raphael/js/render-loop.js",
             "qrc:/raphael/js/main.js",
             "qrc:/idle/index.html", "qrc:/idle/styles.css",
             "qrc:/idle/js/config.js", "qrc:/idle/js/math.js",
             "qrc:/idle/js/glyphs.js", "qrc:/idle/js/earth.js",
             "qrc:/idle/js/rings.js", "qrc:/idle/js/see-through-hook.js",
             "qrc:/idle/js/render-loop.js",
             "qrc:/idle/js/animate.js", "qrc:/idle/js/main.js",
             "qrc:/explorer/index.html", "qrc:/explorer/styles.css",
             "qrc:/explorer/js/config.js", "qrc:/explorer/js/math.js",
             "qrc:/explorer/js/glyphs.js", "qrc:/explorer/js/earth.js",
             "qrc:/explorer/js/rings.js", "qrc:/explorer/js/rising-sparks.js",
             "qrc:/explorer/js/render-loop.js", "qrc:/explorer/js/animate.js",
             "qrc:/explorer/js/main.js", "qrc:/explorer/js/see-through-hook.js",
             "qrc:/shared/js/alert-overlay.js"}) {
            if (source == path) { safeSource = path; break; }
        }
        char record[recordBytes];
        const char *severity = level == 0 ? "info" : level == 1 ? "warn" :
                               level == 2 ? "error" : "unknown";
        // Invalid or excessively large line numbers never enter the record verbatim.
        const int safeLine = line >= 0 && line <= 999999 ? line : 0;
        std::snprintf(record, sizeof(record),
                      "CIELINUX_DIAGNOSTICS_JS severity=%s source=%s line=%d message=%s\n",
                      severity, safeSource, safeLine, text);
        direct(record);
    }
private:
    unsigned count = 0;
    bool capped = false;
    bool started = false;
    bool failed = false;
    static void sanitize(std::string_view input, char *output, unsigned limit) noexcept {
        unsigned n = 0;
        for (unsigned char byte : input) {
            if (n == limit) break;
            // Printable ASCII only: blocks CR/LF, NUL, ESC, C1 and Unicode control tricks.
            output[n++] = byte >= 32 && byte <= 126 ? static_cast<char>(byte) : '?';
        }
        output[n] = '\0';
    }
    static void direct(const char *record) noexcept {
        std::fwrite(record, 1, std::strlen(record), stderr);
        std::fflush(stderr);
    }
};
}
