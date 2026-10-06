cmake_minimum_required(VERSION 3.24)
project(cielinux VERSION 0.1.0 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
include(GNUInstallDirs)
find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets DBus Network Multimedia Quick Qml WebEngineQuick ShaderTools)
find_package(LayerShellQt REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(Wayland REQUIRED IMPORTED_TARGET wayland-client)
qt_add_executable(cielinux src/main.cpp src/settings.cpp src/scene-host.cpp src/tray.cpp src/http-server.cpp src/http-token.cpp src/alerts.cpp src/alert-sounds.cpp)
# A6: mini positions + glide, and the per-user control socket / single-instance lock.
target_sources(cielinux PRIVATE src/mini-position.cpp src/mini-dodge.cpp src/instance-control.cpp src/log-routing.h)
# B2: wallpaper fullscreen coverage from Hyprland IPC (pause + held alerts).
target_sources(cielinux PRIVATE src/fullscreen-watch.cpp)
target_include_directories(cielinux PRIVATE src)
qt_add_qml_module(cielinux
    URI CieLinux.Host
    VERSION 1.0
    RESOURCE_PREFIX /qt/qml
    OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/CieLinux/Host"
    SOURCES src/policy.h src/alert-bridge.h
)
# Host QML, served as qrc:/view.qml.
qt_add_resources(cielinux "host" PREFIX "/" BASE src FILES src/view.qml)
# Scene pages, served as qrc:/<scene>/... (the shared alert overlay and its font as
# qrc:/shared/...); every file is listed explicitly and must match the resourceUrls
# allowlist in src/main.cpp.
qt_add_resources(cielinux "scenes" PREFIX "/" BASE scenes FILES
    scenes/processing/index.html scenes/processing/styles.css
    scenes/processing/js/config.js scenes/processing/js/math.js scenes/processing/js/nebula.js
    scenes/processing/js/sphere.js scenes/processing/js/scene-data.js scenes/processing/js/sprites.js
    scenes/processing/js/layers.js scenes/processing/js/see-through-hook.js scenes/processing/js/render-loop.js scenes/processing/js/main.js
    scenes/raphael/index.html scenes/raphael/styles.css
    scenes/raphael/js/config.js scenes/raphael/js/math.js scenes/raphael/js/hexadecagon.js scenes/raphael/js/nebula.js
    scenes/raphael/js/sphere.js scenes/raphael/js/scene-data.js scenes/raphael/js/feathers.js scenes/raphael/js/glyphs.js
    scenes/raphael/js/glyph-rings.js scenes/raphael/js/digits.js scenes/raphael/js/central-core.js scenes/raphael/js/sprites.js
    scenes/raphael/js/layers.js scenes/raphael/js/see-through-hook.js scenes/raphael/js/render-loop.js scenes/raphael/js/main.js
    scenes/idle/index.html scenes/idle/styles.css
    scenes/idle/js/config.js scenes/idle/js/math.js scenes/idle/js/glyphs.js scenes/idle/js/earth.js scenes/idle/js/rings.js
    scenes/idle/js/see-through-hook.js scenes/idle/js/render-loop.js scenes/idle/js/animate.js scenes/idle/js/main.js
    scenes/explorer/index.html scenes/explorer/styles.css
    scenes/explorer/js/config.js scenes/explorer/js/math.js scenes/explorer/js/glyphs.js scenes/explorer/js/earth.js
    scenes/explorer/js/rings.js scenes/explorer/js/rising-sparks.js scenes/explorer/js/see-through-hook.js
    scenes/explorer/js/render-loop.js scenes/explorer/js/animate.js scenes/explorer/js/main.js
    scenes/shared/js/alert-overlay.js scenes/shared/fonts/ArchivoBlack-Regular.ttf
)
# Tray icon, served as qrc:/raphael-mini.ico: the multi-size Raphael mini icon (README, Tray), read
# by qt6-base's ICO image plugin.
qt_add_resources(cielinux "assets" PREFIX "/" BASE assets FILES assets/raphael-mini.ico)
# Produces qrc:/lumakey.frag.qsb for the view.qml layer effect.
qt_add_shaders(cielinux "lumakey" PREFIX "/" BASE src FILES src/lumakey.frag)
target_link_libraries(cielinux PRIVATE Qt6::Widgets Qt6::DBus Qt6::Network Qt6::Multimedia Qt6::Quick Qt6::Qml Qt6::WebEngineQuick LayerShellQt::Interface PkgConfig::Wayland)
install(TARGETS cielinux RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
