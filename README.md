# CieLinux

Animated HTML scenes for the Linux desktop. CieLinux is the Linux counterpart of
CielWin (Windows): it shows one animated scene (`processing`, `explorer`, `idle` or
`raphael`) on one output, in one of two modes. Only one mode runs at a time; the tray
switches between them live.

| Mode | `wallpaper-mode` | What you see |
| --- | --- | --- |
| Mini (default) | `scene-mini` | A 240 px always-on-top overlay at one of eight positions, see-through by brightness. |
| Wallpaper | `scene` | The full-size scene as the desktop wallpaper on the bottom layer, paused under fullscreen windows. |

Choose **Frame rate ▸ 30 FPS or 60 FPS** in the tray. One persisted global cap
(default: **30 FPS**) follows every scene and both modes. See [Frame rate](#frame-rate).
Alerts (`POST /v1/alerts`) and alert sounds work the same way in both modes.

The host is a small Qt 6 / QtWebEngine program. It draws the scene page into a
layer-shell surface and ignores all input (clicks go through to the windows below).
CieLinux uses a single output by design: the one named by `--output`, else the primary
output. Multi-monitor is out of scope.

## Requirements

- A Wayland compositor with `zwlr_layer_shell_v1` (Hyprland, Sway and other
  wlroots compositors). X11 and GNOME are not supported.
- Hyprland for the Hyprland-specific parts: fullscreen detection (wallpaper pause),
  reserved-zone reads (mini glide, wallpaper alert layout) and the `SUPER+Z` binds.
  `install.sh` supports both the Lua config (Hyprland 0.56+, `hyprland.lua`) and the
  hyprlang config. On other compositors these parts degrade as described below.
- Qt 6 with Core, Gui, Widgets, DBus, Network, Multimedia, Quick, Qml, WebEngineQuick and
  ShaderTools. The tray icon is read by the ICO image plugin that ships with `qt6-base`.
  Alert sounds play through `qt6-multimedia` with its FFmpeg backend
  (`qt6-multimedia-ffmpeg`) on PipeWire.
- LayerShellQt (Qt 6), `wayland-client`, CMake 3.24 or newer, a C++17 compiler.
- A StatusNotifierItem tray host for the tray icon (Waybar's `tray` module, the Omarchy
  shell or another SNI host). Optional: CieLinux runs without one.
- Node.js 20 or newer, only to run the tests.

No external helper (such as `socat` or `hyprctl`) is needed: CieLinux talks to
Hyprland's IPC sockets directly.

On Arch Linux:

```sh
sudo pacman -S --needed cmake base-devel qt6-base qt6-declarative qt6-webengine \
    qt6-shadertools qt6-multimedia qt6-multimedia-ffmpeg layer-shell-qt wayland nodejs
```

## Build and install

```sh
./install.sh            # build into ./build and install to ~/.local
./install.sh --enable   # same, then enable and start the user service
```

`install.sh` installs:

| File | Purpose |
| --- | --- |
| `~/.local/bin/cielinux` | The host. The scenes are embedded in the binary. |
| `~/.config/systemd/user/cielinux.service` | User unit that runs `cielinux --resident` with your graphical session. |
| Hyprland binds block | `SUPER+Z` / `SUPER+SHIFT+Z` cycle the mini position (see [Hyprland binds](#hyprland-binds)). |

| Option | Default | Effect |
| --- | --- | --- |
| `--prefix DIR` | `~/.local` | Install prefix. |
| `--build-dir DIR` | `./build` | CMake build directory. |
| `--enable` | off | Enable and start `cielinux.service`. |
| `--no-hypr-binds` | off | Do not touch the Hyprland config. |

Without `--enable` nothing is started; run
`systemctl --user enable --now cielinux.service` when you are ready.

### Systemd unit and autostart

The unit runs `cielinux --resident`, is bound to `graphical-session.target` and is wanted
by it, so an enabled unit starts with every graphical session. Your session must import
`WAYLAND_DISPLAY` into the systemd user manager (uwsm and most Hyprland setups already
do). The host recovers renderer crashes itself (3 per rolling hour). Any exit is
restarted, including the clean exit taken when the selected output disappears (monitor
unplugged or powered off): first after 5 s, backing off up to every 5 min while the
output is still missing. `systemctl --user stop cielinux` is never restarted.

### Uninstall

`./uninstall.sh` removes the binary, the unit and the Hyprland binds block. Add
`--purge` to also delete settings and data; `--prefix DIR` matches a custom install.

### Build by hand

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
```

## Usage

```sh
cielinux --resident                    # run until stopped (what the service does)
cielinux --scene idle --duration 120   # preview a scene for 120 seconds
cielinux --cycle-position next         # move the running mini to its next position
```

| Flag | Values | Default |
| --- | --- | --- |
| `--scene` | `processing`, `explorer`, `idle`, `raphael` | `scene` in settings.conf |
| `--mode` | `scene-mini`, `scene` (wallpaper) | `wallpaper-mode` in settings.conf |
| `--output` | output name, e.g. `DP-1` | primary output |
| `--resident` | run until SIGTERM/SIGINT | off |
| `--duration` | `15` or `120` seconds (not with `--resident`) | `15` |
| `--cycle-position` | `next`, `prev` (client mode, see [Control socket](#control-socket-and-single-instance)) | none |

- Flags win over the settings file, but only for what is shown at start. settings.conf
  changes when the scene or mode is switched (tray or HTTP), once the new page is ready:
  `--scene idle` followed by a tray switch to Processing leaves `scene = processing`.
- Unknown, repeated or malformed flags exit with status 2.
- For safety the host refuses to start when `QTWEBENGINE_CHROMIUM_FLAGS`,
  `QTWEBENGINE_DISABLE_SANDBOX` or `QTWEBENGINE_REMOTE_DEBUGGING` is set.

Every log line (`CIELINUX_*` diagnostics and Qt messages alike) goes to stderr, in order:
the host sets `QT_FORCE_STDERR_LOGGING=1` unless you set it yourself, because a
journald-enabled Qt would otherwise send its messages straight to the journal when there
is no terminal. Under the user unit that stream lands in the journal
(`journalctl --user -u cielinux`). See [Log reference](#log-reference).

## Frame rate

Open the tray's **Frame rate ▸** submenu and choose **30 FPS** or **60 FPS**.
The checked item follows the host's current target, including refused clicks and
tray-host restarts. Re-selecting the current rate does nothing.

- `frame-rate = 30` is the default; `60` is the only other accepted value.
- This is one global preference, not a per-scene or per-mode setting. Scene and
  wallpaper/mini switches keep it; no HTTP route or CLI flag changes it.
- Changing the rate rebuilds the page and may reset its animation. Active alerts
  continue for their remaining duration without another sound, and fullscreen
  wallpaper pause is preserved.
- The selected rate is saved only after the replacement page confirms readiness.
  An unreadable settings file is never overwritten. FPS is a cap, not a guarantee
  of display cadence: scene cost, compositor refresh and load still matter.

## Mini mode

The mini window is 240 px square, drawn at the global frame-rate cap on the layer-shell top layer. It is
see-through by brightness (a luminance key makes black transparent), so only the scene
shows over your desktop. It is never covered by other windows and never pauses.

### Positions

The window sits at one of eight positions of the output, in CielWin's order:
`top-left`, `top-center`, `top-right` (default), `right-center`, `bottom-right`,
`bottom-center`, `bottom-left`, `left-center`. It is 16 px from the edges it touches
and kept clear of bars: at rest it is anchored to its position's edges, so the
compositor places it inside the area left by other surfaces' exclusive zones (Waybar).
The position is saved to `mini-position` in settings.conf on every move.

| Keys (Hyprland) | Command | Moves |
| --- | --- | --- |
| `SUPER+Z` | `cielinux --cycle-position next` | clockwise (CielWin Alt+M) |
| `SUPER+SHIFT+Z` | `cielinux --cycle-position prev` | counter-clockwise (CielWin Alt+Shift+M) |

- **Glide:** each move glides there in 220 ms (ease-out cubic, as in CielWin) by
  animating the layer-shell margins, and always lands exactly where the compositor
  puts that position.
- **No blocking:** the glide path uses Hyprland's reserved zones (bars) cached by the
  [Hyprland watch](#hyprland-watch), so a move never waits on Hyprland. Until the
  first answer, and on other compositors, the glide uses the whole output: the move
  still lands exactly but may start or end with a small jump.
- **Ignored moves:** a move outside the mini mode or while its window is being rebuilt
  is ignored and logged.
- There is no tray item for positions (CielWin has none).

### Hyprland binds

`install.sh` appends the two binds to your Hyprland config in one marked block:

| Config flavour | Detected by | Where the block goes |
| --- | --- | --- |
| Lua (Hyprland 0.56+) | `~/.config/hypr/hyprland.lua` exists | `~/.config/hypr/bindings.lua` (Omarchy's `require("hypr.bindings")`), between `-- >>> cielinux mini position binds … >>>` and `-- <<< cielinux mini position binds <<<`, as `o.bind("SUPER + Z", …)` |
| hyprlang | no `hyprland.lua` | `~/.config/hypr/bindings.conf` when it exists (Omarchy), otherwise `hyprland.conf`, between `# >>> cielinux mini position binds … >>>` and `# <<< cielinux mini position binds <<<`, as `bindd = SUPER, Z, …` lines |

- With a Lua config, `bindings.lua` is created only when `hyprland.lua` requires
  `hypr.bindings`; otherwise the binds are skipped with a message. An older hyprlang
  block in `bindings.conf` (which a Lua config does not load) is removed.
- Running `install.sh` again refreshes the block instead of adding a second one;
  `--no-hypr-binds` skips it. `uninstall.sh` removes exactly that block from
  `bindings.lua`, `bindings.conf` and `hyprland.conf`.
- Hyprland reloads its config on save. The binds are on by default because they are
  the only way to move the mini; nothing else in your config is changed.

### Control socket and single instance

`cielinux --cycle-position next|prev` never starts a second CieLinux. It sends one line
to the running instance over a Unix socket and exits:

| Exit status | Meaning |
| --- | --- |
| `0` | The instance took the command (a refusal such as `ignored: not in mini mode` is printed on stderr). |
| `1` | No instance answers (`no running CieLinux instance`). |
| `2` | Any argument other than `next` or `prev`. |

The socket is `$XDG_RUNTIME_DIR/cielinux/control.sock`:

- The directory is created mode `0700`; an existing one owned by you is tightened to
  `0700`, and a symlink or a directory owned by someone else is refused.
- The socket is owner-only, and both ends check the other process's uid.
- The same directory holds `instance.lock`. A normal start takes it (like CielWin's
  single-instance guard), so a second start while one runs prints
  `CieLinux is already running for this user (…)` and exits with status `3`. The kernel
  drops the lock when the process dies, so a crash never blocks the next start.
- Without `XDG_RUNTIME_DIR` CieLinux runs without the socket and the guard and logs
  `CIELINUX_IPC unavailable`.

## Wallpaper mode

`wallpaper-mode = scene` (or `--mode scene`, or **Scene Mode ▸ Scene Wallpaper** in
the tray) shows the scene as the desktop wallpaper:

- The full-size page (no mini variant) at the global frame-rate cap on the layer-shell **bottom**
  layer of the selected output, anchored to every edge with exclusive zone -1, so it
  also extends under bars.
- Opaque, ignores input, and has none of the mini's parts (no luminance key, no
  occlusion disc, no position; `SUPER+Z` is ignored).
- It keeps the full look: the mini's CPU savings that leave out or resample something
  (unused sprites, the lighting mask, spark culling and the spark atlas, baked glyph
  rings and hexadecagon glow, rounded alphas, merged band fills) stay in the mini. The
  ones that draw the same thing run in both: cached gradients, static layers for
  screen-fixed art, reused typed arrays and scratch objects, and precomputed tables.

### Live mode switch

The switch between the wallpaper and the mini is live: the current surface is replaced
by the other one in the same process, without counting against the renderer recovery
budget, and `wallpaper-mode` is saved once the new page is ready. An alert on screen
during a switch continues on the other surface for the rest of its duration, without a
second sound. The default stays `scene-mini` (CielWin defaults to `scene`).

### Pause under fullscreen windows

While a fullscreen window covers the wallpaper's output, the scene pauses: the page
stops drawing altogether and, when uncovered, continues at the current time (no
catch-up).

- Only true fullscreen counts. A maximised window (Hyprland's `fullscreen 1`, bars
  still visible) does not, as in CielWin.
- The window must be on a workspace that output shows: its active workspace, or an open
  special workspace.
- A fullscreen window already open at startup is found at once.
- Coverage is tracked only in the wallpaper. The mini sits above other windows and is
  never covered or paused.

### Alerts in the wallpaper

Alerts show in the wallpaper as they do in the mini (same mosaic, shake, pixelate,
sound, mute; see [Alerts](#alerts)), with two differences:

- **Layout:** the mosaic is laid out in the output's free work area (the area left by
  bars, from Hyprland's reserved zones cached by the watch), so showing an alert never
  waits on Hyprland. Until the first answer, and on other compositors, the whole output
  is used.
- **Held while covered:** an alert sent while the wallpaper is covered waits silently
  and starts, with its sound, when the wallpaper is uncovered, within the alert's
  5-minute maximum age. An alert already showing when a fullscreen window appears keeps
  its timing and ends on time. A [held warning](#held-warning) waits the same way, but
  its hold max still counts from the request, so a long fullscreen session never brings
  back a stale question.

### Hyprland watch

Coverage and reserved zones come from Hyprland's IPC, event driven (never polled):

1. The event socket
   (`$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock`) says when
   something changed (fullscreen, workspace, monitor focus, a window opening, closing
   or moving, a layer surface such as Waybar opening or closing, a config reload).
2. One query over the request socket (`j/monitors`, plus `j/clients` in the wallpaper)
   then says whether a fullscreen window covers the output, and refreshes the cached
   reserved zones. One query also runs at every (re)connect.

The watch runs in both modes. In the mini, coverage is off: no `j/clients` queries, and
only bar, config and monitor events refresh the reserved zones.

| Situation | Behaviour |
| --- | --- |
| No Hyprland at start, or its socket unreachable | Logged once; the wallpaper counts as visible and never pauses. Retried as below until Hyprland shows up. |
| Hyprland exits or restarts | Logged once; the wallpaper counts as visible meanwhile. Retried after 1 s, doubling up to every 30 s, silently. Each try uses the instance named by `HYPRLAND_INSTANCE_SIGNATURE` if it is still there, else the newest instance under `$XDG_RUNTIME_DIR/hypr/` that accepts a connection (a restarted Hyprland has a new signature). On reconnect, coverage is asked for at once. |
| A query gets no readable answer within 1 s | Logged once per failure streak and counts as visible, as in CielWin. Retried after 250 ms, doubling up to every 4 s, silently, until one succeeds. Only time CieLinux's event loop was actually running counts toward the 1 s, so a busy GUI thread is not blamed on Hyprland. |

## Tray

CieLinux puts an icon (tooltip `CieLinux`) in the system tray through the
StatusNotifierItem D-Bus protocol, so Waybar's `tray` module and other SNI hosts show
it. The icon is CielWin's: the Raphael scene's mini figure (`assets/raphael-mini.ico`,
identical to CielWin's file), with frames drawn for 16, 20, 24, 32 and 48 px; the small
frames keep CielWin's contrast pass (deeper gold, a thin dark outline). Right-click (or
your host's menu gesture) opens the menu:

| Item | Action |
| --- | --- |
| **Scene Mode ▸** Scene Wallpaper, Scene Mini | Switches the mode live (see [Live mode switch](#live-mode-switch)); the current one is checked. Saved to `wallpaper-mode` once the new page is ready. |
| **Scene ▸** Processing, Explorer, Idle, Raphael | Switches the scene live; the current one is checked. Saved to `scene` once the new page is ready. |
| **Frame rate ▸** 30 FPS, 60 FPS | One global cap for all scenes and modes (default 30); saved to `frame-rate` once the new page is ready. Rebuilds the page. |
| **Import failed sound…** / **Import warning sound…** | Picks a sound file for that alert kind (see [Sounds](#sounds)). |
| **Remove failed sound** / **Remove warning sound** | Deletes that kind's sound; shown only while it has one. |
| **Alert sounds** | Mute toggle, checked while sounds are on; shown only while either kind has a sound. Saved to `alert-sounds`. |
| **Exit** | Closes CieLinux cleanly (the user service, if enabled, stays stopped until next login or `systemctl --user start cielinux`). |

- The checks are re-read every time the menu opens, so a scene changed some other way
  is shown correctly. Clicking the icon itself does nothing (as in CielWin).
- The tray host (whatever owns `org.kde.StatusNotifierWatcher`; on Omarchy, the shell)
  may start after CieLinux or restart while it runs: CieLinux watches for it on the
  session bus and puts the icon back when it appears, with the menu as it was.
- Without a D-Bus session bus, CieLinux keeps running without a tray.

## HTTP

CieLinux serves a small local HTTP API, the same one CielWin serves, so existing callers
keep working.

| Item | Value |
| --- | --- |
| Address | loopback only: `127.0.0.1`, plus `::1` when available |
| Port | `43811` (`http-server-port`) |
| Switch | `http-server = off` turns it off |
| Busy port | logged once; CieLinux keeps running without HTTP |
| Token | `$XDG_STATE_HOME/cielinux/http.token` (usually `~/.local/state/cielinux/http.token`) |

Every request needs the bearer token. It is created on first start (43 random base64url
characters; directory `0700`, file `0600`) and then kept unchanged, so callers can cache
it. A malformed file is replaced with a fresh token. The token is never logged.

```sh
TOKEN=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/cielinux/http.token")

# Switch the scene: processing, explorer, idle or raphael (case-insensitive).
curl -i -X POST http://127.0.0.1:43811/v1/wallpaper/scene \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"scene":"idle"}'
# -> 202 ok

# Show an alert (see Alerts below).
curl -i -X POST http://127.0.0.1:43811/v1/alerts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"failed":1,"warning":2,"duration":8}'
# -> 202 ok id=1

# Hold a warning until it is cleared (see Held warning below), then clear it.
curl -i -X POST http://127.0.0.1:43811/v1/alerts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"warning":1,"duration":0}'
# -> 202 ok id=2
curl -i -X POST http://127.0.0.1:43811/v1/alerts/clear \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":2}'
# -> 202 ok
```

| Route | Body (max) | Success |
| --- | --- | --- |
| `POST /v1/wallpaper/scene` | `{"scene":"<name>"}` (256 bytes) | `202 ok` |
| `POST /v1/alerts` | alert counters (1024 bytes) | `202 ok id=<n>`, or `202 ok` when ignored |
| `POST /v1/alerts/clear` | `{}` or `{"id":<n>}` (64 bytes) | `202 ok` |

Replies are plain text: `ok`, `ok id=<n>` (an accepted alert) or `error: <reason>`.
Checks run in this order and the first failure answers:

1. Loopback peer (403).
2. No `Origin` header (403).
3. `Host` is `127.0.0.1:<port>` or `localhost:<port>` (403).
4. Known route (404).
5. `POST` (405, `Allow: POST`).
6. Bearer token (401, `WWW-Authenticate: Bearer`).
7. `Content-Type: application/json` (415).
8. Body size (413).
9. UTF-8 (400).
10. Body validation (400).

A scene switch the host refuses answers 503. The scene route switches the scene only:
any other field (such as `mode`) is rejected with `error: unknown field '<name>'`.
Limits: 8 KiB of request head (431), 2 seconds per request (408), 8 connections at once.

## Alerts

`POST /v1/alerts` shows a CielWin alert inside the current scene, in either mode: a red
**FAILED** and/or amber **WARNING** mosaic drawn into the scene's own canvas, with the
scene's animation showing through the letters. Body (every field optional, at most 1024
bytes):

```json
{ "failed": 1, "warning": 2, "duration": 8 }
```

| Field | Meaning | Range |
| --- | --- | --- |
| `failed` | number of FAILED tiles | whole number 1–16 |
| `warning` | number of WARNING tiles | whole number 1–16 |
| `duration` | seconds on screen; `0` holds a warning until cleared | whole number 1–60, default 5; `0` with `warning` only |

- At least one of `failed`/`warning` is required, and together they may ask for at most
  16 tiles.
- At most 8 tiles are shown, every failed tile first (failed always wins past the cap),
  on this grid: 1 tile 1×1, 2 → 2×1, 3–4 → 2×2, 5–6 → 3×2, 7–8 → 4×2.
- A failed alert briefly shakes the scene and pixelates it behind the overlay; a
  warning does neither.
- In the mini, the alert keeps the CielWin wash, frame and modules, and draws the
  letters in their CielWin hue at full brightness so they stay readable through the
  luminance key (dark colors fade out there).

Replies: `202 ok id=<n>` when accepted, `n` a whole number that grows with every
accepted alert of this CieLinux run; `400 error: <reason>` for a bad body, naming the
field or token (`error: unknown field 'info'`, `error: field 'warning' must be a whole
number`, `error: 'warning:0' must be 1..16`, `error: at least one 'warning:N' or
'failed:N' group is required`, `error: 'duration:0' requires warning only`). Callers
that only read the status code are unaffected by the id; a caller that compared the body
to exactly `ok` should check that it starts with `ok`.

Only one alert exists at a time. A request that arrives while one is showing (or still
waiting to show) is ignored, yet still answered `202 ok`, without an id, since there is
nothing to clear. An alert that cannot start within 5 minutes is dropped. In the
wallpaper, alerts wait while a fullscreen window covers it (see
[Alerts in the wallpaper](#alerts-in-the-wallpaper)). The exceptions are held warnings,
below.

### Held warning

`{"warning": n, "duration": 0}` shows a warning that stays up until it is cleared, for
example while a program waits for your answer. `duration: 0` is accepted only with
`warning` alone: a failure has nothing to wait for.

- **Clearing:** `POST /v1/alerts/clear` with `{"id": n}` clears that alert (held or
  timed) if it is still showing, suspended or waiting; `{}` clears the held alert
  whatever its id, and never a timed one. The reply is always `202 ok`, whether or not
  something was cleared. The route runs the same checks as the others; its body is at
  most 64 bytes and holds only the optional `id` (a whole number of at least 1).
- **Safety max:** a held warning ends by itself `alert-hold-max-seconds` (default 600)
  after it was requested, not after it was first shown, so a crashed caller never leaves
  it up forever. A held warning still waiting to start is dropped by that deadline or
  the 5-minute start limit, whichever comes first.
- **Failed preempts held:** a request with any failed tile while a held warning shows
  (or waits) is shown at once for its own duration, with its sound and shake. The held
  warning is suspended and comes back when the failed alert ends, for the rest of its
  hold, under the same id and without playing its sound again, however many times it is
  preempted. One preempted before it ever showed plays its sound when it first shows. If
  it is cleared or its hold max passes meanwhile, it does not come back.
- **Repeating sound:** while a held warning shows, its warning sound (when alert sounds
  are on and a warning sound is set) plays again every 5 seconds until it is cleared or
  its hold max passes. It does not repeat while suspended, waiting or covered by a
  fullscreen window; once it shows again, the next repeat comes 5 seconds later.
- **Other requests:** a warning while a held warning shows is ignored as usual. A held
  warning sent while a timed alert shows waits for it and starts when it ends (within
  the 5-minute start limit).
- **One at a time:** at most one held warning exists. A held warning sent while another
  one shows, waits or is suspended is ignored (plain `202 ok`, no id), so a later failed
  request never displaces the suspended one. The ignored request is dropped, not
  queued: it never shows, even after the first one is cleared. A client that sees
  `202 ok` without an id knows its warning was not taken and has nothing to clear;
  it can send it again once the first one is gone.

### Writing a client

What a caller (a plugin, a script, CielWin's own callers) needs beyond the routes above.
The [Claude Code plugin](#claude-code-integration) follows these rules and is a working
reference.

- **Token:** read the token file and cache it. On a `401`, read the file again and
  retry once: CieLinux replaces a malformed file with a fresh token.
- **Replies:** treat any `202` as success and read the body only for the id. Check that
  it starts with `ok`, never that it equals `ok`.
- **Scenes:** CieLinux keeps the last scene it was sent. A caller that sets a scene for
  some activity should send the scene it wants afterwards (usually `idle`) when that
  activity ends.
- **Held warning flow:**
  1. Send `{"warning": 1, "duration": 0}` when your program starts waiting for the user.
  2. `202 ok id=<n>`: the warning is shown (or waiting to show). Keep `n`.
  3. `202 ok` without an id: another alert was showing, so yours was ignored. Nothing is
     on screen for you and there is nothing to clear.
  4. `400`: the server has no held warnings (CielWin today, or an older CieLinux). Fall
     back to a timed warning, such as `{"warning": 1, "duration": 8}`.
  5. When the wait ends (answered, cancelled, or your program exits), send
     `POST /v1/alerts/clear` with `{"id": n}`. Prefer the id over `{}`: `{}` clears
     whatever held warning is up, including one from another caller.
- **Crashes:** a caller that dies without clearing is covered by
  `alert-hold-max-seconds`. Do not rely on it for normal flow.
- **Failures while holding:** a failed alert can be sent while your held warning is up.
  It shows at once, and your warning comes back after it under the same id, so the id
  stays valid for the clear.

## Claude Code integration

[`integrations/claude-code/`](integrations/claude-code/README.md) holds `cielinux-scenes`,
a Claude Code plugin that drives the scene and alerts from Claude Code activity over the
HTTP API: `raphael` while Claude thinks or plans, `processing` while it edits or runs
commands, `explorer` while it reads or searches, `idle` once the session goes quiet, a
warning when Claude asks you something (optionally held until you answer) and a failed
alert when Bash fails. It reads the bearer token from the token file above. Its README
covers how it works, install, configuration and uninstall.

## pi integration

[`integrations/pi/`](integrations/pi/README.md) holds the same `cielinux-scenes` behavior
as a [pi](https://github.com/earendil-works/pi) coding-agent extension (for pi as launched
by `gentle-shell`, or plain pi): scenes from the turn, tool calls and `subagent_run`
subagents, a warning while a pi dialog waits for you (optionally held until it closes)
and a failed alert when `bash` fails. Its README covers install, configuration and
uninstall.

## Sounds

No sound ships with CieLinux: each alert kind is silent until you import one from the
tray.

- **Import:** **Import failed sound…** / **Import warning sound…** open a file dialog
  filtered to `.wav`, `.mp3` and `.m4a`. The file is copied to
  `$XDG_DATA_HOME/cielinux/sounds/` (usually `~/.local/share/cielinux/sounds/`) as
  `failed.<ext>` or `warning.<ext>`, replacing that kind's previous sound whatever its
  extension, so moving or deleting the original later changes nothing.
- **Stored name:** the copy's bare file name is saved to `failed-sound` /
  `warning-sound`. A value with a folder in it is ignored, so only files in the sounds
  folder ever play (symlinks there are not followed).
- **Remove:** **Remove …** deletes the copy and clears the key.
- **Mute:** **Alert sounds** (`alert-sounds = on|off`) is the mute toggle.

A newly shown alert plays its sound once, in either mode: the failed sound when it has
any failed tile, otherwise the warning sound (no fallback to the other kind). A re-show
of the same alert (for example after a mode switch) never plays again, and an alert
shown while muted stays silent even if you unmute. A held warning is the one exception:
it repeats every 5 seconds while it shows (see Held warning). Playback uses QtMultimedia on the
default output (PipeWire). A missing or undecodable file is logged and the alert itself
always goes on. Log lines never include paths.

## Settings

`$XDG_CONFIG_HOME/cielinux/settings.conf` (usually `~/.config/cielinux/settings.conf`)
uses CielWin's `key = value` format and key names, so one file reads the same on both
apps. It is created with commented defaults on first start.

- Blank lines and `#` comments are ignored; an unknown key or unrecognised value only
  costs that setting (the default stays). The last recognised assignment of a key wins.
- `on|off` flags also accept `true|false` and `1|0`.
- Saves are atomic, and a file that cannot be read is never overwritten.

| Key | Values | Default | Changed by |
| --- | --- | --- | --- |
| `wallpaper-mode` | `scene-mini`, `scene` | `scene-mini` | tray **Scene Mode ▸** (live) |
| `scene` | `processing`, `explorer`, `idle`, `raphael` | `processing` | tray **Scene ▸**, `POST /v1/wallpaper/scene` |
| `frame-rate` | `30`, `60` (global FPS cap) | `30` | tray **Frame rate ▸** |
| `mini-position` | `top-left`, `top-center`, `top-right`, `right-center`, `bottom-right`, `bottom-center`, `bottom-left`, `left-center` | `top-right` | `SUPER+Z` / `SUPER+SHIFT+Z` |
| `http-server` | `on`, `off` | `on` | hand edit (read at start) |
| `http-server-port` | 1–65535 | `43811` | hand edit (read at start) |
| `alert-sounds` | `on`, `off` | `on` | tray **Alert sounds** |
| `failed-sound`, `warning-sound` | bare file name of a `.wav`, `.mp3` or `.m4a` | empty (silent) | tray **Import … sound…** / **Remove … sound**; an unusable value clears the sound |
| `alert-hold-max-seconds` | 10–3600 (CieLinux only) | `600` | hand edit (read at start); the [held warning](#held-warning) safety max |

Legacy CielWin spellings are still read, and the new key wins whatever the line order:
`wallpaper-mode = html|html-mini|mini`, `wallpaper-scene`, `mini-corner`, `alert-http`,
`alert-http-port`. Only the new names are ever written.

## Log reference

All lines go to stderr (the journal under the user unit). `<name>` is the output name,
for example `HDMI-A-2`. This section lists every line CieLinux emits:

- [Event lines](#event-lines): what the host is doing, one line per change.
- [Startup and client messages](#startup-and-client-messages): plain-text reasons for an
  exit at start, and the replies printed by `--cycle-position`.
- [Diagnostics markers](#diagnostics-markers): machine-readable records that appear in
  every normal journal. They are not errors.
- [Lines from Qt and FFmpeg](#lines-from-qt-and-ffmpeg) and
  [Filtering the journal](#filtering-the-journal).

### Event lines

| Line | When |
| --- | --- |
| `Output "<name>" DPR <ratio>` | Start: the selected output and its device pixel ratio. |
| `CIELINUX_MODE switched mode=scene-mini\|scene` | A live mode switch happened. |
| `CIELINUX_MINI position=<position>` | The mini moved; the new position is saved. |
| `CIELINUX_MINI position ignored reason=not-mini-mode\|window-not-ready` | A move arrived outside the mini, or while its window is rebuilt. |
| `CIELINUX_MINI settings save-failed` | The new position could not be saved. |
| `CIELINUX_IPC listening` | The control socket is up. |
| `CIELINUX_IPC unavailable: <reason>` | No control socket and no single-instance guard (for example, no `XDG_RUNTIME_DIR`). |
| `CIELINUX_IPC rejected peer-uid=<uid>\|busy\|extra-data\|unknown-command` | A control connection was refused. |
| `CIELINUX_HYPRLAND fullscreen-watch started monitor=<name>` | Connected to Hyprland at start. |
| `CIELINUX_HYPRLAND fullscreen-watch unavailable reason=no-hyprland-socket\|connect-failed` | No Hyprland reachable (once per outage). |
| `CIELINUX_HYPRLAND fullscreen-watch lost` | The Hyprland event socket dropped (Hyprland exited or restarted). |
| `CIELINUX_HYPRLAND fullscreen-watch reconnected monitor=<name>` | Connected again after an outage. |
| `CIELINUX_HYPRLAND fullscreen-watch coverage on monitor=<name>` | Coverage tracking turned on for the wallpaper. Scene/rate changes within the same mode do not toggle coverage. |
| `CIELINUX_HYPRLAND fullscreen-watch coverage off monitor=<name>` | Coverage tracking turned off for the mini. Starting in the mini logs this before `started`. |
| `CIELINUX_HYPRLAND fullscreen-watch query-failed` | First failed query of a streak. |
| `CIELINUX_HYPRLAND fullscreen-watch query-recovered` | A query succeeded after a failure streak. |
| `CIELINUX_WALLPAPER covered monitor=<name>` / `uncovered monitor=<name>` | A fullscreen window started or stopped covering the wallpaper's output. |
| `CIELINUX_WALLPAPER paused reason=fullscreen` / `resumed` | The wallpaper scene stopped or resumed drawing. |
| `CIELINUX_ALERT shown kind=failed\|warning` | A new alert is on screen (failed wins); its sound plays from here. |
| `CIELINUX_ALERT alert ignored: one is already showing` / `… already waiting to show` | A request arrived while the single alert slot was taken. |
| `CIELINUX_ALERT alert dropped: waited longer than the <age> max age without starting` | A held alert expired. |
| `CIELINUX_ALERT alert dropped: held past the <max> hold max` | A held warning that was waiting or suspended reached `alert-hold-max-seconds`. |
| `CIELINUX_ALERT alert <n> suspended: a failed alert preempts it` | A failed alert took the place of held warning `<n>`; it resumes afterwards. |
| `CIELINUX_ALERT alert ignored: a held warning is already suspended` | A held warning was requested while another one was suspended; only one exists at a time. |
| `CIELINUX_ALERT alert <n> cleared` | `POST /v1/alerts/clear` removed alert `<n>`. |
| `CIELINUX_ALERT alert rejected: <error>` | An alert command could not be parsed. |
| `CIELINUX_ALERT page-done gen=<n>` | The scene page reports the alert finished. |
| `CIELINUX_ALERT alert hide-failed` | Taking the previous alert off the surface threw; it is not retried. |
| `CIELINUX_ALERT alert start-failed` | Handing the alert to the surface threw; the next 400 ms tick retries. |
| `CIELINUX_ALERT alert workarea-failed` | The wallpaper's work area could not be read; the alert uses the whole output. |
| `CIELINUX_SOUND alert sound-played kind=<kind>` | A sound started. |
| `CIELINUX_SOUND alert sound-muted kind=<kind>` | Muted; no sound played. |
| `CIELINUX_SOUND alert sound-skipped kind=<kind> reason=missing-file` | The sound file is gone. |
| `CIELINUX_SOUND alert sound-failed kind=<kind> reason=media-failed error=<e>\|no-output\|exception` | The sound could not play. |
| `CIELINUX_SOUND alert-sound imported\|removed kind=<kind>` | A tray import or removal succeeded. |
| `CIELINUX_SOUND alert-sound import-rejected kind=<kind> reason=unsupported-format` | The picked file is not `.wav`, `.mp3` or `.m4a`. |
| `CIELINUX_SOUND alert-sound pick-failed kind=<kind>` | The file dialog failed. |
| `CIELINUX_SOUND alert-sound import-failed kind=<kind> reason=not-a-file\|folder-unavailable\|copy-failed\|replace-failed` | The import failed; any previous sound of that kind is kept. |
| `CIELINUX_SOUND alert-sound remove-failed kind=<kind> reason=delete-failed` | A sound file could not be deleted. |
| `CIELINUX_SOUND alert-sounds toggled enabled=on\|off` | The mute toggle changed. |
| `CIELINUX_SOUND settings save-failed` | A sound setting could not be saved. |
| `CIELINUX_TRAY available` | A tray host was already up at start. |
| `CIELINUX_TRAY unavailable: <reason>` | No tray host yet, it went away, or there is no D-Bus session bus. |
| `CIELINUX_TRAY recreated` | The icon is back after the host returned. |
| `CIELINUX_TRAY click-failed item=<item>` | A menu action threw. `<item>` is `mode`, `scene`, `frame-rate`, `import-failed-sound`, `import-warning-sound`, `remove-failed-sound`, `remove-warning-sound`, `alert-sounds` or `exit`. |
| `CIELINUX_HTTP listening port=<port>` | The HTTP server is up. |
| `CIELINUX_HTTP ::1 unavailable (<error>); serving 127.0.0.1 only` | IPv6 loopback could not be bound; IPv4 loopback still serves. Logged just before `listening`. |
| `CIELINUX_HTTP unavailable: <reason>; running without HTTP` | Busy port or no token. |
| `CIELINUX_HTTP http token: <problem>` | The token file or its directory could not be created, read, written, locked or restricted, or the path is not absolute. Followed by `unavailable: no token`. |
| `CIELINUX_HTTP http token: <path> held an invalid token; replacing it with a freshly generated one.` | The old token was replaced; HTTP still starts. Clients need the new token. |
| `CIELINUX_HTTP disabled (http-server = off)` | HTTP is turned off in settings. |
| `CIELINUX_HTTP rejected <status> <reason>` | A request was refused. |
| `CIELINUX_HTTP the alert command handler threw` / `the scene switch handler threw` | An internal error while handling a valid request; the client gets `500`. |

### Startup and client messages

These are plain text, without a `CIELINUX_` prefix. Each one ends the process with the
status shown.

| Message | Status | Cause |
| --- | --- | --- |
| `Unsupported, missing or duplicate arguments` | 2 | Bad flags. |
| `Rejected inherited QTWEBENGINE_…` | 2 | A refused Chromium override is set (see [Usage](#usage)). |
| `CieLinux is already running for this user (<socket>); use cielinux --cycle-position next\|prev to control it` | 3 | Another instance holds the lock. |
| `Wayland with zwlr_layer_shell_v1 required` | 2 | No Wayland session or no layer shell. |
| `Stop control unavailable` | 2 | The SIGTERM/SIGINT handler could not be set up. |
| `Selected output unavailable` | 2 | `--output` names no connected output. |
| `Recovery budget unavailable` | 2 | Internal: the resident recovery budget was refused. |
| `LayerShellQt unavailable` | 2 | The window could not get a layer-shell surface. |

`cielinux --cycle-position` prints to its own terminal, never to the journal: nothing on
success, `ignored: not in mini mode` or `ignored: window not ready` (status 0), or one of
`Usage: cielinux --cycle-position next|prev` (2), `XDG_RUNTIME_DIR is unset or not absolute;
cannot reach CieLinux`, `no running CieLinux instance (<socket>)`, `refused: …`,
`cannot reach|send to CieLinux: <error>`, `cannot create a socket: <error>`,
`control socket path too long (<socket>)` or `no reply from CieLinux (<socket>)` (status 1).

### Diagnostics markers

These records are stable and machine-readable. Timed runs (`--duration 15|120`) are read
through them, and the contract tests in `tests/` check their exact format. They appear in
every normal journal and are not errors, including the `warn` and `error` probe lines at
each page start.

| Marker | When |
| --- | --- |
| `CIELINUX_DIAGNOSTICS_HOST_START` | Once, after the start checks pass and before Qt starts. |
| `CIELINUX_DIAGNOSTICS_HOST_FAILURE HTML load or renderer failed; closing host` | Once, when the host closes on a failure (exit status 1). |
| `CIELINUX_LIFECYCLE_V1 seq=<n> event=<event> gen=<g> a=<a> b=<b> c=<c>` | One record per lifecycle step (table below). |
| `CIELINUX_LIFECYCLE_CAP` | After 48 lifecycle records; later ones are dropped, except up to two `terminal` records. |
| `CIELINUX_DIAGNOSTICS_JS severity=info\|warn\|error\|unknown source=<file> line=<n> message=<text>` | A scene page wrote to the console (see [Scene console lines](#scene-console-lines)). |
| `CIELINUX_DIAGNOSTICS_CONSOLE_CAP` | After 64 console lines in the process; later ones are dropped. |

#### Lifecycle events

`seq` counts records from 1. `gen` is the page generation: 1 at start, plus one for every
scene or mode switch and every renderer recovery. Fields not listed are `0`.

| `event` | Meaning | `a` | `b` | `c` |
| --- | --- | --- | --- | --- |
| `load` | The page finished loading. | | | |
| `draw` | The page drew its first frame. | | | |
| `ready` | Loaded and drawn: the page is live. | | | |
| `renderer_pid` | The renderer process for this generation. | process ID | | |
| `terminated` | The renderer process ended. | Qt termination status: 0 normal, 1 abnormal, 2 crashed, 3 killed | exit code | |
| `incident` | A load failure or renderer exit. | generation after it (one higher when a recovery starts, unchanged when the host gives up) | recoveries used | 0 load failed, 1 renderer ended |
| `prepared` | The window and page for this generation were built. | | | |
| `mapped` | That window was shown. | | | |
| `view_retired`, `profile_retired` | The old window or web profile was destroyed. | build stage reached: 1 profile, 2 window, 3 prepared, 4 shown | | |
| `terminal` | The host is closing. | exit status | close reason | |

The `terminal` close reason is an index: 0 Normal (tray **Exit**, SIGTERM or SIGINT),
1 Deadline (the `--duration` timer), 2 Output (the output was unplugged), 3 Dismissal
(the compositor closed the window), 4 Ambient (the event loop ended with no other
reason), 5 Failure,
6 Guard (the window could not be built; `a` is then its status). A failure during a
normal close adds a second `terminal` record.

#### Scene console lines

Console output from a scene page reaches the journal as `CIELINUX_DIAGNOSTICS_JS`.
`severity` is `info` for `console.log`/`console.info`, `warn` and `error` otherwise.
`source` is the scene file (`qrc:/<scene>/js/<file>.js`), or `<unknown>` for anything
outside the bundled files. `message` is cut at 512 bytes and every character outside
printable ASCII becomes `?`. The page-to-host markers (`CIELINUX_SCENE_DRAW_READY_V1`,
`CIELINUX_ALERT_READY_V1`, `CIELINUX_ALERT_DONE_V1`) are consumed by the host and never
logged.

| `message=` | Meaning |
| --- | --- |
| `CIELINUX_DIAGNOSTICS_JS_INFO\|WARN\|ERROR synthetic transport probe` | Three intentional probes, one per severity, each time a page starts. They prove the console route works. |
| `CADENCE scene=<scene> kind=periodic\|final …` | Frame statistics (below). |
| `[<scene>-scene] render frame failed (scene\|alert-overlay) <error>` | A frame or the alert overlay threw. Logged once per distinct error. |
| `[processing-nebula] <stage>: <detail>` / `[raphael-nebula] …` | The WebGL nebula fell back. `<stage>` is `unavailable`, `compile-vertex`, `compile-fragment`, `link` or `initialize`. Logged once per distinct detail. |

`CADENCE` is cumulative since the page's first frame. `kind=periodic` comes every 10 s
of page time, at most 12 times (the first two minutes, a full `--duration 120` run);
`kind=final` comes once when the page is unloaded.

| Field | Meaning |
| --- | --- |
| `elapsed_ms` | Time from the first to the latest animation frame. |
| `raf` | Animation frame callbacks received. |
| `eligible` | Frames that started a render. |
| `draw` | Renders that completed. |
| `err` | Renders that threw. |
| `dt=[…]` | Histogram of the gap between completed renders, in seven buckets: ≤8, ≤17, ≤34, ≤50, ≤100, ≤250 and >250 ms. |
| `work=[…]` | Histogram of the time spent in each render, same buckets. |
| `work_n` | Renders measured in `work`. |
| `maxgap_ms` | Longest gap between two completed renders. |

At 60 fps most `dt` samples fall in the ≤17 ms bucket, at 30 fps in ≤34 ms (either mode).

### Lines from Qt and FFmpeg

- `<Unknown File>: QML QQuickWebEngineProfile: Please use WebEngineProfilePrototype for
  profile creation from 6.9, …` (also as `QML WebEngineProfile: …`) appears at every page
  start. It is a QtWebEngine deprecation notice and is harmless.
- `qt.multimedia.ffmpeg: Using Qt multimedia with FFmpeg version …` and an FFmpeg stream
  description (`Metadata:`, `Stream #0:0 …`) appear when an alert sound plays.

### Filtering the journal

To hide the per-frame and console records:

```sh
journalctl --user -u cielinux | rg -v 'CADENCE|DIAGNOSTICS_JS'
```

## Tests

```sh
node --test tests/*.test.mjs                 # from CieLinux/
node --test CieLinux/tests/*.test.mjs        # from the repository root
```

36 contract test files, 350 tests. They read the sources and compile small native
harnesses against `src/` (they need the same Qt and CMake toolchain as the build).
`tests/paths.mjs` maps file names to `src/` and `scenes/`.

## Layout

```
CieLinux/
├── CMakeLists.txt, install.sh, uninstall.sh
├── assets/raphael-mini.ico       tray icon, CielWin's file byte for byte (qrc:/raphael-mini.ico)
├── scenes/                       the four HTML scenes, served from the binary as qrc:/<scene>/...
│   ├── processing/  explorer/  idle/  raphael/
│   └── shared/                   alert overlay (js/alert-overlay.js) and its font
│                                 (Archivo Black, SIL OFL, see fonts/OFL.txt)
├── src/
│   ├── main.cpp                  host wiring: flags, surfaces, alerts, HTTP, tray, control socket
│   ├── policy.h                  lifecycle and renderer recovery policy
│   ├── output-policy.h           output selection (--output, else primary)
│   ├── settings.{h,cpp}          settings.conf read/write
│   ├── scene-host.{h,cpp}        current scene and mode, live switching
│   ├── mini-position.{h,cpp}     eight positions and the 220 ms glide
│   ├── fullscreen-watch.{h,cpp}  Hyprland IPC: coverage and reserved zones
│   ├── alerts.{h,cpp}            alert parsing, queue, layout and driver
│   ├── alert-bridge.h            alert messages to and from the scene page
│   ├── alert-sounds.{h,cpp}      sound import, mute and playback
│   ├── tray.{h,cpp}              StatusNotifierItem tray
│   ├── http-server.{h,cpp}       loopback HTTP API
│   ├── http-token.{h,cpp}        bearer token file
│   ├── instance-control.{h,cpp}  control socket and single-instance lock
│   ├── resident-control.h        flag parsing and SIGTERM/SIGINT stop
│   ├── diagnostics.h             CIELINUX_DIAGNOSTICS_* and CIELINUX_LIFECYCLE_* lines
│   ├── log-routing.h             forces Qt logging to stderr
│   ├── view.qml                  QtWebEngine view
│   └── lumakey.frag              mini luminance key shader
├── systemd/cielinux.service.in   user unit template
├── integrations/claude-code/      cielinux-scenes Claude Code plugin (see its README)
├── integrations/pi/               cielinux-scenes pi extension (see its README)
└── tests/                        Node contract tests
```

Adding a file to a scene means listing it in `CMakeLists.txt` and in the `resourceUrls`
allowlist in `src/main.cpp`; anything else is blocked at runtime.

## Design notes

- **Single output.** Wallpaper, mini and fullscreen detection all use the selected
  output only (`--output`, else the primary one). This is a deliberate scope decision.
- **Hyprland queries are written immediately.** Hyprland reads a request-socket command
  on its main loop right after accepting the connection and waits up to 5 s for it.
  CieLinux therefore writes and flushes each query command as soon as the connection
  opens, so a busy GUI thread (for example during QtWebEngine's first EGL setup) never
  holds the compositor waiting.
- **Nothing blocks on Hyprland.** The mini glide and the wallpaper alert layout read
  the reserved zones from the watch's cache instead of querying on the GUI thread.

## Roadmap

| Stage | Status | Scope |
| --- | --- | --- |
| 1 | Done | Mini overlay mode (`scene-mini`): scenes, tray, HTTP, alerts, sounds, positions, control socket. |
| 2 | Done | Wallpaper mode (`scene`), live mode switch, pause under fullscreen windows, alerts in the wallpaper, Hyprland reconnect and query retry. |

Out of scope by design: multi-monitor (see [Design notes](#design-notes)).

<p align="right">
  <a href="https://github.com/Gentleman-Programming/gentle-ai"><img src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI" width="180"></a>
</p>
