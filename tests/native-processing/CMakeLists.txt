cmake_minimum_required(VERSION 3.24)
project(cielinux_native_processing LANGUAGES CXX)
option(CIELINUX_NATIVE_PROCESSING "Build the bounded native Processing smoke fixture" OFF)
if(NOT CIELINUX_NATIVE_PROCESSING)
    return()
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 6.8 REQUIRED COMPONENTS Quick Qml WebEngineQuick)
qt_add_executable(native-processing runner.cpp)
target_link_libraries(native-processing PRIVATE Qt6::Quick Qt6::Qml Qt6::WebEngineQuick)
qt_add_resources(native-processing "fixture" PREFIX "/native-processing" BASE "." FILES
    view.qml fixture.html driver.js)
# Reference the working tree directly: no copied or rewritten production scripts.
qt_add_resources(native-processing "scene" PREFIX "/" BASE "../../scenes" FILES
    ../../scenes/processing/styles.css
    ../../scenes/processing/js/config.js
    ../../scenes/processing/js/math.js
    ../../scenes/processing/js/nebula.js
    ../../scenes/processing/js/sphere.js
    ../../scenes/processing/js/scene-data.js
    ../../scenes/processing/js/sprites.js
    ../../scenes/processing/js/layers.js
    ../../scenes/processing/js/see-through-hook.js
    ../../scenes/shared/js/alert-overlay.js
    ../../scenes/processing/js/render-loop.js
    ../../scenes/processing/js/main.js
    ../../scenes/shared/fonts/ArchivoBlack-Regular.ttf)
