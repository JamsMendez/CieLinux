#pragma once

#include "alerts.h"
#include <QObject>
#include <QString>
#include <QtQml/qqmlregistration.h>
#include <optional>

// The host <-> page alert channel for the current scene page (CielWin's MiniSceneWindowController
// Post/OnReady/HideAlert over WebView2 PostWebMessageAsJson + "ready"/"done" web messages).
//
// Host -> page: pageCommand(generation, json) is handled by view.qml, which runs exactly
//   window.cielinuxAlertCommand(<json as a JS string literal>)
// in the page; the page JSON.parses it and accepts only show/hide/pause/resume (pause/resume
// only ever for the wallpaper page). The JSON is
// built by AlertLayerMessages from host-validated values only.
// Page -> host: two exact console.log markers from qrc:/shared/js/alert-overlay.js at info level,
// for the current generation only: CIELINUX_ALERT_READY_V1 and CIELINUX_ALERT_DONE_V1. Nothing
// else a page prints is interpreted, so a page can never call host code.
class AlertBridge : public QObject { // not final: QML registration derives from it
    Q_OBJECT
    QML_NAMED_ELEMENT(SceneAlerts)
    QML_UNCREATABLE("SceneAlerts is supplied by the native host")
public:
    static constexpr char readyMarker[] = "CIELINUX_ALERT_READY_V1";
    static constexpr char doneMarker[] = "CIELINUX_ALERT_DONE_V1";
    static constexpr char overlaySource[] = "qrc:/shared/js/alert-overlay.js";

    using QObject::QObject;
    // A new page generation (scene switch or recovery): not ready until its own page says so.
    // A pending show is kept and delivered to the new page (CielWin keeps _pendingAlert across
    // navigations).
    void attach(int generation) {
        currentGeneration = generation;
        ready = false;
        postedPaused = false; // a fresh page starts running
    }
    bool pageReady() const { return ready; }
    // A show: posted now when the page is ready, otherwise kept in the single pending slot.
    void post(const QString &json) {
        if (ready) emit pageCommand(currentGeneration, json);
        else pending = json;
    }
    // Drops a pending show; tells a ready page to hide its overlay.
    void hide() {
        pending.reset();
        if (ready) emit pageCommand(currentGeneration, AlertLayerMessages::hide());
    }
    // B2, wallpaper only (CielWin WebViewAlertLayerController.SetScenePaused): the DESIRED pause
    // state while a fullscreen window covers the output. Posted to a ready page when it differs
    // from what that page was last told; remembered otherwise and told to each new page on ready.
    void setScenePaused(bool paused) {
        scenePaused = paused;
        if (ready && postedPaused != scenePaused) postScenePause();
    }
    // Every console message of the page is offered here first. True when it was one of the two
    // alert markers (consumed); false hands it on to the ordinary diagnostics.
    Q_INVOKABLE bool pageMessage(int generation, int level, const QString &message, const QString &sourceID) {
        // Raw exact comparisons; level 0 is WebEngine's InfoMessageLevel (console.log).
        if (generation != currentGeneration || level != 0 || sourceID != QLatin1String(overlaySource)) return false;
        if (message == QLatin1String(readyMarker)) {
            ready = true;
            // CielWin TryMarkReady: the pause first (if covered right now), then a pending show.
            postedPaused = false;
            if (scenePaused) postScenePause();
            if (pending) {
                const QString json = *pending;
                pending.reset();
                emit pageCommand(currentGeneration, json);
            }
            return true;
        }
        if (message == QLatin1String(doneMarker)) {
            // Informational, as in CielWin: the host-side duration stays authoritative.
            emit pageDone(generation);
            return true;
        }
        return false;
    }
signals:
    void pageCommand(int generation, const QString &json);
    void pageDone(int generation);

private:
    void postScenePause() {
        emit pageCommand(currentGeneration, scenePaused ? AlertLayerMessages::pause() : AlertLayerMessages::resume());
        postedPaused = scenePaused;
    }
    int currentGeneration = 0;
    bool ready = false;
    bool scenePaused = false, postedPaused = false;
    std::optional<QString> pending;
};
