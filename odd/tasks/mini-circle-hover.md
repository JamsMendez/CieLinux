# Mini visible-circle hover

## Objective and scope
Trigger mini dodge only inside the visible animation circle, excluding transparent corners and old rectangular padding. Use the shared centered outer-fade support: strict radius 0.48 times the smaller canvas dimension. Background host discs are different; no pixel-alpha sampling or visual changes.
Use the last applied glide frame for new triggers. Preserve travel/fallback, fit, polling, persistence, lifecycle and 400 ms return delay. Leave .atl/ untouched.

## Tasks
- [x] T1: Implement circle/current-frame hit testing, regressions and README update; verify automated behavior.
  - Route: gentle-ai-worker (multi-file/preparation triggers), independent gentle-ai-verify.
  - Acceptance: circle interior triggers; corners, old padding and exact transparent boundary do not; followed-window and mid-glide behavior use current position; return timing preserved.
- [x] T2: Install and restart CieLinux after explicit user authorization; verify runtime health and binary parity.
  - Route: parent deployment commands; gentle-ai-verify runtime checks.

## Evidence
T1: 116 additions / 21 deletions across seven source/test/README files. Worker observed RED for transparent-corner regression before production edits, then GREEN.
- node --test tests/mini-position.contract.test.mjs tests/disc.contract.test.mjs: 9/9 passed.
- node --test --test-name-pattern="mini dodge|cursor query" tests/fullscreen.contract.test.mjs: 3/3 passed.
- node --test tests/*.test.mjs: 360/360 passed.
- cmake -S . -B build -DCMAKE_BUILD_TYPE=Release: passed, nonfatal Vulkan headers notice.
- cmake --build build -j2: passed.
- git diff --check: passed.
Native review review-381a2331c12620d8 approved and exact acknowledgement burned authority. ASSESS unavailable due untracked declaration; independent verifier repeated focused checks successfully and found no candidate-caused bug.

T2: User explicitly authorized installation and restart.
- ./install.sh --no-hypr-binds && systemctl --user restart cielinux.service: passed; no Hyprland bind changes.
- Independent systemctl/journal/proc verification: active/running, PID 2485463, renderer ready with err=0; installed executable confirmed.
- Build/installed SHA-256: 4030f14dc65f7a84f5ad83df7f84546fd1af14850867466eec509082ee6b90f5.
- Startup warnings: GBM fallback to Vulkan and deprecated Qt profile creation; no fatal startup failure observed.

## Delivery and constraints
Forecast 150–250 authored lines; actual 137 source/test/README lines. Strategy ask-on-risk. User explicitly authorized the behavior commit and local merge into main; .atl/ is excluded and no push is authorized. Installed ~/.local/bin/cielinux and user systemd unit only; no compositor restart.

## Next step
User observes live circle versus transparent-corner hover behavior. Interactive visual/cursor verification remains pending; automated implementation and runtime health checks are complete.
