// Luminance key for the WebEngine layer. Qt WebEngine 6.11 accumulates stale
// bright content in empty areas of a transparent page when a scene draws heavy
// semi-transparent canvas content, so the page renders opaque on black and the
// host turns brightness into coverage: black is fully see-through.
#version 440
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf { mat4 qt_Matrix; float qt_Opacity; };
layout(binding = 1) uniform sampler2D source;
void main() {
    vec3 c = texture(source, qt_TexCoord0).rgb;
    float a = max(c.r, max(c.g, c.b));
    fragColor = vec4(c, a) * qt_Opacity; // premultiplied: every channel <= a
}
