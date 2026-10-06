// A6 mini positions: CielWin's eight positions, order and cycle
// (CielWin/CielWin.App/Wallpaper/MiniWindowPlacement.cs, Settings.cs), its 220 ms ease-out
// cubic glide (Wallpaper/MiniGlide.cs, MiniSceneWindowController.cs), ported to layer-shell
// anchors + margins. The pure placement code and the glider run as a real Qt harness
// compiled from the shipped sources; a model of the compositor's layer-shell placement
// checks that no request sequence ever makes the window jump.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, SRC, source } from './paths.mjs';

const read = name => readFileSync(source(name), 'utf8');
let binary, fixture;

const run = (program, args, env = process.env) => {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 240000, env });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
};

after(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

before(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cielinux-a6-position.'));
    binary = join(fixture, 'build', 'position-contract');
    writeFileSync(join(fixture, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(PositionContract LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Network)
add_executable(position-contract harness.cpp "${SRC}/mini-position.cpp" "${SRC}/mini-position.h"
    "${SRC}/mini-dodge.cpp" "${SRC}/mini-dodge.h" "${SRC}/settings.cpp" "${SRC}/settings.h")
target_include_directories(position-contract PRIVATE "${SRC}")
target_link_libraries(position-contract PRIVATE Qt6::Core Qt6::Network)
`);
    writeFileSync(join(fixture, 'harness.cpp'), String.raw`
#include "mini-dodge.h"
#include "mini-position.h"
#include "settings.h"
#include <QCoreApplication>
#include <QList>
#include <iostream>
#define CHECK(x) do { if (!(x)) { std::cerr << "CHECK " << __LINE__ << ": " #x "\n"; return 3; } } while (false)
using namespace MiniPlacement;

// The compositor: one surface whose anchors and margins change one request at a time.
struct Compositor {
    QSize usable;
    Layer state{0, QMargins()};
    QList<QPoint> seen;
    void record() { seen << resolve(state, usable, side); }
};

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    // Order, names and cycle exactly as CielWin.
    const QStringList order{"top-left", "top-center", "top-right", "right-center",
                            "bottom-right", "bottom-center", "bottom-left", "left-center"};
    CHECK(MiniPosition::names() == order);
    for (int i = 0; i < order.size(); ++i) {
        CHECK(MiniPosition::isValid(order[i]));
        CHECK(MiniPosition::next(order[i]) == order[(i + 1) % 8]);
        CHECK(MiniPosition::previous(order[i]) == order[(i + 7) % 8]);
        CHECK(MiniPosition::previous(MiniPosition::next(order[i])) == order[i]);
    }
    CHECK(!MiniPosition::isValid("Top-Right") && !MiniPosition::isValid("center") && !MiniPosition::isValid(""));
    CHECK(MiniPosition::next("bogus") == "top-left" && MiniPosition::previous("bogus") == "top-left");

    // Settings: default top-right, invalid keeps the default, legacy mini-corner read, new key written.
    CHECK(Settings().miniPosition == "top-right");
    CHECK(Settings::parse("mini-position = sideways\n").miniPosition == "top-right");
    CHECK(Settings::parse("mini-position = Bottom-Left\n").miniPosition == "bottom-left");
    CHECK(Settings::parse("mini-corner = left-center\n").miniPosition == "left-center");
    Settings s; s.miniPosition = "bottom-center";
    CHECK(s.serialize().contains("\nmini-position = bottom-center\n"));
    CHECK(Settings::parse(s.serialize()) == s);

    // Geometry in the usable area (output minus other surfaces' exclusive zones): 240 px square, 16 px inset.
    CHECK(side == 240 && inset == 16 && glideMs == 220);
    const QSize usable(1883, 1080); // 1920x1080 with a 37 px bar on the right
    CHECK(rect("top-left", usable) == QRect(16, 16, 240, 240));
    CHECK(rect("top-center", usable) == QRect(821, 16, 240, 240));
    CHECK(rect("top-right", usable) == QRect(1627, 16, 240, 240));
    CHECK(rect("right-center", usable) == QRect(1627, 420, 240, 240));
    CHECK(rect("bottom-right", usable) == QRect(1627, 824, 240, 240));
    CHECK(rect("bottom-center", usable) == QRect(821, 824, 240, 240));
    CHECK(rect("bottom-left", usable) == QRect(16, 824, 240, 240));
    CHECK(rect("left-center", usable) == QRect(16, 420, 240, 240));
    CHECK(rect("bogus", usable) == rect("top-right", usable));

    // Resting placement: anchors to the position's edges, inset on those edges only, so the
    // compositor (which honours exclusive zones) does the final placement.
    CHECK((resting("top-right") == Layer{Top | Right, QMargins(0, 16, 16, 0)}));
    CHECK((resting("top-center") == Layer{Top, QMargins(0, 16, 0, 0)}));
    CHECK((resting("left-center") == Layer{Left, QMargins(16, 0, 0, 0)}));
    CHECK((resting("bottom-left") == Layer{Bottom | Left, QMargins(16, 0, 0, 16)}));
    for (const QString &p : order) CHECK(resolve(resting(p), usable, side) == rect(p, usable).topLeft());
    CHECK(unsigned(Top) == 1 && unsigned(Bottom) == 2 && unsigned(Left) == 4 && unsigned(Right) == 8);

    // Ease-out cubic and glide frames rounded away from zero, exact at both ends.
    CHECK(ease(0) == 0 && ease(1) == 1 && qAbs(ease(0.5) - 0.875) < 1e-12);
    const QRect a(0, 0, 240, 240), b(100, 50, 240, 240);
    CHECK(glideAt(a, b, -5, 220) == a);
    CHECK(glideAt(a, b, 0, 220) == a);
    CHECK(glideAt(a, b, 110, 220) == QRect(88, 44, 240, 240)); // 87.5 -> 88, 43.75 -> 44
    CHECK(glideAt(a, b, 220, 220) == b && glideAt(a, b, 999, 220) == b);

    // The glider: instant attach, 220 ms glide through margins, never a jump.
    qint64 now = 1000;
    Compositor wl{usable};
    int usableQueries = 0;
    MiniGlider glider([&] { return now; }, [&] { ++usableQueries; return usable; });
    MiniGlider::Sink sink{[&](const QMargins &m) { wl.state.margins = m; wl.record(); },
                          [&](unsigned anchors) { wl.state.anchors = anchors; wl.record(); }};
    CHECK(!glider.attached() && !glider.glideTo("top-left"));
    glider.attach(sink, "top-right");
    CHECK(glider.attached() && !glider.gliding() && glider.position() == "top-right");
    CHECK(wl.state == resting("top-right"));
    CHECK(wl.seen.last() == QPoint(1627, 16));

    wl.seen.clear();
    CHECK(glider.glideTo("right-center"));
    CHECK(glider.gliding() && glider.position() == "right-center" && usableQueries == 1);
    CHECK(wl.state.anchors == (Top | Left));
    for (const QPoint &p : wl.seen) CHECK(p == QPoint(1627, 16)); // switching frames never moves it
    int lastDistance = 1 << 30;
    for (now = 1000; now <= 1220; now += 16) {
        glider.tick();
        const QPoint p = wl.seen.last();
        const int distance = qAbs(p.x() - 1627) + qAbs(p.y() - 420);
        CHECK(distance <= lastDistance);
        lastDistance = distance;
    }
    now = 1220;
    glider.tick();
    CHECK(!glider.gliding());
    CHECK(wl.state == resting("right-center"));
    for (const QPoint &p : wl.seen) CHECK(p.x() == 1627 && p.y() >= 16 && p.y() <= 420);
    CHECK(wl.seen.last() == QPoint(1627, 420));

    // Retarget mid-glide: starts from where it is, never jumps back or ahead.
    wl.seen.clear();
    now = 2000;
    CHECK(glider.glideTo("bottom-center"));
    now = 2100;
    glider.tick();
    const QPoint mid = wl.seen.last();
    CHECK(mid.x() < 1627 && mid.x() > 821 && mid.y() > 420 && mid.y() < 824);
    wl.seen.clear();
    CHECK(glider.glideTo("top-left"));
    CHECK(wl.seen.isEmpty() || wl.seen.last() == mid);
    for (now = 2100; now <= 2320; now += 10) glider.tick();
    CHECK(!glider.gliding() && wl.state == resting("top-left"));
    CHECK(wl.seen.last() == QPoint(16, 16));
    for (const QPoint &p : wl.seen) CHECK(p.x() >= 16 && p.x() <= mid.x() && p.y() >= 16 && p.y() <= mid.y());

    // Every cycle step lands exactly, in both directions, without a jump on any request.
    QString position = "top-left";
    for (int step = 0; step < 16; ++step) {
        const QString target = step < 8 ? MiniPosition::next(position) : MiniPosition::previous(position);
        const QRect from = rect(position, usable), to = rect(target, usable);
        const QRect box = from.united(to);
        wl.seen.clear();
        now += 1000;
        CHECK(glider.glideTo(target));
        for (int t = 0; t <= 240; t += 8) { now += 8; glider.tick(); }
        CHECK(!glider.gliding() && wl.state == resting(target));
        for (const QPoint &p : wl.seen) CHECK(box.contains(QRect(p, QSize(240, 240))));
        position = target;
    }

    // Same position: nothing sent. Detach stops a glide and drops the sink.
    wl.seen.clear();
    CHECK(glider.glideTo(position) && wl.seen.isEmpty());
    CHECK(glider.glideTo(MiniPosition::next(position)) && glider.gliding());
    const int sent = wl.seen.size();
    glider.detach();
    CHECK(!glider.attached() && !glider.gliding());
    now += 50; glider.tick();
    CHECK(wl.seen.size() == sent);
    // Re-attach (a new scene attachment) places the remembered target instantly.
    Compositor fresh{usable};
    glider.attach({[&](const QMargins &m) { fresh.state.margins = m; fresh.record(); },
                   [&](unsigned anchors) { fresh.state.anchors = anchors; fresh.record(); }},
                  glider.position());
    CHECK(fresh.state == resting(glider.position()));

    // Unknown usable size (no compositor information): the move is instant, never a glide.
    MiniGlider blind([&] { return now; }, [] { return QSize(); });
    Compositor wl2{usable};
    blind.attach({[&](const QMargins &m) { wl2.state.margins = m; },
                  [&](unsigned anchors) { wl2.state.anchors = anchors; }}, "top-right");
    CHECK(blind.glideTo("bottom-left") && !blind.gliding() && wl2.state == resting("bottom-left"));

    // Hyprland reserved areas: [left, top, right, bottom] per monitor name, JSON from j/monitors.
    const QByteArray monitors = R"([{"name":"DP-1","reserved":[0,30,0,0]},{"name":"HDMI-A-2","reserved":[0,0,37,0]}])";
    CHECK(parseHyprlandReserved(monitors, "HDMI-A-2") == QMargins(0, 0, 37, 0));
    CHECK(parseHyprlandReserved(monitors, "DP-1") == QMargins(0, 30, 0, 0));
    CHECK(!parseHyprlandReserved(monitors, "eDP-1"));
    CHECK(!parseHyprlandReserved("not json", "DP-1"));
    CHECK(!parseHyprlandReserved(R"([{"name":"DP-1","reserved":[0,-3,0,0]}])", "DP-1"));
    CHECK(!parseHyprlandReserved(R"([{"name":"DP-1","reserved":[0,3]}])", "DP-1"));
    // Hover dodge geometry (mini-dodge): away from the cursor along the dominant axis, fully inside
    // the usable area (16 px inset), far enough to clear the approach zone; else a perpendicular
    // side (the one farther from the cursor first); else nowhere.
    {
        using namespace MiniDodge;
        CHECK(approach == 24 && gap == 8 && returnMs == 400 && pollMs == 100);
        CHECK(zone(QRect(16, 16, 240, 240)) == QRect(-8, -8, 288, 288));
        CHECK(name(Direction::Left) == "left" && name(Direction::Right) == "right"
              && name(Direction::Up) == "up" && name(Direction::Down) == "down");
        struct Case { const char *position; QPoint cursor; Direction direction; QRect rect; };
        const Case cases[] = {
            {"top-right", {1870, 136}, Direction::Left, {1355, 16, 240, 240}},   // cursor right: left
            {"left-center", {2, 540}, Direction::Right, {288, 420, 240, 240}},   // cursor left: right
            {"top-left", {136, 0}, Direction::Down, {16, 288, 240, 240}},        // cursor above: down
            {"bottom-left", {136, 1075}, Direction::Up, {16, 552, 240, 240}},    // cursor below: up
            {"top-right", {1610, 136}, Direction::Down, {1627, 288, 240, 240}},  // right does not fit
            {"right-center", {1610, 560}, Direction::Up, {1627, 148, 240, 240}}, // cursor lower: up first
            {"right-center", {1610, 520}, Direction::Down, {1627, 692, 240, 240}},
        };
        for (const Case &k : cases) {
            const QRect home = rect(k.position, usable);
            CHECK(zone(home).contains(k.cursor));
            const std::optional<Choice> c = choose(home, k.cursor, usable);
            CHECK(c && c->direction == k.direction && c->rect == k.rect);
            CHECK(!c->rect.intersects(zone(home)) && !zone(c->rect).contains(k.cursor));
            CHECK(QRect(16, 16, usable.width() - 32, usable.height() - 32).contains(c->rect));
        }
        // A vertical dodge that does not fit takes a side (a low usable area).
        const QSize low(1883, 300);
        const std::optional<Choice> side = choose(rect("top-center", low), QPoint(941, 0), low);
        CHECK(side && side->direction == Direction::Left && side->rect == QRect(549, 16, 240, 240));
        // No side fits: stays home.
        CHECK(!choose(QRect(16, 16, 240, 240), QPoint(250, 136), QSize(300, 300)));
        // A side whose rect would sit by the cursor is no dodge either.
        CHECK(!choose(rect("top-right", usable), QPoint(1610, 270), usable));
    }

    // Rect glides (the dodge): the saved position stays, the frame rests on Top|Left margins, and
    // the glide back to the position (or to a new one) starts where the window is: never a jump.
    {
        qint64 t = 50000;
        Compositor wd{usable};
        MiniGlider g([&] { return t; }, [&] { return usable; });
        CHECK(!g.glideToRect(QRect(1355, 16, 240, 240)));
        g.attach({[&](const QMargins &m) { wd.state.margins = m; wd.record(); },
                  [&](unsigned anchors) { wd.state.anchors = anchors; wd.record(); }}, "top-right");
        CHECK(!g.aside());
        const QRect aside(1355, 16, 240, 240);
        wd.seen.clear();
        CHECK(g.glideToRect(aside) && g.gliding() && g.aside() && g.position() == "top-right");
        for (int i = 0; i < 16; ++i) { t += 16; g.tick(); }
        CHECK(!g.gliding() && g.aside() && g.position() == "top-right");
        CHECK(wd.state == gliding(aside) && wd.seen.last() == aside.topLeft());
        int x = 1627;
        for (const QPoint &p : wd.seen) { CHECK(p.y() == 16 && p.x() <= x && p.x() >= 1355); x = p.x(); }
        int sent = wd.seen.size();
        CHECK(g.glideToRect(aside) && !g.gliding() && wd.seen.size() == sent);
        // Back to the saved position: a glide too, resting on its anchors at the end.
        wd.seen.clear();
        CHECK(g.glideTo(g.position()) && g.gliding() && !g.aside());
        for (int i = 0; i < 16; ++i) { t += 16; g.tick(); }
        CHECK(!g.gliding() && wd.state == resting("top-right") && wd.seen.last() == QPoint(1627, 16));
        x = 1355;
        for (const QPoint &p : wd.seen) { CHECK(p.y() == 16 && p.x() >= x && p.x() <= 1627); x = p.x(); }
        // Home and resting: nothing to do.
        sent = wd.seen.size();
        CHECK(g.glideTo("top-right") && wd.seen.size() == sent);
        // A new position mid-dodge-glide starts from the frame last placed.
        CHECK(g.glideToRect(aside));
        t += 100; g.tick();
        const QPoint mid = wd.seen.last();
        CHECK(mid.x() < 1627 && mid.x() > 1355);
        wd.seen.clear();
        CHECK(g.glideTo("bottom-right") && !g.aside());
        CHECK(wd.seen.isEmpty() || wd.seen.last() == mid);
        for (int i = 0; i < 16; ++i) { t += 16; g.tick(); }
        CHECK(wd.state == resting("bottom-right") && g.position() == "bottom-right");
        for (const QPoint &p : wd.seen) CHECK(QRect(mid, QPoint(1627, 824)).contains(p));
        // A rebuild forgets the dodge: the new surface rests at the position.
        CHECK(g.glideToRect(QRect(1355, 824, 240, 240)));
        g.detach();
        CHECK(!g.aside() && !g.gliding());
        Compositor again{usable};
        g.attach({[&](const QMargins &m) { again.state.margins = m; },
                  [&](unsigned anchors) { again.state.anchors = anchors; }}, g.position());
        CHECK(!g.aside() && again.state == resting("bottom-right"));
        // Without a usable size there is no frame to dodge to.
        MiniGlider b([&] { return t; }, [] { return QSize(); });
        b.attach({[](const QMargins &) {}, [](unsigned) {}}, "top-right");
        CHECK(!b.glideToRect(aside) && !b.aside());
    }
    // The dodge driver (MiniDodger): one cursor request at a time, a dodge on approach, a return once
    // the cursor stayed away 400 ms, one trace line per transition, the saved position untouched.
    {
        qint64 t = 90000;
        Compositor wm{usable};
        MiniGlider g([&] { return t; }, [&] { return usable; });
        g.attach({[&](const QMargins &m) { wm.state.margins = m; wm.record(); },
                  [&](unsigned anchors) { wm.state.anchors = anchors; wm.record(); }}, "top-right");
        QStringList trace;
        int asks = 0;
        bool available = true, enabled = true;
        std::function<void(std::optional<QPoint>)> pending;
        MiniDodger d(g, [&] { return t; }, [&] { return usable; },
                     [&](std::function<void(std::optional<QPoint>)> done) {
                         if (!available) return false;
                         ++asks;
                         pending = std::move(done);
                         return true;
                     },
                     [&] { return enabled; }, [&](const QString &line) { trace << line; });
        const auto land = [&] { for (int i = 0; i < 16; ++i) { t += 16; g.tick(); } };
        const auto answer = [&](std::optional<QPoint> p) { auto done = std::move(pending); pending = nullptr; done(p); };
        CHECK(!d.polling() && MiniDodge::pollMs == 100);
        d.start();
        CHECK(d.polling());
        // One request at a time: a poll while an answer is due asks nothing.
        d.poll(); d.poll();
        CHECK(asks == 1);
        answer(QPoint(800, 700));
        CHECK(!d.dodged() && !g.aside() && trace.isEmpty());
        // Approach from the right: glides left; the position (and so the setting) stays.
        d.poll();
        CHECK(asks == 2);
        answer(QPoint(1870, 136));
        CHECK(d.dodged() && g.aside() && g.position() == "top-right" && trace == QStringList{"dodge direction=left"});
        land();
        CHECK(wm.state == gliding(QRect(1355, 16, 240, 240)));
        // Lingering over the home spot keeps it aside and logs nothing more.
        d.update(QPoint(1700, 136)); t += 1000; d.update(QPoint(1700, 136));
        CHECK(d.dodged() && trace.size() == 1);
        // Away for 400 ms: back home.
        d.update(QPoint(800, 700)); t += 399; d.update(QPoint(800, 700));
        CHECK(d.dodged() && g.aside());
        t += 1; d.update(QPoint(800, 700));
        CHECK(!d.dodged() && !g.aside() && g.gliding() && trace == QStringList({"dodge direction=left", "dodge return"}));
        land();
        CHECK(wm.state == resting("top-right"));
        // Coming near again before 400 ms restarts the wait.
        d.update(QPoint(1870, 136)); land();
        d.update(QPoint(800, 700)); t += 300; d.update(QPoint(1700, 100));
        t += 300; d.update(QPoint(800, 700)); t += 300; d.update(QPoint(800, 700));
        CHECK(d.dodged());
        t += 100; d.update(QPoint(800, 700));
        CHECK(!d.dodged());
        land();
        // Following the window to its new spot: it takes another side (down), one line per move.
        d.update(QPoint(1870, 136)); land();
        trace.clear();
        d.update(QPoint(1400, 136));
        CHECK(d.dodged() && trace == QStringList{"dodge direction=down"});
        land();
        CHECK(wm.state == gliding(QRect(1627, 288, 240, 240)));
        // No cursor (Hyprland gone, an unreadable answer) reads as away: home after 400 ms.
        trace.clear();
        d.update(std::nullopt); t += 400; d.update(std::nullopt);
        CHECK(!d.dodged() && trace == QStringList{"dodge return"});
        land();
        CHECK(wm.state == resting("top-right"));
        // Nothing to ask (no Hyprland): nothing happens, the next poll asks again.
        available = false;
        d.poll();
        CHECK(asks == 2 && d.polling() && !d.dodged());
        available = true;
        d.poll();
        CHECK(asks == 3);
        // A cycle-position move cancels the dodge and glides itself: no return line.
        answer(QPoint(1870, 136));
        CHECK(d.dodged());
        trace.clear();
        d.cancel();
        CHECK(!d.dodged() && d.polling() && g.glideTo("bottom-right"));
        land();
        CHECK(wm.state == resting("bottom-right") && trace.isEmpty());
        // A cancel while an answer is due drops that answer but still waits for it: no second request.
        d.poll();
        CHECK(asks == 4);
        d.cancel();
        d.poll();
        CHECK(asks == 4);
        answer(QPoint(1870, 944));
        CHECK(!d.dodged() && !g.aside() && trace.isEmpty());
        d.poll();
        CHECK(asks == 5);
        answer(QPoint(800, 700));
        // stop() ends polling and drops an answer still due; a restart waits for it too.
        d.poll();
        CHECK(asks == 6);
        d.stop();
        CHECK(!d.polling());
        d.start();
        d.poll();
        CHECK(asks == 6);
        answer(QPoint(1870, 944));
        CHECK(!d.dodged() && !g.aside() && trace.isEmpty());
        // An answer that never comes cannot wedge the dodge: after askLimitMs the next poll asks again,
        // and the lost answer, if it ever arrives, is dropped.
        CHECK(MiniDodge::askLimitMs == 2000);
        d.poll();
        CHECK(asks == 7);
        auto lost = std::move(pending);
        t += 1999; d.poll();
        CHECK(asks == 7);
        t += 1; d.poll();
        CHECK(asks == 8);
        lost(QPoint(1870, 944));
        CHECK(!d.dodged() && !g.aside() && trace.isEmpty());
        d.poll();
        CHECK(asks == 8);
        answer(QPoint(800, 700));
        d.stop();
        // Out of the mini (or closing): the next poll stops polling, asking nothing.
        d.start();
        enabled = false;
        d.poll();
        CHECK(!d.polling() && asks == 8);
        // No surface (a rebuild): the same.
        enabled = true;
        d.start();
        g.detach();
        d.poll();
        CHECK(!d.polling() && asks == 8);
    }
    std::cout << "POSITION_OK";
    return 0;
}
`);
    for (const args of [['-S', fixture, '-B', join(fixture, 'build')], ['--build', join(fixture, 'build'), '-j2']]) {
        const result = run('cmake', args);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
});

test('eight CielWin positions, cycle, settings and a jump-free 220 ms margin glide', () => {
    const result = run(binary, [], { ...process.env, QT_QPA_PLATFORM: 'offscreen' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /POSITION_OK/);
});

test('the mini attachment is placed and glided only through MiniGlider', () => {
    const main = read('main.cpp');
    const prepare = main.slice(main.indexOf('auto prepareAttachment'), main.indexOf('policy.bindReconstruction'));
    const mini = prepare.slice(prepare.indexOf('} else {', prepare.indexOf('if (wallpaper) {')));
    assert.match(mini, /miniGlider\.attach\(/);
    assert.match(mini, /stored\.settings\.miniPosition/);
    assert.doesNotMatch(mini, /layer->setAnchors|layer->setMargins/);
    // A new attachment drops the old surface before it is destroyed.
    assert.ok(prepare.indexOf('miniGlider.detach()') >= 0);
    assert.ok(prepare.indexOf('miniGlider.detach()') < prepare.indexOf('attachment.reset()'));
    // The glide frame uses the usable area: output size minus Hyprland's reserved zones, read from
    // the fullscreen watch's cache (B10: never a blocking request on the GUI thread).
    const glider = main.slice(main.indexOf('MiniGlider miniGlider('), main.indexOf('instance.setHandler('));
    assert.match(glider, /screen->size\(\)\.shrunkBy\(fullscreenWatch\.reserved\(\)\.value_or\(QMargins\(\)\)\)/);
    assert.ok(main.indexOf('FullscreenWatch fullscreenWatch(') < main.indexOf('MiniGlider miniGlider('));
    assert.doesNotMatch(main + read('mini-position.cpp') + read('mini-position.h'), /hyprlandReserved/);
    assert.doesNotMatch(read('mini-position.cpp'), /waitFor(Connected|ReadyRead|BytesWritten)/);
    const cmake = read('CMakeLists.txt');
    assert.match(cmake, /target_sources\(cielinux PRIVATE [^)]*src\/mini-position\.cpp/);
});

test('the hover dodge runs only in the mini, through MiniDodger and the watch cursor query', () => {
    const main = read('main.cpp');
    // Built after the glider; the cursor comes from the fullscreen watch's asynchronous query,
    // moved into the usable area by the cached reserved left/top.
    assert.ok(main.indexOf('MiniGlider miniGlider(') < main.indexOf('MiniDodger miniDodger('));
    const dodger = main.slice(main.indexOf('MiniDodger miniDodger('), main.indexOf('instance.setHandler('));
    assert.match(dodger, /fullscreenWatch\.queryCursor\(/);
    assert.match(dodger, /fullscreenWatch\.reserved\(\)\.value_or\(QMargins\(\)\)/);
    assert.match(dodger, /!policy\.closed\(\) && sceneHost\.mode\(\) == QStringLiteral\("scene-mini"\)/);
    assert.match(dodger, /qInfo\("CIELINUX_MINI %s", qPrintable\(line\)\)/);
    // SUPER+Z cancels a dodge before gliding to the new position (which is what gets saved).
    const handler = main.slice(main.indexOf('instance.setHandler('), main.indexOf('instance.listen();'));
    assert.ok(handler.indexOf('miniDodger.cancel()') >= 0);
    assert.ok(handler.indexOf('miniDodger.cancel()') < handler.indexOf('miniGlider.glideTo(next)'));
    // A rebuild (also every mode switch) stops it before the surface goes; a mini surface starts it.
    const prepare = main.slice(main.indexOf('auto prepareAttachment'), main.indexOf('policy.bindReconstruction'));
    assert.ok(prepare.indexOf('miniDodger.stop()') >= 0);
    assert.ok(prepare.indexOf('miniDodger.stop()') < prepare.indexOf('miniGlider.detach()'));
    const mini = prepare.slice(prepare.indexOf('} else {', prepare.indexOf('if (wallpaper) {')));
    assert.ok(mini.indexOf('miniDodger.start()') > mini.indexOf('miniGlider.attach('));
    // The mini still lets every click through.
    assert.match(main, /Qt::WindowTransparentForInput/);
    assert.doesNotMatch(read('mini-dodge.cpp') + read('mini-dodge.h'), /waitFor(Connected|ReadyRead|BytesWritten)|QSettings|miniPosition/);
    assert.match(read('CMakeLists.txt'), /target_sources\(cielinux PRIVATE [^)]*src\/mini-dodge\.cpp/);
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /CIELINUX_MINI dodge direction=<left\\\|right\\\|up\\\|down>/);
    assert.match(readme, /CIELINUX_MINI dodge return/);
    assert.match(readme, /j\/cursorpos/);
});
