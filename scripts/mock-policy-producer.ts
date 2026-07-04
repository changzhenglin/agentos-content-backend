// mock-policy-producer.ts — sim ops-platform producer（sim CA cert 签服务 cert + push content_policy envelope）。
// 既作 e2e 测试模块（pushPolicy 导出），又作 CLI（tsx scripts/mock-policy-producer.ts <port> <action> <commandId> [version]）。
// fold devex C1（sim 闭环可跑）/eng M1（真实 CLI 非 placeholder）。
//
// 适配 selfsigned 5.x 实际 API（brief 假设 node-forge 旧 API 已过时）：
// - generate() 异步，返 {private, public, cert}；CA 签名用 options.ca={key,cert}（非 keyPair）；
// - SAN/EKU 用 extensions[{name:'subjectAltName',altNames:[{type:2,value}]},{name:'extKeyUsage',clientAuth:true}]；
// - CA cert 须带 basicConstraints cA:true（否则 OpenSSL 不认其为 CA，client cert chain 校验失败）。
// pushPolicy 走真实 TLS 握手（node:https request），非 fastify inject——opsApp 须 listen 真实端口。
import { request } from "node:https";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import selfsigned from "selfsigned";

export interface PushOpts {
  port: number;
  ca: string; // sim CA cert（用于校验 opsApp 服务端 cert）
  key: string; // client cert private key（mTLS）
  cert: string; // client cert（mTLS，SAN localhost + EKU clientAuth）
  commandId: string;
  action: "allow" | "block" | "region_restrict";
  audience: string;
  upstreamVersion: number; // T1 PolicyEnvelope 要求 version 字段
}

/** pushPolicy：向 opsApp /content_policy/push 发 envelope（真实 TLS 握手）。
 *  envelope shape 对齐 src/policy/policy-store.ts PolicyEnvelope：
 *  command_id/kind=content_policy/capability_mode/version(=upstreamVersion)/payload{rule_id,action,target_scope}/security_context{actor,rbac_decision,audience,expiry}。
 *  actor 绑定 mTLS caller（ops-app.ts 校验 sc.actor === callerIdentity，caller=client cert CN="ops-platform"）。 */
export function pushPolicy(opts: PushOpts): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const envelope = {
      command_id: opts.commandId,
      kind: "content_policy" as const,
      capability_mode: "real",
      version: opts.upstreamVersion,
      payload: {
        rule_id: "r1",
        action: opts.action,
        target_scope: "content_management",
      },
      security_context: {
        actor: "ops-platform", // 须与 client cert CN 一致（ops-app.ts actor 绑定校验）
        rbac_decision: { role: "admin", allowed: true },
        audience: opts.audience,
        expiry: new Date(Date.now() + 60000).toISOString(),
      },
    };
    const data = JSON.stringify(envelope);
    const req = request(
      {
        port: opts.port,
        host: "127.0.0.1",
        servername: "localhost", // 校验服务端 cert SAN localhost（不发 servername 会用 host=127.0.0.1 校验失败）
        method: "POST",
        path: "/content_policy/push",
        ca: opts.ca,
        key: opts.key,
        cert: opts.cert,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: JSON.parse(buf || "{}") }),
        );
      },
    );
    req.on("error", (e) => resolve({ status: 0, body: { error: String(e) } }));
    req.write(data);
    req.end();
  });
}

// cert 缓存：首次生成 sim CA + service cert 写 .sim-certs/，后续复用（dev 反复跑不重复生成）。
// CLI dev 工具用（e2e 测试直接传测试内生成的 cert，不走 ensureCerts）。
async function ensureCerts(): Promise<{ ca: string; cert: string; key: string }> {
  const dir = ".sim-certs";
  const caPath = `${dir}/ca.pem`;
  const svcPath = `${dir}/svc.pem`;
  const svcKeyPath = `${dir}/svc-key.pem`;
  if (existsSync(caPath) && existsSync(svcPath) && existsSync(svcKeyPath)) {
    return {
      ca: readFileSync(caPath, "utf8"),
      cert: readFileSync(svcPath, "utf8"),
      key: readFileSync(svcKeyPath, "utf8"),
    };
  }
  mkdirSync(dir, { recursive: true });
  // sim CA（带 basicConstraints CA:TRUE，否则 OpenSSL 不认其为 CA）
  const ca = await selfsigned.generate([{ name: "commonName", value: "sim-ca" }], {
    algorithm: "sha256",
    extensions: [{ name: "basicConstraints", cA: true, critical: true }],
  });
  // service cert（mTLS client；SAN localhost + EKU clientAuth，匹配 opsApp expectedSan=localhost）
  const svc = await selfsigned.generate(
    [{ name: "commonName", value: "ops-platform" }],
    {
      algorithm: "sha256",
      ca: { key: ca.private, cert: ca.cert },
      extensions: [
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
        { name: "extKeyUsage", clientAuth: true },
      ],
    },
  );
  writeFileSync(caPath, ca.cert);
  writeFileSync(svcPath, svc.cert);
  writeFileSync(svcKeyPath, svc.private);
  return { ca: ca.cert, cert: svc.cert, key: svc.private };
}

// CLI: tsx scripts/mock-policy-producer.ts <port> <action> <commandId> [version]
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [, , port, action, commandId, version] = process.argv;
  if (!port || !action || !commandId) {
    console.error(
      "usage: tsx scripts/mock-policy-producer.ts <port> <allow|block|region_restrict> <commandId> [version=1]",
    );
    process.exit(1);
  }
  const validActions = ["allow", "block", "region_restrict"];
  if (!validActions.includes(action)) {
    console.error(`invalid action: ${action} (allow|block|region_restrict)`);
    process.exit(1);
  }
  const { ca, cert, key } = await ensureCerts();
  pushPolicy({
    port: Number(port),
    ca,
    key,
    cert,
    commandId,
    action: action as "allow" | "block" | "region_restrict",
    audience: "content_backend",
    upstreamVersion: Number(version ?? 1),
  }).then((r) => console.log(JSON.stringify(r)));
}
