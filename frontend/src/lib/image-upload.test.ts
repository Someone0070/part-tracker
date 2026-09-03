import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_MAX_EDGE,
  MAX_SELECTED_IMAGE_BYTES,
  prepareImageFile,
  validateSelectedImage,
} from "./image-upload";

afterEach(() => vi.unstubAllGlobals());

describe("validateSelectedImage", () => {
  it.each([
    ["part.jpg", "image/jpeg"],
    ["part.png", "image/png"],
    ["camera.heic", "image/heic"],
    ["camera.HEIF", ""],
    ["part.webp", "image/webp"],
    ["part.avif", "image/avif"],
  ])("accepts supported phone image %s", (name, type) => {
    expect(() => validateSelectedImage({ name, type, size: 1024 })).not.toThrow();
  });

  it("rejects empty, oversized, and unsupported files with actionable codes", () => {
    expect(() => validateSelectedImage({ name: "empty.jpg", type: "image/jpeg", size: 0 }))
      .toThrowError(expect.objectContaining({ code: "empty_image" }));
    expect(() => validateSelectedImage({ name: "huge.jpg", type: "image/jpeg", size: MAX_SELECTED_IMAGE_BYTES + 1 }))
      .toThrowError(expect.objectContaining({ code: "image_too_large" }));
    expect(() => validateSelectedImage({ name: "animated.gif", type: "image/gif", size: 100 }))
      .toThrowError(expect.objectContaining({ code: "unsupported_image" }));
  });
});

describe("prepareImageFile", () => {
  it("corrects the decoded orientation, bounds dimensions, and emits JPEG", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4000, height: 2000, close })));
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage }),
      toBlob: (callback: (blob: Blob | null) => void, type: string) => callback(new Blob(["jpeg"], { type })),
    };
    vi.stubGlobal("document", { createElement: () => canvas });

    const result = await prepareImageFile(new File(["source"], "camera.heic", { type: "image/heic" }));
    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("camera.jpg");
    expect(canvas.width).toBe(IMAGE_MAX_EDGE);
    expect(canvas.height).toBe(1200);
    expect(drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("preserves real bytes and MIME for server conversion when the browser decoder lacks support", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { throw new Error("unsupported"); }));
    vi.stubGlobal("URL", { createObjectURL: () => "blob:test", revokeObjectURL: vi.fn() });
    vi.stubGlobal("Image", class {
      decoding = "";
      src = "";
      async decode() { throw new Error("unsupported"); }
    });
    const original = new File(["source"], "camera.heic", { type: "image/heic" });
    await expect(prepareImageFile(original)).resolves.toBe(original);
  });
});
