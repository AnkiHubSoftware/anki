// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// spec: Discard-Changes Prompt
// seed: ts/tests/e2e/fixtures.ts
//
// Goal: prove the editor's onClose flow correctly computes shouldPromptBeforeClosing()
// — true when any field has unsaved content, false when all fields are empty.
// The Python backend decides whether to show the Discard dialog; this test stops
// at the RPC payload (closeAddCards request body).
//
// Architecture notes:
//   - We intercept /_anki/closeAddCards and fulfill with an empty 200 response so
//     the backend's closeAddCards handler (which tries to find an active Qt window)
//     is never reached in the standalone test harness.
//   - The request body is a proto3-encoded generic.Bool. When val=false, proto3
//     omits the field entirely (default-value elision), so decoding zero bytes
//     yields Bool { val: false } — this is correct and handled transparently by
//     Bool.fromBinary().

import { Bool } from "@generated/anki/generic_pb";

import { expect, test } from "./fixtures";

test.describe("Discard-Changes Prompt", () => {
    test("close with unsaved content fires closeAddCards with val=true", async ({
        editor,
    }) => {
        // Mock closeAddCards so the backend never tries to find the Qt window.
        await editor.route("**/_anki/closeAddCards", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/binary",
                body: "",
            });
        });

        // Set up waitForRequest BEFORE clicking so we don't miss the request.
        const closeAddCardsReq = editor.waitForRequest("**/_anki/closeAddCards", {
            timeout: 10_000,
        });

        // Focus the first field and type content to make shouldPromptBeforeClosing() return true.
        const firstFieldEditable = editor
            .locator(".editor-field")
            .first()
            .locator(".rich-text-editable")
            .locator("anki-editable");
        await firstFieldEditable.click();
        await firstFieldEditable.type("Unsaved Content");

        // Wait for the 600ms debounce to settle via the noteFieldsCheck RPC it triggers.
        await editor.waitForRequest("**/_anki/noteFieldsCheck", { timeout: 5_000 });

        // Click the Close button.
        await editor.getByRole("button", { name: "Close", exact: true }).click();

        // Decode the closeAddCards request body as generic.Bool.
        const request = await closeAddCardsReq;
        const buf = request.postDataBuffer();
        // proto3 encodes Bool{val:true} as non-empty bytes; buf should be non-null here.
        const decoded = Bool.fromBinary(buf ? new Uint8Array(buf) : new Uint8Array(0));

        // shouldPromptBeforeClosing() returned true because field 0 has content.
        expect(decoded.val).toBe(true);
    });

    test("close with empty fields fires closeAddCards with val=false", async ({
        editor,
    }) => {
        // Mock closeAddCards so the backend never tries to find the Qt window.
        await editor.route("**/_anki/closeAddCards", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/binary",
                body: "",
            });
        });

        // Set up waitForRequest BEFORE clicking so we don't miss the request.
        const closeAddCardsReq = editor.waitForRequest("**/_anki/closeAddCards", {
            timeout: 10_000,
        });

        // Do NOT type anything — all fields are empty, so shouldPromptBeforeClosing() returns false.

        // Click the Close button.
        await editor.getByRole("button", { name: "Close", exact: true }).click();

        // Decode the closeAddCards request body as generic.Bool.
        const request = await closeAddCardsReq;
        const buf = request.postDataBuffer();
        // proto3 elides default-false bool field — zero bytes decode to Bool{val:false}.
        const decoded = Bool.fromBinary(buf ? new Uint8Array(buf) : new Uint8Array(0));

        // shouldPromptBeforeClosing() returned false because all fields are empty.
        expect(decoded.val).toBe(false);
    });
});
