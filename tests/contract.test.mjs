import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SRC, source } from './paths.mjs';
const read = name => readFileSync(source(name), 'utf8');
const cpp = read('main.cpp');
const policy = read('policy.h');
const resident = read('resident-control.h');
const qml = read('view.qml');

test('native safety is configured before mapping', () => {
    assert.ok(cpp.indexOf('QtWebEngineQuick::initialize()') < cpp.indexOf('QApplication app(argc, argv)'));
    for (const marker of ['WindowTransparentForInput', 'KeyboardInteractivityNone',
        'setActivateOnShow(false)', 'setExclusiveZone(0)', 'configureLifetime(lifetime, options)',
        'LayerShellQt::Window::get(&view)', 'setCloseOnDismissed(true)',
        'setLayer(LayerShellQt::Window::LayerTop)']) {
        assert.ok(cpp.indexOf(marker) >= 0 && cpp.indexOf(marker) < cpp.lastIndexOf('attachment.view->show()'), marker);
    }
    assert.doesNotMatch(cpp, /setMask|useLayerShell|--no-sandbox/);
    assert.match(cpp, /zwlr_layer_shell_v1/);
    assert.match(cpp, /screenRemoved/);
    for (const marker of ['WindowDoesNotAcceptFocus', 'setLayer(LayerShellQt::Window::LayerTop)',
        'miniGlider.attach(', 'setDesiredSize(QSize(240, 240))', // A6: anchors/margins via MiniGlider
        'view.resize(240, 240)', 'qputenv("QT_WAYLAND_SHELL_INTEGRATION", "layer-shell")']) {
        assert.ok(cpp.includes(marker), marker);
    }
});

test('closed native duration maps to one non-renewing timer with a 15-second default', () => {
    assert.match(resident, /int durationMs = 15000;/);
    assert.match(resident, /options.durationMs = std::strcmp\(argv\[i\], "120"\) == 0 \? 120000 : 15000;/);
    assert.equal((resident.match(/durationMs\s*=/g) || []).length, 2);
    assert.equal((cpp.match(/QTimer lifetime;/g) || []).length, 1);
    assert.equal((resident.match(/lifetime\.start\(/g) || []).length, 1);
    assert.equal((cpp.match(/configureLifetime\(lifetime, options\)/g) || []).length, 1);
    assert.match(resident, /if \(!options.resident\) lifetime.start\(options.durationMs\)/);
    assert.match(cpp, /lifetime\.setSingleShot\(true\)/);
    assert.match(cpp, /connect\(&lifetime, &QTimer::timeout, &policy, \[&\] \{\s*policy.noteCloseReason\(Diagnostics::Reason::Deadline\);\s*policy.closeNormally\(\);\s*\}\)/);
    assert.ok(cpp.indexOf('configureLifetime(lifetime, options)') < cpp.lastIndexOf('attachment.view->show()'));
    assert.match(cpp, /parseHostOptions\(argc, argv, options\)/);
    assert.ok(cpp.indexOf('if (!pendingControl->valid())') < cpp.indexOf('QtWebEngineQuick::initialize()'));
    assert.ok(cpp.indexOf('control->activate') < cpp.indexOf('view.setSource'));
    assert.match(cpp, /control->activate\(&policy, \[&\] \{ policy.closeNormally\(\); \}\)/);
    assert.match(cpp, /lifetime.stop\(\);\s*control->cancel\(\)/);
    assert.doesNotMatch(cpp + resident, /lifetime\.(?:setInterval)|toInt\(|atoi\(|strtol\(/);
    assert.match(cpp, /\[--duration 15\|120\]/);
    assert.match(cpp, /Duration defaults to 15 seconds; only 15 or 120 accepted/);
});

test('dedicated local-only profile and failure closure', () => {
    assert.match(cpp, /request.block\(encoded != selectedUrl && !resourceUrls.contains\(encoded\)\)/);
    assert.match(policy, /url.toEncoded\(\) == selectedUrl/);
    assert.match(qml, /url: sceneRoot.sceneUrl/);
    assert.match(cpp, /setOffTheRecord\(true\)/);
    assert.match(cpp, /QTWEBENGINE_DISABLE_SANDBOX/);
    assert.match(cpp, /QTWEBENGINE_CHROMIUM_FLAGS/);
    assert.match(cpp, /QTWEBENGINE_REMOTE_DEBUGGING/);
    assert.match(cpp, /download->cancel\(\)/);
    assert.match(cpp, /QQuickWebEngineProfile::NoCache/);
    assert.match(cpp, /QQuickWebEngineProfile::NoPersistentCookies/);
    for (const setting of ['javascriptCanOpenWindows', 'javascriptCanAccessClipboard',
        'screenCaptureEnabled', 'fullScreenSupportEnabled', 'pluginsEnabled']) {
        assert.ok(qml.includes(`settings.${setting}: false`), setting);
    }
    assert.match(qml, /localContentCanAccessRemoteUrls: false/);
    assert.match(qml, /localContentCanAccessFileUrls: false/);
    assert.match(qml, /request.reject\(\)/);
    assert.match(qml, /permission.deny\(\)/);
    assert.match(qml, /LoadFailedStatus/);
});

test('typed root contract uses generated uncreatable native metadata, not context globals', () => {
    assert.match(qml, /import CieLinux\.Host/);
    assert.match(qml, /id: sceneRoot/);
    for (const [type, name] of [['WebEngineProfile', 'sceneProfile'], ['url', 'sceneUrl'],
        ['ScenePolicy', 'scenePolicy']]) {
        assert.ok(qml.includes(`required property ${type} ${name}`));
    }
    assert.match(qml, /profile: sceneRoot\.sceneProfile/);
    assert.match(qml, /url: sceneRoot\.sceneUrl/);
    assert.match(qml, /!sceneRoot\.scenePolicy\.allowed\(request.url\)/);
    assert.match(qml, /if \(info.status === WebEngineView.LoadFailedStatus\)\s*sceneRoot.scenePolicy.incident\(sceneRoot.sceneAttachment.generation, 0\)/);
    assert.match(qml, /onRenderProcessTerminated: function\(status, code\) \{\s*sceneRoot.scenePolicy.rendererTerminatedFor\(sceneRoot.sceneAttachment.generation,\s*status, code\)/);
    assert.match(policy, /rendererTerminatedFor\(int generation, int status, int code\)[\s\S]*?incident\(generation, 1\)/);
    assert.match(qml, /required property SceneAttachment sceneAttachment/);
    assert.match(policy, /Q_PROPERTY\(int generation READ generation CONSTANT\)/);
    assert.match(policy, /const int value;/);
    assert.doesNotMatch(qml, /ScenePolicy\s*\{|WebEngineProfile\s*\{|qmllint disable/);
    assert.match(policy, /class Policy final : public QObject\s*\{\s*Q_OBJECT/);
    assert.match(policy, /QML_NAMED_ELEMENT\(ScenePolicy\)/);
    assert.match(policy, /QML_UNCREATABLE\("ScenePolicy is supplied by the native host"\)/);
    const cmake = read('CMakeLists.txt');
    assert.match(cmake, /qt_add_qml_module\(cielinux\s+URI CieLinux\.Host/);
    assert.match(cmake, /OUTPUT_DIRECTORY "\$\{CMAKE_CURRENT_BINARY_DIR\}\/CieLinux\/Host"\s+SOURCES src\/policy.h/);
    assert.doesNotMatch(cmake, /NO_GENERATE_QMLTYPES|NO_LINT|QT_QML_SKIP|--disable|Wno-/);
    assert.doesNotMatch(cpp, /setContextProperty|QQmlContext|main\.moc/);
    for (const [name, value] of [['sceneProfile', 'QVariant::fromValue(&profile)'],
        ['scenePolicy', 'QVariant::fromValue(&policy)'], ['sceneUrl', 'sceneUrl']]) {
        assert.ok(cpp.includes(`{QStringLiteral("${name}"), ${value}}`));
    }
    const markers = ['Policy policy(sceneUrl);', 'attachment.profile = std::make_unique<QQuickWebEngineProfile>();',
        'attachment.view = std::make_unique<QQuickView>();', 'view.setInitialProperties(QVariantMap{',
        'view.setSource(QUrl(QStringLiteral("qrc:/view.qml")))',
        'if (view.status() != QQuickView::Ready) { policy.constructionFailed(generation); return 1; }', 'attachment.view->show();'];
    for (let i = 0; i < markers.length; i++) {
        assert.ok(cpp.includes(markers[i]), markers[i]);
        if (i) assert.ok(cpp.indexOf(markers[i - 1]) < cpp.indexOf(markers[i]));
    }
});
