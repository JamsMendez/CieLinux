# cielinux-scenes (pi extension)

A [pi](https://github.com/earendil-works/pi) coding-agent extension that turns what the
agent is doing into ambient feedback on the [CieLinux](../../README.md) wallpaper, over its
local [HTTP API](../../README.md#http). It is the pi peer of the
[Claude Code plugin](../claude-code/README.md) and behaves the same way:

- **Scenes** (`POST /v1/wallpaper/scene`): `raphael` while the agent thinks or a reviewer /
  judge / verify subagent runs, `processing` while it edits or runs commands, `explorer`
  while it reads, searches or researches, and `idle` once the session goes quiet.
- **Alerts** (`POST /v1/alerts`): a `WARNING` while a pi dialog waits for you (a
  confirmation, a question, a choice), and a `FAILED` when `bash` fails, batched into one
  request.

The extension only observes: no handler returns a value, blocks, or changes the session.
Errors are swallowed and requests are sent without being awaited, so a slow or absent
CieLinux never delays the agent; after a connection failure the extension backs off for
30 s.

## How it works

The extension registers these pi events (`extension.ts`):

| Event | Effect |
| --- | --- |
| `session_start` | Resets state and loads the configuration. Sends nothing. |
| `agent_start` | Reloads the configuration; starts the `turn` activity. |
| `agent_settled` | Ends the `turn` activity (pi will not continue on its own). |
| `agent_end` | Ends the `turn` activity after 5 s unless `agent_start` or `agent_settled` comes first (fallback). |
| `tool_execution_start` / `tool_execution_end` | Starts / ends a tool activity, or a subagent activity for `subagent_run`; counts failures. A background `subagent_run` or `subagent_continue` keeps its activity past the call; a `subagent_*` readback with a finished status (`completed`, `failed`, `cancelled`, `timed_out`) ends it. |
| `message_end` | A `gentle-agents.result` message ends the matching background subagent's activity (by `taskId`). |
| `ui_prompt_start` / `ui_prompt_end` | Opens / closes a warning for a blocking dialog (`select`, `confirm`, `input`, `editor`, `custom`). |
| `session_shutdown` | Clears every held warning and sends `idle` (if another scene was sent), within a 1 s budget. |

From these events:

1. **Scene selection.** Every running activity (the turn, each subagent call, each tool
   call) resolves to a scene and a priority through `scenes.rules`. The wanted scene is
   the highest-priority running activity (see [Scenes and priorities](#scenes-and-priorities)).
2. **Debounce.** A wanted scene is sent only after it stayed wanted for `settleMs`, at most
   once every `minHoldMs`, and `idle` only after `idleDelayMs` of nothing running (same
   rules as the Claude Code plugin's
   [Why the debounce](../claude-code/README.md#why-the-debounce)).
3. **Alerts.** A dialog opens a `WARNING` at once; failed `bash` calls are batched into one
   `FAILED` request (see [Alerts](#alerts)). Alerts bypass the scene debounce.
4. **Held warning** (opt-in, `alerts.warning.hold`). The warning stays up until the dialog
   closes: the extension sends `{"warning":1,"duration":0}` and later
   `POST /v1/alerts/clear` with the id CieLinux returned.
5. **Sound.** The extension never plays sound; CieLinux plays the alert's sound.

**Subagents.** gentle-pi runs each subagent as a separate `pi --mode rpc` process with
`GENTLE_PI_AGENTS_CHILD=1`, and those processes load extensions too. The extension does
nothing there (it registers no handler), so only the parent session talks to CieLinux. In
the parent, a `subagent_run` call is an agent activity named by its `agent` argument, for
as long as the call runs; in `background` mode, until gentle-pi delivers the task's
`gentle-agents.result` message, or until a `subagent_result` / `subagent_status` readback
reports the task finished (reading a finished result consumes it, so no message follows).
A background `subagent_continue` starts a new agent activity for the task it launches,
named by the `agent` in its result.

## Requirements

- CieLinux running with its HTTP server on (`http-server`, the default), on
  `127.0.0.1:43811`.
- The CieLinux bearer token file, created on CieLinux's first start:
  `$XDG_STATE_HOME/cielinux/http.token` (usually `~/.local/state/cielinux/http.token`).
- pi with the `ui_prompt_start` / `ui_prompt_end` and `agent_settled` events. Developed
  against pi 1.0.2 (gentle-shell, gentle-pi 4). An older pi without `agent_settled` still
  ends turns through the `agent_end` fallback; without the prompt events there are no
  warnings.
- For the held warning only: a CieLinux that accepts `duration: 0` and serves
  `POST /v1/alerts/clear`. An older one answers `400`; the extension then falls back to
  timed warnings for the rest of the session.

## Install

The extension runs from a folder; nothing is built and it has no dependencies. pi loads
`<agent-dir>/extensions/<name>/index.ts` automatically. This folder in the repository is
the source, not the installed copy.

1. Copy the extension (from the `CieLinux/` folder). For pi launched by `gentle-shell`
   (agent dir `~/.gentle-shell/agent`):

   ```sh
   rm -rf ~/.gentle-shell/agent/extensions/cielinux-scenes
   mkdir -p ~/.gentle-shell/agent/extensions
   cp -r integrations/pi ~/.gentle-shell/agent/extensions/cielinux-scenes
   ```

   For plain pi use `~/.pi/agent/extensions/cielinux-scenes` instead. A pi started with
   another `PI_CODING_AGENT_DIR` loads `$PI_CODING_AGENT_DIR/extensions/`. Removing the
   old folder first keeps `cp` from nesting the new copy inside it. Your settings live in
   `~/.config/pi-cielinux/config.json` (see [Configuration](#configuration)), so they
   survive the copy.

2. Restart gentle-shell (or pi).

To update, repeat step 1 and restart. To try the repository copy for one session without
installing, run `pi -e /path/to/CieLinux/integrations/pi/index.ts`.

Verify: start a session and ask the agent to read a file. The wallpaper switches to
`explorer` after about 1.5 s, and back to `idle` about 8 s after the turn ends. A dialog
(for example a bash permission confirmation) shows a `WARNING`.

No token setup is needed: with `server.token` empty (the default), the extension reads the
token file (see the Claude Code plugin's [Token](../claude-code/README.md#token); the rules
are the same).

## Configuration

`config.json` in this folder holds the defaults (it mirrors `DEFAULT_CONFIG` in
`lib/config.ts`; a test checks that they match). Put your changes in a user override
instead:

`$XDG_CONFIG_HOME/pi-cielinux/config.json` (usually `~/.config/pi-cielinux/config.json`)

The override is deep-merged onto the defaults: objects merge, arrays (such as
`scenes.rules`) replace, and a value of the wrong type keeps the default. Both files are
re-read on session start and at every `agent_start`, so edits apply without a restart. A
file that is not valid JSON is ignored (the last good config stays) and a notification
says so once per session (only when pi has a UI).

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; `false` sends nothing. |
| `server.baseUrl` | `http://127.0.0.1:43811` | CieLinux address. |
| `server.sceneRoute` | `/v1/wallpaper/scene` | Scene route. |
| `server.alertsRoute` | `/v1/alerts` | Alerts route (`/clear` is appended for the held warning). |
| `server.token` | `""` | Inline bearer token; wins over `tokenFile` when set. |
| `server.tokenFile` | `~/.local/state/cielinux/http.token` | Token file (`~` expanded, trimmed). |
| `timing.settleMs` | `1500` | A new scene must stay wanted this long before it is sent. |
| `timing.minHoldMs` | `4000` | Minimum time between two scene requests. |
| `timing.idleDelayMs` | `8000` | Quiet time before `idle` is sent. |
| `scenes.turn` | `raphael`, priority 5 | Baseline while the agent runs. |
| `scenes.idle.scene` | `idle` | Scene once nothing is running. |
| `scenes.subagentTools` | `["subagent_run"]` | Tools (globs) whose call is a subagent named by `args.agent`. |
| `scenes.rules` | see below | Ordered rules, first match wins. |
| `alerts.warning.enabled` | `true` | Warn while a dialog waits for you. |
| `alerts.warning.hold` | `false` | Keep the warning up until the dialog closes (see Alerts). |
| `alerts.warning.duration` | `5` | Seconds on screen (1–60); with `hold`, only for the fallback. |
| `alerts.warning.cooldownMs` | `10000` | Minimum time between two timed warnings. |
| `alerts.warning.on` | `["*"]` | Dialog kinds (globs): `select`, `confirm`, `input`, `editor`, `custom`. |
| `alerts.failed.enabled` | `true` | Alert on failed tool calls. |
| `alerts.failed.duration` | `8` | Seconds on screen (1–60). |
| `alerts.failed.batchMs` | `3000` | Failures within this window become one request. |
| `alerts.failed.tools` | `["bash"]` | Tool-name globs that count. |
| `alerts.failed.ignoreInterrupted` | `true` | A call you aborted is not a failure. |

Differences from the Claude Code plugin's keys: `alerts.warning.on` lists dialog kinds
(pi reports every dialog, so there is no `PermissionRequest` special name),
`scenes.subagentTools` is new, and `scenes.inheritAgentScene` is gone (a subagent's own
tool calls run in its child process, which the extension ignores).

Example override that holds the warning until the dialog closes and quiets failures:

```json
{
  "alerts": {
    "warning": { "hold": true },
    "failed": { "enabled": false }
  }
}
```

## Scenes and priorities

Every running activity resolves to a scene and a priority (0–100) when it starts:

- `turn`: the agent run, from `agent_start` to `agent_settled` (or the `agent_end`
  fallback).
- `agent:<call id>`: a `subagent_run` call, by its `agent` argument, until the call ends
  (a background call: until its `gentle-agents.result` message or a finished readback; a
  background `subagent_continue` call is tracked the same way).
- `tool:<call id>`: any other tool call, by its tool name, until the call ends.

The wanted scene is the highest-priority running activity (ties: the most recently
started). Rules are `{ "kind": "agent" | "tool", "match": glob or [globs], "scene": name or
null, "priority": n }`; `*` matches any run of characters and matching is case-sensitive.
`scene: null` ignores the activity, as does a name no rule matches. pi tool names are
lowercase.

Default rules:

| Scene | Priority | Agents | Tools |
| --- | --- | --- | --- |
| `raphael` (analysis, judgment, planning) | 40 | `review-*`, `jd-judge-*`, `*-verify`, `*judge*`, `*planner*`, `sdd-propose`, `sdd-spec`, `sdd-design`, `sdd-tasks` | |
| `processing` (hands-on work) | 30 | `jd-fix-agent`, `*-worker`, `*-fix*`, `*apply*`, `sdd-archive`, `sdd-init`, `sdd-onboard` | `bash`, `edit`, `write` |
| `processing` (generic agents) | 25 | any other (`*`) | |
| `explorer` (searching, reading, research) | 20 | `*-explore`, `*explorer*`, `sdd-explore`, `*research*` | `read`, `grep`, `find`, `ls`, `web_*`, `*search*`, `fetch_content`, `source_check`, `*codegraph*`, `*context7*` |
| `raphael` (agent run baseline) | 5 | | |
| ignored | | | `ask_user_*`, `*question*`, `todo`, `mem_*`, `*engram*`, `subagent_*` (other than `subagent_run`), `orchestrator_*`, anything unmatched |

With gentle-pi's agents: `review-*`, `jd-judge-*` and `gentle-ai-verify` show `raphael`;
`jd-fix-agent` and `gentle-ai-worker` show `processing`; `gentle-ai-explore` shows
`explorer`.

## Alerts

- **Warning:** sent at once when a blocking dialog opens (`ui_prompt_start`), as
  `{"warning":1,"duration":5}`, at most once per `cooldownMs`. This covers bash
  permission confirmations, `ask_user_question`, `ask_user_choice` and any extension
  dialog. pi reports only the outermost of nested dialogs; the extension also counts
  depth, so a nested dialog never opens a second warning.
- **Held warning** (`alerts.warning.hold: true`): on open the extension sends
  `{"warning":1,"duration":0}` at once (ignoring the cooldown), keeps the id CieLinux
  answers (`202 ok id=<n>`), and on `ui_prompt_end` sends `POST /v1/alerts/clear
  {"id":<n>}` (also when the reply came after the close). A reply without an id (another
  warning is already held) has nothing to clear. A `400` means CieLinux has no held
  warnings: the timed warning is sent instead and holding stops for the session. Session
  end clears an outstanding hold within its 1 s budget. CieLinux ends a held warning by
  itself after `alert-hold-max-seconds` (default 600).
- **Failed:** each `tool_execution_end` with `isError` for a tool in `failed.tools` is
  counted; `batchMs` after the first, one `{"failed":N,"duration":8}` is sent (N capped at
  16). An aborted call is not counted: the extension treats a call as aborted when the
  handler context's abort signal is set, or when the result text contains `aborted`,
  `interrupted` or `cancelled` (a heuristic: pi reports cancellations as error results
  with that wording).
- **One at a time:** CieLinux shows a single alert and silently drops requests made while
  one is showing. The extension tracks when its last alert ends (`duration` + 0.5 s) and
  holds new ones until then, then sends everything pending as one request.

## Uninstall

1. Delete the installed copy: `rm -rf ~/.gentle-shell/agent/extensions/cielinux-scenes`
   (or the `~/.pi/agent/extensions/` copy).
2. Restart gentle-shell (or pi).
3. Optionally delete your settings: `rm -rf ~/.config/pi-cielinux`.

Nothing else is installed.

## Development

```sh
cd integrations/pi
node --experimental-strip-types --test tests/*.test.ts   # or: npm test
```

Tests use `node:test` and need no running CieLinux or pi. `tests/extension.test.ts` drives
the extension through a fake `pi` (it collects the `pi.on` handlers) with a fake clock,
filesystem and network.

The engines in `lib/` (`scenes`, `alerts`, `holds`, `client`, `config`) are copies of the
Claude Code plugin's `hooks/` files, adapted only where needed (Node type stripping does
not allow TypeScript parameter properties; imports name their `.ts` files; pi defaults in
`config.ts`). The duplication is deliberate: a copied install must be self-contained, and
an import across `integrations/` would break it. Change both copies together.

The extension imports no types from `@earendil-works/pi-coding-agent`; `PiLike` in
`extension.ts` describes the part of pi's API it uses, so the copied folder needs no
`node_modules`.

## Limitations

- A background subagent whose result gentle-pi never delivers as a message (stale or
  re-owned tasks) keeps its activity until the engine prunes it as stale (30 min).
- Other `subagent_*` tools only matter for background tasks: a finished readback ends
  one, and a background `subagent_continue` starts one. A task-mode `subagent_continue`
  shows nothing (its call has no `agent` argument).
- The busy estimate is the extension's own: an alert CieLinux defers or one sent by
  another client is not seen, so a request may still be dropped.
- Without `hold`, a warning shows for its `duration`, not until the dialog closes.
- "Failed" is the tool's error result; aborts are recognized by a heuristic (see Alerts).
- In print mode (`pi -p`) and other modes without a UI, pi opens no dialogs, so there are
  no warnings.
- Several pi (or Claude Code) sessions drive the same wallpaper independently; the last
  request wins.

## Layout

| Path | What |
| --- | --- |
| `index.ts` | pi entry point: real I/O (fetch, files, timers), then `extension.ts`. |
| `extension.ts` | The event wiring, with injectable I/O. |
| `config.json` | Bundled defaults; `server.token` stays empty. |
| `package.json` | Name, `pi.extensions` entry, test script. |
| `lib/config.ts` | Defaults, merge, glob rules. |
| `lib/scenes.ts` | Scene engine (priority, settle, hold, idle); pure, time injected. |
| `lib/alerts.ts` | Alert batcher (cooldown, batching, one-at-a-time); pure. |
| `lib/holds.ts` | Held warnings: one per open dialog, cleared by id; I/O injected. |
| `lib/client.ts` | HTTP client (token, 401 retry, backoff). |
| `tests/` | `node:test` suites: engines, client, config, wiring and entry point. |
