import multer from "multer";
import type { NextFunction, Request, Response } from "express";
import { ImageInputError, MAX_IMAGE_INPUT_BYTES } from "../services/image-input.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_INPUT_BYTES,
    files: 1,
    fields: 4,
  },
});

export function receiveImage(req: Request, res: Response, next: NextFunction) {
  if (!req.is("multipart/form-data")) {
    next();
    return;
  }

  upload.single("image")(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.locals.imageUploadError = new ImageInputError(
        "image_too_large",
        "Image is too large. Maximum file size is 10 MB",
        413,
      );
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      res.locals.imageUploadError = new ImageInputError(
        "invalid_image",
        `Invalid image upload: ${error.message}`,
      );
      next();
      return;
    }
    res.locals.imageUploadError = new ImageInputError(
      "invalid_image",
      "The multipart image upload is malformed",
    );
    next();
  });
}
