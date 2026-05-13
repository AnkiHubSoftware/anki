// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { defineConfig } from "@playwright/test";

const MEDIASRV_PORT = process.env.ANKI_API_PORT ?? "40000";

// Use the project's built Python venv directly — avoids uv project-sync
// overhead (and its exit-250 internal errors in fresh CI environments where
// the lock-file re-resolution fails).  The launcher script only needs stdlib,
// and out/pyenv is always present after `just build` or `./ninja pyenv`.
const PYENV_PYTHON = process.platform === "win32"
    ? "out\\pyenv\\Scripts\\python.exe"
    : "out/pyenv/bin/python";

export default defineConfig({
    testDir: "./ts/tests/e2e",
    // The shared Anki backend holds collection state; concurrent workers
    // would race on it. One worker, serial tests.
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: process.env.CI ? "github" : "list",
    use: {
        baseURL: `http://127.0.0.1:${MEDIASRV_PORT}`,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    webServer: {
        command: `${PYENV_PYTHON} qt/tests/launch_anki_for_e2e.py`,
        // The launcher pins mediasrv to ANKI_API_PORT via env. Polling the
        // editor URL itself confirms the SvelteKit page is being served, not
        // just that the port is open.
        url: `http://127.0.0.1:${MEDIASRV_PORT}/editor/?mode=add`,
        timeout: 60_000,
        reuseExistingServer: process.env.ANKI_E2E_REUSE_SERVER === "1",
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ANKI_API_PORT: MEDIASRV_PORT,
        },
    },
});
