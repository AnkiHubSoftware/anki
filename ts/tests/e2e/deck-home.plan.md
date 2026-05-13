# Anki Deck Home Screen Test Plan

## Application Overview

This plan covers Playwright e2e tests for Anki's deck home screen area — specifically the SvelteKit pages and RPC contracts that are reachable from the deck home user flow and testable via the mediasrv harness.

**Architecture note**: The main deck browser list (`DeckBrowser`) is a legacy Qt HTML page served at `/_anki/legacyPageData?id=<webview_id>`. Because the ID is the Python `id()` of a live Qt webview object, there is no stable URL for Playwright to navigate to directly. All user interactions on that page (open deck, rename, delete, collapse, drag-and-drop) are dispatched via `pycmd()` to Python/Qt and are therefore out-of-scope for this Playwright harness (per `specs/as-built-ts-svelte-testing.md`).

What IS in scope are the SvelteKit pages that form the broader deck home experience:

- `/congrats/` — the "you've finished studying" page shown after completing a deck session, which calls `/_anki/congratsInfo`
- `/deck-options/<deckId>` — the deck options page opened from the gear icon on the deck list, which calls `/_anki/getDeckConfigsForUpdate` and `/_anki/updateDeckConfigs`
- `/graphs/` — the statistics page accessible from the deck home toolbar

Additionally, the `/_anki/*` RPC endpoints for deck operations (addDeck, deckTree, setDeckCollapsed, renameDeck, removeDecks, reparentDecks, setCurrentDeck, studiedToday) are callable directly from Playwright and their contracts can be tested independently of the legacy DOM.

Each test file maps to one contract. Tests share a single Anki collection; state-mutating tests use unique deck names and document mutations at the top.

## Test Scenarios

### 1. Congrats Page

**Seed:** `ts/tests/e2e/fixtures.ts`

#### 1.1. congratsInfo RPC is called on page mount and response drives displayed text

**File:** `ts/tests/e2e/deck-home/congrats-info.spec.ts`

**Steps:**

1. Register a response interceptor on `/_anki/congratsInfo` using `captureProtoResponses` before navigating. Decode each response as `CongratsInfoResponse` from `@generated/anki/scheduler_pb`.
2. Navigate to `http://127.0.0.1:40000/congrats/` and wait for the `<h1>` heading to be visible.
   - expect: The page mounts without errors.
   - expect: The heading 'Congratulations! You have finished this deck for now.' is visible.
   - expect: At least one `/_anki/congratsInfo` RPC completes with HTTP 200.
3. Assert the captured `CongratsInfoResponse` is a valid protobuf message (no decode error).
   - expect: The response decodes without throwing.
   - expect: The response object exists (fields may be zero-valued for an empty collection).

#### 1.2. congratsInfo response with reviewRemaining=true shows daily review limit paragraph

**File:** `ts/tests/e2e/deck-home/congrats-info.spec.ts`

**Steps:**

1. Mock `/_anki/congratsInfo` using `mockProtoResponse` to return a `CongratsInfoResponse` with `reviewRemaining: true`, `newRemaining: false`, `haveSchedBuried: false`, `haveUserBuried: false`, `isFilteredDeck: false`, `bridgeCommandsSupported: false`.
2. Navigate to `/congrats/` and wait for the heading to be visible.
3. Assert that the paragraph containing the today-review-limit-reached message is visible.
   - expect: A paragraph with the review limit reached message is present in the DOM.
4. Assert that no new-limit-reached paragraph is visible (since `newRemaining` is false).
   - expect: The new-cards-limit paragraph is absent from the DOM.

#### 1.3. congratsInfo response with newRemaining=true shows daily new-cards limit paragraph

**File:** `ts/tests/e2e/deck-home/congrats-info.spec.ts`

**Steps:**

1. Mock `/_anki/congratsInfo` to return `CongratsInfoResponse` with `newRemaining: true`, `reviewRemaining: false`.
2. Navigate to `/congrats/` and wait for the heading.
3. Assert that the new-cards-limit paragraph is visible.
   - expect: The new-cards-limit paragraph is present and visible.
4. Assert that no review-limit paragraph is present.
   - expect: The review-limit paragraph is absent.

#### 1.4. congratsInfo response with buried cards and bridgeCommandsSupported shows unbury link

**File:** `ts/tests/e2e/deck-home/congrats-info.spec.ts`

**Steps:**

1. Mock `/_anki/congratsInfo` to return `CongratsInfoResponse` with `haveSchedBuried: true`, `haveUserBuried: false`, `bridgeCommandsSupported: true`, `isFilteredDeck: false`.
2. Navigate to `/congrats/` and wait for the heading.
3. Assert that a paragraph containing an 'unbury them' anchor link is present.
   - expect: An anchor with `href` containing `bridgeCommand('unbury')` (or the equivalent bridgeLink) is visible in the DOM.

#### 1.5. congratsInfo response with isFilteredDeck=true hides custom study link

**File:** `ts/tests/e2e/deck-home/congrats-info.spec.ts`

**Steps:**

1. Mock `/_anki/congratsInfo` with `bridgeCommandsSupported: true`, `isFilteredDeck: true`.
2. Navigate to `/congrats/` and wait for the heading.
3. Assert that no 'custom study' link is present in the DOM.
   - expect: The custom study paragraph is absent when the deck is a filtered deck.

#### 1.6. congratsInfo response with deckDescription renders the description block

**File:** `ts/tests/e2e/deck-home/congrats-info.spec.ts`

**Steps:**

1. Mock `/_anki/congratsInfo` with `deckDescription: '<b>My deck description</b>'`.
2. Navigate to `/congrats/` and wait for the heading.
3. Assert that the `.description` div is visible and its text content contains 'My deck description'.
   - expect: The description div is visible.
   - expect: The HTML-rendered description text 'My deck description' appears inside a `.description` container.

#### 1.7. congratsInfo response with no deckDescription omits the description block

**File:** `ts/tests/e2e/deck-home/congrats-info.spec.ts`

**Steps:**

1. Mock `/_anki/congratsInfo` with `deckDescription: ''` (empty string).
2. Navigate to `/congrats/` and wait for the heading.
3. Assert that the `.description` div is not present in the DOM.
   - expect: No `.description` element is rendered when the deck description is empty.

#### 1.8. congratsInfo RPC error is handled gracefully without crashing the page

**File:** `ts/tests/e2e/deck-home/congrats-info.spec.ts`

**Steps:**

1. Mock `/_anki/congratsInfo` to return HTTP 500 with an empty body.
2. Navigate to `/congrats/` and wait for page load.
   - expect: The page does not crash or show an unhandled error overlay.
   - expect: The heading is still visible (the page renders with whatever initial state it has).

### 2. Deck Options Page — Bootstrap and RPC Contracts

**Seed:** `ts/tests/e2e/fixtures.ts`

#### 2.1. deck-options page mounts and fires getDeckConfigsForUpdate on load

**File:** `ts/tests/e2e/deck-home/deck-options-bootstrap.spec.ts`

**Steps:**

1. Before navigating, register a route interceptor for `/_anki/getDeckConfigsForUpdate` using `captureProtoResponses`. Decode responses as `DeckConfigsForUpdate` from `@generated/anki/deck_config_pb`.
2. Navigate to `http://127.0.0.1:40000/deck-options/1` (deck ID 1 is the default deck present in a fresh collection). Wait for the 'Daily Limits' heading to be visible.
   - expect: The page mounts without console errors.
   - expect: The 'Daily Limits' section heading is visible.
   - expect: One `/_anki/getDeckConfigsForUpdate` RPC completes with HTTP 200.
3. Assert the decoded `DeckConfigsForUpdate` response has at least one config.
   - expect: The response contains at least one deck config object.
4. Assert that `/_anki/deckOptionsReady` is called after getDeckConfigsForUpdate completes.
   - expect: The `/_anki/deckOptionsReady` POST completes (HTTP 204).

#### 2.2. Save button fires updateDeckConfigs RPC with the current config payload

**File:** `ts/tests/e2e/deck-home/deck-options-save.spec.ts`

**Steps:**

1. Navigate to `/deck-options/1` and wait for the 'Daily Limits' heading.
2. Record the initial new-cards-per-day value from the first spinbutton (labelled 'New cards/day'). Note this value for later assertion.
3. Set up a `waitForRequest` for `/_anki/updateDeckConfigs` BEFORE clicking Save.
4. Click the 'Save' button (`getByRole('button', { name: 'Save', exact: true })`).
5. Await the `updateDeckConfigs` request. Decode the request body as `UpdateDeckConfigs` from `@generated/anki/decks_pb`.
   - expect: The `updateDeckConfigs` RPC fires exactly once.
   - expect: The decoded request body contains at least one config entry.
   - expect: The new-cards-per-day value in the payload matches the value observed in the UI before saving.

#### 2.3. Changing new cards/day and saving round-trips the value in the RPC payload

**File:** `ts/tests/e2e/deck-home/deck-options-save.spec.ts`

**Steps:**

1. Navigate to `/deck-options/1` and wait for the 'Daily Limits' heading.
2. Find the 'New cards/day' spinbutton. Clear its current value and type '42'.
   - expect: The spinbutton displays '42'.
3. Register `waitForRequest` for `/_anki/updateDeckConfigs`, then click 'Save'.
4. Decode the `updateDeckConfigs` request body. Locate the `newPerDay` field inside the deck config.
   - expect: The decoded payload contains a config with `newPerDay` equal to 42.

#### 2.4. getDeckConfigsForUpdate response with unknown deckId returns an error or empty config list

**File:** `ts/tests/e2e/deck-home/deck-options-bootstrap.spec.ts`

**Steps:**

1. Navigate to `/deck-options/999999999` (a deck ID that does not exist in the fresh collection).
2. Wait 3000 ms for any error state to render.
   - expect: The page either shows an error state or displays an empty / default config form — it must not crash the Playwright context with an unhandled rejection.

#### 2.5. getDeckConfigsForUpdate RPC failure shows an error state rather than an empty form

**File:** `ts/tests/e2e/deck-home/deck-options-bootstrap.spec.ts`

**Steps:**

1. Mock `/_anki/getDeckConfigsForUpdate` to return HTTP 500 with an empty body BEFORE navigating.
2. Navigate to `/deck-options/1` and wait 3000 ms.
   - expect: The 'Daily Limits' heading is absent (form did not render with empty data).
   - expect: An error indicator or empty page is shown instead of form fields.

#### 2.6. Config selector combobox displays the default preset name

**File:** `ts/tests/e2e/deck-home/deck-options-config-selector.spec.ts`

**Steps:**

1. Navigate to `/deck-options/1` and wait for the 'Daily Limits' heading.
2. Locate the config-selector combobox at the top of the page (the first combobox on the page).
   - expect: The combobox is visible and its displayed text contains 'Default'.

### 3. Deck Options Page — Advanced Interactions

**Seed:** `ts/tests/e2e/fixtures.ts`

#### 3.1. Toggling FSRS checkbox does not fire updateDeckConfigs immediately

**File:** `ts/tests/e2e/deck-home/deck-options-fsrs.spec.ts`

**Steps:**

1. Navigate to `/deck-options/1` and wait for the 'Daily Limits' heading.
2. Register a listener on ALL `/_anki/*` requests before interacting.
3. Click the 'FSRS' checkbox to toggle it.
4. Wait 1000 ms.
   - expect: No `updateDeckConfigs` RPC fires during the wait (save is only triggered by the Save button, not by individual field changes).

#### 3.2. Maximum reviews/day spinbutton accepts and displays a valid integer

**File:** `ts/tests/e2e/deck-home/deck-options-save.spec.ts`

**Steps:**

1. Navigate to `/deck-options/1` and wait for the 'Daily Limits' heading.
2. Clear the 'Maximum reviews/day' spinbutton and type '100'.
   - expect: The spinbutton now displays '100'.
3. Register `waitForRequest` for `/_anki/updateDeckConfigs`, then click 'Save'.
4. Decode the `updateDeckConfigs` request. Locate the `reviewsPerDay` field.
   - expect: The payload contains `reviewsPerDay` equal to 100.

#### 3.3. Page-level help button (section collapse toggle) does not trigger any RPC

**File:** `ts/tests/e2e/deck-home/deck-options-bootstrap.spec.ts`

**Steps:**

1. Navigate to `/deck-options/1` and wait for the 'Daily Limits' heading.
2. Register a listener for all `/_anki/*` requests AFTER the page bootstrap RPCs have completed.
3. Click the help/info button (the button with an image icon) next to the 'Daily Limits' heading.
4. Wait 500 ms.
   - expect: No new `/_anki/*` requests fire as a result of clicking the help button.

### 4. Graphs Page — Bootstrap

**Seed:** `ts/tests/e2e/fixtures.ts`

#### 4.1. Graphs page mounts and shows the Today section heading

**File:** `ts/tests/e2e/deck-home/graphs-bootstrap.spec.ts`

**Steps:**

1. Navigate to `http://127.0.0.1:40000/graphs/` and wait for the page to reach DOMContentLoaded.
2. Wait for the 'Today' heading (level 1) to be visible.
   - expect: The heading 'Today' is visible.
   - expect: The search text box with placeholder or value 'deck:current' is visible.

#### 4.2. Graphs page fires graphData or stats RPC on load

**File:** `ts/tests/e2e/deck-home/graphs-bootstrap.spec.ts`

**Steps:**

1. Register a listener on all `/_anki/*` responses before navigating.
2. Navigate to `/graphs/` and wait for the 'Today' heading.
3. Assert that at least one `/_anki/*` RPC was called during page initialisation (e.g. `getGraphPreferences`, `graphs`, or equivalent).
   - expect: At least one stats-related `/_anki/*` endpoint is called during mount.

### 5. Deck RPC Contracts — Direct API Tests

**Seed:** `ts/tests/e2e/fixtures.ts`

#### 5.1. addDeck RPC creates a new deck and returns an OpChangesWithId containing the new deck ID

**File:** `ts/tests/e2e/deck-home/deck-rpcs.spec.ts`

**Steps:**

1. Navigate to `/editor/?mode=add` (any SvelteKit page that has the mediasrv origin context) and wait for `.note-editor` to appear. This gives us a page context from which we can issue `fetch` calls to `/_anki/addDeck`.
2. Using `page.evaluate`, import and call `addDeck` from `@generated/backend` with a unique deck name (e.g. `'e2e-test-addDeck-' + Date.now()`). Capture the returned `OpChangesWithId`.
3. Assert `result.id` is a non-zero BigInt.
   - expect: The `addDeck` RPC returns an `OpChangesWithId` with a non-zero `id` representing the newly created deck.

#### 5.2. deckTree RPC returns a DeckTreeNode with at least the default deck

**File:** `ts/tests/e2e/deck-home/deck-rpcs.spec.ts`

**Steps:**

1. Navigate to `/editor/?mode=add` and wait for `.note-editor`.
2. Call `deckTree({ now: BigInt(0) })` from `@generated/backend` via `page.evaluate`.
3. Assert the returned `DeckTreeNode` has `children.length >= 1`.
   - expect: The deck tree contains at least one child node (the default 'Default' deck).
4. Assert each child node has a non-empty `name` string and a non-zero `deckId`.
   - expect: Each top-level deck entry has a valid name and numeric deck ID.

#### 5.3. renameDeck RPC updates the deck name and is reflected in a subsequent deckTree call

**File:** `ts/tests/e2e/deck-home/deck-rpcs.spec.ts`

**Steps:**

1. Navigate to `/editor/?mode=add` and wait for `.note-editor`. This test mutates collection state — it creates and then renames a deck.
2. Call `addDeck` with a unique original name (e.g. `'e2e-rename-original-' + Date.now()`). Capture the returned deck `id`.
3. Call `renameDeck({ deckId: id, newName: 'e2e-rename-updated-' + Date.now() })`. Capture the `OpChanges` response.
4. Call `deckTree({ now: BigInt(0) })`. Flatten all nodes recursively and find the node with the deck ID from step 2.
   - expect: The node's `name` matches the updated name, not the original name.
   - expect: The `renameDeck` RPC returned an `OpChanges` with at least one change flag set.

#### 5.4. removeDecks RPC deletes the target deck and it no longer appears in deckTree

**File:** `ts/tests/e2e/deck-home/deck-rpcs.spec.ts`

**Steps:**

1. Navigate to `/editor/?mode=add` and wait for `.note-editor`. This test mutates collection state — it creates and then deletes a deck.
2. Call `addDeck` with a unique name (e.g. `'e2e-delete-' + Date.now()`). Capture the returned `id`.
3. Call `removeDecks({ dids: [id] })`. Assert the returned `OpChangesWithCount` has `count >= 1`.
   - expect: The `removeDecks` response indicates at least one deck was removed.
4. Call `deckTree({ now: BigInt(0) })` and flatten all nodes. Assert that no node has the deleted deck ID.
   - expect: The deleted deck ID is absent from the deck tree.

#### 5.5. setDeckCollapsed RPC toggles the collapsed state and it persists in deckTree

**File:** `ts/tests/e2e/deck-home/deck-rpcs.spec.ts`

**Steps:**

1. Navigate to `/editor/?mode=add` and wait for `.note-editor`.
2. Call `deckTree({ now: BigInt(0) })` to get the current state. Find the first top-level deck ID and note its current `collapsed` value (expect `false` in a fresh collection).
3. Call `setDeckCollapsed({ deckId: firstDeckId, collapsed: true, scope: 0 })` (scope 0 = REVIEWER). Assert the response is an `OpChanges`.
   - expect: The `setDeckCollapsed` RPC returns successfully.
4. Call `deckTree({ now: BigInt(0) })` again. Find the same deck node.
   - expect: The node's `collapsed` field is `true`.
5. Restore the state: call `setDeckCollapsed({ deckId: firstDeckId, collapsed: false, scope: 0 })`.
   - expect: The deck is returned to its original uncollapsed state.

#### 5.6. reparentDecks RPC moves a child deck under a new parent and deckTree reflects the hierarchy

**File:** `ts/tests/e2e/deck-home/deck-rpcs.spec.ts`

**Steps:**

1. Navigate to `/editor/?mode=add` and wait for `.note-editor`. This test mutates collection state — two decks are created.
2. Call `addDeck` twice to create a parent deck (`e2e-parent-<ts>`) and a source deck (`e2e-source-<ts>`). Capture both IDs.
3. Call `reparentDecks({ deckIds: [sourceDeckId], newParent: parentDeckId })`. Assert the returned `OpChangesWithCount` has `count >= 1`.
   - expect: The reparent operation reports at least one change.
4. Call `deckTree({ now: BigInt(0) })`. Locate the parent node and traverse its `children`.
   - expect: The source deck ID appears as a direct child of the parent deck node.

#### 5.7. setCurrentDeck RPC updates the active deck and getCurrentDeck reflects the change

**File:** `ts/tests/e2e/deck-home/deck-rpcs.spec.ts`

**Steps:**

1. Navigate to `/editor/?mode=add` and wait for `.note-editor`.
2. Call `addDeck` with a unique name to create a new deck. Capture its `id`.
3. Call `setCurrentDeck({ did: newDeckId })`. Assert the response is a valid `OpChanges`.
   - expect: The `setCurrentDeck` RPC returns successfully.
4. Call `getCurrentDeck({})`. Assert the returned `Deck` has `id` matching the `newDeckId`.
   - expect: The current deck is now the newly created deck.

#### 5.8. studiedToday RPC returns a non-empty string

**File:** `ts/tests/e2e/deck-home/deck-rpcs.spec.ts`

**Steps:**

1. Navigate to `/editor/?mode=add` and wait for `.note-editor`.
2. Call `studiedToday({})` from `@generated/backend` via `page.evaluate`.
3. Assert the returned `generic.String` has a non-empty `val` field.
   - expect: The `studiedToday` response contains a non-empty string (e.g. 'Studied 0 cards in 0 minutes today.').

#### 5.9. addDeck with an empty name string returns an RPC error

**File:** `ts/tests/e2e/deck-home/deck-rpcs.spec.ts`

**Steps:**

1. Navigate to `/editor/?mode=add` and wait for `.note-editor`.
2. Call `addDeck` with `name: ''` via `page.evaluate`. Wrap the call in try/catch and capture the error.
3. Assert that an error is thrown (the backend rejects empty deck names).
   - expect: The `addDeck` call throws or rejects when given an empty name.
   - expect: No new deck with an empty name appears in a subsequent `deckTree` call.
