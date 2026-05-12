#!/usr/bin/env python
"""POC: call bridgeCommand in an Anki Qt webview via the CDP WebSocket."""

import json
import websocket

CDP_WS = "ws://localhost:8080/devtools/page/661A24F76B9743ECACF3DAA138D4DAB0"

_next_id = iter(range(1, 9999))


def evaluate(ws: websocket.WebSocket, expression: str, await_promise: bool = False) -> dict:
    msg_id = next(_next_id)
    ws.send(json.dumps({
        "id": msg_id,
        "method": "Runtime.evaluate",
        "params": {"expression": expression, "awaitPromise": await_promise, "returnByValue": True},
    }))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == msg_id:
            return msg.get("result", {})


def main() -> None:
    ws = websocket.create_connection(CDP_WS)

    # 1. Confirm bridgeCommand is injected by Qt
    r = evaluate(ws, "typeof window.bridgeCommand")
    print("typeof window.bridgeCommand:", r["result"]["value"])

    # 2. Fire a one-way command (no callback)
    evaluate(ws, "window.bridgeCommand('domDone')")
    print("bridgeCommand('domDone'): sent (no response expected)")

    # 3. Round-trip: wrap callback in a Promise so CDP can await it
    roundtrip_js = """
    new Promise((resolve) => {
        window.bridgeCommand('domDone', (result) => resolve(result));
        // fall back after 500 ms if Python sends no data back
        setTimeout(() => resolve('(no callback data)'), 500);
    })
    """
    r = evaluate(ws, roundtrip_js, await_promise=True)
    print("round-trip callback value:", r.get("result", {}).get("value"))

    ws.close()


main()
