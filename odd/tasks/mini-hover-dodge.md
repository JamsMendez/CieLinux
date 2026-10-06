# Mini hover dodge

## Objective

When the mouse cursor approaches the mini window, the mini glides aside so the user can
see what is behind it, and glides back to its saved position once the cursor leaves.

## Problem / why

The mini is an always-on-top 240 px overlay. Clicks already pass through it
(`Qt::WindowTransparentForInput`, `src/main.cpp:463`), but it still hides what is under
it. Hovering it should read as "move aside, let me see behind you".

## Behavior

- Trigger: the cursor enters the mini's home rect expanded by a small approach margin.
- Direction: away from the cursor along the dominant axis. Cursor on the right moves it
  left, above moves it down, below moves it up, on the left moves it right.
- Viability: the dodged rect must fit inside the usable area (output minus Hyprland
  reserved zones). If the preferred direction does not fit, use a viable perpendicular
  side (the one farther from the cursor). If none fits, stay.
- Distance: far enough that the dodged rect no longer covers the approach zone.
- Return: once the cursor has left the approach zone for a short delay, the mini glides
  back to its saved position. The saved `mini-position` setting never changes for a dodge.
- Cycle-position moves (`SUPER+Z`) cancel any dodge and glide to the new named position.
- Mode switches, rebuilds and closing stop the dodge and the cursor polling.

## Constraints

- The mini gets no pointer events, so the cursor comes from Hyprland IPC `j/cursorpos`
  (global layout coordinates), mapped onto the output with the monitor's `x`/`y` from
  `j/monitors`.
- Polling is async and never overlaps (skip a tick while a request is in flight), and
  runs only in the mini with an attached surface. The README's "never polled" statement
  for the Hyprland watch gets a documented mini-only exception.
- Glides reuse `MiniGlider` (220 ms ease-out cubic, margins before anchors, no jumps).
- On compositors other than Hyprland there is no cursor, so no dodge.
- Linux only; Windows portability is out of scope.

## Delivery

- Branch: `feat/mini-hover-dodge` from `main`; merge into `integration` when done.
- Commits: none unless the user asks (user preference for this workspace).
- Delivery strategy: `ask-on-risk`. Forecast: about 450 to 600 authored changed lines.

## Tasks

- [x] T1 Dodge geometry and rect glide. Pure function choosing the dodged rect (direction,
  viability, fallback) plus a `MiniGlider` rect glide that leaves the saved position
  alone and can return to it. Tests in `tests/mini-position.contract.test.mjs`.
  Route: delegated (writer trigger: multiple non-trivial files).
- [x] T2 Cursor query. Public async cursor query on `FullscreenWatch` (`j/cursorpos`),
  monitor origin parsed from `j/monitors`. Fake Hyprland answers `j/cursorpos` in
  `tests/fullscreen.contract.test.mjs`. Route: delegated (same writer).
- [x] T3 Wiring, logs and docs. Mini-only poll timer in `src/main.cpp` gated by mode,
  attachment and close; dodge/return state with return delay; cycle-position cancels the
  dodge; `CIELINUX_MINI` dodge log lines; README mini mode, Hyprland watch and log
  reference. Route: delegated (same writer).

## Acceptance criteria

- Unit tests prove the four directions, edge fallback, no-viable-side, and that the saved
  position is untouched.
- Harness test proves a cursor near the mini triggers a glide aside and a later far
  cursor glides it back, with no jumps and no blocking.
- `node --test tests/*.test.mjs` passes.

## Checks

- `node --test tests/mini-position.contract.test.mjs tests/fullscreen.contract.test.mjs`
- `node --test tests/*.test.mjs`

## Progress

- Exploration done (glide, Hyprland watch, mode hook, test harness patterns).
- T1 done (no commit by user preference). New `src/mini-dodge.{h,cpp}` (`MiniDodge::choose`,
  `zone`, constants approach 24 / gap 8 / return 400 ms / poll 100 ms), `MiniGlider::glideToRect`
  + `aside()`; `glideTo(position())` glides back from a dodge frame. Evidence:
  RED `node --test tests/mini-position.contract.test.mjs` failed (cmake: cannot find
  src/mini-dodge.cpp); GREEN after implementation: 2 pass, 0 fail.
- T2 done (no commit by user preference). `FullscreenWatch::queryCursor` (async, quiet, false when
  not connected or no origin), `origin()` cached from `j/monitors` x/y, `HyprlandIpc::monitorOrigin`
  and `cursorPosition`. Evidence: RED `node --test --test-name-pattern="cursor query"
  tests/fullscreen.contract.test.mjs` failed (harness: no member `queryCursor`); GREEN 2 pass;
  `node --test tests/mini-position.contract.test.mjs tests/fullscreen.contract.test.mjs`: 24 pass, 0 fail.
- T3 done (no commit by user preference). `MiniDodger` (in `src/mini-dodge.*`: 100 ms poll, one
  request at a time, dodge on approach, return after 400 ms away, re-dodge when followed, epoch
  drops stale answers) wired in `src/main.cpp` (enabled only while not closed and in
  `scene-mini`; started after the mini `attach`, stopped before every `detach`; cycle-position
  calls `cancel()` before its glide; logs `CIELINUX_MINI dodge direction=...` / `dodge return`).
  README: Hover dodge section, Hyprland watch polling exception, log rows, test count 354.
  Evidence: RED `MiniDodger` not declared (mini-position harness), RED main.cpp shape test
  (no `MiniDodger miniDodger(`), then README regex RED; GREEN after wiring + docs. The fake
  Hyprland end-to-end test (`mini dodge: a near cursor ...`) passed on first run since the logic
  had landed with the unit tests.
- Checks: `node --test tests/mini-position.contract.test.mjs tests/fullscreen.contract.test.mjs`:
  26 pass, 0 fail. `node --test tests/*.test.mjs`: 354 tests, first run 353 pass / 1 fail
  (`server: limits (header size, request timeout, connection cap) and malformed framing`,
  tests/http.contract.test.mjs, timed out; unrelated), rerun 354 pass / 0 fail.
  `cmake --build build -j`: built target cielinux, no warnings.
- Next: user review; merge into `integration` when approved.
