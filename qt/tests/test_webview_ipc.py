# Copyright: Ankitects Pty Ltd and contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""
POC integration tests for Anki's webview IPC (bridgeCommand / pycmd).
Requires conftest.py to have launched a temporary Anki instance.
"""

from __future__ import annotations

import json
from itertools import count
from typing import Any

import websocket

_msg_id = count(1)


def _evaluate(
    ws: websocket.WebSocket, expression: str, *, await_promise: bool = False
) -> Any:
    mid = next(_msg_id)
    ws.send(
        json.dumps(
            {
                "id": mid,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": expression,
                    "awaitPromise": await_promise,
                    "returnByValue": True,
                },
            }
        )
    )
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            return msg.get("result", {}).get("result", {}).get("value")


def test_expected_webviews_exist(cdp_pages: dict[str, str]) -> None:
    assert "main webview" in cdp_pages
    assert "top toolbar" in cdp_pages
    assert "bottom toolbar" in cdp_pages


def test_bridge_command_is_injected(main_ws: websocket.WebSocket) -> None:
    assert _evaluate(main_ws, "typeof window.bridgeCommand") == "function"


def test_bridge_command_one_way(main_ws: websocket.WebSocket) -> None:
    result = _evaluate(main_ws, "window.bridgeCommand('domDone'); 'ok'")
    assert result == "ok"


def test_bridge_command_round_trip(main_ws: websocket.WebSocket) -> None:
    result = _evaluate(
        main_ws,
        """
        new Promise((resolve) => {
            window.bridgeCommand('domDone', (data) => resolve(data ?? 'null-callback'));
            setTimeout(() => resolve('timeout'), 500);
        })
        """,
        await_promise=True,
    )
    assert result != "timeout", "QWebChannel did not call back into JS within 500 ms"
