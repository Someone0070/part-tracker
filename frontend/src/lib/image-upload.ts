export const MAX_SELECTED_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_SERVER_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SELECTED_IMAGE_PIXELS = 80_000_000;
export const IMAGE_MAX_EDGE = 2400;
export const IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp,.heic,.heif,.avif,image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif";

const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
]);
const ALLOWED_EXTENSIONS = /\.(?:jpe?g|png|webp|heic|heif|avif)$/i;

export class ImagePreparationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ImagePreparationError";
  }
}

export function validateSelectedImage(file: Pick<File, "name" | "type" | "size">): void {
  const mime = file.type.toLowerCase();
  if ((mime && !ALLOWED_MIMES.has(mime)) || (!mime && !ALLOWED_EXTENSIONS.test(file.name))) {
    throw new ImagePreparationError(
      "unsupported_image",
      "Choose a JPEG, PNG, WebP, HEIC, or AVIF photo",
    );
  }
  if (file.size === 0) {
    throw new ImagePreparationError("empty_image", "The selected image is empty");
  }
  if (file.size > MAX_SELECTED_IMAGE_BYTES) {
    throw new ImagePreparationError("image_too_large", "Choose a photo smaller than 25 MB");
  }
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Safari can decode camera HEIC through <img> even when createImageBitmap cannot.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    throw new ImagePreparationError(
      "image_decode_failed",
      "This photo format cannot be opened on this device. Export it as JPEG or PNG and try again",
    );
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new ImagePreparationError("image_encode_failed", "Could not prepare this photo")),
      "image/jpeg",
      quality,
    );
  });
}

export async function prepareImageFile(file: File): Promise<File> {
  validateSelectedImage(file);
  let decoded: DecodedImage;
  try {
    decoded = await decodeImage(file);
  } catch (error) {
    // Some desktop browsers cannot decode HEIC/AVIF, while the backend image
    // pipeline can. Preserve the real MIME instead of relabelling the bytes.
    if (file.size <= MAX_SERVER_IMAGE_BYTES) return file;
    throw error;
  }
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_SELECTED_IMAGE_PIXELS) {
      throw new ImagePreparationError(
        "image_dimensions_too_large",
        "This photo has unusually large dimensions. Choose a smaller copy",
      );
    }

    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new ImagePreparationError("image_encode_failed", "This browser cannot prepare photos for upload");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(decoded.source, 0, 0, width, height);
    let blob = await canvasToBlob(canvas, 0.84);
    if (blob.size > MAX_SERVER_IMAGE_BYTES) blob = await canvasToBlob(canvas, 0.68);
    if (blob.size > MAX_SERVER_IMAGE_BYTES) {
      throw new ImagePreparationError("image_too_large", "The prepared photo is still too large. Choose a smaller copy");
    }
    const basename = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${basename}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
  } finally {
    decoded.close();
  }
}
