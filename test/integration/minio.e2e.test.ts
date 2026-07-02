// minio.e2e.test.ts — T8：完整 minio e2e（解 plan-eng I4，非注释-only）。
//
// @testcontainers/minio 起真实 container → createS3 → CreateBucketCommand
// → PutObjectCommand → presignUrl → fetch(url) assert 200 → container.stop。
// docker 不可用时 skip（DOCKER_HOST env 或 docker ps 探测）。
//
// 验证链路：T3 presignUrl 产出的 presigned URL 对真实 S3 兼容后端 GETtable，
// auth.token 提取自 X-Amz-Signature query param（spec §4.7）。

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { MinioContainer } from "@testcontainers/minio";
import { createS3 } from "../../src/storage/s3-client.js";
import { presignUrl, objectKey } from "../../src/storage/presign.js";
import { CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// docker + minio image 可用性探测：DOCKER_HOST 存在 或 docker ps 成功，
// 且 minio/minio:latest 镜像本地存在（拉取由 CI/ops 预取，避免 registry mirror 故障导致 flaky）。
function dockerAvailable(): boolean {
  if (!process.env.DOCKER_HOST) {
    try {
      execSync("docker ps", { stdio: "ignore" });
    } catch {
      return false;
    }
  }
  try {
    const id = execSync("docker images -q minio/minio:latest", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    return id.length > 0;
  } catch {
    return false;
  }
}

describe(
  "minio e2e",
  { skip: !dockerAvailable() },
  () => {
    it(
      "presign URL GETtable",
      async () => {
        const container = await new MinioContainer("minio/minio:latest").start();
      try {
        const s3 = createS3(
          container.getConnectionUrl(),
          "us-east-1",
          container.getUsername(),
          container.getPassword(),
        );
        await s3.send(new CreateBucketCommand({ Bucket: "test" }));
        await s3.send(
          new PutObjectCommand({
            Bucket: "test",
            Key: "self:t1:v1",
            Body: Buffer.from("audio"),
          }),
        );
        const { url, auth } = await presignUrl(
          s3,
          "test",
          objectKey("self", "t1", 1),
        );
        expect(auth.token_type).toBe("query_param");
        expect(auth.token.length).toBeGreaterThan(0);
        const r = await fetch(url);
        expect(r.status).toBe(200);
        const body = await r.text();
        expect(body).toBe("audio");
      } finally {
        await container.stop();
      }
    },
    60000,
  );
  },
);
