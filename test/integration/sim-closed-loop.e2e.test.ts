// sim-closed-loop.e2e.test.ts — M2b Task 8 sim 闭环 e2e（producer push → app2 接收 → app1 kind 受约束 → audit 链）。
// 真实 TLS 握手（opsApp.listen + node https.request via pushPolicy），非 fastify inject（inject 不走真实 TLS）。
// 3 场景：block → 403 COPYRIGHT_RESTRICTED / allow → 200 / region_restrict → 403 REGION_RESTRICTED（X-Region: us）。
// audit 链：config_apply（push 命中）+ tool_call（drm blocked emit）hash chain 完整。
//
// 适配 selfsigned 5.x 实际 API（brief 假设 node-forge 旧 API 已过时）：
// - generate() 异步，返 {private, public, cert}；CA 签名用 options.ca={key,cert}（非 keyPair）；
// - SAN/EKU 用 extensions[{name:'subjectAltName',altNames:[{type:2,value}]},{name:'extKeyUsage',clientAuth:true}]；
// - CA cert 须带 basicConstraints cA:true（否则 OpenSSL 不认其为 CA，client cert chain 校验失败）。
// 适配 ops-app.ts TlsOpts 实际签名：需服务端自身 key/cert（TLS server 身份），brief tlsOpts 缺 key/cert 为笔误。
//
// region_restrict 测试需 X-Region header（T6 drmGuard 从 X-Region 提取 requestRegion，默认 getRegion()=cn）；
// region_restrict policy 命中需 requestRegion !== backendRegion，故 region_restrict 测试发 X-Region: us
// （backend region 默认 cn → us !== cn → 命中 → 403 REGION_RESTRICTED）。
// block/allow 测试不发 X-Region（block 全命中，allow 放行，region 不影响）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildOpsApp } from "../../src/ops-app.js";
import { buildServer } from "../../src/index.js";
import { createTestDb, seedTrack } from "./helpers.js";
import { createPolicyStore } from "../../src/policy/policy-store.js";
import { createAuditSink, verifyChain } from "../../src/audit/audit-sink.js";
import { pushPolicy } from "../../scripts/mock-policy-producer.js";
import { rmSync, readFileSync } from "node:fs";
import selfsigned from "selfsigned";

const auditPath = ".tmp-audit-sim.jsonl";
let opsApp: any, apiApp: any, db: any, store: any, caCert: any, serverCert: any, serviceCert: any, opsPort: number;

beforeAll(async () => {
  rmSync(auditPath, { force: true });
  db = createTestDb();
  await seedTrack(db, {
    track_id: "self:t1",
    title: "t1",
    artist: "a",
    duration_ms: 1000,
    audio_object_key: "self/t1/1",
    format: "mp3",
    bitrate: 128000,
    license: "CC-BY",
  });
  store = createPolicyStore(db);
  const audit = createAuditSink(auditPath);

  // sim CA（带 basicConstraints CA:TRUE，否则 OpenSSL 不认其为 CA）
  caCert = await selfsigned.generate([{ name: "commonName", value: "sim-ca" }], {
    algorithm: "sha256",
    extensions: [{ name: "basicConstraints", cA: true, critical: true }],
  });
  // 服务端 cert（opsApp TLS 自身身份；SAN localhost 让 client 校验 hostname 通过）
  serverCert = await selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    {
      algorithm: "sha256",
      ca: { key: caCert.private, cert: caCert.cert },
      extensions: [
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
        { name: "extKeyUsage", serverAuth: true },
      ],
    },
  );
  // client cert（mTLS；SAN localhost + EKU clientAuth，匹配 opsApp expectedSan=localhost）
  serviceCert = await selfsigned.generate(
    [{ name: "commonName", value: "ops-platform" }],
    {
      algorithm: "sha256",
      ca: { key: caCert.private, cert: caCert.cert },
      extensions: [
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
        { name: "extKeyUsage", clientAuth: true },
      ],
    },
  );

  opsApp = await buildOpsApp({
    db,
    auditSink: audit,
    policyStore: store,
    tlsOpts: {
      key: serverCert.private,
      cert: serverCert.cert,
      ca: caCert.cert,
      requestCert: true,
      rejectUnauthorized: true,
    },
    expectedSan: "localhost",
  });
  await opsApp.listen({ port: 0, host: "127.0.0.1" });
  opsPort = opsApp.server.address().port;

  apiApp = await buildServer({
    db,
    presign: async () => ({
      url: "https://mock.s3/self/t1/1",
      auth: {
        token: "t",
        token_type: "query_param" as const,
        expires_at: "2026-12-31T00:00:00.000Z",
      },
    }),
    policyStore: store,
    auditSink: audit,
    actor: "cloud-ext",
  });
});

afterAll(async () => {
  await opsApp.close();
  await apiApp.close();
  rmSync(auditPath, { force: true });
});

describe("sim 闭环 e2e", () => {
  it("block → app1 /content_stream 403 COPYRIGHT_RESTRICTED", async () => {
    await pushPolicy({
      port: opsPort,
      ca: caCert.cert,
      key: serviceCert.private,
      cert: serviceCert.cert,
      commandId: "sim-block",
      action: "block",
      audience: "content_backend",
      upstreamVersion: 1,
    });
    const res = await apiApp.inject({
      method: "POST",
      url: "/content_stream",
      payload: { track_id: "self:t1" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe("COPYRIGHT_RESTRICTED");
  });

  it("allow → app1 /content_stream 200（fold ceo M2，非只 block）", async () => {
    await pushPolicy({
      port: opsPort,
      ca: caCert.cert,
      key: serviceCert.private,
      cert: serviceCert.cert,
      commandId: "sim-allow",
      action: "allow",
      audience: "content_backend",
      upstreamVersion: 2,
    });
    const res = await apiApp.inject({
      method: "POST",
      url: "/content_stream",
      payload: { track_id: "self:t1" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("region_restrict + region 不符 → 403 REGION_RESTRICTED（fold ceo M2）", async () => {
    await pushPolicy({
      port: opsPort,
      ca: caCert.cert,
      key: serviceCert.private,
      cert: serviceCert.cert,
      commandId: "sim-region",
      action: "region_restrict",
      audience: "content_backend",
      upstreamVersion: 3,
    });
    // backend region 默认 cn；发 X-Region: us → requestRegion=us !== cn → region_restrict 命中 → 403
    const res = await apiApp.inject({
      method: "POST",
      url: "/content_stream",
      payload: { track_id: "self:t1" },
      headers: { "x-region": "us" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe("REGION_RESTRICTED");
  });

  it("audit 链含 config_apply + tool_call，hash chain 完整", async () => {
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const types = lines.map((l) => JSON.parse(l).eventType);
    expect(types).toContain("config_apply");
    expect(types).toContain("tool_call");
    expect(verifyChain(auditPath)).toBe(true);
  });
});
