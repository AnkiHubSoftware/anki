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

import json
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
    """Pre-create prefs21.db so Anki skips first-run dialogs and auto-opens TEST_PROFILE.

    Without this, Anki shows the language picker on first run and the Profiles
    chooser when -p references a profile that doesn't exist yet.
    """
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
    profile = {
        "mainWindowGeom": None,
        "mainWindowState": None,
        "numBackups": 50,
        "lastOptimize": int(time.time()),
        "searchHistory": [],
        "syncKey": None,
        "syncMedia": True,
        "autoSync": False,
        "allowHTML": False,
        "importMode": 1,
        "lastColour": "#00f",
        "stripHTML": True,
        "deleteMedia": False,
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
    conn.execute(
        "insert into profiles values (?, ?)",
        (TEST_PROFILE, pickle.dumps(profile, protocol=4)),
    )
    conn.commit()
    conn.close()


def _wait_for_main_window(timeout: float = 45.0) -> None:
    """Wait until the main webview's QWebChannel bridge is initialized.

    Three layers of readiness:
    1. CDP HTTP port responds (Qt is up)
    2. A page titled 'main webview' exists (profile picker has been dismissed)
    3. window.bridgeCommand is a function (QWebChannel connect callback has fired)
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            pages = requests.get(f"{CDP_HTTP}/json", timeout=1).json()
            main = next((p for p in pages if p["title"] == "main webview"), None)
            if main is not None:
                ws = websocket.create_connection(main["webSocketDebuggerUrl"])
                try:
                    ws.send(
                        json.dumps(
                            {
                                "id": 1,
                                "method": "Runtime.evaluate",
                                "params": {
                                    "expression": "typeof window.bridgeCommand",
                                    "returnByValue": True,
                                },
                            }
                        )
                    )
                    while True:
                        msg = json.loads(ws.recv())
                        if msg.get("id") == 1:
                            value = msg.get("result", {}).get("result", {}).get("value")
                            if value == "function":
                                return
                            break
                finally:
                    ws.close()
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError(
        f"window.bridgeCommand not ready on port {CDP_PORT} within {timeout}s"
    )


@pytest.fixture(scope="session")
def anki_process(
    tmp_path_factory: pytest.TempPathFactory,
) -> Generator[subprocess.Popen, None, None]:
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
    _wait_for_main_window()
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
