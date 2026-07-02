import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * 构造对象存储 key：`<provider>:<track_id>:v<version>`。
 */
export function objectKey(
  provider: string,
  trackId: string,
  version: number,
): string {
  return `${provider}:${trackId}:v${version}`;
}

/**
 * 解析对象存储 key。正则解冒号边界（plan-eng M4）。
 */
export function parseObjectKey(key: string): {
  provider: string;
  trackId: string;
  version: number;
} {
  const m = key.match(/^([^:]+):([^:]+):v(\d+)$/);
  if (!m) throw new Error(`bad object key: ${key}`);
  return { provider: m[1], trackId: m[2], version: parseInt(m[3], 10) };
}

/**
 * TTL 规范化：默认 3600s，range 300-86400，越界 throw。
 */
export function presignTtl(ttl?: number): number {
  const t = ttl ?? 3600;
  if (t < 300 || t > 86400) {
    throw new Error(`TTL ${t} out of range [300, 86400]`);
  }
  return t;
}

/**
 * 签发 presigned URL + auth normalization（spec §4.7）。
 * token 从 url 提取 X-Amz-Signature，token_type=query_param。
 */
export async function presignUrl(
  client: S3Client,
  bucket: string,
  key: string,
  ttl?: number,
): Promise<{
  url: string;
  auth: {
    token: string;
    token_type: "query_param";
    expires_at: string;
  };
}> {
  const expires = presignTtl(ttl);
  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expires },
  );
  const expiresAt = new Date(Date.now() + expires * 1000).toISOString();
  const token = url.match(/X-Amz-Signature=([^&]+)/)?.[1] ?? "";
  return { url, auth: { token, token_type: "query_param", expires_at: expiresAt } };
}
