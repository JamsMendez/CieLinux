# Proposal: a held warning in CieLinux

Status: implemented in CieLinux and the plugin; CielWin pending. Audience: CieLinux maintainers and this plugin.

## Problem

When Claude Code blocks on the user (an AskUserQuestion dialog, a permission prompt), the
plugin can only show a WARNING for a fixed `duration` (1–60 s). The user who looks away
for two minutes comes back to a quiet wallpaper and a stalled session. The warning should
stay until the question is answered.

The plugin can observe both ends precisely:

- **open:** AskUserQuestion's `tool.call` starts; `classic.PermissionRequest` fires;
- **close:** that `tool.call` resolves (answered, denied or interrupted); for a permission
  prompt, the guarded tool call resolves or is denied.

## Decision summary

1. `POST /v1/alerts` with `"duration": 0` means **hold until cleared**, with a safety
   maximum of 10 minutes.
2. The `202` reply body returns an alert **id** (`ok id=<n>`); clearing is
   `POST /v1/alerts/clear` with an optional `{"id": n}`.
3. A failed alert arriving during a held warning **preempts** it: the failed alert shows
   for its duration, then the held warning resumes (if not cleared meanwhile).
4. Everything else stays backwards compatible.

## API

### Opening a held warning

```json
POST /v1/alerts
{ "warning": 1, "duration": 0 }
```

- `duration: 0` is accepted only with `warning` alone (a held `failed` makes no sense: a
  failure has nothing to wait for). `{"failed":1,"duration":0}` answers `400 error:
  'duration:0' requires warning only`.
- Reply: `202 ok id=<n>`, `n` a positive integer, increasing per CieLinux run. Today's
  callers read only the status code, so the extra text is compatible.
- Safety max: a held alert ends by itself after 10 minutes (`alert-hold-max-seconds`,
  default 600), so a crashed client never leaves the warning up forever.

### Clearing it

Options considered:

| Option | Verdict |
| --- | --- |
| `{"warning": -1}` (the original idea) | Rejected: overloads a tile count with a command, breaks the "whole number 1–16" rule every caller relies on, and cannot say *which* alert. |
| `DELETE /v1/alerts` | Clean, but CieLinux's checks answer 405 for non-POST and only POST is routed; adds a method to the security checklist. |
| `{"clear": true}` on `/v1/alerts` | Mixes two operations in one body schema; validation gets conditional. |
| **`POST /v1/alerts/clear`, body `{}` or `{"id": n}`** | **Chosen**: keeps POST-only and the existing check order, one schema per route, and the id makes clearing precise. |

- `{"id": n}` clears that alert if it is still showing or waiting; otherwise a no-op.
- `{}` clears the current held alert, whatever its id (for simple callers like `curl`).
- A timed (non-held) alert is not cleared by `{}`: it was never meant to be.
- Reply: `202 ok` whether or not something was cleared (idempotent, like today's drops).

### Interaction with the one-alert-at-a-time rule

Today a request during an alert is dropped. A held warning would therefore block every
failed alert for as long as the user does not answer, which is exactly when a failure is
interesting. Rules:

- **failed preempts held:** a `failed` request during a held warning is shown at once for
  its own duration; the held warning is suspended, then resumes for the rest of its hold.
- **warning during held:** dropped as today (already showing a warning).
- **held during a timed alert:** queued as "waiting to show" like any alert today, and
  shown when the timed one ends (the 5-minute start limit still applies).
- Merging (showing failed and warning tiles together) is the simpler alternative, but it
  changes the mosaic mid-alert and replays the failed sound and shake on every merge;
  preemption keeps each alert's look and sound as today.

### Fullscreen

In the wallpaper, alerts already wait while a fullscreen window covers it. A held warning
waits the same way, but its 10-minute safety max counts from when it was requested, not
from when it was first shown, so a long fullscreen session does not resurrect a stale
question. The mini shows it immediately as today.

### Validation changes

- `duration`: `0` allowed only for a warning-only body; otherwise still 1–60.
- Counts: still 1–16, negatives still rejected (no `-1` command).
- New route `/v1/alerts/clear`: same checks 1–9, body at most 64 bytes, only the optional
  `id` field (whole number ≥ 1).

### Backwards compatibility

- Existing bodies and replies are unchanged in meaning; `202 ok` gains an ` id=<n>` suffix
  on `/v1/alerts` only. A caller that compares the body to exactly `ok` would need to use
  `startsWith("ok")`; CielWin compatibility should be checked before shipping.
- CielWin can ignore `duration: 0` (answer 400) until it implements the same; callers fall
  back to a timed warning (see below).

## Plugin changes once CieLinux ships it

1. Config: `alerts.warning.hold: true` (default false until the CieLinux version is
   detected).
2. On open (AskUserQuestion start / PermissionRequest): send `{"warning":1,"duration":0}`
   immediately, bypassing the cooldown and the busy check (preemption makes the busy
   estimate moot for failed alerts); remember the returned id per `tool_use_id`.
3. On close (the tool call resolves): `POST /v1/alerts/clear {"id": n}`.
4. Failed batching keeps working; with preemption, the batcher no longer waits behind a
   held warning (treat a held warning as "not busy" for failed alerts).
5. Fallback: if the hold request answers `400`, use today's timed warning and disable
   hold for the session.
6. Session end: clear any held id.
