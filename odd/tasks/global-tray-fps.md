# Global tray FPS selection

## Objective and intent
Add a persisted global frame-rate cap selectable as 30 FPS or 60 FPS from the tray. The user explicitly chose global rather than per-mode selection. One value follows all four scenes and both mini/wallpaper modes. Default: 30 FPS (the existing default mini cadence).

This supersedes historical fixed mini30/wallpaper60 assumptions in the parent `odd/tasks/cosmiclinux-scenes-app.md`; that completed feature record remains historical evidence.

## Scope and constraints
- Settings, SceneHost, tray, exact readiness matrix, startup/persistence wiring, and alert replay after page reconstruction.
- Reuse existing URL-driven render loops. Changing rate reconstructs the scene and may reset animation.
- Closed values 30/60 only; rejected/no-op changes preserve authoritative menu state and do not reconstruct.
- Persist only after confirmed readiness, respecting unreadable settings protection.
- Preserve exact URL/source/marker and generation validation; do not loosen navigation.
- Preserve active alert remaining duration, pending delivery and single sound; retain wallpaper pause behavior.
- No HTTP/CLI extensions, renderer optimizations, publishing, or commits without explicit user request. User subsequently authorized installing and restarting the resident; do not edit Hyprland bindings or hand-edit real settings.

## Tasks
- [x] FPS-1 — Implement global FPS preference and tray switching with behavioral regression tests and README documentation. Status: verified implementation. Independent tests/build and native review passed; no commit authorized.
- [x] FPS-2 — Install the verified build without changing Hyprland bindings, restart cielinux.service, and independently confirm resident startup/new binary/tray menu. Status: verified. Explicit user authorization: "instala y reinicia". No commit authorized.

## Acceptance and checks
- Frame rate submenu exposes exclusive 30 FPS and 60 FPS actions and re-reads host state, including late tray-host recreation.
- Both rates work across all scene/mode combinations; scene/mode changes retain rate.
- Settings parse/serialize/default/invalid-value behavior is deterministic; readiness-triggered persistence uses the selected global rate.
- Exact readiness matrix admits all legitimate combinations and rejects wrong order, fragments, source, markers and stale generations.
- Active/pending alerts survive FPS replacement without extending duration or repeating sound.
- Deterministic scheduler tests cover 30/60 cadence and hitches; focused native Qt harnesses, full Node suite and release build pass.
- Real resident startup and tray layout checked after authorized install/restart. Physical tray switching and live compositor cadence remain unmeasured.

## Evidence and progress
- Explorer mapped nested Git root `CieLinux`; parent confirmed clean `main...origin/main` and RDD on (global).
- User confirmed switching 30/60 FPS and chose global preference.
- Baseline readiness supports mini30/full60 only; same-mode reconstruction currently skips alert replay.
- Writer completed global settings/SceneHost/tray/readiness/alert integration and documentation. Diff: 425 additions / 99 deletions across 18 implementation/test/doc files; size is coherent with native harness coverage, not split artificially.
- Test-first RED: missing preference serialization and wallpaper30 readiness (4/6 passed); missing FPS APIs then failed harness compilation. GREEN: focused suite 122/122; full suite 299/299, no failed/skipped; release configure/build exit 0; git diff --check passed (writer evidence).
- Native review `review-36ca44d950c386fd` approved; exact acknowledgement completed with authority burned for target `sha256:76da194c492476aba3c38e0481adaa4cb2c712354941fa20374a4cabddc61991`. No correction required. First consent expired without mutation; fresh offered START succeeded.
- Native ASSESS unavailable because its untracked declaration could not be resolved; conservative independent-verifier plan is already running (`muszp6iq-3-go0r`). This does not erase the native acknowledgement.
- Active LSP probe: missing Qt includes cause cascading diagnostics; one path timed out. LSP is not confirmed clean. Native compilation passed; no LSP config changes made.
- Independent verifier confirmed 299/299 tests (0 failed/skipped), Release build exit 0, git diff --check exit 0, no concrete candidate-caused defect. An initial wrong-cwd 0-test invocation was discarded and superseded by the correct 299-test run.
- User authorized installation and restart after verification. `./install.sh --no-hypr-binds && systemctl --user restart cielinux.service` exited 0; bindings untouched.
- Independent deployment snapshot: service active/running, PID 147184, NRestarts=0, lifecycle ready and tray available. Running executable resolves to ~/.local/bin/cielinux; installed/build SHA-256 both `70a8923162df99bf3e274d7c7ab56088becb3f5dc420e7e7cf7546e2bde13635`.
- Real D-Bus tray layout exposes enabled/visible Frame rate -> 30 FPS / 60 FPS, with 30 checked. Initial GetLayout argument parsing failed; corrected -- separator succeeded. No rate-changing commands sent.
- No crash/service failure observed in bounded restart journal; synthetic JS probes and QML deprecation warning noted. Actual FPS URL absent and live cadence unmeasured.
- No commit authorized; commit evidence pending explicit request.

## Next step
User can switch via tray Frame rate -> 30 FPS / 60 FPS. Optional next verification: physical switching and measured live cadence. Implementation and deployment checks complete; LSP setup limitation and no-commit status remain explicit.
