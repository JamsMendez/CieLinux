# cielinux-scenes (Claude Code plugin)

A Claude Code plugin (function hooks) that turns what Claude is doing into ambient
feedback on the [CieLinux](../../README.md) wallpaper, over its local
[HTTP API](../../README.md#http):

- **Scenes** (`POST /v1/wallpaper/scene`): `raphael` while Claude thinks or a reviewer /
  planner subagent runs, `processing` while it edits or runs commands, `explorer` while it
  reads, searches or researches, and `idle` once the session goes quiet.
- **Alerts** (`POST /v1/alerts`): a `WARNING` when Claude asks you something
  (AskUserQuestion, a permission prompt), and a `FAILED` when Bash fails, batched into one
  request.

The plugin only observes: every hook passes its event on unchanged and never denies or
rewrites anything. Network errors are swallowed; if CieLinux is not running the plugin
backs off for 30 s after each connection failure and the session is unaffected.

## How it works

The plugin registers these hooks (`hooks/register.ts`):

| Hook | Effect |
| --- | --- |
| `session.start` | Resets state and loads the configuration. Sends nothing. |
| `turn.start` / `turn.complete` | Reloads the configuration; starts / ends the `turn` activity. |
| `agent.spawn`, `classic.SubagentStart` / `classic.SubagentStop` | Start / end a subagent activity. |
| `tool.call` | Starts a tool activity for the length of the call; counts failures; opens and closes warnings for AskUserQuestion. |
| `classic.PermissionRequest` | Opens a warning for a permission prompt. |
| `session.end` | Clears every held warning and sends `idle` (if another scene was sent), within a 1 s budget. |

From these events:

1. **Scene selection.** Every running activity (the turn, each subagent, each tool call)
   resolves to a scene and a priority through `scenes.rules`. The wanted scene is the
   highest-priority running activity (see [Scenes and priorities](#scenes-and-priorities)).
2. **Debounce.** A wanted scene is sent only after it stayed wanted for `settleMs`, at most
   once every `minHoldMs`, and `idle` only after `idleDelayMs` of nothing running (see
   [Why the debounce](#why-the-debounce)).
3. **Alerts.** A question opens a `WARNING` at once; failed Bash calls are batched into one
   `FAILED` request (see [Alerts](#alerts)). Alerts bypass the scene debounce.
4. **Held warning** (opt-in, `alerts.warning.hold`). The warning stays up until the
   question resolves: the plugin sends `{"warning":1,"duration":0}` and later
   `POST /v1/alerts/clear` with the id CieLinux returned.
5. **Sound.** The plugin never plays sound. CieLinux plays the alert's sound, and for a
   held warning repeats it every 5 seconds until it is cleared (CieLinux
   [Held warning](../../README.md#held-warning)).

## Requirements

- CieLinux running with its HTTP server on (`http-server`, the default), on
  `127.0.0.1:43811`.
- The CieLinux bearer token file, created on CieLinux's first start:
  `$XDG_STATE_HOME/cielinux/http.token` (usually `~/.local/state/cielinux/http.token`).
- A Claude Code version that loads function-hook plugins from a folder (`--plugin-dir`
  and `CLAUDE_CODE_PLUGIN_DIRS`) and has `claude plugin validate` / `claude plugin test`.
  Developed against Claude Code 2.1.288.
- For the held warning only: a CieLinux that accepts `duration: 0` and serves
  `POST /v1/alerts/clear`. An older one answers `400`; the plugin then falls back to timed
  warnings for the rest of the session.

## Install

The plugin runs from a folder; nothing is built. It is installed at
`~/.local/claude-cielinux-plugin`, and Claude Code loads it from there. This folder in the
repository is the source, not the installed copy.

1. Copy the plugin (from the `CieLinux/` folder):

   ```sh
   rm -rf ~/.local/claude-cielinux-plugin
   cp -r integrations/claude-code ~/.local/claude-cielinux-plugin
   ```

   Removing the old folder first keeps `cp` from nesting the new copy inside it. Your
   settings live in `~/.config/claude-cielinux/config.json` (see
   [Configuration](#configuration)), so they survive the copy.

2. Point Claude Code at it: add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block
   of `~/.claude/settings.json`, using the absolute path:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/home/<user>/.local/claude-cielinux-plugin"
     }
   }
   ```

   `CLAUDE_CODE_PLUGIN_DIRS` is a list separated by the platform path delimiter (`:` on
   Linux). If it already lists other folders, append this one instead of replacing them:
   `"/existing/plugin:/home/<user>/.local/claude-cielinux-plugin"`.

3. Restart Claude Code.

To update, repeat step 1 and restart Claude Code. To try a change from the repository for
one session only, without reinstalling, run
`claude --plugin-dir /path/to/CieLinux/integrations/claude-code`.

Verify:

1. `claude plugin validate ~/.local/claude-cielinux-plugin` ends with
   `Validation passed` (one warning, the manifest has no `author`, is expected).
2. Start a session and ask Claude to read a file: the wallpaper switches to `explorer`
   after about 1.5 s, and back to `idle` about 8 s after the turn ends.
3. Trigger a question (a permission prompt, outside bypass-permissions mode): a `WARNING`
   shows.

No token setup is needed: with `server.token` empty (the default), the plugin reads the
token file (see [Token](#token)).

## Configuration

`config.json` in this folder holds the defaults (it mirrors `DEFAULT_CONFIG` in
`hooks/config.ts`). Put your changes in a user override instead:

`$XDG_CONFIG_HOME/claude-cielinux/config.json` (usually `~/.config/claude-cielinux/config.json`)

The override is deep-merged onto the defaults: objects merge, arrays (such as
`scenes.rules`) replace, and a value of the wrong type keeps the default. Both files are
re-read on session start and at the start of every turn, so edits apply without a
restart. A file that is not valid JSON is ignored (the last good config stays) and a toast
says so once per session.

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
| `scenes.turn` | `raphael`, priority 5 | Baseline while the main turn runs. |
| `scenes.idle.scene` | `idle` | Scene once nothing is running. |
| `scenes.inheritAgentScene` | `true` | Tool calls inside a subagent don't count on their own. |
| `scenes.rules` | see below | Ordered rules, first match wins. |
| `alerts.warning.enabled` | `true` | Warn when Claude asks you something. |
| `alerts.warning.hold` | `false` | Keep the warning up until the question is answered (see Alerts). |
| `alerts.warning.duration` | `5` | Seconds on screen (1–60); with `hold`, only for the fallback. |
| `alerts.warning.cooldownMs` | `10000` | Minimum time between two warnings. |
| `alerts.warning.on` | `["AskUserQuestion", "PermissionRequest"]` | Tool-name globs, plus the special `PermissionRequest`. |
| `alerts.failed.enabled` | `true` | Alert on failed tool calls. |
| `alerts.failed.duration` | `8` | Seconds on screen (1–60). |
| `alerts.failed.batchMs` | `3000` | Failures within this window become one request. |
| `alerts.failed.tools` | `["Bash"]` | Tool-name globs that count. |
| `alerts.failed.ignoreInterrupted` | `true` | A call you interrupted is not a failure. |

Example override that holds the warning until you answer and quiets failures:

```json
{
  "alerts": {
    "warning": { "hold": true },
    "failed": { "enabled": false }
  }
}
```

### Token

Keep `server.token` empty and let the plugin read `server.tokenFile`; never commit a token
into `config.json`. When `server.token` is empty the token file is read (and cached); a
missing or empty file means nothing is sent. An inline `server.token` is used when set.
On a `401` the plugin re-reads the token file once and retries, also when the rejected
token was the inline one (CieLinux may have regenerated it); from then on it uses the
file's token until the inline value changes.

## Scenes and priorities

Every running activity resolves to a scene and a priority (0–100) when it starts:

- `turn`: the main turn, from `turn.start` to its `turn.complete`.
- `agent:<id>`: a subagent, by its agent type (`classic.SubagentStart` or `agent.spawn`,
  ended by `classic.SubagentStop` or its `turn.complete`).
- `tool:<id>`: a tool call, by its tool name, for as long as the call runs. With
  `inheritAgentScene`, calls made inside a subagent are represented by the subagent.

The wanted scene is the highest-priority running activity (ties: the most recently
started). Rules are `{ "kind": "agent" | "tool", "match": glob or [globs], "scene": name or
null, "priority": n }`; `*` matches any run of characters and matching is case-sensitive.
`scene: null` ignores the activity, as does a name no rule matches.

Default rules:

| Scene | Priority | Agents | Tools |
| --- | --- | --- | --- |
| `raphael` (analysis, judgment, planning) | 40 | `review-*`, `jd-judge-*`, `sdd-propose`, `sdd-spec`, `sdd-design`, `sdd-tasks`, `sdd-verify`, `Plan` | |
| `processing` (hands-on work) | 30 | `jd-fix-agent`, `sdd-apply`, `sdd-archive`, `sdd-init`, `sdd-onboard`, `statusline-setup` | `Bash`, `BashOutput`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `PowerShell` |
| `processing` (generic agents) | 25 | `general-purpose`, `claude`, any other (`*`) | |
| `explorer` (searching, reading, research) | 20 | `Explore`, `sdd-explore`, `sdd-research`, `claude-code-guide` | `Read`, `Grep`, `Glob`, `LS`, `WebSearch`, `WebFetch`, `ToolSearch`, `mcp__codegraph__*`, `mcp__context7__*` |
| `raphael` (main turn baseline) | 5 | | |
| ignored | | | `Agent`, `Task`, `AskUserQuestion`, `Skill`, `TodoWrite`, `mcp__*engram*`, `mcp__*mem_*`, anything unmatched |

So a reviewer subagent keeps `raphael` up while the main thread edits in parallel, an
edit outranks a read, and the main turn falls back to `raphael` between tool calls.

### Why the debounce

A scene switch is a fullscreen change, and tool calls come in bursts (a Read, a Grep, a
Bash, a Read...). A trailing settle alone (send only once the wanted scene was stable for
`settleMs`) still lets a slow alternation through every couple of seconds, so a second
rule bounds the rate: at least `minHoldMs` between two requests. Together:

- bursts shorter than `settleMs` send nothing;
- at most one scene request every `minHoldMs`;
- the same scene is never sent twice in a row;
- `idle` waits `idleDelayMs` of emptiness, so the pause between two prompts does not
  flash idle;
- nothing is sent at session start until something happens (the wallpaper is left as
  you had it), and `idle` is sent at once when the session ends, if another scene was
  sent;
- an activity older than 30 minutes (a subagent that never reported its end) is dropped.

Alerts bypass the scene debounce.

## Alerts

- **Warning:** sent at once when AskUserQuestion starts or a permission prompt opens
  (`{"warning":1,"duration":5}`), at most once per `cooldownMs`.
- **Held warning** (`alerts.warning.hold: true`): the warning stays up until the question
  resolves (answered, denied, interrupted or errored) instead of for `duration`. On open
  the plugin sends `{"warning":1,"duration":0}` at once, ignoring the cooldown and the
  one-at-a-time rule, and keeps the id CieLinux answers (`202 ok id=<n>`); on close it
  sends `POST /v1/alerts/clear {"id":<n>}` (also when the reply came after the close).
  AskUserQuestion holds for its own call. A permission prompt has no call id, so it holds
  for the pending call of the same tool it fires inside (preferring the same subagent); a
  prompt with no such call gets the timed warning. A reply without an id (another warning
  is already held) has nothing to clear; that question gets its own hold once the shown one
  is cleared. Failures are still sent while a warning is held: CieLinux shows them over it
  and resumes the warning afterwards. Session end clears every outstanding hold within its
  1 s budget. Requires a CieLinux with `duration: 0` and `/v1/alerts/clear`; an older one
  answers `400`, and the plugin then sends the timed warning instead and stops holding for
  the rest of the session. CieLinux ends a held warning by itself after
  `alert-hold-max-seconds` (default 600), and repeats its warning sound every 5 s while it
  shows.
- **Failed:** each failed call of a watched tool (including inside subagents) is counted;
  `batchMs` after the first, one `{"failed":N,"duration":8}` is sent (N capped at 16).
- **One at a time:** CieLinux shows a single alert and silently drops requests made while
  one is showing (still answering `202`). The plugin tracks when its last alert ends
  (`duration` + 0.5 s) and holds new ones until then, then sends everything pending as one
  request (`{"failed":N,"warning":1,"duration":<max>}`, at most 16 tiles together).

## Uninstall

1. Remove `~/.local/claude-cielinux-plugin` from `CLAUDE_CODE_PLUGIN_DIRS` in the `env`
   block of `~/.claude/settings.json`, keeping any other folders it lists, or delete the
   variable if this was the only one.
2. Restart Claude Code.
3. Delete the installed copy: `rm -rf ~/.local/claude-cielinux-plugin`.
4. Optionally delete your settings: `rm -rf ~/.config/claude-cielinux`.

Nothing else is installed. A held warning left up by a session that did not end cleanly
ends by itself after CieLinux's `alert-hold-max-seconds` (default 600); to clear it at
once, `POST /v1/alerts/clear` with `{}` (see the CieLinux [HTTP](../../README.md#http)
examples).

## Development

```sh
claude plugin validate integrations/claude-code     # manifest and hook checks
claude plugin test integrations/claude-code         # 6 suites, 76 tests
```

Both run from the `CieLinux/` folder. Tests use the `claude-code/testing` kit and need no
running CieLinux.

The TypeScript declarations under `.claude-plugin/types/` (referenced by `tsconfig.json`)
are not part of the repository: Claude Code writes them each time it loads the plugin
from a folder you own, and they are ignored by git. `validate` and `test` do not need
them; an editor shows type errors until the plugin has been loaded once.

## Limitations

- The busy estimate is the plugin's own: an alert CieLinux defers (a fullscreen window
  over the wallpaper) or one sent by another client is not seen, so a request may still be
  dropped.
- Without `hold`, a warning shows for its `duration`, not until you answer. The held
  warning's design: [docs/held-warning-proposal.md](docs/held-warning-proposal.md).
- A held warning for a permission prompt is matched to its call by tool name: with two
  pending calls of the same tool, the hold may close with the other call.
- "Failed" is the tool's error result: for Bash that is a non-zero exit, a timeout or an
  error. Interruptions are recognized by the result's `interrupted` flag, the hook's abort
  signal, or the "interrupted by user" text.
- Permission prompts do not occur in bypass-permissions mode, so only AskUserQuestion
  warns there.
- Several Claude Code sessions drive the same wallpaper independently; the last request
  wins.

## Layout

| Path | What |
| --- | --- |
| `.claude-plugin/plugin.json` | Plugin manifest (`cielinux-scenes`). |
| `config.json` | Bundled defaults; `server.token` stays empty. |
| `hooks/hooks.json` | Hook entry point. |
| `hooks/register.ts` | The hooks: wires events to the engines below and the client. |
| `hooks/config.ts` | Defaults, merge, glob rules. |
| `hooks/scenes.ts` | Scene engine (priority, settle, hold, idle); pure, time injected. |
| `hooks/alerts.ts` | Alert batcher (cooldown, batching, one-at-a-time); pure. |
| `hooks/holds.ts` | Held warnings: one per pending question, cleared by id; I/O injected. |
| `hooks/client.ts` | HTTP client (token, 401 retry, backoff). |
| `tests/` | `claude plugin test` suites: pure engines, client, and hook-level tests. |
| `docs/held-warning-proposal.md` | Design notes for the held warning. |
| `tsconfig.json` | Extends the generated `.claude-plugin/types/tsconfig.json`. |
