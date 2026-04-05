import { AwsClient } from "aws4fetch";

let client: AwsClient | null = null;

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

export async function uploadImage(key: string, data: Buffer, contentType: string): Promise<string> {
  const config = getR2Config();
  if (!config) throw new Error("R2 storage not configured");
  const awsClient = getClient()!;
  const url = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`;
  const response = await awsClient.fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(data),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`R2 upload failed: ${response.status} ${text}`);
  }
  return key;
}
