// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// spec: Duplicate Detection
// fixture: ts/tests/e2e/fixtures.ts (editor fixture)
//
// NOTE: This test mutates collection state — one real note is persisted to the
// Anki backend as part of the setup step. Cross-test ordering matters until
// per-test isolation is added.
//
// Strategy: Self-contained (Option A). We first add a fresh note with a unique
// probe value, then type that same probe value back to trigger duplicate detection.
// This makes the test resilient to collection state from prior test runs.

import { NoteFieldsCheckResponse, NoteFieldsCheckResponse_State } from "@generated/anki/notes_pb";

import { expect, test } from "./fixtures";
import { captureProtoResponses, editableField, editorField, rpcUrl } from "./helpers";

test.describe("Duplicate Detection", () => {
    test("typing a duplicate first field fires noteFieldsCheck with DUPLICATE state and surfaces UI", async ({ editor }) => {
        // Step 1: Generate a unique probe string to avoid collisions with other test runs.
        const probe = "dupe-probe-" + Date.now().toString();

        // The first field's editable lives inside a shadow DOM: .rich-text-editable > shadow > anki-editable.
        // Chained locator() calls pierce the shadow DOM automatically.
        const firstFieldEditable = editableField(editor, 0);

        // Step 2: Type the probe string into the first field.
        await firstFieldEditable.click();
        await firstFieldEditable.type(probe);

        // Wait for the 600ms debounce to settle by waiting for the duplicate-check RPC.
        await editor.waitForRequest(rpcUrl("noteFieldsCheck"), { timeout: 5_000 });

        // Step 3: Click the Add button to persist the note. Use exact match to avoid
        // matching "Add tag" in the tag editor.
        const addNoteResp = editor.waitForResponse(rpcUrl("addNote"), {
            timeout: 10_000,
        });
        await editor.getByRole("button", { name: "Add", exact: true }).click();
        const addResponse = await addNoteResp;
        expect(
            addResponse.status(),
            `addNote response status ${addResponse.status()}`,
        ).toBeLessThan(400);

        // Wait for the post-add newNote RPC — this is the form-reset signal.
        await editor.waitForRequest(rpcUrl("newNote"), { timeout: 10_000 });

        // Wait for the first field to be cleared (form reset).
        await expect(firstFieldEditable).toBeEmpty({ timeout: 5_000 });

        // Step 4: Intercept noteFieldsCheck via page.route so we can read the
        // response body reliably. (Playwright's waitForResponse + .body() can
        // return empty bytes for non-intercepted fetch() responses — the
        // body is only guaranteed readable inside a route handler that
        // forwards the request via route.fetch().)
        const observedStates: number[] = [];
        let sawDuplicate = false;
        await captureProtoResponses(
            editor,
            "noteFieldsCheck",
            NoteFieldsCheckResponse,
            (decoded) => {
                observedStates.push(decoded.state);
                sawDuplicate ||= decoded.state === NoteFieldsCheckResponse_State.DUPLICATE;
            },
        );

        // Type the SAME probe string — this should trigger a DUPLICATE response.
        await firstFieldEditable.click();
        await firstFieldEditable.type(probe);

        // Wait until at least one observed response had state=DUPLICATE.
        await expect.poll(() => sawDuplicate, {
            timeout: 10_000,
            message: `expected at least one noteFieldsCheck response with state=DUPLICATE, `
                + `observed states: ${JSON.stringify(observedStates)}`,
        }).toBe(true);

        // Step 6: Assert the DOM reflects the duplicate state.
        // EditorField.svelte applies class:dupe to the .editor-field div when
        // the dupe prop is true. NoteEditor.svelte sets cols[0] = "dupe" when
        // the result is DUPLICATE and calls setBackgrounds().
        const firstEditorField = editorField(editor, 0);
        await expect(firstEditorField).toHaveClass(/dupe/, { timeout: 3_000 });

        // Step 7: Assert the "Show Duplicates" link rendered by DuplicateLink.svelte
        // is visible. The link text is tr.editingShowDuplicates() = "Show Duplicates"
        // (ftl/core/editing.ftl: editing-show-duplicates = Show Duplicates).
        const dupeLink = editor.locator(".duplicate-link");
        await expect(dupeLink).toBeVisible({ timeout: 3_000 });
        await expect(dupeLink).toContainText(/show duplicates/i);

        // Step 8: Clear the first field to remove the duplicate condition.
        // Select-all then delete clears a contenteditable reliably.
        await firstFieldEditable.click();
        await editor.keyboard.press("Control+a");
        await editor.keyboard.press("Delete");

        // Wait for the debounced noteFieldsCheck to fire again after clearing.
        await editor.waitForRequest(rpcUrl("noteFieldsCheck"), { timeout: 5_000 });

        // Step 9: Assert the duplicate class is removed and the Show Duplicates link is gone.
        // After clearing, the field state returns to EMPTY/NORMAL — no dupe class.
        await expect(firstEditorField).not.toHaveClass(/dupe/, { timeout: 3_000 });
        await expect(dupeLink).not.toBeVisible({ timeout: 3_000 });
    });
});
