# Windows-portable contract tests

## Objective and intent
Make the non-Qt6 contract tests pass when the suite runs on a Windows dev checkout, without weakening
what they verify on Linux. Linux stays the source of truth: every assertion must still run there.

Status: **closed.** Fixes applied and verified on Linux; Windows verification dropped (development is Linux-only from now on). Verdict: no product
bug, every failure is test portability (see Progress).

## Context
- `3e4ae36` made source reads CRLF-safe (`readText()` in `tests/paths.mjs`); the hash pins pass on
  CRLF and LF checkouts.
- On Windows `node --test tests/*.test.mjs` then leaves ~164 failures:
  - 155 Qt6/CMake harness failures ("Configuring incomplete"): expected, Qt6 is not installed there.
  - **9 failures below**: the scope of this task.

## Failing tests and suspected causes

| Test file | Tests | Suspected cause on Windows |
|---|---|---|
| `tests/hypr-binds-lua.contract.test.mjs` | 3 | `statSync(file).mode & 0o777` checks (0o640 / 0o600 / 0o644): NTFS has no POSIX permission bits, so `chmod` is a no-op and stat reports 0o666. |
| `tests/hypr-binds-lua.contract.test.mjs` | 1 | "a path with a space, quotes and a backslash survives Lua and sh quoting": NTFS forbids `"` in names and treats `\` as a separator, so the fixture path cannot exist. |
| `tests/hypr-binds.contract.test.mjs` | 1 | "target: Omarchy bindings.conf first…": the script returns `"$dir/<file>"` (POSIX `/`), the test compares with `path.join`, which uses `\` on Windows. |
| `tests/hypr-binds.contract.test.mjs` | 1 | "add is idempotent, keeps the user lines and mode…": same POSIX mode check as above. |
| `tests/diagnostics.contract.test.mjs` | 2 | Child stderr lines end in `\r`: a MinGW build writes stdout/stderr in CRT text mode, turning each `\n` into `\r\n`. |
| `tests/reconstruction.contract.test.mjs` | 1 | Confirmed by reading: "extracted actual ownership destructor with fake objects" (plain `c++`, no Qt). `^FAKE_(VIEW\|PROFILE)_COMPLETE$` and the exact lifecycle lines break on the trailing `\r`: same CRT text-mode cause as diagnostics. |

## Proposed approach (from the stopped attempt)
- `tests/paths.mjs`: add `nativeOutput(text)` that converts `\r\n` to `\n` **only on win32**, so a stray
  `\r` still fails on Linux. Use it for spawned native program stderr in diagnostics and reconstruction.
- Mode checks: guard with `const POSIX_MODES = process.platform !== 'win32'` so Linux keeps the full
  assertion.
- Quoting test: `skip: process.platform === 'win32' && '<reason>'` only for the path that cannot exist on
  NTFS; Linux keeps the coverage.
- Target test: compare with `` `${dir}/hyprland.conf` `` (what the script actually builds) instead of
  `path.join`.

## Acceptance criteria
- On Linux: the 4 touched test files pass with no assertion removed or skipped.
- On Windows: those 9 tests pass (or skip only where the fixture cannot exist on NTFS, with a reason).
- Full suite on Windows: only the Qt6/CMake harness failures remain; nothing new fails.

## Tasks
- [x] W1 Confirm each cause. Done by reading the code on Linux, reconstruction included; the failures
      were not re-run on Windows.
- [x] W2 Apply the test-side fixes above; no changes under `src/`, `scenes/` or `integrations/` (no
      product bug found). Route: inline (small, mechanical, already-understood edits).
- [x] W3 Verify on Linux (touched files + full suite). Windows verification dropped by user decision
      (2026-10-04): all work happens on Linux.

## Progress
- Linux: 4 touched files 28/28 pass, no assertion removed or skipped; full suite 350/350 pass.
- `tests/paths.mjs`: `POSIX_MODES` and `nativeOutput()` (normalizes `\r\n` only on win32).
- Branch `fix/windows-portable-tests`, merged into `main` with `--no-ff`.

## Next step
None. Native review approved and acknowledged (`review-f42448d184b16b5f`).
