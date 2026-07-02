import { S3Client } from "@aws-sdk/client-s3";

/**
 * 创建 S3 兼容 client（MinIO 通过 forcePathStyle 兼容）。
 */
export function createS3(
  endpoint: string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
): S3Client {
  return new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}
