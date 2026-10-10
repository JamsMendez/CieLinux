# Finite synchronous-layer attribution for native Processing

This opt-in fixture samples **120 complete draws after 30 complete warmup draws** to
screen for a synchronous stage worth investigating. It is not a continuous benchmark,
pixel comparison, or performance-gain claim. Production scripts/resources are bundled
unchanged in their original order; no production host, HTTP server, settings, tray,
instance control or service code is linked.

## Compile-only checks

From the repository root, with **Qt 6.8 or newer Qt 6** Quick, Qml and WebEngineQuick
development files (the minimum supports QML's `permissionRequested` API):

```sh
node --test tests/native-processing/contract.test.mjs
build_root=$(mktemp -d /tmp/cielinux-native-processing.XXXXXX)
cmake -S tests/native-processing -B "$build_root/build" -DCIELINUX_NATIVE_PROCESSING=ON -DCMAKE_BUILD_TYPE=Release
cmake --build "$build_root/build" --target native-processing --parallel 1
```

`CIELINUX_NATIVE_PROCESSING` defaults OFF: without opt-in there is no executable target
or Qt dependency lookup. Node contracts use source checks and VM drawing mocks, including
the real production scheduler; they never launch the binary or prove native guards or
pixels. Compilation does not load QML. README-only changes are not bundled and require
no rebuild; preserve the previously verified binary. Removing this directory rolls back
the fixture independently of production changes.

## Before any native launch: parent-owned containment

**No direct/uncontained launch is a supported quick path.** N5 requires independent
readiness checks and one parent-owned, manager-controlled dedicated retained transient
user service, containing all browser descendants. Required policy:

| Setting | Value |
|---|---|
| Type / KillMode | `exec` / `control-group` |
| RuntimeMaxSec / TimeoutStopSec | `15s` / `2s` |
| SendSIGKILL / Restart | `yes` / `no` |
| MemoryMax / TasksMax | `2G` / `128` |

Record the invocation identity and its journal. Audit normal exit and recursive cgroup
`populated=0` **before stopping that dedicated unit**, with the audit bounded by 18 seconds.
Check unit/cgroup/window removal and pre/post resident identity, settings, HTTP state and
surfaces. Missing evidence, deadline or forced cleanup fails the measurement. Capability
metadata and a parent-process/process-group timeout do not prove descendant cleanup.
Do not use wait/pipe/collect modes that lose the required audit lifecycle, target the
resident service, or issue global/process-name signals. Containment is not implemented
by this fixture; setup, auditing and any launch remain parent-owned.

The executable accepts no arguments and requires nonroot Wayland. It rejects **any
presence**, including empty values, of `QTWEBENGINE_DISABLE_SANDBOX`,
`QTWEBENGINE_CHROMIUM_FLAGS` and `QTWEBENGINE_REMOTE_DEBUGGING`. Platform/shell overrides
must be absent or exactly `wayland` / `xdg-shell`; actual Qt selection must be Wayland.
It never changes the environment. Do not weaken guards to obtain a result.

The profile is off-record with cache and persistent cookies disabled. Exact bundled qrc
URLs only are allowed; file/network/data loads, subframes, subsequent navigation,
downloads, permissions, fullscreen and new windows are denied. JavaScript errors fail
except the exact production synthetic transport probe. No DevTools, injected profiler,
external observer or graphics readback is used. Ordinary browser subprocess/IPC/temp-file
activity still exists. Internal SIGALRM bounds the process to 15 seconds, with an earlier
Qt shutdown timer; emergency `_exit` is failure, **not a child-cleanup guarantee**.

## What is sampled

After load and draw readiness pass the existing checkpoint, wrappers forward the original
render and 17 stage calls with their receiver, arguments, return values and exceptions.
Stage timings are recorded only inside wrapped render calls. The already-queued original
render callback is excluded; its successor uses the wrapper. Scheduler throttle callbacks
are **not draws**. Only complete draws with all 17 stages exactly once in order count;
partial/misordered frames fail rather than contribute samples.

The original scheduler, RNG, formulas and live timestamps remain unchanged: no extra
scheduler, render calls, fixed timestamps, ablations or graphics API interception.
Fixed-size storage discards 30 complete warmup draws, retains 120 samples and stops
sampling at that cap. There is no per-frame harness logging. Summary calculation/sorting
occurs after the frame's end clock read. One exact completion marker from bundled
`driver.js` triggers one retrieval of the summary and final checkpoint.

**Interpretation limits:** elapsed time includes JavaScript, Canvas/WebGL submission and
incidental blocking, not asynchronous raster or GPU completion. Wrapper, clock and
bookkeeping overhead is not removed; residual also includes non-stage work. Thirty
warmup draws cannot guarantee all lazy caches are warm; an inactive overlay does not
measure active-alert cost. The ordinary 640×360 viewport clips fixed 3440×1440 CSS canvases
without CSS scaling: it is not fullscreen raster/composition equivalence.

Buffer/DPR/context checks apply at the **start/readiness and final retrieval endpoints
only**, not continuously. They require DPR 1, foreground 3440×1440 and nebula 1548×648,
preserving its separate 0.45 DPR cap, plus a non-null 2D context, a non-lost WebGL context
and matching WebGL drawing-buffer bounds. They do not prove pixels, GPU acceleration/completion, presented
FPS, smoothness or speedup.

## Exact report contract

Normal success exits 0 after Qt teardown and emits one JSON payload, at most 16,384 bytes
before its newline. Qt/Chromium diagnostics may separately appear on stderr. Schema
notation below lists exact keys, not a sample measurement:

```text
Report = { kind: "native-processing", status: "synchronous-layer-attribution",
           checkpoint: Checkpoint, attribution: Attribution }
Checkpoint = { ok: true, dpr: 1, css: [3440, 1440], foreground: [3440, 1440],
               nebula: [1548, 648], nebulaCap: 0.45 }
Attribution = { version: 1, warmup: 30, count: 120, timestampRangeMs: [firstMs, lastMs],
                clock: Clock, frame: Stats, stages: [17 ordered Stage objects], residual: Stats }
Clock = { reads: 5400, zeroDeltas, minimumPositiveDeltaMs, residualToleranceMs: 0 }
Stats = { count: 120, meanMs, medianMs, p95Ms, firstHalfMeanMs, secondHalfMeanMs }
Stage = { name, ...Stats }
```

The exact stage order is:

```text
renderNebula, ensureSprites, drawSoftOvalFields, drawStars, drawRadialStreaks,
drawLensFlares, drawChromaticSideLoops, drawSegmentedSphere, drawAtomicOrbits,
drawOrbitBlocks, drawCentralOctagon, drawTriangularPrism, drawPerspectiveRays,
drawCentralCore, drawFilmGrain, drawVignette, renderAlertOverlay
```

Halves contain 60 samples each; median averages the two middle sorted values, and p95
uses nearest rank (114th of 120). Timestamps are the first/last sampled render arguments,
not fixed times. Native validation rejects wrong types, extra keys, wrong counts/order,
nonfinite or negative durations and malformed/inconsistent summaries. Duration statistics
are bounded to 15,000 ms; timestamp endpoints are nonnegative safe-number values, strictly
increasing and at most 15,000 ms apart. Mean/half-mean arithmetic consistency tolerance
is `1e-7` ms, not a measurement error bound.

Clock reads cover warmup and samples: 150 × (2 frame + 34 stage reads) = 5,400.
`zeroDeltas` is an integer from 0 to 5,398; the minimum positive observed step must be
positive and at most 15,000 ms. **It is not calibrated clock resolution or an error bound.**
Every negative residual is rejected, including tiny negatives; nothing is silently
clamped. Always report `zeroDeltas`, `reads` and `minimumPositiveDeltaMs` alongside the
interpretation (mark them unavailable if failure prevents a summary; never invent them).

Failure reports exactly `kind: "native-processing"`, `status: "failure"` and a bounded
`reason`: exit 2 for preflight/platform, 3 for load/checkpoint/attribution/normal timeout,
4 for emergency deadline/setup failure. No partial attribution is accepted as success.

## Predeclared decision screens for the one N5 measurement

These are **parent-side interpretation rules chosen before launch**, additional to the
implemented schema checks. They are conservative heuristics, not statistical guarantees.
Reject missing/nonfinite inputs and check every denominator is positive **before division**.
Let `q = clock.minimumPositiveDeltaMs`, `F` = frame, `R` = residual and `S` = one candidate
stage. Subscripts 1/2 denote the two half means.

| Gate | Required evidence |
|---|---|
| Valid run | 120 samples, all 17 ordered stages each with count 120, 30 complete warmups; no errors, deadline or forced cleanup; unchanged start/final endpoints and complete containment audit |
| Frame stability | `max(F1,F2)/min(F1,F2) <= 1.25`; frame median > 0; frame `p95/median <= 3` |
| Residual | `R1/F1 < 0.25` **and** `R2/F2 < 0.25` |
| Candidate dominance | Stage `S1/F1 >= 0.25` **and** `S2/F2 >= 0.25` |
| Candidate stability | `max(S1,S2)/min(S1,S2) <= 1.25`; stage `p95/median <= 3` |
| Candidate timing floor | Each stage half mean `>= max(1 ms, 20*q)`; stage median `>= max(0.5 ms, 10*q)` |

A candidate must pass **every** stage screen, with all run/frame/residual gates passing.
On any run-level gate failure or no qualifying candidate, report:
**“CPU-side target unresolved; asynchronous attribution gap remains.”**
Do not automatically retry, expand infrastructure or make speculative optimizations.
Even a qualifying stage is only a target for investigation, not proof of a speedup.
