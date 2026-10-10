import QtQuick
import QtWebEngine

Item {
    width: 640
    height: 360
    WebEngineView {
        id: web
        anchors.fill: parent
        profile: smokeProfile
        url: smokePage
        property bool initialNavigation: true
        property bool loaded: false
        property bool drawn: false
        property bool checking: false
        property bool started: false
        property bool retrieving: false
        function checkpoint() {
            if (loaded && drawn && !checking) {
                checking = true
                runJavaScript("nativeProcessingCheckpoint()", function(value) {
                    if (!value || !value.ok) { smoke.fail("checkpoint"); return }
                    started = true
                    runJavaScript("nativeProcessingStart()", function(ok) {
                        if (ok !== true) smoke.fail("attribution-start")
                    })
                })
            }
        }
        settings.localContentCanAccessRemoteUrls: false
        settings.localContentCanAccessFileUrls: false
        settings.javascriptCanOpenWindows: false
        settings.javascriptCanAccessClipboard: false
        settings.screenCaptureEnabled: false
        settings.fullScreenSupportEnabled: false
        settings.pluginsEnabled: false
        onNavigationRequested: function(request) {
            if (initialNavigation && request.isMainFrame && request.url.toString() === smokePage.toString()) {
                initialNavigation = false
                request.accept()
            } else {
                request.reject()
                smoke.fail("navigation")
            }
        }
        onPermissionRequested: function(permission) { permission.deny(); smoke.fail("permission") }
        onFullScreenRequested: function(request) { request.reject(); smoke.fail("fullscreen") }
        // No new view is opened: the request is deliberately unhandled.
        onNewWindowRequested: function(request) { smoke.fail("new-window") }
        onLoadingChanged: function(info) {
            if (info.status === WebEngineView.LoadSucceededStatus) {
                if (info.url.toString() !== smokePage.toString()) { smoke.fail("load-url"); return }
                loaded = true
                checkpoint()
            } else if (info.status === WebEngineView.LoadFailedStatus) smoke.fail("load")
        }
        onRenderProcessTerminated: function(status, code) { smoke.fail("renderer") }
        onJavaScriptConsoleMessage: function(level, message, lineNumber, sourceID) {
            if (message === "CIELINUX_SCENE_DRAW_READY_V1 processing" &&
                sourceID === "qrc:/processing/js/main.js") {
                drawn = true
                checkpoint()
            }
            if (message === "CIELINUX_NATIVE_PROCESSING_ATTRIBUTION_READY_V1" &&
                sourceID === "qrc:/native-processing/driver.js" &&
                level === WebEngineView.InfoMessageLevel && started && !retrieving) {
                retrieving = true
                runJavaScript("nativeProcessingResult()", function(value) {
                    if (!value) smoke.fail("attribution-result")
                    else smoke.complete(value)
                })
            }
            // Production emits exactly one deliberate transport-error probe at startup.
            if (level === WebEngineView.ErrorMessageLevel &&
                !(message === "CIELINUX_DIAGNOSTICS_JS_ERROR synthetic transport probe" &&
                  sourceID === "qrc:/processing/js/main.js")) smoke.fail("javascript")
        }
    }
}
