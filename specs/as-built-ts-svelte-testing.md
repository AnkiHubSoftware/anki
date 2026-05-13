# Testing Anki's SvelteKit web UI with Playwright

This document captures how — and why — Playwright is used to test the SvelteKit-based pages Anki serves via its in-process Flask mediasrv (the note editor, deck options, image occlusion, import-csv, etc.). It is meant as a reference for anyone adding new tests in `ts/tests/e2e/`, and as the record of decisions that took empirical iteration to find.

## Why Playwright (and not just pytest+CDP)

Anki already has a pytest harness in `qt/tests/conftest.py` that launches a temporary Anki instance and speaks raw CDP via `websocket-client` to `Runtime.evaluate` JS in the live QtWebEngine views. That layer is great for IPC-level tests — "did `pycmd` reach Python", "did the QWebChannel bridge install correctly" — but it's a poor fit for testing the web UI itself:

- No request interception. CDP's `Runtime.evaluate` can observe but can't mock `fetch`. Testing "did the page call `addNote` with the right payload" requires Playwright-style network routing.
- No locator engine. Asserting on DOM state means hand-rolled `document.querySelector(...).className` evaluations; brittle and verbose.
- No tracing / no screenshots / no auto-waiting. Debugging a failure means digging through console output.

Playwright addresses all three, with one caveat: **its `chromium.connectOverCDP()` does not work against QtWebEngine**. Playwright issues `Browser.setDownloadBehavior` during the connect handshake and QtWebEngine rejects it with `Browser context management is not supported`. The connection aborts before any test code runs.

The way out is to skip QtWebEngine entirely: Anki's mediasrv serves the SvelteKit pages over plain HTTP, so Playwright launches its own full Chromium and `goto()`s the URL like any other web app. The Qt webview is irrelevant to the tests — it's just another HTTP client of the same mediasrv.

## Architecture

```
Anki subprocess ──► QtWebEngine ──► mediasrv (Flask, port 40000)
                                         ▲
                                         │ http://127.0.0.1:40000/<page>
                                         │
                                  Playwright's Chromium
                                  (launched per-test by @playwright/test)
```

Playwright's `webServer` config spawns `qt/tests/launch_anki_for_e2e.py`, which seeds a throwaway `ANKI_BASE`, sets the environment knobs below, and execs Anki. Once mediasrv responds on `http://127.0.0.1:40000/<page>`, Playwright proceeds to run tests against its own Chromium pointed at that URL.

### Files

| Path | Role |
| --- | --- |
| `qt/tests/launch_anki_for_e2e.py` | Standalone subprocess launcher. Seeds `prefs21.db` (skipping first-run + update-prompt) and execs Anki with the right env. |
| `playwright.config.ts` | `webServer.command` invokes the launcher; `baseURL` is the mediasrv URL; `workers: 1` because the collection is shared mutable state. |
| `ts/tests/e2e/fixtures.ts` | `editorPage` (navigated + `bridgeCommand` stubbed) and `editor` (above + `loadNote()` invoked + fields rendered) fixtures. Generalizes to any page; the `loadNote` bootstrap step is editor-specific and lives only in the `editor` fixture. |
| `ts/tests/e2e/*.spec.ts` | One `.spec.ts` per contract under test. |

Run via `just test-e2e` (or `yarn playwright test`).

## Environment knobs that make the harness work

Each of these took digging to discover. None are documented elsewhere in the codebase.

| Knob | Why it's needed |
| --- | --- |
| `ANKI_API_PORT=40000` | Without this, mediasrv picks a random port at startup. Playwright config needs a hard-coded `baseURL`. |
| `ANKI_API_HOST=0.0.0.0` | The documented testing escape in `qt/aqt/mediasrv.py:_have_api_access`. Bypasses the `Authorization: Bearer <_APIKEY>` check that only QtWebEngine injects. Side effect: mediasrv binds to all interfaces — fine locally, not safe in shared environments. |
| `meta["check_for_updates"] = False` (seeded into `prefs21.db`) | Suppresses the version-update prompt at startup. The `suppressUpdate` key alone is insufficient — `qt/aqt/update.py:60` compares it to the new version *string*, not a boolean. The real switch is `check_for_updates` read by `ProfileManager` and gated on in `main.py:setup_auto_update`. |
| `addInitScript` stub of `window.bridgeCommand` / `window.pycmd` | The page expects these to be injected by QWebChannel. Without a stub, every `bridgeCommand("editorReady")` etc. throws `ReferenceError` on mount. The stub records calls into `window.__bridgeCalls: string[]` so tests can assert on what the page tried to tell the host. |
| `page.evaluate("loadNote({initial: true})")` (editor-specific) | The editor doesn't bootstrap on its own — in QtWebEngine, Python calls `web.eval("loadNote(...)")` after receiving the `editorReady` bridge command. Tests fire this manually to trigger the full RPC sequence. Other SvelteKit pages may need analogous trigger calls; check the source for what Python invokes after page load. |

## Playwright behaviors worth knowing

Each of these caused real test failures during development. Save yourself the debugging:

1. **`waitForResponse(...).body()` returns 0 bytes for non-intercepted fetch responses.** The HTTP response on the wire has a real body (verifiable via `Content-Length`), but Playwright's observation path doesn't reliably expose it. When a test needs to read a response body, intercept via `page.route`, call `route.fetch()` to forward and capture, then `route.fulfill({response})`. See `duplicate-detection.spec.ts` for the pattern.

2. **`waitForRequest(...).postDataBuffer()` is reliable** for request bodies. This is the canonical way to assert on outgoing RPC payloads — e.g. "did the Add click really send a request with `fields[0] == 'Hello World'`".

3. **Shadow DOM piercing is automatic** with chained `.locator()` calls. `page.locator(".rich-text-editable").locator("anki-editable")` crosses the shadow boundary without ceremony. There is no `pierce/` selector prefix; that's a dead end.

4. **Ephemeral UI is unreliable to assert on.** The editor's success toast auto-dismisses in 500 ms, which is too short for `expect(...).toBeVisible({timeout: 5000})` polling to catch reliably. Prefer durable signals: follow-up RPCs (`newNote` after Add), DOM state resets (field cleared), bridge-call records.

5. **`getByRole("button", { name: "X" })` matches by substring by default** and will fail if multiple buttons share the name fragment. Always pass `exact: true` when there's any chance of collision. Real example: the editor has both an "Add" submit button and an "Add tag" button in the tag editor.

6. **Some component children are rendered as siblings of their parent's primary div.** In the editor, the StickyBadge is inside `.field-container` but not inside `.editor-field` (which is only the input body, not the label area). Verify with a quick `page.evaluate(() => document.querySelector(...).outerHTML.slice(0, 500))` probe before authoring selectors.

7. **Hover-only elements need `.hover()` before `.click()`.** The sticky badge has `opacity: 0` until the field is hovered or focused. Playwright won't click invisible elements.

## What to test (and what not to)

This approach is well-suited for asserting on contracts at the **SvelteKit-to-mediasrv RPC boundary** and at the **DOM behavior** of pages that are normally embedded in QtWebEngine.

Good fits:

- **RPC payload contracts.** Drive the UI, intercept the outgoing RPC, decode the protobuf body, assert the user's inputs round-tripped correctly. Tightens the contract between TS and Rust.
- **Client-side transformations.** Logic that runs in the browser before content reaches the backend (HTML filters, URL detection in paste handlers, IRI encoding). Test by dispatching the input event and asserting on the resulting DOM or outgoing request body.
- **Negative RPC assertions.** "Mode X should NOT call endpoint Y on every keystroke." Observe traffic, assert absence.
- **State-machine transitions.** Walk the UI through a multi-step interaction and assert on response-state changes plus the DOM reactions they trigger.
- **Mocked-response branches.** Mock an RPC to return a known shape without hitting the real backend, then assert on what the UI does with it. Lets you exercise error paths and remote-only behaviors deterministically.

Poor fits — use a different harness:

- **QtWebEngine integration itself.** `pycmd` plumbing, the bridge-command callback dance with Python, Qt menu interactions, anything that depends on `window.bridgeCommand` actually reaching the host. For these, the existing raw-CDP `test_webview_ipc.py` is the right tool.
- **Native Qt dialogs.** Discard MessageBox, file picker, profile chooser, color picker. They live outside the WebEngine and are unreachable from a browser context. Mock them at the RPC boundary if you need to exercise the surrounding flow.
- **OS-level behaviors.** Window focus, clipboard reads from native apps, drag-and-drop from Finder/Explorer.
- **Add-on hook compatibility.** Python-side hooks need a Python-side check.

## Writing a new test

The minimum viable spec looks like this:

```ts
import { expect, test } from "./fixtures";

test("the contract you're protecting", async ({ editor }) => {
    // 1. (optional) Intercept the RPC you care about:
    const reqPromise = editor.waitForRequest("**/_anki/<endpoint>");

    // 2. Drive the UI:
    await editor.getByRole("button", { name: "X", exact: true }).click();

    // 3. Assert on the request body:
    const req = await reqPromise;
    const decoded = SomeProto.fromBinary(new Uint8Array(req.postDataBuffer()!));
    expect(decoded.fields[0]).toBe("expected");

    // 4. (or) Assert on the DOM:
    await expect(editor.locator(".some-class")).toBeVisible();
});
```

Conventions:

- One contract per test. If you need to assert on two related-but-distinct behaviors, write two `test()` blocks under one `test.describe` (see `close-prompt.spec.ts`).
- Use the `editor` fixture when you want fields already rendered; use `editorPage` when you need to control when `loadNote()` fires (rare).
- Tests share a single Anki collection. If your test mutates state, document it at the top and make the test self-contained (use unique probes, not values another test may have added).
- Use `colgrep` to find selectors and proto message names. e.g. `colgrep -e "addMediaFromUrl" "media from URL handler" ./ts/routes/editor`.

## Existing suite as reference

Each spec is a worked example of one of the patterns above:

- `harness-sanity.spec.ts` — page mounts, bootstrap RPC sequence, route interception works
- `note-add-roundtrip.spec.ts` — `waitForRequest` + protobuf decode + multi-RPC orchestration
- `paste-filter.spec.ts` — synthesized `ClipboardEvent` + DOM-only assertion
- `sticky-field.spec.ts` — hover-then-click + RPC payload + CSS class assertion + bridge-call negative assertion
- `duplicate-detection.spec.ts` — predicate-driven response-body capture via `route.fetch()`
- `media-from-url.spec.ts` — fully mocked RPC response + external-host negative check
- `close-prompt.spec.ts` — two-branch RPC payload assertion (`generic.Bool` with proto3 zero-bytes handling)

## Extending to other mediasrv-served pages

The harness was built for the new editor but is mostly page-agnostic. The same approach should work for any mediasrv-served SvelteKit page (deck-options, import-csv, image-occlusion, etc.):

- The launcher and Playwright config are page-independent.
- The `editorPage` fixture (navigate + bridge stub) generalizes; only the `editor` fixture's `loadNote()` call is editor-specific. For other pages, mirror what Python does post-load and add an analogous fixture.
- Proto encoding/decoding via `@generated/anki/*_pb` works for any RPC.
- The four environment knobs (port, host, update-check, bridge stub) are global to the harness.

For a fresh page, the smallest path is: copy `fixtures.ts`, drop the `loadNote` step, name the fixture after the page's bootstrap call, point a single sanity spec at the new URL, and grow from there.
