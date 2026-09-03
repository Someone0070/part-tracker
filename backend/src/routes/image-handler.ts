import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { ImageInputError, prepareImage, readImageInput, type PreparedImage } from "../services/image-input.js";
import { recordImageAttempt, type ImageAttemptKind } from "../services/image-attempts.js";
import { OcrProviderError } from "../services/ocr.js";
import { UpstreamRequestError } from "../services/http-retry.js";
import { StorageUploadError } from "../services/r2.js";
import { runImageOperationOnce } from "../services/image-idempotency.js";

interface PublicImageError {
  status: number;
  error: string;
  errorType: string;
  retryable: boolean;
  providerStatus?: number;
}

function publicError(error: unknown): PublicImageError {
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      status: 499,
      error: "Image upload was cancelled",
      errorType: "client_aborted",
      retryable: true,
    };
  }
  if (error instanceof ImageInputError) {
    return {
      status: error.status,
      error: error.message,
      errorType: error.code,
      retryable: false,
    };
  }
  if (error instanceof OcrProviderError) {
    const retryable = error.providerStatus === 408 || error.providerStatus === 429 || error.providerStatus >= 500;
    return {
      status: retryable ? 503 : 422,
      error: retryable
        ? "Image recognition is temporarily unavailable. Your photo is still selected; retry in a moment"
        : "The image service could not read this photo. Retake it or choose a clearer JPEG/PNG image",
      errorType: retryable ? "ocr_temporarily_unavailable" : "ocr_image_rejected",
      retryable,
      providerStatus: error.providerStatus,
    };
  }
  if (error instanceof UpstreamRequestError) {
    return {
      status: error.status,
      error: `${error.message}. Your photo is still selected; retry in a moment`,
      errorType: error.code,
      retryable: true,
    };
  }
  if (error instanceof StorageUploadError) {
    return {
      status: error.status,
      error: error.message,
      errorType: error.code,
      retryable: error.retryable,
      providerStatus: error.providerStatus,
    };
  }
  if (error instanceof Error && error.message === "not configured") {
    return {
      status: 503,
      error: "Image recognition is not configured",
      errorType: "ocr_not_configured",
      retryable: false,
    };
  }
  return {
    status: 500,
    error: "Image processing failed. Your photo is still selected; please retry",
    errorType: "image_processing_failed",
    retryable: true,
  };
}

export function imageHandler<T>(
  kind: ImageAttemptKind,
  operation: (image: PreparedImage, signal: AbortSignal, uploadId: string) => Promise<T>,
) {
  return async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const inboundRequestId = req.get("x-request-id") ?? "";
    const requestId = /^[A-Za-z0-9_-]{8,100}$/.test(inboundRequestId) ? inboundRequestId : randomUUID();
    const suppliedUploadId = typeof req.body?.uploadId === "string" ? req.body.uploadId : "";
    const uploadId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedUploadId)
      ? suppliedUploadId
      : randomUUID();
    const abort = new AbortController();
    let originalMime: string | null = req.file?.mimetype ?? null;
    let originalBytes: number | null = req.file?.size ?? null;
    let prepared: PreparedImage | undefined;

    res.setHeader("X-Request-Id", requestId);
    req.once("aborted", () => abort.abort(new DOMException("Client disconnected", "AbortError")));
    res.once("close", () => {
      if (!res.writableEnded) abort.abort(new DOMException("Client disconnected", "AbortError"));
    });

    try {
      const middlewareError = res.locals.imageUploadError as ImageInputError | undefined;
      if (middlewareError) throw middlewareError;

      const raw = readImageInput(req.file, req.body as Record<string, unknown> | undefined);
      originalMime = raw.declaredMime;
      originalBytes = raw.originalBytes;
      prepared = await prepareImage(raw);
      const result = await runImageOperationOnce(
        `${kind}:${uploadId}`,
        () => operation(prepared!, abort.signal, uploadId),
      );

      await recordImageAttempt({
        requestId,
        kind,
        status: "succeeded",
        originalMime,
        originalBytes,
        normalizedMime: prepared.mime,
        normalizedBytes: prepared.data.length,
        durationMs: Date.now() - startedAt,
      });
      console.info(JSON.stringify({
        event: "image_attempt",
        requestId,
        kind,
        status: "succeeded",
        originalMime,
        originalBytes,
        normalizedBytes: prepared.data.length,
        durationMs: Date.now() - startedAt,
      }));
      res.json(result);
    } catch (error) {
      const mapped = publicError(error);
      await recordImageAttempt({
        requestId,
        kind,
        status: "failed",
        originalMime,
        originalBytes,
        normalizedMime: prepared?.mime,
        normalizedBytes: prepared?.data.length,
        errorCategory: mapped.errorType,
        providerStatus: mapped.providerStatus,
        durationMs: Date.now() - startedAt,
      });
      console.error(JSON.stringify({
        event: "image_attempt",
        requestId,
        kind,
        status: "failed",
        errorCategory: mapped.errorType,
        providerStatus: mapped.providerStatus,
        durationMs: Date.now() - startedAt,
      }));
      if (!res.headersSent && !abort.signal.aborted) {
        res.status(mapped.status).json({
          error: mapped.error,
          errorType: mapped.errorType,
          retryable: mapped.retryable,
          requestId,
        });
      }
    }
  };
}
