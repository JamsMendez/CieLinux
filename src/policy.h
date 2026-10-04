#pragma once

#include "diagnostics.h"
#include <QCoreApplication>
#include <QObject>
#include <QString>
#include <QUrl>
#include <QtQml/qqmlregistration.h>
#include <functional>
#include <utility>

// Each view owns its immutable callback identity; never read a mutable current
// generation from QML when delivering an event from an older document.
class AttachmentToken final : public QObject {
    Q_OBJECT
    QML_NAMED_ELEMENT(SceneAttachment)
    QML_UNCREATABLE("SceneAttachment is supplied by the native host")
    Q_PROPERTY(int generation READ generation CONSTANT)
public:
    AttachmentToken(int value, QObject *parent) : QObject(parent), value(value) {}
    int generation() const { return value; }
private:
    const int value;
};

class Policy final : public QObject {
    Q_OBJECT
    QML_NAMED_ELEMENT(ScenePolicy)
    QML_UNCREATABLE("ScenePolicy is supplied by the native host")
    Q_PROPERTY(bool ready READ ready NOTIFY readyChanged)
public:
    explicit Policy(const QUrl &selected) : selectedUrl(selected.toEncoded()) {}
    // Live scene/mode switch inside one host: a new generation for a new selected
    // URL, rebuilt through the same reconstruction path as recovery. It is not an
    // incident, so it never spends the recovery budget. Refused once terminal or
    // before the native host bound its reconstruction.
    bool retarget(const QUrl &url) {
        if (terminal || !reconstruct || url.isEmpty()) return false;
        selectedUrl = url.toEncoded();
        ++currentGeneration; // Revoke every old callback before any external effect.
        loaded = drawn = false;
        const bool notify = readyState;
        readyState = false;
        if (notify) emit readyChanged();
        if (terminal || !reconstruct) return false; // Notification may finalize the owner.
        auto callback = reconstruct;
        callback(currentGeneration);
        return true;
    }
    Q_INVOKABLE bool allowed(const QUrl &url) const { return url.toEncoded() == selectedUrl; }
    bool ready() const { return readyState; }
    bool closed() const { return terminal; }
    int terminalResult() const { return result; }
    // One native host binding, installed before QML can report failure.
    bool bindHost(std::function<void()> hide, std::function<void()> cancel) {
        if (terminal || hostBound) return false;
        hostBound = true;
        hideHost = std::move(hide);
        cancelHost = std::move(cancel);
        return true;
    }
    void closeNormally() { finish(false); }
    Diagnostics::Lifecycle &lifecycleDiagnostics() { return lifecycle; }
    void noteCloseReason(Diagnostics::Reason reason, int nativeResult = 0) noexcept {
        if (!terminal && reason != Diagnostics::Reason::Failure) {
            closeReason = reason;
            closeReturnCode = reason == Diagnostics::Reason::Guard ? nativeResult : 0;
        }
    }
    int generation() const { return currentGeneration; }
    bool admits(int generation) const { return !terminal && generation == currentGeneration; }
    bool bindReconstruction(std::function<void(int)> callback) {
        if (terminal || reconstruct) return false;
        reconstruct = std::move(callback);
        return true;
    }
    static constexpr int maxRecoveryBudget = 8;
    // Default: one reconstruction per process lifetime. A configured budget
    // admits `count` reconstructions per rolling monotonic window instead.
    // Configure once, before any incident; invalid or late requests are refused.
    bool setRecoveryBudget(int count, qint64 windowMs, std::function<qint64()> monotonicNowMs) {
        if (terminal || budgetConfigured || usedRecoveries != 0 || currentGeneration != 1 ||
            count < 1 || count > maxRecoveryBudget || windowMs <= 0 || !monotonicNowMs)
            return false;
        budgetConfigured = true;
        recoveryBudget = count;
        recoveryWindowMs = windowMs;
        recoveryClock = std::move(monotonicNowMs);
        return true;
    }
    void closeGeneration(int generation) { if (admits(generation)) closeNormally(); }
    void constructionFailed(int generation) { if (admits(generation)) fail(); }
    Q_INVOKABLE void incident(int generation, int kind) {
        if (!admits(generation) || (kind != 0 && kind != 1)) return;
        const qint64 now = recoveryClock ? recoveryClock() : 0;
        expireRecoveries(now);
        if (usedRecoveries >= recoveryBudget || !reconstruct) {
            lifecycle.record(Diagnostics::Event::Incident, generation, currentGeneration,
                             usedRecoveries, kind);
            fail(); return;
        }
        recoveryTimes[usedRecoveries++] = now; // One budget shared by both incident kinds.
        ++currentGeneration; // Revoke every old callback before any external effect.
        lifecycle.record(Diagnostics::Event::Incident, generation, currentGeneration,
                         usedRecoveries, kind);
        loaded = drawn = false;
        const bool notify = readyState;
        readyState = false;
        if (notify) emit readyChanged();
        if (terminal) return; // Notification may synchronously finalize the owner.
        auto callback = reconstruct;
        callback(currentGeneration);
    }
    // Legacy non-generational APIs remain for existing standalone contracts.
    // Production QML uses only the explicitly generation-scoped entries below.
    Q_INVOKABLE void loadSucceeded(const QUrl &url) { loadSucceededFor(currentGeneration, url); }
    Q_INVOKABLE void loadSucceededFor(int generation, const QUrl &url) {
        if (!admits(generation) || !allowed(url)) return;
        if (!loaded) {
            loaded = true;
            lifecycle.record(Diagnostics::Event::Load, generation);
        }
        updateReady();
    }
signals:
    void readyChanged();
private:
    QByteArray selectedUrl; // Replaced only by retarget(), together with the generation.
    Diagnostics::Sink diagnostics;
    // Native host opts in; standalone Policy contracts retain their old stderr.
    Diagnostics::Lifecycle lifecycle{false};
    Diagnostics::Reason closeReason = Diagnostics::Reason::Normal;
    int closeReturnCode = 0;
    int reportedResult = -1;
    Diagnostics::Reason reportedReason = Diagnostics::Reason::Normal;
    // Current and preceding generation by parity; generation 0 means unseen.
    struct RendererPid { int generation = 0; long long pid = 0; } rendererPids[2];
    bool loaded = false, drawn = false, terminal = false, readyState = false;
    bool hostBound = false;
    int result = 0;
    int currentGeneration = 1;
    bool budgetConfigured = false;
    int recoveryBudget = 1, usedRecoveries = 0;
    qint64 recoveryWindowMs = 0; // Zero: recoveries never expire (lifetime budget).
    qint64 recoveryTimes[maxRecoveryBudget] = {}; // Ascending admission times.
    std::function<qint64()> recoveryClock;
    std::function<void(int)> reconstruct;
    void expireRecoveries(qint64 now) {
        if (recoveryWindowMs <= 0) return;
        // A clock that moves backwards yields a negative age and expires nothing.
        int expired = 0;
        while (expired < usedRecoveries && now - recoveryTimes[expired] >= recoveryWindowMs)
            ++expired;
        for (int i = expired; i < usedRecoveries; ++i) recoveryTimes[i - expired] = recoveryTimes[i];
        usedRecoveries -= expired;
    }
    std::function<void()> hideHost, cancelHost;
    void finish(bool failure) {
        // Latch everything before hide/notification/cancellation can reenter.
        if (failure) result = 1;
        if (failure) closeReason = Diagnostics::Reason::Failure;
        if (!terminal) {
            terminal = true;
            reconstruct = {}; // Queued work still must check admits() at execution.
            loaded = drawn = false;
            const bool notify = readyState;
            readyState = false;
            auto hide = std::move(hideHost);
            auto cancel = std::move(cancelHost);
            if (hide) hide();
            if (notify) emit readyChanged();
            if (cancel) cancel();
        }
        // Nested failure can upgrade a normal close before this observation.
        const int observedResult = result == 1 ? 1 : closeReturnCode;
        if (reportedResult != observedResult || reportedReason != closeReason) {
            reportedResult = observedResult;
            reportedReason = closeReason;
            lifecycle.record(Diagnostics::Event::Terminal, currentGeneration,
                             observedResult, static_cast<int>(closeReason));
        }
        // Keep this upgrader alive through the serialized closure turn.
        if (failure) diagnostics.failure();
        QCoreApplication::exit(result);
    }
    void updateReady() {
        const bool value = !terminal && loaded && drawn;
        if (readyState == value) return;
        readyState = value;
        if (value) lifecycle.record(Diagnostics::Event::Ready, currentGeneration);
        emit readyChanged();
    }
    bool drawReport(int level, const QString &message, const QString &source) const {
        // Raw exact comparisons, never diagnostic canonicalization or truncation.
        if (level != 0) return false; // WebEngine InfoMessageLevel (console.log).
        return ((selectedUrl == "qrc:/processing/index.html?variant=mini&fps=30" ||
                 selectedUrl == "qrc:/processing/index.html?variant=mini&fps=60" ||
                 selectedUrl == "qrc:/processing/index.html?fps=30" ||
                 selectedUrl == "qrc:/processing/index.html?fps=60") &&
                source == QStringLiteral("qrc:/processing/js/main.js") &&
                message == QStringLiteral("CIELINUX_SCENE_DRAW_READY_V1 processing")) ||
               ((selectedUrl == "qrc:/raphael/index.html?variant=mini&fps=30" ||
                 selectedUrl == "qrc:/raphael/index.html?variant=mini&fps=60" ||
                 selectedUrl == "qrc:/raphael/index.html?fps=30" ||
                 selectedUrl == "qrc:/raphael/index.html?fps=60") &&
                source == QStringLiteral("qrc:/raphael/js/main.js") &&
                message == QStringLiteral("CIELINUX_SCENE_DRAW_READY_V1 raphael")) ||
               // idle and explorer run their frame loop in js/animate.js; main.js only resizes and starts it.
               ((selectedUrl == "qrc:/idle/index.html?variant=mini&fps=30" ||
                 selectedUrl == "qrc:/idle/index.html?variant=mini&fps=60" ||
                 selectedUrl == "qrc:/idle/index.html?fps=30" ||
                 selectedUrl == "qrc:/idle/index.html?fps=60") &&
                source == QStringLiteral("qrc:/idle/js/animate.js") &&
                message == QStringLiteral("CIELINUX_SCENE_DRAW_READY_V1 idle")) ||
               ((selectedUrl == "qrc:/explorer/index.html?variant=mini&fps=30" ||
                 selectedUrl == "qrc:/explorer/index.html?variant=mini&fps=60" ||
                 selectedUrl == "qrc:/explorer/index.html?fps=30" ||
                 selectedUrl == "qrc:/explorer/index.html?fps=60") &&
                source == QStringLiteral("qrc:/explorer/js/animate.js") &&
                message == QStringLiteral("CIELINUX_SCENE_DRAW_READY_V1 explorer"));
    }
public:
    Q_INVOKABLE void consoleMessage(int level, const QString &message, int lineNumber,
                                    const QString &sourceID) {
        consoleMessageFor(currentGeneration, level, message, lineNumber, sourceID);
    }
    Q_INVOKABLE void consoleMessageFor(int generation, int level, const QString &message,
                                      int lineNumber, const QString &sourceID) {
        if (!admits(generation)) return;
        if (drawReport(level, message, sourceID)) {
            if (!drawn) {
                drawn = true;
                lifecycle.record(Diagnostics::Event::Draw, generation);
                updateReady();
            }
            return; // Control reports do not consume the diagnostics budget.
        }
        // Bound conversions before UTF-8 allocation; the sink bounds output again.
        const auto text = message.left(Diagnostics::Sink::messageBytes).toUtf8();
        const auto source = sourceID.left(Diagnostics::Sink::sourceBytes).toUtf8();
        diagnostics.console(level, std::string_view(text.constData(), text.size()), lineNumber,
                            std::string_view(source.constData(), source.size()));
    }
    Q_INVOKABLE void rendererPidFor(int generation, qint64 pid) {
        // The notifier reports association, not ownership or OS-process freshness.
        // Every generation is accepted; a slot superseded by a newer generation
        // ignores older reports, and the lifecycle cap bounds total output.
        if (generation < 1) return;
        auto &slot = rendererPids[(generation - 1) % 2];
        if (generation < slot.generation) return;
        if (slot.generation == generation && slot.pid == pid) return;
        slot = {generation, pid};
        lifecycle.record(Diagnostics::Event::RendererPid, generation, pid);
    }
    Q_INVOKABLE void rendererTerminatedFor(int generation, int status, int code) {
        lifecycle.record(Diagnostics::Event::Terminated, generation, status, code);
        incident(generation, 1); // Preserve eligibility, including every status/code.
    }
    Q_INVOKABLE void fail() {
        finish(true);
    }
};
