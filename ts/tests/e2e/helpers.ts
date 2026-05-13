// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { type Locator, type Page, type Request } from "@playwright/test";

type BinaryType<T> = {
    fromBinary(bytes: Uint8Array): T;
};

type BinaryMessage = {
    toBinary(): Uint8Array;
};

export function rpcUrl(method: string): string {
    if (method === "*" || method === "**") {
        return "**/_anki/**";
    }
    return `**/_anki/${method}`;
}

export function fieldContainer(page: Page, index: number): Locator {
    return page.locator(`.field-container[data-index="${index}"]`);
}

export function editorField(page: Page, index: number): Locator {
    return fieldContainer(page, index).locator(".editor-field");
}

export function editableField(page: Page, index: number): Locator {
    return editorField(page, index).locator(".rich-text-editable").locator("anki-editable");
}

export async function bridgeCalls(page: Page): Promise<string[]> {
    return await page.evaluate(() => window.__bridgeCalls ?? []);
}

export function decodeRequestBody<T>(
    request: Request,
    messageType: BinaryType<T>,
): T {
    const body = request.postDataBuffer();
    if (!body) {
        throw new Error(`${request.url()} request had no postData`);
    }
    return messageType.fromBinary(new Uint8Array(body));
}

export async function mockProtoResponse(
    page: Page,
    method: string,
    response: BinaryMessage,
): Promise<void> {
    await page.route(rpcUrl(method), async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/binary",
            body: Buffer.from(response.toBinary()),
        });
    });
}

export async function mockEmptyProtoResponse(
    page: Page,
    method: string,
): Promise<void> {
    await page.route(rpcUrl(method), async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/binary",
            body: "",
        });
    });
}

export async function captureProtoResponses<T>(
    page: Page,
    method: string,
    messageType: BinaryType<T>,
    onResponse: (response: T) => void,
): Promise<void> {
    await page.route(rpcUrl(method), async (route) => {
        const response = await route.fetch();
        const body = await response.body();
        if (response.status() < 400 && body.length > 0) {
            onResponse(messageType.fromBinary(new Uint8Array(body)));
        }
        await route.fulfill({ response });
    });
}

export async function pasteData(
    locator: Locator,
    data: Record<string, string>,
): Promise<void> {
    await locator.evaluate((el, entries) => {
        const dt = new DataTransfer();
        for (const [type, value] of Object.entries(entries)) {
            dt.setData(type, value);
        }
        (el as HTMLElement).focus();
        el.dispatchEvent(
            new ClipboardEvent("paste", {
                clipboardData: dt,
                bubbles: true,
                cancelable: true,
            }),
        );
    }, data);
}
