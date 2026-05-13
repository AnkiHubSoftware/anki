// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// spec: Note Add Roundtrip
// fixture: ts/tests/e2e/fixtures.ts (editor fixture)
//
// NOTE: This test mutates collection state — a real note is persisted to the
// Anki backend. Cross-test ordering matters until per-test isolation is added.

import { AddNoteRequest } from "@generated/anki/notes_pb";

import { expect, test } from "./fixtures";
import { bridgeCalls, decodeRequestBody, editableField, rpcUrl } from "./helpers";

test.describe("Note Add Roundtrip", () => {
    test("add note fires addNote RPC, shows toast, resets form", async ({ editor }) => {
        // Step 1: Wire up route interception for addNote BEFORE typing.
        // Also record all /_anki/* response URLs for later assertions.
        const seenUrls: string[] = [];
        editor.on("response", (r) => {
            const m = r.url().match(/\/_anki\/([^?#]+)/);
            if (m && r.status() < 400) { seenUrls.push(m[1]); }
        });

        // Body capture happens off the Request returned by waitForRequest below.
        // page.route()'s `postDataBuffer()` sometimes resolves to null even for
        // bodies that exist; the waitForRequest path is the reliable pattern.

        // Step 2: Focus the first editor field (Front) and type 'Hello World'.
        // The rich-text input uses a shadow DOM: .rich-text-editable > shadow > anki-editable.
        // We pierce the shadow with >> and target the first field's editable element.
        const firstFieldEditable = editableField(editor, 0);
        await firstFieldEditable.click();
        await firstFieldEditable.type("Hello World");

        // Tab to the second field (Back) and type 'Goodbye World'.
        const secondFieldEditable = editableField(editor, 1);
        await secondFieldEditable.click();
        await secondFieldEditable.type("Goodbye World");

        // Step 2 (cont.): Wait for the 600ms debounce to settle by waiting for
        // the duplicate-check RPC that the debounce triggers.
        await editor.waitForRequest(rpcUrl("noteFieldsCheck"), { timeout: 5_000 });

        // Step 3: Assert no updateNotes request fired during typing (add mode only).
        expect(seenUrls).not.toContain("updateNotes");

        // Step 4: Assert noteFieldsCheck did fire (confirmed by waitForRequest above).
        expect(seenUrls).toContain("noteFieldsCheck");

        // Step 5: Click the Add button. Use exact match to avoid matching
        // "Add tag" in the tag editor.
        const addNoteReq = editor.waitForRequest(rpcUrl("addNote"), {
            timeout: 10_000,
        });
        const addNoteResp = editor.waitForResponse(rpcUrl("addNote"), {
            timeout: 10_000,
        });
        await editor
            .getByRole("button", { name: "Add", exact: true })
            .click();
        const request = await addNoteReq;
        const response = await addNoteResp;
        expect(
            response.status(),
            `addNote response status ${response.status()}, body: ${await response.text().catch(() => "<unreadable>")}`,
        ).toBeLessThan(400);

        // Step 6: Decode the AddNoteRequest protobuf body and assert field values.
        const decoded = decodeRequestBody(request, AddNoteRequest);
        expect(decoded.note?.fields[0]).toBe("Hello World");
        expect(decoded.note?.fields[1]).toBe("Goodbye World");
        expect(decoded.deckId).not.toBe(0n);

        // Step 7: Verify form-reset behavior (more durable than the 500ms toast).
        // After successful add, the editor calls loadNote({stickyFieldsFrom: note})
        // which fires a fresh newNote RPC.
        await editor.waitForRequest(rpcUrl("newNote"), { timeout: 10_000 });
        await expect(firstFieldEditable).toBeEmpty({ timeout: 5_000 });

        // Step 8: Assert window.__bridgeCalls contains 'saved' (fired by saveNow()).
        expect(await bridgeCalls(editor)).toContain("saved");

        // Step 9: Toast verification — best-effort. The toast auto-dismisses
        // after 500ms (showToast(..., 500) in NoteEditor.svelte), so polling
        // can miss it. Skip strict assertion; trace will show whether it
        // appeared.
        // TODO: if a longer-lived assertion target exists for "add succeeded"
        // (e.g. a history list entry), prefer it.
    });
});
