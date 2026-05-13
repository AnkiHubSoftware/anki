# PR #4029 — Shift Editor Control to TypeScript: Playwright POC

**Status:** Implemented. All 10 test cases passing in ~11s. Target PR: <https://github.com/ankitects/anki/pull/4029>. Parent issue: <https://github.com/ankitects/anki/issues/3830>.

This document is the as-built record. Earlier drafts assumed a CDP-attach architecture; that was wrong. The actual architecture, lessons that took empirical work to discover, and the per-suite contract under test are below.

## Architecture

PR #4029 ports Anki's note editor from Qt/Python to SvelteKit. The new editor is served by Anki's in-process Flask mediasrv at `http://127.0.0.1:<port>/editor/?mode=add|browser|current` over plain HTTP. QtWebEngine is one HTTP client of that server; Playwright launches its own Chromium and is another. Tests run as standard `@playwright/test` specs — no CDP attach to QtWebEngine, no `connectOverCDP`.

```
Anki subprocess ──► QtWebEngine ──► mediasrv (Flask, port 40000)
                                         ▲
                                         │ http://127.0.0.1:40000/editor/?mode=add
                                         │
                                  Playwright's Chromium
                                  (launched per-test by @playwright/test)
```

### Why this works

The editor's `/_anki/*` calls are plain `fetch()` from the renderer. mediasrv serves any HTTP client. The only friction points the harness must paper over:

| Friction | Resolution |
| --- | --- |
| API auth check rejects external clients | `ANKI_API_HOST=0.0.0.0` env var — the documented testing escape. Bypasses the Bearer-token check in `_have_api_access()`. |
| mediasrv picks a random port at startup | `ANKI_API_PORT=40000` env var pins it. |
| Update-prompt dialog on startup | Seed `meta["check_for_updates"] = False` in `prefs21.db`. The `suppressUpdate` key alone is not enough — it's keyed on version string, not boolean. |
| `window.bridgeCommand` / `window.pycmd` undefined (QWebChannel-only) | Stub via `page.addInitScript`. Calls land in `window.__bridgeCalls: string[]` for assertion. |
| Editor doesn't bootstrap without Python calling `loadNote()` | Test fires `page.evaluate("loadNote({initial: true})")` to trigger the same RPC flow Python would. |

### Playwright wrinkles worth knowing

- **Response bodies via `waitForResponse(...).body()` are unreliable** for non-intercepted `fetch()` responses — they return 0 bytes even when content-length is non-zero. Tests that need to read a response body must intercept with `page.route`, call `route.fetch()`, capture the body, and `route.fulfill({response})`. See `duplicate-detection.spec.ts` for the pattern.
- **Request bodies via `waitForRequest(...).postDataBuffer()` are reliable.** This is the canonical way to assert on RPC payloads (e.g. note-add-roundtrip).
- **Shadow DOM piercing** happens automatically when you chain `.locator()` calls. There is no `pierce/` selector prefix — that was an early dead end.
- **Toast assertions are fragile.** The editor's success toast auto-dismisses in 500 ms; polling can miss it. Assert on durable downstream state (a follow-up RPC, a DOM reset) instead.
- **Exact button names matter.** `getByRole("button", { name: "Add" })` matches both the submit Add and the tag-editor "Add tag". Always pass `exact: true` when there's any chance of duplicates.

## Files

### Harness
- `qt/tests/launch_anki_for_e2e.py` — standalone launcher. Seeds `prefs21.db` (skipping first-run + update-prompt) and spawns Anki with the env above. Invoked by Playwright's `webServer` config.
- `playwright.config.ts` — `webServer.command` runs the launcher; `baseURL` is the mediasrv URL; `workers: 1` because the collection is shared mutable state.
- `ts/tests/e2e/fixtures.ts` — `editorPage` (navigated + bridge stubbed) and `editor` (above + `loadNote()` invoked + fields rendered) fixtures.

### Test recipe
```
just test-e2e        # runs `yarn playwright test`
```

## Test scenarios

Each scenario is one `.spec.ts` file with one or two `test()` blocks under a `describe`. Files are named after the contract they protect.

### Suite 0 — Harness sanity
**File:** `ts/tests/e2e/harness-sanity.spec.ts`

Foundational checks the rest of the suite depends on:

1. **`editor page is served and SvelteKit hydrates`** — `.note-editor` mounts on navigation; `window.__bridgeCalls` records `editorReady`.
2. **`loadNote() drives the full bootstrap RPC sequence`** — invoking `loadNote({initial: true})` fires `defaultsForAdding`, `newNote`, `getNotetype`, `getFieldNames`, `noteFieldsCheck` in turn. Validates the editor-to-backend wiring end-to-end.
3. **`page.route() intercepts /_anki/* fetches`** — confirms the network-interception capability that every downstream suite relies on.

### Suite B — Note add roundtrip
**File:** `ts/tests/e2e/note-add-roundtrip.spec.ts`

Types `Hello World` / `Goodbye World` into the two fields, clicks Add, asserts:
- `/_anki/addNote` request body decodes to `AddNoteRequest` with the typed field values and a non-zero `deckId`
- `/_anki/noteFieldsCheck` fires during typing (the 600ms debounce) but `/_anki/updateNotes` does NOT (add mode contract)
- After Add: a fresh `/_anki/newNote` fires (form-reset signal) and the first field is empty
- `window.__bridgeCalls` contains `'saved'` (the `bridgeCommand('saved')` in `saveNow()`)
- Toast is deliberately not asserted; the 500 ms auto-dismiss is too short to be reliable

### Suite C — Sticky field toggle
**File:** `ts/tests/e2e/sticky-field.spec.ts`

Clicks the sticky badge on field 0. Asserts:
- `/_anki/getNotetype` then `/_anki/updateNotetype` fire in order
- The decoded `Notetype` request body has `fields[0].config.sticky` flipped
- `window.__bridgeCalls` does NOT contain `toggleSticky:0` (i.e. the legacy bridge path is dead)
- The badge gains the `highlighted` CSS class
- Toggling again flips back to `sticky=false`

The sticky badge is found via `.field-container` nth(0) (not `.editor-field`, which is only the input body). Hover is required to make the badge clickable.

### Suite D — Duplicate detection
**File:** `ts/tests/e2e/duplicate-detection.spec.ts`

1. Adds a note with a unique probe string (`dupe-probe-<timestamp>`)
2. Waits for form reset
3. Retypes the same probe and intercepts `/_anki/noteFieldsCheck` via `page.route` to read each response body
4. Asserts at least one response decodes to `state === DUPLICATE`
5. Asserts the `.editor-field` element at index 0 gains the `dupe` class and a `.duplicate-link` with "Show Duplicates" text appears
6. Clears the field; asserts the class and link disappear

This suite is the one that uncovered the response-body-readback issue — early versions used `waitForResponse().body()` and saw zero bytes even when the backend returned a real response.

### Suite E — Paste HTML filter
**File:** `ts/tests/e2e/paste-filter.spec.ts`

Dispatches a synthetic `paste` `ClipboardEvent` with `text/html` set to `<p>Paragraph One</p><p>Paragraph Two</p>` on the first field's `anki-editable`. Asserts:
- The contenteditable's `innerHTML` contains `<div>Paragraph One</div><div>Paragraph Two</div>` and zero `<p>` tags (proves the `convertToDiv` rule in `ts/lib/html-filter/element.ts` ran client-side, replacing the Python BeautifulSoup filter)
- The persisted `addNote` request body contains `<div>` and no `<p>`

The paste event must be constructed inside `evaluate()` because Playwright's Node-side `dispatchEvent` doesn't populate `clipboardData`.

### Suite F — Media from URL
**File:** `ts/tests/e2e/media-from-url.spec.ts`

Mocks `/_anki/addMediaFromUrl` via `page.route` to return a synthetic `AddMediaFromUrlResponse{filename: "pasted-image.jpg"}`. Pastes a `text/uri-list` containing `https://example.com/image.jpg`. Asserts:
- The intercepted request body decodes to `AddMediaFromUrlRequest{url: "https://example.com/image.jpg"}`
- The field's `innerHTML` ends up containing `<img src="...pasted-image.jpg">`
- No external HTTP request is fired (verified by failing the test if any non-127.0.0.1 host is contacted)

Important: `text/html` cannot be set on the DataTransfer because the paste handler short-circuits to raw-HTML mode when html is present and never calls `addMediaFromUrl`. URI-list is the trigger.

### Suite G — Close prompt
**File:** `ts/tests/e2e/close-prompt.spec.ts`

Two tests, one per close branch:

1. **`close with unsaved content fires closeAddCards with val=true`** — type into a field, click Close, decode the intercepted `/_anki/closeAddCards` request as `generic.Bool`, assert `val === true` (because `shouldPromptBeforeClosing()` returns true)
2. **`close with empty fields fires closeAddCards with val=false`** — click Close without typing; decoded `val === false`

The native Qt Discard MessageBox never appears because (a) we're not in QtWebEngine and (b) the route handler returns an empty 200, so the request never reaches Python. The original plan worried about the dialog as a hard limitation — turned out to be a non-issue once we stopped assuming a QtWebEngine attach.

## Suites dropped from the original plan

- **Suite A — Mode Toggle (Shift key).** The Shift-toggle between legacy and new editors is a Qt menu interaction outside the WebEngine. Playwright in this architecture never goes through Anki's Qt menu, so there's no way to exercise the toggle from a test. Suite 0 covers the "new editor loads at `editor/?mode=add`" half; the "legacy editor opens when Shift is held" half is unreachable.

## Scope and known gaps

What this POC proves:
- The contract between the new editor and the Rust backend (RPC payloads on add, sticky, duplicate-check, media-from-URL, close)
- The client-side TS html-filter actually runs (and produces the same output the Python BeautifulSoup filter did)
- The editor boots correctly when handed a `loadNote` call
- DOM state changes (duplicate class, sticky `highlighted` class, form reset) follow the right RPCs

What it does NOT cover:
- The QtWebEngine integration itself (`pycmd` plumbing, the `editorReady` → `_set_ready` Python callback dance, Qt menu wiring, the Shift-toggle). For those, a separate Qt-driven harness — pytest-qt or the existing raw-CDP `test_webview_ipc.py` — is the right tool.
- Native Qt dialogs (Discard MessageBox, file picker, Profile chooser). Out of reach by design.
- macOS-specific behaviors (`parentWindow.activateWindow()`).
- Add-on hook compatibility (`editor_will_munge_html`, `editor_will_load_note` etc.). The hooks accept `Editor | NewEditor` but several pass a Python `Note` that the new editor doesn't hold — out of scope for these tests; needs a Python-side check.

## Lessons reusable for future Playwright work in this codebase

1. Anki's mediasrv is the natural test target for any SvelteKit page. Pin it via `ANKI_API_PORT`, open the API via `ANKI_API_HOST=0.0.0.0`, and Playwright can drive any of the pages (`deck-options`, `import-csv`, `image-occlusion`, etc.) the same way the editor is driven here.
2. The `addInitScript` bridge stub + `loadNote()` invocation pattern generalizes to any page that expects Python-side setup calls.
3. Profile seeding (`prefs21.db` with a pre-canned `_global` row + a per-profile row) skips first-run + profile-chooser dialogs deterministically; the same shape works for any test that needs a clean Anki subprocess.
4. Use `page.route` + `route.fetch()` + `route.fulfill({response})` whenever you need to assert on a response body. Don't trust `waitForResponse().body()` for fetch responses.
