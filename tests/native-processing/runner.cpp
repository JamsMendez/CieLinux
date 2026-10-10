#include <QGuiApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QQmlContext>
#include <QQuickView>
#include <QSet>
#include <QTimer>
#include <QWebEngineUrlRequestInfo>
#include <QWebEngineUrlRequestInterceptor>
#include <QtWebEngineQuick/QQuickWebEngineDownloadRequest>
#include <QtWebEngineQuick/QQuickWebEngineProfile>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>
#include <cmath>
#include <csignal>
#include <iostream>
#include <unistd.h>

static const QUrl page(QStringLiteral("qrc:/native-processing/fixture.html"));

// Exact URLs only: no file/network/data URLs, queries, fragments or extra resources.
class Resources final : public QWebEngineUrlRequestInterceptor {
public:
    void interceptRequest(QWebEngineUrlRequestInfo &info) override {
        static const QSet<QString> urls{
            QStringLiteral("qrc:/native-processing/fixture.html"),
            QStringLiteral("qrc:/native-processing/driver.js"),
            QStringLiteral("qrc:/processing/styles.css"),
            QStringLiteral("qrc:/processing/js/config.js"),
            QStringLiteral("qrc:/processing/js/math.js"),
            QStringLiteral("qrc:/processing/js/nebula.js"),
            QStringLiteral("qrc:/processing/js/sphere.js"),
            QStringLiteral("qrc:/processing/js/scene-data.js"),
            QStringLiteral("qrc:/processing/js/sprites.js"),
            QStringLiteral("qrc:/processing/js/layers.js"),
            QStringLiteral("qrc:/processing/js/see-through-hook.js"),
            QStringLiteral("qrc:/shared/js/alert-overlay.js"),
            QStringLiteral("qrc:/processing/js/render-loop.js"),
            QStringLiteral("qrc:/processing/js/main.js"),
            QStringLiteral("qrc:/shared/fonts/ArchivoBlack-Regular.ttf")};
        const bool allowed = urls.contains(info.requestUrl().toString(QUrl::FullyEncoded));
        info.block(!allowed || info.requestMethod() != "GET" ||
                   (info.resourceType() == QWebEngineUrlRequestInfo::ResourceTypeMainFrame &&
                    info.requestUrl() != page) ||
                   info.resourceType() == QWebEngineUrlRequestInfo::ResourceTypeSubFrame);
    }
};

// Independent native boundary: never coerce strings/bools to numbers or accept extras.
static bool exactKeys(const QJsonObject &object, QStringList expected) {
    expected.sort();
    return object.keys() == expected;
}
static bool number(const QJsonValue &value, double low, double high) {
    return value.isDouble() && std::isfinite(value.toDouble()) &&
           value.toDouble() >= low && value.toDouble() <= high;
}
static bool near(double a, double b) { return std::abs(a - b) <= 1e-7; }

static bool validStats(const QJsonValue &value, bool stage = false) {
    if (!value.isObject()) return false;
    const auto object = value.toObject();
    QStringList keys{"count", "meanMs", "medianMs", "p95Ms", "firstHalfMeanMs", "secondHalfMeanMs"};
    if (stage) keys.append("name");
    if (!exactKeys(object, keys) || !number(object["count"], 120, 120)) return false;
    for (const char *key : {"meanMs", "medianMs", "p95Ms", "firstHalfMeanMs", "secondHalfMeanMs"})
        if (!number(object[key], 0, 15000)) return false;
    return object["medianMs"].toDouble() <= object["p95Ms"].toDouble() &&
           near(object["meanMs"].toDouble(),
                (object["firstHalfMeanMs"].toDouble() + object["secondHalfMeanMs"].toDouble()) / 2);
}

static bool validAttribution(const QJsonValue &value) {
    if (!value.isObject()) return false;
    const auto object = value.toObject();
    if (!exactKeys(object, {"version", "warmup", "count", "timestampRangeMs", "clock", "frame", "stages", "residual"}) ||
        !number(object["version"], 1, 1) || !number(object["warmup"], 30, 30) ||
        !number(object["count"], 120, 120)) return false;
    const auto range = object["timestampRangeMs"].toArray();
    if (!object["timestampRangeMs"].isArray() || range.size() != 2 ||
        !number(range[0], 0, 9007199254740991.0) || !number(range[1], 0, 9007199254740991.0) ||
        range[1].toDouble() <= range[0].toDouble() || range[1].toDouble() - range[0].toDouble() > 15000) return false;
    const auto clock = object["clock"].toObject();
    if (!object["clock"].isObject() ||
        !exactKeys(clock, {"reads", "zeroDeltas", "minimumPositiveDeltaMs", "residualToleranceMs"}) ||
        !number(clock["reads"], 5400, 5400) || !number(clock["zeroDeltas"], 0, 5398) ||
        std::floor(clock["zeroDeltas"].toDouble()) != clock["zeroDeltas"].toDouble() ||
        !number(clock["minimumPositiveDeltaMs"], 0, 15000) || clock["minimumPositiveDeltaMs"].toDouble() == 0 ||
        !number(clock["residualToleranceMs"], 0, 0)) return false;
    static const QStringList names{"renderNebula", "ensureSprites", "drawSoftOvalFields", "drawStars",
        "drawRadialStreaks", "drawLensFlares", "drawChromaticSideLoops", "drawSegmentedSphere",
        "drawAtomicOrbits", "drawOrbitBlocks", "drawCentralOctagon", "drawTriangularPrism",
        "drawPerspectiveRays", "drawCentralCore", "drawFilmGrain", "drawVignette", "renderAlertOverlay"};
    const auto stages = object["stages"].toArray();
    const auto frame = object["frame"].toObject(), residual = object["residual"].toObject();
    if (!validStats(object["frame"]) || !validStats(object["residual"]) ||
        frame["firstHalfMeanMs"].toDouble() <= 0 || frame["secondHalfMeanMs"].toDouble() <= 0 ||
        !object["stages"].isArray() || stages.size() != names.size()) return false;
    for (qsizetype i = 0; i < names.size(); ++i) {
        const auto stage = stages[i].toObject();
        if (!validStats(stages[i], true) || !stage["name"].isString() || stage["name"].toString() != names[i]) return false;
    }
    for (const char *key : {"meanMs", "firstHalfMeanMs", "secondHalfMeanMs"}) {
        double sum = residual[key].toDouble();
        for (const auto &stage : stages) sum += stage.toObject()[key].toDouble();
        if (!near(frame[key].toDouble(), sum)) return false;
    }
    return true;
}

class Smoke final : public QObject {
    Q_OBJECT
public:
    QJsonObject result{{"kind", "native-processing"}, {"status", "failure"}, {"reason", "incomplete"}};
    bool finished = false;
    int code = 3;
    Q_INVOKABLE void fail(const QString &reason) {
        if (finished) return;
        finished = true;
        result["reason"] = reason.left(48); // Never echo unbounded page/console text.
        QCoreApplication::exit(code);
    }
    Q_INVOKABLE void complete(const QVariantMap &value) {
        if (finished) return;
        const QJsonObject expected{{"ok", true}, {"dpr", 1}, {"css", QJsonArray{3440, 1440}},
            {"foreground", QJsonArray{3440, 1440}}, {"nebula", QJsonArray{1548, 648}}, {"nebulaCap", 0.45}};
        QJsonObject candidate = QJsonObject::fromVariantMap(value);
        if (!exactKeys(candidate, {"checkpoint", "attribution"}) ||
            candidate["checkpoint"] != expected) {
            fail(QStringLiteral("checkpoint"));
            return;
        }
        if (!validAttribution(candidate["attribution"])) {
            fail(QStringLiteral("attribution-schema"));
            return;
        }
        candidate["kind"] = "native-processing";
        candidate["status"] = "synchronous-layer-attribution";
        if (QJsonDocument(candidate).toJson(QJsonDocument::Compact).size() > 16384) {
            fail(QStringLiteral("attribution-size"));
            return;
        }
        finished = true;
        code = 0;
        result = candidate;
        QCoreApplication::exit(0);
    }
};

// Unlike an event-loop timer alone, SIGALRM also bounds startup and teardown stalls.
// Only async-signal-safe operations here. Emergency exit is not clean runtime proof.
static void deadline(int) {
    constexpr char line[] = "{\"kind\":\"native-processing\",\"status\":\"failure\",\"reason\":\"deadline\"}\n";
    (void)::write(STDOUT_FILENO, line, sizeof(line) - 1);
    _exit(4);
}

static bool compatibleOverride(const char *name, const char *expected) {
    return !qEnvironmentVariableIsSet(name) || qgetenv(name) == expected;
}

static bool rejectEnvironment(int argc) {
    if (argc != 1 || getuid() == 0 || geteuid() == 0 ||
        qEnvironmentVariableIsEmpty("WAYLAND_DISPLAY") ||
        !compatibleOverride("QT_QPA_PLATFORM", "wayland") ||
        !compatibleOverride("QT_WAYLAND_SHELL_INTEGRATION", "xdg-shell")) return true;
    for (const char *name : {"QTWEBENGINE_DISABLE_SANDBOX", "QTWEBENGINE_CHROMIUM_FLAGS",
                             "QTWEBENGINE_REMOTE_DEBUGGING"}) {
        if (qEnvironmentVariableIsSet(name)) return true;
    }
    return false;
}

static int run(int argc, char **argv, QJsonObject &result) {
    QtWebEngineQuick::initialize();
    QGuiApplication app(argc, argv);
    app.setApplicationName("native-processing");
    if (app.platformName() != QStringLiteral("wayland")) {
        result["reason"] = "platform";
        return 2;
    }
    Resources resources;
    QQuickWebEngineProfile profile;
    profile.setOffTheRecord(true);
    profile.setHttpCacheType(QQuickWebEngineProfile::NoCache);
    profile.setPersistentCookiesPolicy(QQuickWebEngineProfile::NoPersistentCookies);
    profile.setUrlRequestInterceptor(&resources);
    Smoke smoke;
    QObject::connect(&profile, &QQuickWebEngineProfile::downloadRequested, &smoke,
        [&](QQuickWebEngineDownloadRequest *download) { download->cancel(); smoke.fail("download"); });
    QQuickView view;
    view.setTitle("Processing load/buffer smoke (not a benchmark)");
    view.setResizeMode(QQuickView::SizeRootObjectToView);
    view.resize(640, 360);
    view.setMinimumSize(QSize(640, 360));
    view.setMaximumSize(QSize(640, 360));
    view.rootContext()->setContextProperty("smoke", &smoke);
    view.rootContext()->setContextProperty("smokeProfile", &profile);
    view.rootContext()->setContextProperty("smokePage", page);
    QObject::connect(&view, &QQuickView::statusChanged, &smoke, [&](QQuickView::Status status) {
        if (status == QQuickView::Error) smoke.fail("qml");
    });
    QObject::connect(&view, &QQuickWindow::closing, &smoke, [&] { smoke.fail("window-closed"); });
    view.setSource(QUrl("qrc:/native-processing/view.qml"));
    // Normal shutdown first; the alarm remains armed through all Qt destruction.
    QTimer::singleShot(14000, &smoke, [&] { smoke.fail("deadline"); });
    if (!smoke.finished) {
        view.show(); // Ordinary xdg-shell window, never layer-shell or fullscreen.
        app.exec();
    }
    result = smoke.result;
    return smoke.code;
}

int main(int argc, char **argv) {
    struct sigaction action{};
    action.sa_handler = deadline;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGALRM, &action, nullptr) != 0) {
        std::cout << "{\"kind\":\"native-processing\",\"status\":\"failure\",\"reason\":\"deadline-setup\"}\n";
        return 4;
    }
    alarm(15);
    QJsonObject result{{"kind", "native-processing"}, {"status", "failure"}, {"reason", "preflight"}};
    int code = 2;
    if (!rejectEnvironment(argc)) code = run(argc, argv, result);
    // run() has destroyed the view, profile and application before reporting success.
    std::cout << QJsonDocument(result).toJson(QJsonDocument::Compact).constData() << '\n' << std::flush;
    alarm(0);
    return code;
}

#include "runner.moc"
