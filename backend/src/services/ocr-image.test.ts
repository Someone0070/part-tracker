import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPartInfo, OcrProviderError } from "./ocr.js";
import type { PreparedImage } from "./image-input.js";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.ZAI_API_KEY;
const image: PreparedImage = {
  data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  mime: "image/jpeg",
  originalMime: "image/png",
  originalBytes: 20,
  width: 2,
  height: 2,
};

beforeEach(() => {
  process.env.ZAI_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.ZAI_API_KEY;
  else process.env.ZAI_API_KEY = originalApiKey;
});

describe("OCR normalized image request", () => {
  it("sends the normalized bytes with the matching data-URI MIME", async () => {
    let requestBody = "";
    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body);
      return Response.json({ md_results: "Part # WPW10321304" });
    };
    const result = await extractPartInfo(image);
    const payload = JSON.parse(requestBody) as { file: string };
    assert.equal(payload.file, `data:image/jpeg;base64,${image.data.toString("base64")}`);
    assert.equal(result.partNumber, "WPW10321304");
  });

  it("retains provider status while containing provider diagnostics", async () => {
    globalThis.fetch = async () => new Response("sensitive diagnostic", { status: 400 });
    await assert.rejects(
      extractPartInfo(image),
      (error: unknown) => error instanceof OcrProviderError
        && error.providerStatus === 400
        && error.providerBody === "sensitive diagnostic",
    );
  });
});
