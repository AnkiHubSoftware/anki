// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// spec: specs/paste-filter
// seed: ts/tests/e2e/fixtures.ts
//
// Goal: prove the TS html-filter runs in the browser on external paste and
// rewrites <p> to <div> before the content lands in the field. This validates
// that the Python BeautifulSoup paste filter (in editor_legacy.py) has been
// faithfully replaced by ts/lib/html-filter.
//
// Architecture notes:
//   - anki-editable[contenteditable="true"] is mounted inside a shadow DOM
//     rooted at div.rich-text-editable (see RichTextInput.svelte: attachShadow).
//     We must pierce the shadow root to reach it. The paste listener is
//     registered directly on the anki-editable element via rich-text-resolve.ts.
//   - The ClipboardEvent must carry a real DataTransfer with text/html set, so
//     we construct it entirely inside page.evaluate() where the DataTransfer
//     constructor is available. Playwright synthetic events dispatched from
//     Node.js do not carry clipboardData, so this evaluate-based approach is
//     the reliable path.
//   - wantsExtendedPaste() calls getConfigBool(PASTE_STRIPS_FORMATTING). With
//     the default value false, extended=true. tagsAllowedExtended spreads
//     tagsAllowedBasic, so P: convertToDiv is active in both modes — the P→DIV
//     assertion holds regardless of the config value.

import { AddNoteRequest } from "@generated/anki/notes_pb";

import { expect, test } from "./fixtures";
import { decodeRequestBody, editableField, pasteData, rpcUrl } from "./helpers";

test.describe("Paste HTML Filter", () => {
    test("pasted P tags are rewritten to DIV by the TS filter", async ({ editor: page }) => {
        // 1. Obtain the anki-editable element by piercing the shadow DOM of the
        //    first .rich-text-editable host and wait for it to be present.
        //    Playwright's locator() supports shadow-piercing via the >> combinator
        //    or the pierce/ CSS prefix.
        // Chained .locator() calls pierce shadow DOM automatically; Playwright
        // has no `pierce/` selector syntax (this was tried earlier and failed).
        const editableLocator = editableField(page, 0);

        await expect(editableLocator).toBeAttached({ timeout: 10_000 });

        const mediaRequests: string[] = [];
        page.on("request", (req) => {
            if (req.url().includes("/_anki/addMediaFromUrl")) {
                mediaRequests.push(req.url());
            }
        });

        // 2. Focus the first field by clicking it.
        await editableLocator.click();

        // 3. Dispatch a synthetic paste ClipboardEvent with text/html containing
        //    two <p> elements. We do this entirely inside evaluate() so that the
        //    DataTransfer constructor is available in the browser context.
        //    The event must bubble so the listener on anki-editable fires.
        //    handlePasteOrDrop calls event.preventDefault() and reads
        //    event.clipboardData — both work correctly with this pattern.
        await pasteData(editableLocator, {
            "text/html": "<p>Paragraph One</p><p>Paragraph Two</p>",
        });

        // 4. Wait for the async paste handler to finish and the DOM to update.
        //    handlePasteOrDrop is async (awaits getConfigBool), so we wait for
        //    the expected content to appear rather than asserting immediately.
        await expect(editableLocator).toContainText("Paragraph One", { timeout: 5_000 });

        // 4a. Assert the contenteditable innerHTML contains <div> wrappers and
        //     does NOT contain any <p> tag.
        const innerHTML = await editableLocator.evaluate((el) => el.innerHTML);
        expect(innerHTML).toContain("<div>Paragraph One</div>");
        expect(innerHTML).toContain("<div>Paragraph Two</div>");
        expect(innerHTML).not.toMatch(/<p[\s>]/i);

        // 5. Set up a route to capture (and continue) the addNote request body,
        //    then click the Add button to trigger note submission.
        //    The Add button label comes from tr.actionsAdd() — we match by role
        //    to avoid hard-coding the i18n string.
        const addNoteReq = page.waitForRequest(rpcUrl("addNote"), {
            timeout: 10_000,
        });

        // Click the Add button. Use exact name to avoid matching "Add tag".
        await page.getByRole("button", { name: "Add", exact: true }).click();

        // Wait for the addNote request to be intercepted.
        await page.waitForResponse((resp) => resp.url().includes("/_anki/addNote") && resp.status() < 400, {
            timeout: 10_000,
        });

        // 5a. Decode and assert the captured request body.
        const decoded = decodeRequestBody(await addNoteReq, AddNoteRequest);
        expect(decoded.note?.fields[0]).toContain("<div>");
        expect(decoded.note?.fields[0]).not.toMatch(/<p[\s>]/);

        // 6. Assert that no /_anki/addMediaFromUrl request was fired.
        //    The pasted content contains no images or URLs, so the media
        //    retrieval path in runPreFilter should be a no-op.
        // Give a short tick for any in-flight media requests to arrive.
        await page.waitForTimeout(500);
        expect(mediaRequests).toHaveLength(0);
    });
});
