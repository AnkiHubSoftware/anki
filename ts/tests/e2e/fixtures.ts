// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { type Page, test as base } from "@playwright/test";

declare global {
    interface Window {
        __bridgeCalls?: string[];
        pycmd?<T>(cmd: string, cb?: (data: T) => void): void;
    }
}

export interface LoadNoteArgs {
    nid: bigint | null;
    notetypeId: bigint | null;
    deckId: bigint | null;
    focusTo: number | null;
    originalNoteId: bigint | null;
    reviewerCardId: bigint | null;
    initial: boolean;
}

const defaultLoadArgs: LoadNoteArgs = {
    nid: null,
    notetypeId: null,
    deckId: null,
    focusTo: 0,
    originalNoteId: null,
    reviewerCardId: null,
    initial: true,
};

type AnkiFixtures = {
    // Editor mode to load. "add" by default; override with test.use().
    editorMode: "add" | "current" | "browser";
    // Page navigated to the editor with bridgeCommand/pycmd stubbed.
    editorPage: Page;
    // Editor with loadNote() already invoked — i.e. fields rendered, all
    // bootstrap RPCs fired. Use this for most tests.
    editor: Page;
};

async function installBridgeStub(page: Page): Promise<void> {
    await page.addInitScript(() => {
        window.__bridgeCalls = [];
        const stub = <T>(cmd: string, cb?: (data: T) => void) => {
            window.__bridgeCalls!.push(cmd);
            if (typeof cb === "function") {
                cb(null as T);
            }
        };
        window.bridgeCommand = stub;
        window.pycmd = stub;
    });
}

export const test = base.extend<AnkiFixtures>({
    editorMode: ["add", { option: true }],

    editorPage: async ({ page, editorMode }, use) => {
        await installBridgeStub(page);
        await page.goto(`/editor/?mode=${editorMode}`, {
            waitUntil: "domcontentloaded",
        });
        await page.waitForSelector(".note-editor", { timeout: 15_000 });
        await use(page);
    },

    editor: async ({ editorPage }, use) => {
        // Mirror what Python does after receiving the editorReady bridge command:
        // call loadNote with initial=true so defaultsForAdding/newNote etc fire.
        await editorPage.evaluate((args) => {
            // @ts-expect-error -- loadNote is exposed on globalThis by base.ts
            return loadNote(args);
        }, defaultLoadArgs);
        // Wait until at least one editor field has rendered.
        await editorPage.waitForSelector(
            ".editor-field, [class*='editor-field'], .rich-text-input",
            { timeout: 15_000 },
        );
        await use(editorPage);
    },
});

export { expect } from "@playwright/test";
