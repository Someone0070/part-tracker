import { AwsClient } from "aws4fetch";

let client: AwsClient | null = null;

export class StorageUploadError extends Error {
  constructor(
    message: string,
    public readonly code: "storage_timeout" | "storage_unavailable" | "storage_not_configured",
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly providerStatus?: number,
  ) {
    super(message);
    this.name = "StorageUploadError";
  }
}

function getR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

function getClient(): AwsClient | null {
  if (client) return client;
  const config = getR2Config();
  if (!config) return null;
  client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey });
  return client;
}

export function isR2Configured(): boolean {
  return getR2Config() !== null;
}

export async function uploadImage(
  key: string,
  data: Buffer,
  contentType: string,
  signal?: AbortSignal,
): Promise<string> {
  const config = getR2Config();
  if (!config) {
    throw new StorageUploadError("Photo storage is not configured", "storage_not_configured", 503, false);
  }
  const awsClient = getClient()!;
  const url = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const timeout = AbortSignal.timeout(25_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await awsClient.fetch(url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(data),
        signal: requestSignal,
      });
      if (response.ok) return key;
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      await response.body?.cancel().catch(() => undefined);
      if (!retryable || attempt === 2) {
        throw new StorageUploadError(
          retryable ? "Photo storage is temporarily unavailable" : "Photo storage rejected the upload",
          "storage_unavailable",
          retryable ? 503 : 502,
          retryable,
          response.status,
        );
      }
    } catch (error) {
      if (error instanceof StorageUploadError) throw error;
      if (signal?.aborted) throw signal.reason;
      if (attempt === 2) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        throw new StorageUploadError(
          timedOut ? "Photo storage timed out" : "Photo storage is temporarily unavailable",
          timedOut ? "storage_timeout" : "storage_unavailable",
          timedOut ? 504 : 503,
          true,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
  }

  throw new StorageUploadError("Photo storage is temporarily unavailable", "storage_unavailable", 503, true);
}
