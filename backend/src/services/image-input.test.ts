import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  ImageInputError,
  MAX_IMAGE_INPUT_BYTES,
  NORMALIZED_IMAGE_MAX_EDGE,
  imageToDataUri,
  prepareImage,
  readImageInput,
} from "./image-input.js";

async function png(width = 20, height = 10): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: "#44aa88" } }).png().toBuffer();
}

describe("image input", () => {
  it("strictly decodes a legacy data URI and keeps its declared MIME", async () => {
    const data = await png();
    const input = readImageInput(undefined, { image: `data:image/png;base64,${data.toString("base64")}` });
    assert.deepEqual(input.data, data);
    assert.equal(input.declaredMime, "image/png");
  });

  it("rejects malformed Base64 before it reaches an upstream provider", () => {
    assert.throws(
      () => readImageInput(undefined, { image: "%%%not-base64%%%" }),
      (error: unknown) => error instanceof ImageInputError && error.code === "invalid_base64",
    );
  });

  it("rejects decoded input larger than the actual 10 MB limit", () => {
    assert.throws(
      () => readImageInput(undefined, { image: Buffer.alloc(MAX_IMAGE_INPUT_BYTES + 1).toString("base64") }),
      (error: unknown) => error instanceof ImageInputError && error.code === "image_too_large",
    );
  });

  it("normalizes PNG bytes to a correctly-labelled bounded JPEG", async () => {
    const data = await png(4000, 2000);
    const prepared = await prepareImage({ data, declaredMime: "image/png", originalBytes: data.length });
    const metadata = await sharp(prepared.data).metadata();
    assert.equal(prepared.mime, "image/jpeg");
    assert.equal(metadata.format, "jpeg");
    assert.ok(Math.max(metadata.width ?? 0, metadata.height ?? 0) <= NORMALIZED_IMAGE_MAX_EDGE);
    assert.match(imageToDataUri(prepared), /^data:image\/jpeg;base64,/);
  });

  it("applies EXIF orientation while normalizing", async () => {
    const data = await sharp({ create: { width: 10, height: 20, channels: 3, background: "#123456" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const prepared = await prepareImage({ data, declaredMime: "image/jpeg", originalBytes: data.length });
    assert.equal(prepared.width, 20);
    assert.equal(prepared.height, 10);
  });

  it("rejects MIME spoofing and corrupt image bytes", async () => {
    const data = await png();
    await assert.rejects(
      prepareImage({ data, declaredMime: "image/jpeg", originalBytes: data.length }),
      (error: unknown) => error instanceof ImageInputError && error.code === "invalid_image",
    );
    await assert.rejects(
      prepareImage({ data: Buffer.from("not an image"), declaredMime: "image/png", originalBytes: 12 }),
      (error: unknown) => error instanceof ImageInputError && error.code === "invalid_image",
    );
  });

  it("rejects valid but unsupported GIF images", async () => {
    const data = await sharp({ create: { width: 5, height: 5, channels: 3, background: "red" } }).gif().toBuffer();
    await assert.rejects(
      prepareImage({ data, declaredMime: "image/gif", originalBytes: data.length }),
      (error: unknown) => error instanceof ImageInputError && error.code === "unsupported_image",
    );
  });
});
