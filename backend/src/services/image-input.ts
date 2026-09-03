import sharp, { type Metadata } from "sharp";

export const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const NORMALIZED_IMAGE_MAX_EDGE = 2400;
export const NORMALIZED_IMAGE_MIME = "image/jpeg" as const;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "heif", "avif"]);
const HEIF_MIMES = new Set(["image/heic", "image/heif", "image/avif"]);

export type ImageErrorCode =
  | "image_required"
  | "image_too_large"
  | "invalid_base64"
  | "invalid_image"
  | "unsupported_image"
  | "image_dimensions_too_large";

export class ImageInputError extends Error {
  constructor(
    public readonly code: ImageErrorCode,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ImageInputError";
  }
}

export interface RawImageInput {
  data: Buffer;
  declaredMime: string | null;
  originalBytes: number;
}

export interface PreparedImage {
  data: Buffer;
  mime: typeof NORMALIZED_IMAGE_MIME;
  originalMime: string;
  originalBytes: number;
  width: number;
  height: number;
}

function normalizeMime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase() || null;
  if (mime === "image/jpg") return "image/jpeg";
  if (mime === "image/x-png") return "image/png";
  return mime;
}

function strictBase64Decode(value: string): Buffer {
  const compact = value.replace(/\s/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const decodedBytes = compact.length > 0 ? (compact.length / 4) * 3 - padding : 0;
  if (decodedBytes > MAX_IMAGE_INPUT_BYTES) {
    throw new ImageInputError(
      "image_too_large",
      `Image is too large. Maximum original file size is ${MAX_IMAGE_INPUT_BYTES / 1024 / 1024} MB`,
      413,
    );
  }
  if (!compact || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
    throw new ImageInputError("invalid_base64", "The uploaded image is not valid Base64 data");
  }
  const data = Buffer.from(compact, "base64");
  if (data.length === 0) {
    throw new ImageInputError("image_required", "Choose an image to upload");
  }
  return data;
}

function sniffImageMime(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (data.length >= 12 && data.toString("ascii", 4, 8) === "ftyp") {
    const brands = data.toString("ascii", 8, Math.min(data.length, 40));
    if (/avif|avis/.test(brands)) return "image/avif";
    if (/heic|heix|hevc|hevx|mif1|msf1/.test(brands)) return "image/heic";
  }
  return null;
}

function equivalentMime(declared: string, detected: string): boolean {
  return declared === detected || (HEIF_MIMES.has(declared) && HEIF_MIMES.has(detected));
}

export function readImageInput(
  file: Express.Multer.File | undefined,
  body: Record<string, unknown> | undefined,
): RawImageInput {
  if (file) {
    if (!file.buffer?.length) {
      throw new ImageInputError("image_required", "Choose an image to upload");
    }
    return {
      data: file.buffer,
      declaredMime: normalizeMime(file.mimetype),
      originalBytes: file.buffer.length,
    };
  }

  const image = body?.image;
  if (typeof image !== "string") {
    throw new ImageInputError("image_required", "Upload an image in the 'image' field");
  }

  const dataUri = /^data:([^;,]+);base64,(.*)$/is.exec(image);
  const encoded = dataUri?.[2] ?? image;
  const data = strictBase64Decode(encoded);
  return {
    data,
    declaredMime: normalizeMime(dataUri?.[1] ?? body?.contentType),
    originalBytes: data.length,
  };
}

export async function prepareImage(input: RawImageInput): Promise<PreparedImage> {
  if (input.data.length > MAX_IMAGE_INPUT_BYTES) {
    throw new ImageInputError(
      "image_too_large",
      `Image is too large. Maximum original file size is ${MAX_IMAGE_INPUT_BYTES / 1024 / 1024} MB`,
      413,
    );
  }

  const detectedMime = sniffImageMime(input.data);
  if (!detectedMime) {
    if (input.data.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) {
      throw new ImageInputError(
        "unsupported_image",
        "Unsupported image format. Use JPEG, PNG, WebP, HEIC, or AVIF",
        415,
      );
    }
    throw new ImageInputError("invalid_image", "The selected file is damaged or is not a readable image");
  }
  if (
    input.declaredMime &&
    input.declaredMime !== "application/octet-stream" &&
    !equivalentMime(input.declaredMime, detectedMime)
  ) {
    throw new ImageInputError(
      "invalid_image",
      `Image contents do not match the declared type ${input.declaredMime}`,
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(input.data, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/pixel limit|input image exceeds/i.test(message)) {
      throw new ImageInputError(
        "image_dimensions_too_large",
        "Image dimensions are too large. Use a photo under 40 megapixels",
        413,
      );
    }
    throw new ImageInputError("invalid_image", "The selected file is damaged or is not a readable image");
  }

  if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) {
    throw new ImageInputError(
      "unsupported_image",
      "Unsupported image format. Use JPEG, PNG, WebP, HEIC, or AVIF",
      415,
    );
  }
  if (!metadata.width || !metadata.height) {
    throw new ImageInputError("invalid_image", "The selected image has no readable dimensions");
  }
  if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw new ImageInputError(
      "image_dimensions_too_large",
      "Image dimensions are too large. Use a photo under 40 megapixels",
      413,
    );
  }

  try {
    const { data, info } = await sharp(input.data, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    })
      .rotate()
      .resize({
        width: NORMALIZED_IMAGE_MAX_EDGE,
        height: NORMALIZED_IMAGE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return {
      data,
      mime: NORMALIZED_IMAGE_MIME,
      originalMime: detectedMime,
      originalBytes: input.originalBytes,
      width: info.width,
      height: info.height,
    };
  } catch {
    throw new ImageInputError(
      "unsupported_image",
      "This image could not be converted. Export it as JPEG or PNG and try again",
      415,
    );
  }
}

export function imageToDataUri(image: Pick<PreparedImage, "data" | "mime">): string {
  return `data:${image.mime};base64,${image.data.toString("base64")}`;
}
