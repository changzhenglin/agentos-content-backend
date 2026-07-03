// policy-push.e2e.test.ts — App2 content_policy push e2e（mTLS 非 CN-only D1 加强版 + audience/expiry/actor 校验 + 幂等）。
// 真实 TLS 握手（app.listen + node https.request），非 fastify inject（inject 不走真实 TLS）。
//
// 适配 selfsigned 5.x 实际 API（brief 假设 node-forge 旧 API）：
// - generate() 异步，返 {private, public, cert}；CA 签名用 options.ca={key,cert}（非 keyPair）；
// - SAN/EKU 用 extensions[{name:'subjectAltName',altNames:[{type:2,value}]},{name:'extKeyUsage',clientAuth:true}]；
// - 过期用 notBeforeDate/notAfterDate（非 days:-1）；CA cert 须带 basicConstraints cA:true。
// mTLS 校验逻辑（authorized + SAN + EKU clientAuth）保持不变（brief 约束）。
//
// 适配 Node TLS 实际行为：TLS 层 rejectUnauthorized:true 校验 chain/validity/EKU clientAuth（OpenSSL purpose），
// 但不校验 client cert SAN → wrong-SAN 须由 app 层 mtlsVerify 拒绝（403 MTLS_CERT_REQUIRED，非 status:0）。
// 故 brief "wrong-SAN→status:0" 期望据此调整为 403（mTLS 校验逻辑不变，仅拒绝层与状态码适配）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildOpsApp } from "../../src/ops-app.js";
import { createTestDb } from "./helpers.js";
import { createPolicyStore } from "../../src/policy/policy-store.js";
import { createAuditSink, verifyChain } from "../../src/audit/audit-sink.js";
import selfsigned from "selfsigned";
import { request } from "node:https";
import { rmSync, readFileSync } from "node:fs";

// sim CA（带 basicConstraints CA:TRUE，否则 OpenSSL 不认其为 CA，client cert chain 校验失败）
const caCert = await selfsigned.generate([{ name: "commonName", value: "sim-ca" }], {
  algorithm: "sha256",
  extensions: [{ name: "basicConstraints", cA: true, critical: true }],
});

// 服务端 cert（TLS server 自身身份；SAN localhost 让 client 校验 hostname 通过）
const serverCert = await selfsigned.generate(
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

// 合法 client cert（mTLS；SAN localhost + EKU clientAuth）
const serviceCert = await selfsigned.generate(
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

// 异质 CA（测 wrong-CA 拒绝，fold D1）
const otherCa = await selfsigned.generate([{ name: "commonName", value: "other-ca" }], {
  algorithm: "sha256",
  extensions: [{ name: "basicConstraints", cA: true, critical: true }],
});
const otherCert = await selfsigned.generate(
  [{ name: "commonName", value: "evil" }],
  {
    algorithm: "sha256",
    ca: { key: otherCa.private, cert: otherCa.cert },
    extensions: [
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
      { name: "extKeyUsage", clientAuth: true },
    ],
  },
);

// 过期 cert（notAfterDate 已过，fold D1）
const expiredCert = await selfsigned.generate(
  [{ name: "commonName", value: "ops-platform" }],
  {
    algorithm: "sha256",
    ca: { key: caCert.private, cert: caCert.cert },
    notBeforeDate: new Date(Date.now() - 2 * 86400000),
    notAfterDate: new Date(Date.now() - 86400000),
    extensions: [
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
      { name: "extKeyUsage", clientAuth: true },
    ],
  },
);

// wrong-SAN cert（chain/EKU 合法但 SAN=evil.example，fold D1 非 CN-only）
const wrongSanCert = await selfsigned.generate(
  [{ name: "commonName", value: "ops-platform" }],
  {
    algorithm: "sha256",
    ca: { key: caCert.private, cert: caCert.cert },
    extensions: [
      { name: "subjectAltName", altNames: [{ type: 2, value: "evil.example" }] },
      { name: "extKeyUsage", clientAuth: true },
    ],
  },
);

let app: any, port: number, db: any, store: any;
const auditPath = ".tmp-audit-push.jsonl";

beforeAll(async () => {
  rmSync(auditPath, { force: true });
  db = await createTestDb();
  store = createPolicyStore(db);
  app = await buildOpsApp({
    db,
    auditSink: createAuditSink(auditPath),
    policyStore: store,
    tlsOpts: {
      key: serverCert.private,
      cert: serverCert.cert,
      ca: caCert.cert,
      requestCert: true,
      rejectUnauthorized: true,
    },
    expectedSan: "localhost", // 期望 SAN（fold D1 非 CN-only）
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = app.server.address().port;
});
afterAll(async () => {
  await app.close();
  rmSync(auditPath, { force: true });
});

function postPush(
  body: any,
  opts: { key?: string; cert?: string; ca?: string } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    // 区分"未传该字段→用默认 service cert"与"显式传 undefined→不发 cert"（no-cert 测试需要）
    const useKey = "key" in opts ? opts.key : serviceCert.private;
    const useCert = "cert" in opts ? opts.cert : serviceCert.cert;
    const reqOpts: any = {
      port,
      host: "127.0.0.1",
      method: "POST",
      path: "/content_policy/push",
      ca: opts.ca ?? caCert.cert,
      servername: "localhost",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(data),
      },
    };
    if (useKey) reqOpts.key = useKey;
    if (useCert) reqOpts.cert = useCert;
    const req = request(reqOpts, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: JSON.parse(buf || "{}") }),
        );
      },
    );
    req.on("error", () => resolve({ status: 0, body: { error: "conn refused" } }));
    req.write(data);
    req.end();
  });
}

// envelope 含 upstream version（fold codex P1#2）
function envelope(
  audience: string,
  cmdId: string,
  action: any = "block",
  expiryMs = 60000,
  upstreamVersion = 1,
  actor = "ops-platform",
) {
  return {
    command_id: cmdId,
    kind: "content_policy",
    capability_mode: "real",
    version: upstreamVersion,
    payload: { rule_id: "r1", action, target_scope: "content_management" },
    security_context: {
      actor,
      rbac_decision: { role: "admin", allowed: true },
      audience,
      expiry: new Date(Date.now() + expiryMs).toISOString(),
    },
  };
}

describe("content_policy push e2e", () => {
  it("mTLS + audience 正确 → 200 applied", async () => {
    const r = await postPush(envelope("content_backend", "cmd-1"));
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
    expect(r.body.version).toBe(1);
  });

  it("audience ≠ content_backend → 403 AUDIENCE_MISMATCH + audit unauthorized", async () => {
    const r = await postPush(envelope("device-hub", "cmd-2"));
    expect(r.status).toBe(403);
    expect(r.body.error_code).toBe("AUDIENCE_MISMATCH");
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1]).actor).toBe("ops-platform");
  });

  it("expiry 过期 → 403 ENVELOPE_EXPIRED", async () => {
    const r = await postPush(envelope("content_backend", "cmd-3", "block", -60000));
    expect(r.status).toBe(403);
    expect(r.body.error_code).toBe("ENVELOPE_EXPIRED");
  });

  it("actor ≠ callerIdentity（self-declared 不信，fold codex P2）→ 403 UNAUTHORIZED_ACTOR", async () => {
    const r = await postPush(
      envelope("content_backend", "cmd-actor", "block", 60000, 1, "fake-actor"),
    );
    expect(r.status).toBe(403);
    expect(r.body.error_code).toBe("UNAUTHORIZED_ACTOR");
  });

  it("envelope shape 非法（kind/action/target_scope）→ 400 INVALID_ENVELOPE", async () => {
    const bad = envelope("content_backend", "cmd-shape");
    bad.payload.action = "delete"; // 非法 action
    const r = await postPush(bad);
    expect(r.status).toBe(400);
    expect(r.body.error_code).toBe("INVALID_ENVELOPE");
  });

  it("command_id 重复 → 200 applied=false 幂等", async () => {
    await postPush(envelope("content_backend", "cmd-dup"));
    const r = await postPush(envelope("content_backend", "cmd-dup"));
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(false);
  });

  // D1=A 加强版：非 CN-only 校验 4 拒绝测试
  it("无 client cert → TLS 层拒绝（status 0）", async () => {
    const r = await postPush(envelope("content_backend", "cmd-nocert"), {
      key: undefined as any,
      cert: undefined as any,
    });
    expect(r.status).toBe(0);
  });

  it("wrong-CA cert（不被 sim CA trust）→ TLS 层拒绝（fold D1）", async () => {
    const r = await postPush(envelope("content_backend", "cmd-wca"), {
      key: otherCert.private,
      cert: otherCert.cert,
    });
    expect(r.status).toBe(0); // TLS 层 chain 校验拒绝
  });

  it("expired cert → TLS 层拒绝（fold D1）", async () => {
    const r = await postPush(envelope("content_backend", "cmd-exp"), {
      key: expiredCert.private,
      cert: expiredCert.cert,
    });
    expect(r.status).toBe(0); // TLS 层 validity 校验拒绝
  });

  it("wrong-SAN cert → app 层 mtlsVerify 拒绝 403 MTLS_CERT_REQUIRED（fold D1 非 CN-only）", async () => {
    const r = await postPush(envelope("content_backend", "cmd-san"), {
      key: wrongSanCert.private,
      cert: wrongSanCert.cert,
    });
    // TLS 层不校验 client cert SAN（OpenSSL 只校验 chain/validity/EKU purpose）；
    // app 层 mtlsVerify 校验 cert.subjectaltname 含 expectedSan → 403。
    expect(r.status).toBe(403);
    expect(r.body.error_code).toBe("MTLS_CERT_REQUIRED");
    // T5 review fix #3：wrong-SAN 403 路径应 emitUnauthorized（cert 存在 + 有 CN）
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.actor).toBe("ops-platform");
    expect(last.traceId).toContain("unauthorized:san_mismatch");
  });

  it("envelope 缺 security_context → 400 INVALID_ENVELOPE（T5 review fix #1）", async () => {
    const bad = envelope("content_backend", "cmd-nosc");
    delete (bad as any).security_context;
    const r = await postPush(bad);
    expect(r.status).toBe(400);
    expect(r.body.error_code).toBe("INVALID_ENVELOPE");
  });

  it("audit hash chain 完整性未断", async () => {
    expect(verifyChain(auditPath)).toBe(true);
  });
});
