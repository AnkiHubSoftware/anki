// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// spec: Media from URL Roundtrip
// seed: ts/tests/e2e/fixtures.ts
//
// Goal: prove that when external content containing an image URL is pasted into
// a field, the editor calls the backend's addMediaFromUrl RPC with that URL,
// receives a local filename in the response, and inserts an <img> element whose
// src points at that local filename.
//
// Architecture notes:
//   - getUrls() reads DataTransfer via data.getData("text/uri-list").
//   - processDataTransferEvent checks for text/html first; if present it returns
//     the raw HTML without going through processUrls. We must NOT set text/html
//     on the DataTransfer — only text/uri-list — so the URL path is exercised.
//   - urlToFile() checks that the URL ends with a supported media suffix (.jpg
//     qualifies). It then calls retrieveUrl() -> addMediaFromUrl({ url }).
//   - filenameToLink("pasted-image.jpg") returns `<img src="pasted-image.jpg">`
//     (encodeURI of a plain filename is a no-op for ASCII with no special chars).
//   - The RPC route is intercepted via page.route() and fulfilled with a
//     hand-crafted AddMediaFromUrlResponse proto binary. The request body is
//     captured via waitForRequest() + request.postDataBuffer() on the returned
//     Request object (NOT off route.request() inside the handler, which is
//     unreliable).

import { AddMediaFromUrlRequest, AddMediaFromUrlResponse } from "@generated/anki/media_pb";

import { expect, test } from "./fixtures";
import { decodeRequestBody, editableField, mockProtoResponse, pasteData, rpcUrl } from "./helpers";

test.describe("Media from URL Roundtrip", () => {
    test("pasting an image URL fires addMediaFromUrl and inserts an img with the returned filename", async ({ editor: page }) => {
        // Step 1: Assert no request leaks to external hosts. Register the
        // listener early so it captures anything that fires during the test.
        const externalRequests: string[] = [];
        page.on("request", (req) => {
            const url = req.url();
            // Allow anything going to 127.0.0.1 (mediasrv) or devtools internals.
            if (!url.startsWith("http://127.0.0.1") && !url.startsWith("devtools://")) {
                externalRequests.push(url);
            }
        });

        // Step 2: Register route interception for addMediaFromUrl BEFORE the
        // paste so we catch the very first request.
        await mockProtoResponse(
            page,
            "addMediaFromUrl",
            new AddMediaFromUrlResponse({
                filename: "pasted-image.jpg",
            }),
        );

        // Step 3: Arm waitForRequest BEFORE dispatching the paste event so we
        // don't miss the request. The promise is awaited after the paste.
        const addMediaReqPromise = page.waitForRequest(
            rpcUrl("addMediaFromUrl"),
            { timeout: 10_000 },
        );

        // Step 4: Locate the first field's anki-editable (inside shadow DOM of
        // .rich-text-editable) and click to focus.
        const editable = editableField(page, 0);
        await expect(editable).toBeAttached({ timeout: 10_000 });
        await editable.click();

        // Step 5: Dispatch a synthetic paste ClipboardEvent entirely inside
        // evaluate() so that the DataTransfer constructor is available in the
        // browser context. Only text/uri-list is set — no text/html — so
        // processDataTransferEvent falls through to processUrls.
        await pasteData(editable, {
            "text/uri-list": "https://example.com/image.jpg",
        });

        // Step 6: Await the intercepted addMediaFromUrl request and decode the
        // protobuf body to assert the URL was passed through correctly.
        const addMediaReq = await addMediaReqPromise;
        const decoded = decodeRequestBody(addMediaReq, AddMediaFromUrlRequest);
        expect(decoded.url).toBe("https://example.com/image.jpg");

        // Step 7: Wait for the paste handler to finish writing the <img> into
        // the editable's DOM. filenameToLink("pasted-image.jpg") produces
        // `<img src="pasted-image.jpg">` — assert that pattern appears.
        await expect
            .poll(
                async () => await editable.evaluate((el) => el.innerHTML),
                { timeout: 5_000 },
            )
            .toMatch(/<img[^>]+src=[^>]*pasted-image\.jpg/);

        // Step 8: Assert no request was made to any external (non-127.0.0.1) host.
        // Give any in-flight requests a short tick to arrive before checking.
        await page.waitForTimeout(300);
        expect(
            externalRequests,
            `Unexpected external requests: ${externalRequests.join(", ")}`,
        ).toHaveLength(0);
    });
});
