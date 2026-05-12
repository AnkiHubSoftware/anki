# Copyright: Ankitects Pty Ltd and contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""
Session-scoped fixtures that launch a throwaway Anki instance for integration
tests and tear it down when the session ends.

Usage:
    just test-integration

Environment (all have defaults; override via .env or shell):
    ANKI_TEST_PORT   CDP port for the test instance (default 8081)
                     Use a different port from the dev instance (8080) so they
                     don't clash when both are running.
"""

from __future__ import annotations

import os
import pickle
import random
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Generator

import pytest
import requests
import websocket

REPO_ROOT = Path(__file__).parent.parent.parent
CDP_PORT = int(os.environ.get("ANKI_TEST_PORT", "8081"))
CDP_HTTP = f"http://localhost:{CDP_PORT}"
TEST_PROFILE = "test"


def _seed_prefs(base: Path) -> None:
    """Pre-create prefs21.db so Anki skips the first-run language picker dialog."""
    meta = {
        "ver": 0,
        "updates": False,
        "created": int(time.time()),
        "id": random.randrange(0, 2**63),
        "lastMsg": 0,
        "suppressUpdate": True,
        "firstRun": False,
        "defaultLang": "en_US",
    }
    db_path = base / "prefs21.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "create table profiles (name text primary key collate nocase, data blob not null)"
    )
    conn.execute(
        "insert into profiles values ('_global', ?)",
        (pickle.dumps(meta, protocol=4),),
    )
    conn.commit()
    conn.close()


def _wait_for_anki(timeout: float = 45.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            requests.get(f"{CDP_HTTP}/json/version", timeout=1)
            return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(
        f"Anki did not expose CDP on port {CDP_PORT} within {timeout}s"
    )


@pytest.fixture(scope="session")
def anki_process(tmp_path_factory: pytest.TempPathFactory) -> Generator[subprocess.Popen, None, None]:
    base = tmp_path_factory.mktemp("anki_base")
    _seed_prefs(base)

    env = {
        **os.environ,
        "ANKI_BASE": str(base),
        "QTWEBENGINE_REMOTE_DEBUGGING": str(CDP_PORT),
        "QTWEBENGINE_CHROMIUM_FLAGS": f"--remote-allow-origins=http://localhost:{CDP_PORT}",
        "ANKIDEV": "1",
        "PYTHONPYCACHEPREFIX": str(REPO_ROOT / "out" / "pycache"),
        "RUST_BACKTRACE": "1",
    }
    python = REPO_ROOT / "out" / "pyenv" / "bin" / "python"
    proc = subprocess.Popen(
        [str(python), str(REPO_ROOT / "tools" / "run.py"), "-p", TEST_PROFILE],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _wait_for_anki()
    yield proc
    proc.terminate()
    proc.wait(timeout=10)


@pytest.fixture(scope="session")
def cdp_pages(anki_process: subprocess.Popen) -> dict[str, str]:
    """Map of webview title -> CDP WebSocket URL."""
    return {
        p["title"]: p["webSocketDebuggerUrl"]
        for p in requests.get(f"{CDP_HTTP}/json").json()
    }


@pytest.fixture
def main_ws(cdp_pages: dict[str, str]) -> Generator[websocket.WebSocket, None, None]:
    ws = websocket.create_connection(cdp_pages["main webview"])
    yield ws
    ws.close()
