// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// spec: Sticky Field Toggle
// seed: ts/tests/e2e/fixtures.ts (editor fixture)
//
// Goal: prove that toggling a field's sticky badge in the new editor
// (1) reaches the backend via the new updateNotetype RPC (not via the legacy
//     bridgeCommand("toggleSticky") path),
// (2) flips the right field's sticky flag in the protobuf payload, and
// (3) updates the badge's visible state.
//
// Architecture notes:
//   - isLegacy defaults to false in setupEditor() (+page.svelte calls
//     setupEditor(mode) with no second argument), so StickyBadge.toggle()
//     always takes the new path: getNotetype → mutate → updateNotetype.
//   - The updateNotetype RPC receives a bare Notetype message (not a wrapper),
//     decoded with Notetype.fromBinary().
//   - The StickyBadge <span role="button"> gains class "highlighted" when
//     active===true (class:highlighted={active} in StickyBadge.svelte).
//   - show prop is true only when the field is hovered or focused
//     (NoteEditor.svelte line ~1543), so we must hover the .editor-field first
//     to make the badge interactable.
//
// This test mutates the notetype's sticky configuration. Subsequent tests
// against the same Anki instance will see flds[0].sticky=false at the end
// (we toggle twice). If a test relies on a specific sticky state, set it
// explicitly.

import { Notetype } from "@generated/anki/notetypes_pb";

import { expect, test } from "./fixtures";
import { bridgeCalls, decodeRequestBody, fieldContainer, rpcUrl } from "./helpers";

test.describe("Sticky Field Toggle", () => {
    test("clicking sticky badge fires updateNotetype with the right flds[i].sticky flip", async ({ editor }) => {
        // Step 1: Scope to the first field. `.editor-field` is ONLY the input
        // body; the StickyBadge lives in the sibling slot (`field-label`)
        // inside `.field-container`. Use `.field-container` as the scope.
        const firstFieldContainer = fieldContainer(editor, 0);

        // StickyBadge.svelte renders <span role="button"> with the toggle
        // handler bound. The inner Badge wraps it visually; the title
        // attribute "Toggle sticky (F9)" lands on the inner element.
        // We target the span via its inner Badge title attribute, which is
        // the only sticky-titled element in the field.
        const stickyBadge = firstFieldContainer
            .locator("[title*=\"sticky\" i]")
            .locator("xpath=ancestor-or-self::span[@role='button']")
            .first();

        // Step 2: Hover the field-container so the badge becomes visible
        // (show prop = true when field is hovered).
        await firstFieldContainer.hover();

        // Verify the badge is attached before proceeding.
        await expect(stickyBadge).toBeAttached({ timeout: 5_000 });

        // Step 3a: Set up request/response captures for getNotetype and
        // updateNotetype BEFORE clicking, so we don't miss fast responses.
        const getNotetypeReqPromise = editor.waitForRequest(
            rpcUrl("getNotetype"),
            { timeout: 10_000 },
        );
        const getNotetypeRespPromise = editor.waitForResponse(
            rpcUrl("getNotetype"),
            { timeout: 10_000 },
        );
        const updateNotetypeReqPromise = editor.waitForRequest(
            rpcUrl("updateNotetype"),
            { timeout: 10_000 },
        );
        const updateNotetypeRespPromise = editor.waitForResponse(
            rpcUrl("updateNotetype"),
            { timeout: 10_000 },
        );

        // Step 3b: Click the sticky badge to toggle sticky ON.
        await stickyBadge.click();

        // Step 4a: Resolve getNotetype — confirm it fired and succeeded.
        const getNotetypeResp = await getNotetypeRespPromise;
        expect(
            getNotetypeResp.status(),
            `getNotetype response status ${getNotetypeResp.status()}`,
        ).toBeLessThan(400);
        await getNotetypeReqPromise; // drain the promise

        // Step 4b: Resolve updateNotetype and decode the protobuf body.
        const updateNotetypeResp = await updateNotetypeRespPromise;
        expect(
            updateNotetypeResp.status(),
            `updateNotetype response status ${updateNotetypeResp.status()}`,
        ).toBeLessThan(400);

        // Step 5: Decode and assert sticky was flipped to true for field 0.
        // updateNotetype receives a bare Notetype message (see backend.ts:399).
        // TODO: The initial sticky state is assumed to be false. If the test
        // Anki instance has sticky=true for flds[0] already, this assertion
        // will fail. In that case, toggle twice to start from a known state.
        const notetype = decodeRequestBody(
            await updateNotetypeReqPromise,
            Notetype,
        );
        expect(
            notetype.fields[0]?.config?.sticky,
            "expected flds[0].config.sticky to be true after first toggle",
        ).toBe(true);

        // Step 6: Assert no bridgeCommand("toggleSticky:...") was recorded.
        // The legacy path calls bridgeCommand(`toggleSticky:${index}`); the
        // new path must NOT call it.
        const toggleStickyCalls = (await bridgeCalls(editor)).filter((c: string) => c.startsWith("toggleSticky"));
        expect(
            toggleStickyCalls,
            "bridgeCommand toggleSticky should not be called in non-legacy mode",
        ).toHaveLength(0);

        // Step 7: Assert the badge DOM reflects the new active state.
        // StickyBadge.svelte: class:highlighted={active} on the outer <span>.
        await expect(stickyBadge).toHaveClass(/highlighted/, { timeout: 3_000 });

        // Step 8: Click again to toggle sticky OFF. Re-hover to ensure visibility.
        await firstFieldContainer.hover();

        const updateNotetypeReqPromise2 = editor.waitForRequest(
            rpcUrl("updateNotetype"),
            { timeout: 10_000 },
        );
        const updateNotetypeRespPromise2 = editor.waitForResponse(
            rpcUrl("updateNotetype"),
            { timeout: 10_000 },
        );

        await stickyBadge.click();

        const updateResp2 = await updateNotetypeRespPromise2;
        expect(updateResp2.status()).toBeLessThan(400);

        const notetype2 = decodeRequestBody(
            await updateNotetypeReqPromise2,
            Notetype,
        );
        expect(
            notetype2.fields[0]?.config?.sticky,
            "expected flds[0].config.sticky to be false after second toggle",
        ).toBe(false);

        // Step 8b: Assert the highlighted class is removed.
        await expect(stickyBadge).not.toHaveClass(/highlighted/, { timeout: 3_000 });
    });
});
