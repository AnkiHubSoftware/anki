set windows-shell := ["cmd.exe", "/c"]

mod release

# Show available commands
default:
    @just --list

# Build the project and local dev/test browser dependency
build: _install-playwright-browsers
    {{ ninja }} pylib qt

# Build wheels (needed for some platforms)
wheels:
    {{ ninja }} wheels

# Build and run all checks (lint + test) - lets ninja handle dependencies
check:
    {{ ninja }} pylib qt check

# Run all tests (Rust, Python, TypeScript). Pass --coverage to enforce coverage, and --html to include HTML reports.
[arg("coverage", long="coverage", value="--coverage")]
[arg("html", long="html", value="--html")]
test coverage='' html='':
    just {{ if coverage == "--coverage" { "coverage " + html } else { "_test" } }}

# Run coverage for Rust, Python, TypeScript, and Svelte-related Vitest tests
[arg("html", long="html", value="--html")]
coverage html='':
    just _coverage-rust {{ html }}
    just _coverage-py {{ html }}
    just _coverage-ts {{ html }}

# Run Rust tests. Pass --coverage to enforce Rust coverage, and --html to include an HTML report.
[arg("coverage", long="coverage", value="--coverage")]
[arg("html", long="html", value="--html")]
test-rust coverage='' html='':
    just {{ if coverage == "--coverage" { "_coverage-rust " + html } else { "_test-rust" } }}

# Run Python tests. Pass --coverage to enforce pylib and Qt Python coverage, and --html to include HTML reports.
[arg("coverage", long="coverage", value="--coverage")]
[arg("html", long="html", value="--html")]
test-py coverage='' html='':
    just {{ if coverage == "--coverage" { "_coverage-py " + html } else { "_test-py" } }}

# Run TypeScript/Svelte-related Vitest tests. Pass --coverage to enforce Vitest coverage, and --html to include an HTML report.
[arg("coverage", long="coverage", value="--coverage")]
[arg("html", long="html", value="--html")]
test-ts coverage='' html='':
    just {{ if coverage == "--coverage" { "_coverage-ts " + html } else { "_test-ts" } }}

[private]
_test:
    {{ ninja }} check:rust_test check:pytest check:vitest

[private]
_test-rust:
    {{ ninja }} check:rust_test

[private]
_test-py:
    {{ ninja }} check:pytest

[private]
_test-ts:
    {{ ninja }} check:vitest

[private]
_coverage-rust html='':
    mkdir -p out/coverage/rust out/bin
    test -x out/bin/cargo-llvm-cov || cargo install cargo-llvm-cov --version 0.8.4 --locked --root out
    ANKI_TEST_MODE=1 out/bin/cargo-llvm-cov llvm-cov --workspace --locked --json --summary-only --output-path out/coverage/rust/coverage-summary.json --fail-under-lines 60
    {{ if html == "--html" { "ANKI_TEST_MODE=1 out/bin/cargo-llvm-cov llvm-cov report --html --output-dir out/coverage/rust/html" } else { "true" } }}

[private]
_coverage-py html='':
    {{ ninja }} pylib qt
    just _coverage-py-pylib {{ html }}
    just _coverage-py-qt {{ html }}

[private]
_coverage-py-pylib html='':
    mkdir -p out/coverage/python-pylib
    PYTHONPATH=out/pylib ANKI_TEST_MODE=1 out/pyenv/bin/python -m coverage run --source=pylib/anki --data-file=out/coverage/python-pylib/.coverage -m pytest -p no:cacheprovider pylib/tests
    out/pyenv/bin/python -m coverage json --data-file=out/coverage/python-pylib/.coverage -o out/coverage/python-pylib/coverage-summary.json
    out/pyenv/bin/python -m coverage report --data-file=out/coverage/python-pylib/.coverage --fail-under=65
    {{ if html == "--html" { "out/pyenv/bin/python -m coverage html --data-file=out/coverage/python-pylib/.coverage -d out/coverage/python-pylib/html --fail-under=65" } else { "true" } }}

[private]
_coverage-py-qt html='':
    mkdir -p out/coverage/python-qt
    PYTHONPATH=pylib:out/pylib:out/qt ANKI_TEST_MODE=1 out/pyenv/bin/python -m coverage run --source=qt/aqt --data-file=out/coverage/python-qt/.coverage -m pytest -p no:cacheprovider qt/tests
    out/pyenv/bin/python -m coverage json --data-file=out/coverage/python-qt/.coverage -o out/coverage/python-qt/coverage-summary.json
    out/pyenv/bin/python -m coverage report --data-file=out/coverage/python-qt/.coverage --fail-under=20
    {{ if html == "--html" { "out/pyenv/bin/python -m coverage html --data-file=out/coverage/python-qt/.coverage -d out/coverage/python-qt/html --fail-under=20" } else { "true" } }}

[private]
_coverage-ts html='':
    {{ ninja }} node_modules ts:generated
    mkdir -p out/coverage/typescript
    {{ yarn }} vitest:once --coverage.enabled true --coverage.provider=v8 --coverage.reporter=text-summary --coverage.reporter=json-summary {{ if html == "--html" { "--coverage.reporter=html" } else { "" } }} --coverage.reportsDirectory=../out/coverage/typescript --coverage.thresholds.lines=5

[private]
_install-playwright-browsers:
    {{ ninja }} node_modules
    {{ playwright_env }} {{ yarn }} playwright install chromium

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

# Run TS Playwright e2e tests against a temporary Anki instance.
test-e2e *args: _install-playwright-browsers
    {{ ninja }} pyenv ts:generated pylib qt
    {{ playwright_env }} {{ yarn }} playwright test {{ args }}

# Helpers to get the right commands for the platform

ninja := if os() == "windows" { "tools\\ninja" } else { "./ninja" }
playwright_env := if os() == "windows" { "set PLAYWRIGHT_BROWSERS_PATH=out\\playwright-browsers&&" } else { "PLAYWRIGHT_BROWSERS_PATH=out/playwright-browsers" }
yarn := if os() == "windows" { "out\\extracted\\node\\yarn.cmd" } else { "out/extracted/node/bin/yarn" }
