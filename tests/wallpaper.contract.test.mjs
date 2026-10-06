// B1 wallpaper mode (stage 2): the `scene` mode is the full-size page on the layer-shell
// bottom layer of the selected output, switched live with `scene-mini` from the tray
// (exactly one mode at a time), persisted as `wallpaper-mode`. B2: alerts show in the wallpaper
// too, held while a fullscreen window covers it, and the scene pauses meanwhile; the SUPER+Z
// position cycle is ignored outside the mini.
// Source of truth: CielWin/CielWin.App/AppComposition.cs (SelectMode, ActivateSurface),
// Tray/TrayIconHost.cs (ModeLabel, MenuOrder), Settings.cs (WallpaperMode); B2: Composition/
// WallpaperSceneSurface.cs, AlertDriver.cs, Wallpaper/Web/shared/js/render-loop.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT, source } from './paths.mjs';

const read = name => readFileSync(source(name), 'utf8');
const cpp = read('main.cpp');
const main = cpp.slice(cpp.indexOf('int main('));
const prepare = main.slice(main.indexOf('auto prepareAttachment'), main.indexOf('policy.bindReconstruction'));
const wallpaperBranch = prepare.slice(prepare.indexOf('if (wallpaper) {'), prepare.indexOf('} else {', prepare.indexOf('if (wallpaper) {')));

test('wallpaper attachment: bottom layer, every edge, zone -1, opaque, full-size page, no mini parts', () => {
    assert.match(wallpaperBranch, /layer->setLayer\(LayerShellQt::Window::LayerBottom\);/);
    // Never the background layer: the desktop's own wallpaper shares it and may draw on top.
    assert.doesNotMatch(prepare, /LayerShellQt::Window::LayerBackground/);
    for (const edge of ['AnchorTop', 'AnchorBottom', 'AnchorLeft', 'AnchorRight'])
        assert.ok(wallpaperBranch.includes(edge), edge);
    assert.match(wallpaperBranch, /layer->setMargins\(QMargins\(\)\);/);
    assert.match(wallpaperBranch, /layer->setExclusiveZone\(-1\);/);
    // The mini placement (glider, 240 px size) never touches the wallpaper surface.
    assert.doesNotMatch(wallpaperBranch, /miniGlider|setDesiredSize\(QSize\(240/);
    assert.match(prepare, /view\.setColor\(wallpaper \? QColor\(Qt::black\) : QColor\(Qt::transparent\)\);/);
    assert.match(prepare, /if \(wallpaper\) view\.resize\(screen->size\(\)\);/);
    // Same output for both modes; input always passes through.
    assert.match(prepare, /view\.setScreen\(screen\);/);
    assert.match(prepare, /layer->setScreen\(screen\);/);
    assert.match(prepare, /Qt::WindowTransparentForInput/);
    // No luminance key and no host disc outside the mini.
    const qml = read('view.qml');
    assert.match(qml, /layer\.enabled: sceneRoot\.sceneMode === "scene-mini"/);
    assert.match(qml, /visible: sceneRoot\.sceneMode === "scene-mini" && sceneRoot\.sceneDisc\.radius > 0/);
    // Full-size pages: no mini variant, 60 fps (CielWin WallpaperSceneSurface).
    const host = read('scene-host.cpp');
    for (const scene of ['processing', 'explorer', 'idle', 'raphael'])
        assert.ok(host.includes(`"qrc:/${scene}/index.html?fps=60"`), scene);
});

test('live mode switch: through SceneHost::setMode and Policy::retarget, persisted once ready', () => {
    // The switcher is the only rebuild path and never spends the recovery budget
    // (policy retarget; see scenes.contract.test.mjs POLICY_OK).
    assert.match(main, /interceptor\.select\(url\);\s*return policy\.retarget\(url\);/);
    assert.match(main, /stored\.settings\.wallpaperMode = shownMode;/);
    const policy = read('policy.h');
    assert.match(policy, /It is not an\s*\/\/ incident, so it never spends the recovery budget/);
    // Stage 1 default is kept: a fresh settings file starts in the mini.
    assert.match(read('settings.h'), /QString wallpaperMode = QStringLiteral\("scene-mini"\);/);
});

test('mode switch replaces the alert surface; the wallpaper shows alerts unless covered (B2)', () => {
    // One function names the surface alerts go to: the mini, or the wallpaper (B2).
    assert.match(main, /auto alertSurface = \[&\]\(\) -> const AlertSurface \* \{\s*return sceneHost\.mode\(\) == QStringLiteral\("scene-mini"\) \? &miniAlerts : &wallpaperAlerts;\s*\};/);
    assert.doesNotMatch(main, /alertDriver\.update\(&miniAlerts|alertDriver\.update\(alertSurface\(\), false\)/);
    // Every update (tick, accept, mode switch, coverage change) goes through one helper that passes
    // the wallpaper's coverage (always false in the mini).
    assert.match(main, /auto updateAlerts = \[&\] \{ alertDriver\.update\(alertSurface\(\), wallpaperCovered\(\)\); \};/);
    assert.match(main, /auto wallpaperCovered = \[&\] \{ return sceneHost\.mode\(\) == QStringLiteral\("scene"\) && fullscreenWatch\.covered\(\); \};/);
    assert.ok((main.match(/updateAlerts\(\)/g) ?? []).length >= 4, 'tick, accept, mode switch, coverage change');
    // CielWin SelectMode: the old surface is gone -> SurfaceReplaced, then an update; a show still
    // pending for the old page is dropped; one trace line.
    const hook = main.slice(main.indexOf('QString alertSurfaceMode'), main.indexOf('alertTick.start(400);'));
    assert.match(hook, /QObject::connect\(&sceneHost, &SceneHost::changed, &alertDriver, \[&\] \{/);
    assert.match(hook, /if \(sceneHost\.mode\(\) != alertSurfaceMode\) \{/);
    assert.ok(hook.indexOf('alertBridge.attach(policy.generation());') < hook.indexOf('alertBridge.hide();'));
    assert.ok(hook.indexOf('alertDriver.surfaceReplaced();') < hook.indexOf('if (sceneHost.mode() != alertSurfaceMode)'));
    assert.ok(hook.indexOf('alertBridge.hide();') < hook.indexOf('alertDriver.surfaceReplaced();'));
    assert.match(hook, /qInfo\("CIELINUX_MODE switched mode=%s", qPrintable\(alertSurfaceMode\)\);/);
});

test('B2 wallpaper alert surface: canShow honours covered, fills the work area, pauses the scene while covered', () => {
    const surface = main.slice(main.indexOf('const AlertSurface wallpaperAlerts{'), main.indexOf('auto alertSurface ='));
    // CielWin WallpaperSceneSurface.CanShowAlerts: ... && !primaryMonitorCovered.
    assert.match(surface, /\[&\]\(bool covered\) \{ return !policy\.closed\(\) && sceneHost\.mode\(\) == QStringLiteral\("scene"\) && !covered; \}/);
    assert.match(surface, /alertBridge\.post\(AlertLayerMessages::show\(request\)\)/);
    assert.match(surface, /\[&\] \{ alertBridge\.hide\(\); \}/);
    // Work area = the output minus Hyprland's reserved zones (bars), read at show time from the
    // watch's cache (B9: never a blocking request on the GUI thread).
    assert.match(surface, /AlertWorkArea::forOutput\(screen->size\(\), fullscreenWatch\.reserved\(\)\.value_or\(QMargins\(\)\), screen->devicePixelRatio\(\)\)/);
    // The mini keeps its whole-canvas surface and ignores coverage.
    assert.match(main, /const AlertSurface miniAlerts\{\s*\[&\]\(bool\) \{ return !policy\.closed\(\) && sceneHost\.mode\(\) == QStringLiteral\("scene-mini"\); \}/);
    // Coverage of the wallpaper's own output from Hyprland IPC, tracked only for the wallpaper (B10:
    // the watch itself runs in both modes for the reserved zones cache).
    // B11: watch lifecycle lines go out as CIELINUX_HYPRLAND, coverage lines as CIELINUX_WALLPAPER.
    assert.match(main, /FullscreenWatch fullscreenWatch\(screen->name\(\), \[\]\(const QString &line\) \{\s*qInfo\("%s %s", FullscreenWatch::logPrefix\(line\), qPrintable\(line\)\);/);
    assert.match(main, /QObject::connect\(&fullscreenWatch, &FullscreenWatch::coveredChanged, &alertDriver, \[&\] \{\s*updateScenePause\(\);\s*updateAlerts\(\);\s*\}\);/);
    assert.ok((main.match(/fullscreenWatch\.setCoverage\(sceneHost\.mode\(\) == QStringLiteral\("scene"\)\);/g) ?? []).length >= 2,
        'at startup and on every mode switch');
    // Pause/resume (CielWin "scene-wallpaper paused reason=fullscreen" / "resumed"): only a change is sent and logged.
    const pause = main.slice(main.indexOf('auto updateScenePause'), main.indexOf('auto updateScenePause') + 400);
    assert.match(pause, /const bool paused = wallpaperCovered\(\);\s*if \(paused == scenePaused\) return;\s*scenePaused = paused;\s*alertBridge\.setScenePaused\(paused\);/);
    assert.match(pause, /CIELINUX_WALLPAPER paused reason=fullscreen/);
    assert.match(pause, /CIELINUX_WALLPAPER resumed/);
    // Built into the host.
    assert.match(read('CMakeLists.txt'), /target_sources\(cielinux PRIVATE src\/fullscreen-watch\.cpp\)/);
});

// The page half of the pause (CielWin shared/js/render-loop.js "pause-scene-when-covered T1"):
// while paused scheduleFrame arms no requestAnimationFrame at all; resume re-arms each held callback once.
function loopSandbox(search) {
    const frames = [];
    const sandbox = vm.createContext({
        window: { requestAnimationFrame: callback => { frames.push(callback); return frames.length; } },
        location: { search, hash: '' }, URLSearchParams,
        document: { documentElement: { classList: { add() {} } } },
        ctx: {}, canvasScaleX: 1, canvasScaleY: 1, console,
    });
    vm.runInContext(read('idle/js/render-loop.js'), sandbox, { filename: 'qrc:/idle/js/render-loop.js' });
    const runFrames = time => { const due = frames.splice(0); for (const frame of due) frame(time); };
    return { sandbox, frames, runFrames };
}

test('B2 page: the full-size render loop goes idle while paused and resumes at the current time', () => {
    const { sandbox, frames, runFrames } = loopSandbox('?fps=60');
    const drawn = [];
    sandbox.draw = ms => { drawn.push(ms); };
    vm.runInContext('scheduleFrame(draw)', sandbox);
    assert.equal(frames.length, 1);
    runFrames(1000);
    assert.deepEqual(drawn, [1000]);
    // The pause arrives while a frame is in flight: it draws nothing and re-arms nothing.
    vm.runInContext('scheduleFrame(draw); setWallpaperPaused(true)', sandbox);
    runFrames(1016);
    assert.deepEqual(drawn, [1000]);
    assert.equal(frames.length, 0, 'fully idle while paused');
    vm.runInContext('scheduleFrame(draw); scheduleFrame(draw)', sandbox);
    assert.equal(frames.length, 0);
    vm.runInContext('setWallpaperPaused(false)', sandbox);
    assert.equal(frames.length, 1, 'each held callback re-armed exactly once');
    runFrames(90000);
    assert.deepEqual(drawn, [1000, 90000], 'no catch-up burst, the first resumed frame draws at once');
    // Repeated resume is a no-op.
    vm.runInContext('setWallpaperPaused(false)', sandbox);
    assert.equal(frames.length, 0);
    // Every scene shares the same loop file (one adapter).
    for (const scene of ['processing', 'explorer', 'raphael'])
        assert.equal(read(`${scene}/js/render-loop.js`), read('idle/js/render-loop.js'), scene);
});

test('B2 page: the mini never pauses (the host never sends it, the page ignores it)', () => {
    const { sandbox, frames } = loopSandbox('?variant=mini&fps=30');
    vm.runInContext('setWallpaperPaused(true); scheduleFrame(function () {})', sandbox);
    assert.equal(frames.length, 1);
});

test('B2 page: the overlay routes host pause/resume commands to the render loop', () => {
    const { sandbox } = loopSandbox('?fps=60');
    Object.assign(sandbox, { canvas: { width: 1920, height: 1080, style: {} }, W: 1920, H: 1080,
        sceneSeeThroughLayer: () => {}, console: { log() {}, error() {} } });
    vm.runInContext(read('shared/js/alert-overlay.js'), sandbox, { filename: 'qrc:/shared/js/alert-overlay.js' });
    sandbox.cielinuxAlertCommand('{"type":"pause"}');
    assert.equal(vm.runInContext('wallpaperPaused', sandbox), true);
    sandbox.cielinuxAlertCommand('{"type":"resume"}');
    assert.equal(vm.runInContext('wallpaperPaused', sandbox), false);
});

test('SUPER+Z position cycle is ignored outside the mini', () => {
    assert.match(main, /if \(policy\.closed\(\) \|\| sceneHost\.mode\(\) != QStringLiteral\("scene-mini"\)\) \{\s*qInfo\("CIELINUX_MINI position ignored reason=not-mini-mode"\);\s*return "ignored: not in mini mode";/);
});

test('help, settings comment and README describe the wallpaper mode (no "stage 2 preview")', () => {
    assert.doesNotMatch(main, /stage 2 preview/);
    assert.match(main, /Mode scene-mini \(default\) is the small overlay; scene is the full-screen animated wallpaper/);
    assert.doesNotMatch(read('settings.cpp'), /stage 2 preview/);
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.doesNotMatch(readme, /stage 2 preview|Coming later in the same menu/);
    assert.match(readme, /## Wallpaper mode/);
    assert.match(readme, /\*\*Scene Mode ▸\*\* Scene Wallpaper, Scene Mini/);
    // B2: fullscreen pause and alerts are documented, with their log lines.
    assert.doesNotMatch(readme, /Not yet in the wallpaper/);
    assert.match(readme, /CIELINUX_WALLPAPER paused reason=fullscreen/);
    assert.match(readme, /CIELINUX_HYPRLAND fullscreen-watch unavailable/);
    assert.match(readme, /CIELINUX_WALLPAPER covered monitor=/);
});
