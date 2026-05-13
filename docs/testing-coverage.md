# Testing and Coverage

Current CI runs Rust, Python, and TypeScript tests, plus lint/type checks. Coverage is orchestrated in `justfile` with direct CLI calls, using ninja only to prepare generated build artifacts that the test commands need.

## Current Snapshot

Measured locally on May 13, 2026:

| Stack                           | Test runner                       | Coverage tool      | Current line coverage | POC minimum |
| ------------------------------- | --------------------------------- | ------------------ | --------------------: | ----------: |
| Rust workspace                  | `cargo test` via `cargo llvm-cov` | `cargo llvm-cov`   |                62.44% |         60% |
| Python `pylib/anki`             | `pytest pylib/tests`              | `coverage.py`      |                69.39% |         65% |
| Python `qt/aqt`                 | `pytest qt/tests`                 | `coverage.py`      |                22.69% |         20% |
| TypeScript/Svelte-adjacent code | `vitest run`                      | Vitest V8 coverage |                 6.58% |          5% |

The generated reports are written under `out/coverage/`.

## What The POC Enforces

`just test --coverage` currently checks that each stack can produce coverage and remains above a low baseline:

- Rust: `cargo-llvm-cov`, minimum `60`.
- Python pylib: `coverage.py` over `pylib/tests`, minimum `65`.
- Python Qt: `coverage.py` over `qt/tests`, minimum `20`.
- TypeScript/Svelte-adjacent Vitest tests: Vitest V8 coverage, minimum `5`.

Linux pull requests run `just test --coverage` by default in `.github/workflows/ci.yml`. The temporary `playwright-poc` push trigger also runs Linux coverage so the fork can validate this POC before the workflow change is reverted. Pushes to `main`, macOS, and Windows keep the existing `just test` behavior for now.

The stack-specific entry points are:

- `just test-rust` / `just test-rust --coverage`
- `just test-py` / `just test-py --coverage`
- `just test-ts` / `just test-ts --coverage`

## Gaps

Svelte does not have a separate component/browser coverage story yet. Current Svelte coverage is only whatever Vitest reaches through imported TypeScript/Svelte modules.

The TypeScript coverage denominator is broad relative to the current eight Vitest test files, so the line percentage is low even though the tests pass.

Rust coverage is meaningful but expensive because `cargo llvm-cov` rebuilds with instrumentation.

Python coverage is split because pylib and Qt use different `PYTHONPATH` setups and test folders.

The coverage recipes still depend on a few build prerequisites: Python coverage runs `./ninja pylib qt`, and TypeScript coverage runs `./ninja node_modules ts:generated`.

## What Would Improve This

Raise thresholds gradually after establishing stable CI timings and excluding generated files where appropriate.

Add component/browser tests for Svelte UI surfaces if Svelte coverage is intended to mean rendered component behavior.

Publish `out/coverage` as a CI artifact so reviewers can inspect reports on failed or low-coverage PRs.

Consider changed-file or diff coverage once the baseline is stable. Whole-repo coverage is useful as a guardrail, but diff coverage is a better enforcement mechanism for incremental improvement.
