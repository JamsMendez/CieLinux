import QtQuick
import QtQuick.Shapes
import QtWebEngine
import CieLinux.Host

// One window per mode, holding two persistent scene slots (ping-pong). A live switch that keeps
// the mode (scene or frame rate) never builds a new window, profile or web view: the host loads
// the new page into the slot that is not on screen, stacks it above the other one and fades it
// in; once the fade has finished the covered slot is parked (its web view hidden, so it stops
// rendering, and its last page kept for reuse). Creating and destroying web views on every switch
// deadlocks Qt WebEngine's compositor. Only a mode switch builds a new window (see main.cpp).
Item {
    id: sceneWindow
    // One off-the-record profile per window, shared by both slots.
    required property WebEngineProfile sceneProfile
    // The first slot's first page and generation; later pages arrive through navigate().
    required property url sceneUrl
    required property ScenePolicy scenePolicy
    required property SceneAttachment sceneAttachment
    // Validated by parseHostOptions (closed set); never derived from the page.
    required property string sceneName
    // "scene-mini" (keyed corner window) or "scene" (opaque full-size wallpaper).
    required property string sceneMode
    // Host <-> page alert channel (src/alert-bridge.h): two console markers in, one fixed call out.
    required property SceneAlerts sceneAlerts
    // The second slot's identity until its first switch: generation 0, which no policy admits.
    required property SceneAttachment sceneIdleAttachment
    width: 320
    height: 320

    // Host entry point for a same-mode switch: the slot `index` gets a new generation, hidden
    // (not yet revealed), stacked above the other slot, which stays on screen meanwhile.
    function navigate(index, attachment, url, name) {
        const incoming = index === 0 ? firstSlot : secondSlot
        const other = index === 0 ? secondSlot : firstSlot
        other.z = 0
        incoming.z = 1
        incoming.load(attachment, url, name)
        return true
    }
    // Host entry point once a crossfade has finished: the covered slot stops rendering.
    function park(index) {
        const covered = index === 0 ? firstSlot : secondSlot
        covered.live = false
        return true
    }

    // One scene page: the occlusion disc, the keyed web view and its generation-scoped handlers.
    component SceneSlot: Item {
        id: sceneRoot
        required property WebEngineProfile sceneProfile
        required property ScenePolicy scenePolicy
        required property SceneAlerts sceneAlerts
        required property string sceneMode
        // This slot's own callback identity, replaced (never mutated) for every page it shows.
        required property SceneAttachment sceneAttachment
        required property url sceneUrl
        required property string sceneName
        // Live: shown, or fading in or out. A parked slot's web view is hidden and stops rendering.
        required property bool live
        readonly property bool ready: sceneRoot.scenePolicy.ready
        // Host-owned occlusion disc {x, y, radius}; radius 0 draws none.
        readonly property var sceneDisc: discFor(sceneRoot.sceneName, sceneRoot.width, sceneRoot.height)
        anchors.fill: parent
        // Crossfade on a live switch: a replacement starts hidden over the page it replaces and
        // fades in once the host reveals it (first frame drawn, or the host deadline). The page
        // still renders underneath, which is what lets it report that first frame. The duration
        // mirrors crossfadeMs in main.cpp. An initial attachment is revealed from the start.
        opacity: sceneRoot.sceneAttachment.revealed ? 1 : 0
        Behavior on opacity {
            id: fade
            NumberAnimation { duration: 300; easing.type: Easing.InOutQuad }
        }
        // A reused slot jumps to hidden (the fade is bypassed while the new, unrevealed generation
        // is handed over), so its previous page never fades out over the one on screen. The same
        // URL as its last page reloads: every generation loads its own document.
        function load(attachment, url, name) {
            fade.enabled = false
            sceneRoot.sceneAttachment = attachment
            sceneRoot.sceneName = name
            if (String(sceneRoot.sceneUrl) === String(url))
                sceneView.reload()
            else
                sceneRoot.sceneUrl = url
            fade.enabled = true
            sceneRoot.live = true
        }
        // Mirrors each scene's own mini geometry (see README "Host occlusion disc (D1)").
        function discFor(name, w, h) {
            const side = Math.min(w, h)
            switch (name) {
            case "idle":
            case "explorer": // animate.js mini centre W/2,H/2; inside the 0.41-0.48 edge fade.
                return { x: w / 2, y: h / 2, radius: side * 0.44 }
            case "processing": // main.js render() centre; in-page base fades out at 0.40.
                return { x: w * 0.505, y: h * 0.515, radius: side * 0.40 }
            case "raphael": // main.js: mini centre W/2,H/2; rimRadius = MINI_RING_RADIUS_FRACTION 0.40 * side (T3); falloff * 1.06.
                return { x: w / 2, y: h / 2, radius: side * 0.40 * 1.06 }
            default: // Unknown scene: no disc.
                return { x: w / 2, y: h / 2, radius: 0 }
            }
        }
        // Under the luminance key the in-page near-black base disc is ~4% alpha, so the
        // host restores occlusion here, behind (declared before) the keyed view.
        Shape {
            anchors.fill: parent
            visible: sceneRoot.sceneMode === "scene-mini" && sceneRoot.sceneDisc.radius > 0 && sceneRoot.live
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
            visible: sceneRoot.live
            profile: sceneRoot.sceneProfile
            url: sceneRoot.sceneUrl
            // Opaque black regardless of page CSS: a transparent page accumulates stale
            // bright content in Qt WebEngine 6.11, so black is keyed out below instead.
            backgroundColor: "black"
            // Luminance key: alpha = max(r,g,b), premultiplied (see lumakey.frag). Mini
            // only: the wallpaper is opaque on the bottom layer and needs no key.
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
            // A reused view reports the end of a load it was navigated away from (for example a
            // superseded page that was still loading); only a failure of the selected page is an
            // incident, so a rapid switch never spends the recovery budget.
            onLoadingChanged: function(info) {
                if (info.status === WebEngineView.LoadSucceededStatus) {
                    sceneRoot.scenePolicy.loadSucceededFor(sceneRoot.sceneAttachment.generation, info.url)
                    if (sceneRoot.scenePolicy.allowed(info.url))
                        sceneRoot.scenePolicy.rendererPidFor(sceneRoot.sceneAttachment.generation,
                                                            renderProcessPid)
                }
                if (info.status === WebEngineView.LoadFailedStatus && sceneRoot.scenePolicy.allowed(info.url))
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
        // (a page being replaced, or a parked slot) are ignored.
        Connections {
            target: sceneRoot.sceneAlerts
            function onPageCommand(generation, json) {
                if (generation !== sceneRoot.sceneAttachment.generation || typeof json !== "string")
                    return
                sceneView.runJavaScript("window.cielinuxAlertCommand(" + JSON.stringify(json) + ")")
            }
        }
    }

    SceneSlot {
        id: firstSlot
        sceneProfile: sceneWindow.sceneProfile
        scenePolicy: sceneWindow.scenePolicy
        sceneAlerts: sceneWindow.sceneAlerts
        sceneMode: sceneWindow.sceneMode
        sceneAttachment: sceneWindow.sceneAttachment
        sceneUrl: sceneWindow.sceneUrl
        sceneName: sceneWindow.sceneName
        live: true
    }
    // Idle until the first same-mode switch: no page, its web view hidden.
    SceneSlot {
        id: secondSlot
        sceneProfile: sceneWindow.sceneProfile
        scenePolicy: sceneWindow.scenePolicy
        sceneAlerts: sceneWindow.sceneAlerts
        sceneMode: sceneWindow.sceneMode
        sceneAttachment: sceneWindow.sceneIdleAttachment
        sceneUrl: ""
        sceneName: ""
        live: false
    }
}
