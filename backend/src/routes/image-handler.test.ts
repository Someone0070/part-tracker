import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { receiveImage } from "../middleware/image-upload.js";
import { OcrProviderError } from "../services/ocr.js";
import { imageHandler } from "./image-handler.js";
import { clearImageOperationCacheForTests } from "../services/image-idempotency.js";

afterEach(() => clearImageOperationCacheForTests());

function testApp(operation: Parameters<typeof imageHandler>[1]) {
  const app = express();
  app.use(express.json({ limit: "12mb" }));
  app.post("/image", receiveImage, imageHandler("part_ocr", operation));
  return app;
}

describe("imageHandler", () => {
  it("returns an actionable error when the multipart image field is missing", async () => {
    const response = await request(testApp(async () => ({ ok: true }))).post("/image").field("uploadId", "ignored");
    assert.equal(response.status, 400);
    assert.equal(response.body.errorType, "image_required");
    assert.equal(response.body.retryable, false);
  });

  it("accepts multipart image bytes and gives the operation a normalized JPEG", async () => {
    const input = await sharp({ create: { width: 20, height: 10, channels: 4, background: "blue" } }).png().toBuffer();
    const response = await request(testApp(async (image) => ({ mime: image.mime, bytes: image.data.length })))
      .post("/image")
      .attach("image", input, { filename: "phone.png", contentType: "image/png" });
    assert.equal(response.status, 200);
    assert.equal(response.body.mime, "image/jpeg");
    assert.ok(response.body.bytes > 0);
    assert.match(response.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  });

  it("returns a stable, non-retryable error for corrupt bytes", async () => {
    const response = await request(testApp(async () => ({ ok: true })))
      .post("/image")
      .attach("image", Buffer.from("corrupt"), { filename: "bad.png", contentType: "image/png" });
    assert.equal(response.status, 400);
    assert.equal(response.body.errorType, "invalid_image");
    assert.equal(response.body.retryable, false);
    assert.ok(response.body.requestId);
  });

  it("classifies provider image rejection without exposing its body", async () => {
    const input = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).jpeg().toBuffer();
    const response = await request(testApp(async () => {
      throw new OcrProviderError(400, "private provider diagnostic");
    }))
      .post("/image")
      .attach("image", input, { filename: "label.jpg", contentType: "image/jpeg" });
    assert.equal(response.status, 422);
    assert.equal(response.body.errorType, "ocr_image_rejected");
    assert.equal(response.body.retryable, false);
    assert.doesNotMatch(response.text, /private provider diagnostic/);
  });

  it("reuses a successful operation for retries with the same upload id", async () => {
    const input = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).jpeg().toBuffer();
    let calls = 0;
    const app = testApp(async () => ({ calls: ++calls }));
    const uploadId = "1f718540-5884-4a95-832b-17a56e4a2f91";
    const first = await request(app).post("/image").field("uploadId", uploadId)
      .attach("image", input, { filename: "label.jpg", contentType: "image/jpeg" });
    const retry = await request(app).post("/image").field("uploadId", uploadId)
      .attach("image", input, { filename: "label.jpg", contentType: "image/jpeg" });
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.equal(first.body.calls, 1);
    assert.equal(retry.body.calls, 1);
    assert.equal(calls, 1);
  });
});
