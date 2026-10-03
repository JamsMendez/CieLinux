import QtQuick
import QtQuick.Shapes
import QtWebEngine
import CieLinux.Host

Item {
    id: sceneRoot
    required property WebEngineProfile sceneProfile
    required property url sceneUrl
    required property ScenePolicy scenePolicy
    required property SceneAttachment sceneAttachment
    // Validated by parseHostOptions (closed set); never derived from the page.
    required property string sceneName
    // "scene-mini" (keyed corner window) or "scene" (opaque full-size wallpaper).
    required property string sceneMode
    // Host <-> page alert channel (src/alert-bridge.h): two console markers in, one fixed call out.
    required property SceneAlerts sceneAlerts
    readonly property bool ready: sceneRoot.scenePolicy.ready
    // Host-owned occlusion disc {x, y, radius}; radius 0 draws none.
    readonly property var sceneDisc: discFor(sceneRoot.sceneName, sceneRoot.width, sceneRoot.height)
    width: 240
    height: 240
    // Mirrors each scene's own mini geometry (see README "Host occlusion disc (D1)").
    function discFor(name, w, h) {
        const side = Math.min(w, h)
        switch (name) {
        case "idle":
        case "explorer": // animate.js mini centre W/2,H/2; inside the 0.41-0.48 edge fade.
            return { x: w / 2, y: h / 2, radius: side * 0.44 }
        case "processing": // main.js render() centre; in-page base fades out at 0.40.
            return { x: w * 0.505, y: h * 0.515, radius: side * 0.40 }
        case "raphael": // main.js: rimRadius = (side/2 - 50) * MINI_SCENE_ZOOM 1.3507 (B6); falloff * 1.06.
            return { x: w * 0.505, y: h * 0.515, radius: (side / 2 - 50) * 1.3507 * 1.06 }
        default: // Unknown scene: no disc.
            return { x: w / 2, y: h / 2, radius: 0 }
        }
    }
    // Under the luminance key the in-page near-black base disc is ~4% alpha, so the
    // host restores occlusion here, behind (declared before) the keyed view.
    Shape {
        anchors.fill: parent
        visible: sceneRoot.sceneMode === "scene-mini" && sceneRoot.sceneDisc.radius > 0
        ShapePath {
            strokeWidth: -1
            fillGradient: RadialGradient {
                centerX: sceneRoot.sceneDisc.x; centerY: sceneRoot.sceneDisc.y; centerRadius: sceneRoot.sceneDisc.radius
                focalX: sceneRoot.sceneDisc.x; focalY: sceneRoot.sceneDisc.y
                GradientStop { position: 0.0; color: Qt.rgba(1/255, 4/255, 10/255, 0.9) }
                GradientStop { position: 0.9; color: Qt.rgba(1/255, 4/255, 10/255, 0.6) }
                GradientStop { position: 1.0; color: Qt.rgba(1/255, 4/255, 10/255, 0.0) }
            }
            PathAngleArc { centerX: sceneRoot.sceneDisc.x; centerY: sceneRoot.sceneDisc.y; radiusX: sceneRoot.sceneDisc.radius; radiusY: sceneRoot.sceneDisc.radius; startAngle: 0; sweepAngle: 360 }
        }
    }
    WebEngineView {
        id: sceneView
        anchors.fill: parent
        profile: sceneRoot.sceneProfile
        url: sceneRoot.sceneUrl
        // Opaque black regardless of page CSS: a transparent page accumulates stale
        // bright content in Qt WebEngine 6.11, so black is keyed out below instead.
        backgroundColor: "black"
        // Luminance key: alpha = max(r,g,b), premultiplied (see lumakey.frag). Mini
        // only: the wallpaper is opaque on the background layer and needs no key.
        layer.enabled: sceneRoot.sceneMode === "scene-mini"
        layer.effect: ShaderEffect { fragmentShader: "qrc:/lumakey.frag.qsb" }
        settings.localContentCanAccessRemoteUrls: false
        settings.localContentCanAccessFileUrls: false
        settings.javascriptCanOpenWindows: false
        settings.javascriptCanAccessClipboard: false
        settings.screenCaptureEnabled: false
        settings.fullScreenSupportEnabled: false
        settings.pluginsEnabled: false
        onJavaScriptConsoleMessage: function(level, message, lineNumber, sourceID) {
            // The two alert markers are consumed by the bridge; everything else is diagnostics.
            if (sceneRoot.sceneAlerts.pageMessage(sceneRoot.sceneAttachment.generation, level, message, sourceID))
                return
            sceneRoot.scenePolicy.consoleMessageFor(sceneRoot.sceneAttachment.generation,
                                                   level, message, lineNumber, sourceID)
        }
        onNavigationRequested: function(request) {
            if (!sceneRoot.scenePolicy.allowed(request.url))
                request.reject()
        }
        // New-window requests are intentionally not opened in any view.
        onPermissionRequested: function(permission) { permission.deny() }
        Component.onCompleted: {
            sceneRoot.scenePolicy.rendererPidFor(sceneRoot.sceneAttachment.generation,
                                                renderProcessPid)
        }
        onLoadingChanged: function(info) {
            if (info.status === WebEngineView.LoadSucceededStatus) {
                sceneRoot.scenePolicy.loadSucceededFor(sceneRoot.sceneAttachment.generation, info.url)
                if (sceneRoot.scenePolicy.allowed(info.url))
                    sceneRoot.scenePolicy.rendererPidFor(sceneRoot.sceneAttachment.generation,
                                                        renderProcessPid)
            }
            if (info.status === WebEngineView.LoadFailedStatus)
                sceneRoot.scenePolicy.incident(sceneRoot.sceneAttachment.generation, 0)
        }
        onRenderProcessPidChanged: {
            sceneRoot.scenePolicy.rendererPidFor(sceneRoot.sceneAttachment.generation,
                                                renderProcessPid)
        }
        onRenderProcessTerminated: function(status, code) {
            sceneRoot.scenePolicy.rendererTerminatedFor(sceneRoot.sceneAttachment.generation,
                                                       status, code)
        }
    }
    // Host -> page alert commands (show/hide JSON built by AlertLayerMessages from validated
    // values). The only script the host ever runs: one fixed function, the JSON passed as a JS
    // string literal (JSON.stringify of the text), parsed as data by the page. Stale generations
    // (a page being replaced) are ignored.
    Connections {
        target: sceneRoot.sceneAlerts
        function onPageCommand(generation, json) {
            if (generation !== sceneRoot.sceneAttachment.generation || typeof json !== "string")
                return
            sceneView.runJavaScript("window.cielinuxAlertCommand(" + JSON.stringify(json) + ")")
        }
    }
}
