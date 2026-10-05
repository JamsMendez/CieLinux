# Windows-portable contract tests

## Objective and intent
Make the non-Qt6 contract tests pass when the suite runs on a Windows dev checkout, without weakening
what they verify on Linux. Linux stays the source of truth: every assertion must still run there.

Status: **not started** (handed over to be done on the Linux machine). An attempt on Windows was
stopped before it was verified on Linux; its findings are recorded below as a starting point, not as
proven fixes.

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
| `tests/reconstruction.contract.test.mjs` | 1 | Reported as a fake-process regex mismatch; the attempted fix normalized child stderr the same way as diagnostics. Confirm the real cause. |

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
- [ ] W1 Reproduce the 9 failures (Windows) and confirm each cause, especially reconstruction.
- [ ] W2 Apply the test-side fixes above; no changes under `src/`, `scenes/` or `integrations/` unless a
      real product bug shows up.
- [ ] W3 Verify on Linux (touched files + full suite) and on Windows (touched files + full suite).

## Next step
W1 on the Linux machine: check out `main`, run the 4 files, then repeat on Windows to confirm the
remaining failures.
