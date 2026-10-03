#pragma once

namespace OutputPolicy {

// Preserve container order and the caller's native name comparison.
// The screen identities are borrowed; selection does not own their lifetime.
template<typename Screens, typename Matches>
auto select(const Screens &screens, bool unnamed, Matches matches)
    -> typename Screens::value_type {
    for (auto candidate : screens) {
        if (unnamed || matches(candidate)) return candidate;
    }
    return nullptr;
}

// Compare identities only: the removed screen must never be dereferenced.
// Keep hide before quit, including when the caller's actions have side effects.
template<typename Screen, typename Hide, typename Quit>
void removed(Screen selected, Screen removedScreen, Hide hide, Quit quit) {
    if (removedScreen == selected) {
        hide();
        quit();
    }
}

} // namespace OutputPolicy
