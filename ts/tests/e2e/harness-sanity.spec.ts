// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// Suite 0 — Harness Sanity
//
// Verifies the foundational assumptions every downstream suite depends on:
//   1. The editor page is served by Anki's mediasrv and Playwright can load it
//      from its own Chromium without CDP attach.
//   2. The bridgeCommand stub absorbs the editor's QWebChannel calls so the
//      page boots without errors.
//   3. Calling loadNote() triggers the full /_anki/* bootstrap (defaultsForAdding,
//      newNote, getNotetype, noteFieldsCheck, etc).
//   4. page.route() intercepts /_anki/* fetches in Playwright's Chromium —
//      the table stakes for every mock-based suite.

import { expect, test } from "./fixtures";

test.describe("harness sanity", () => {
    test("editor page is served and SvelteKit hydrates", async ({ editorPage }) => {
        // editorPage fixture already waits for .note-editor.
        await expect(editorPage.locator(".note-editor")).toBeVisible();
        // The editor reports a state-change bridge call as soon as it mounts.
        const bridgeCalls = await editorPage.evaluate(() => window.__bridgeCalls!);
        expect(bridgeCalls).toContain("editorReady");
    });

    test("loadNote() drives the full bootstrap RPC sequence", async ({ editorPage }) => {
        const seen = new Set<string>();
        editorPage.on("response", (r) => {
            const m = r.url().match(/\/_anki\/([^?]+)/);
            if (m && r.status() < 400) seen.add(m[1]);
        });

        await editorPage.evaluate(() => {
            // @ts-expect-error -- loadNote is on globalThis via base.ts globalExport
            return loadNote({
                nid: null,
                notetypeId: null,
                deckId: null,
                focusTo: 0,
                originalNoteId: null,
                reviewerCardId: null,
                initial: true,
            });
        });

        // Wait for fields to render — proxy for "bootstrap done".
        await editorPage.waitForSelector(
            ".editor-field, [class*='editor-field'], .rich-text-input",
            { timeout: 10_000 },
        );

        for (const expected of [
            "defaultsForAdding",
            "newNote",
            "getNotetype",
            "getFieldNames",
            "noteFieldsCheck",
        ]) {
            expect(
                seen.has(expected),
                `expected /_anki/${expected} in bootstrap, observed: ${
                    JSON.stringify([...seen])
                }`,
            ).toBe(true);
        }
    });

    test("page.route() intercepts /_anki/* fetches", async ({ editorPage }) => {
        const intercepted: string[] = [];
        await editorPage.route("**/_anki/**", async (route) => {
            intercepted.push(route.request().url());
            await route.continue();
        });

        await editorPage.evaluate(() => {
            // @ts-expect-error -- loadNote is on globalThis
            return loadNote({
                nid: null,
                notetypeId: null,
                deckId: null,
                focusTo: 0,
                originalNoteId: null,
                reviewerCardId: null,
                initial: true,
            });
        });

        await editorPage.waitForSelector(
            ".editor-field, [class*='editor-field'], .rich-text-input",
            { timeout: 10_000 },
        );

        expect(intercepted.length).toBeGreaterThan(0);
        expect(intercepted.some((u) => u.includes("/_anki/defaultsForAdding"))).toBe(
            true,
        );
    });
});
