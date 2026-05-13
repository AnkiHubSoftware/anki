set windows-shell := ["cmd.exe", "/c"]
set dotenv-load

mod release

# Show available commands
default:
    @just --list

# Build the project
build:
    {{ ninja }} pylib qt

# Build wheels (needed for some platforms)
wheels:
    {{ ninja }} wheels

# Build and run all checks (lint + test) - lets ninja handle dependencies
check:
    {{ ninja }} pylib qt check

# Run all tests (Rust, Python, TypeScript). Pass --coverage to enforce coverage.
test coverage='':
    just {{ if coverage == "--coverage" { "coverage" } else { "_test" } }}

# Run coverage for Rust, Python, TypeScript, and Svelte-related Vitest tests
coverage:
    just _coverage-rust
    just _coverage-py
    just _coverage-ts

# Run Rust tests. Pass --coverage to enforce Rust coverage.
test-rust coverage='':
    just {{ if coverage == "--coverage" { "_coverage-rust" } else { "_test-rust" } }}

# Run Python tests. Pass --coverage to enforce pylib and Qt Python coverage.
test-py coverage='':
    just {{ if coverage == "--coverage" { "_coverage-py" } else { "_test-py" } }}

# Run TypeScript/Svelte-related Vitest tests. Pass --coverage to enforce Vitest coverage.
test-ts coverage='':
    just {{ if coverage == "--coverage" { "_coverage-ts" } else { "_test-ts" } }}

_test:
    {{ ninja }} check:rust_test check:pytest check:vitest

_test-rust:
    {{ ninja }} check:rust_test

_test-py:
    {{ ninja }} check:pytest

_test-ts:
    {{ ninja }} check:vitest

_coverage-rust:
    mkdir -p out/coverage/rust out/bin
    test -x out/bin/cargo-llvm-cov || cargo install cargo-llvm-cov --version 0.8.4 --locked --root out
    ANKI_TEST_MODE=1 out/bin/cargo-llvm-cov --workspace --locked --json --summary-only --output-path out/coverage/rust/coverage-summary.json --fail-under-lines 60

_coverage-py:
    {{ ninja }} pylib qt
    just _coverage-py-pylib
    just _coverage-py-qt

_coverage-py-pylib:
    mkdir -p out/coverage/python-pylib
    PYTHONPATH=out/pylib ANKI_TEST_MODE=1 out/pyenv/bin/python -m coverage run --source=pylib/anki --data-file=out/coverage/python-pylib/.coverage -m pytest -p no:cacheprovider pylib/tests
    out/pyenv/bin/python -m coverage json --data-file=out/coverage/python-pylib/.coverage -o out/coverage/python-pylib/coverage-summary.json
    out/pyenv/bin/python -m coverage report --data-file=out/coverage/python-pylib/.coverage --fail-under=65

_coverage-py-qt:
    mkdir -p out/coverage/python-qt
    PYTHONPATH=pylib:out/pylib:out/qt ANKI_TEST_MODE=1 out/pyenv/bin/python -m coverage run --source=qt/aqt --data-file=out/coverage/python-qt/.coverage -m pytest -p no:cacheprovider qt/tests
    out/pyenv/bin/python -m coverage json --data-file=out/coverage/python-qt/.coverage -o out/coverage/python-qt/coverage-summary.json
    out/pyenv/bin/python -m coverage report --data-file=out/coverage/python-qt/.coverage --fail-under=20

_coverage-ts:
    {{ ninja }} node_modules ts:generated
    mkdir -p out/coverage/typescript
    out/extracted/node/bin/yarn vitest:once --coverage.enabled true --coverage.provider=v8 --coverage.reporter=text-summary --coverage.reporter=json-summary --coverage.reportsDirectory=../out/coverage/typescript --coverage.thresholds.lines=5

# Check formatting (fast, no build needed)
fmt:
    {{ ninja }} check:format

# Fix formatting
fix-fmt:
    {{ ninja }} format

# Run linting and type checking (requires build outputs)
lint:
    {{ ninja }} \
        check:clippy \
        check:mypy \
        check:ruff \
        check:eslint \
        check:svelte \
        check:typescript

# Fix auto-fixable lint issues (ruff + eslint)
fix-lint:
    {{ ninja }} fix:ruff fix:eslint

# Run minilints (copyright, contributors, licenses)
minilints:
    {{ ninja }} check:minilints

# Fix minilints (update licenses.json)
fix-minilints:
    {{ ninja }} fix:minilints

# Sync translation files
ftl-sync:
    {{ ninja }} ftl-sync

# Deprecate translation strings
ftl-deprecate:
    {{ ninja }} ftl-deprecate

# Build documentation site
docs:
    uv run --group docs sphinx-build -b html docs out/docs/html
    @echo "Docs built at out/docs/html/index.html"

# Build and serve documentation site
docs-serve:
    uv run --group docs sphinx-autobuild docs out/docs/html --host 127.0.0.1 --port 8000

# Build Rust API docs
docs-rust:
    cargo doc --open

# Dispatch CI workflow on a given branch or tag
ci branch:
    gh workflow run ci.yml --ref {{ branch }}

# Start Anki in dev mode (env vars loaded from .env)
run:
    out/pyenv/bin/python tools/run.py

# Run integration tests against a temporary Anki instance (starts + tears down automatically)
test-integration *args:
    uv run pytest qt/tests/test_webview_ipc.py -v {{ args }}

# Run TS Playwright e2e tests against a temporary Anki instance
# (Playwright's webServer config invokes qt/tests/launch_anki_for_e2e.py)
test-e2e *args:
    {{ ninja }} node_modules ts:generated pylib qt
    out/extracted/node/bin/yarn playwright test {{ args }}

# Helper to get the right ninja command for the platform
ninja := if os() == "windows" { "tools\\ninja" } else { "./ninja" }
