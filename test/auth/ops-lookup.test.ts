// ops-lookup.test.ts — #2 ops-lookup 模块测试（Fold-6/7 修正版）。
// Node 25 global fetch 不消费 undici 包的 setGlobalDispatcher（即使 path /.*/ 也走真实 DNS），
// 故改用本地 http.createServer mock ops 端点（与 jwt-verify.test.ts 同款，已验证可行）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createOpsLookupClient, LookupError } from "../../src/auth/ops-lookup.js";

let server: http.Server;
let baseUrl: string;
// Fold-6：header 捕获（断言非 no-op）
let lastHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const device_id = url.searchParams.get("device_id") ?? "";
    // 按 device_id 路由响应
    const routes: Record<string, () => void> = {
      "d-1": () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ bound: true, role: "owner", device_group_id: "g-1" }));
      },
      "d-2": () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ bound: false }));
      },
      "d-3": () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ bound: true }));
      },
      "d-4": () => {
        res.statusCode = 500;
        res.end("err");
      },
      "d-6": () => {
        res.statusCode = 401;
        res.end("unauthorized");
      },
      "d-7": () => {
        res.statusCode = 403;
        res.end("forbidden");
      },
      "d-8": () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ bound: "true" }));
      },
      "d-9": () => {
        // 200 + 非 JSON body（如反代 HTML 错误页带 200）→ res.json() 抛 → LookupError(503)
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end("not json");
      },
    };
    const handler = routes[device_id];
    if (handler) {
      handler();
      return;
    }
    res.statusCode = 404;
    res.end("no route");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server.close());

function makeClient(overrideBaseUrl?: string) {
  return createOpsLookupClient({
    baseUrl: overrideBaseUrl ?? baseUrl,
    serviceToken: "tok-1",
    serviceName: "content-backend",
  });
}

describe("createOpsLookupClient", () => {
  it("200 bound:true → {bound, role, device_group_id}", async () => {
    const client = makeClient();
    const r = await client.lookupDeviceBinding("u-1", "d-1");
    expect(r).toEqual({ bound: true, role: "owner", device_group_id: "g-1" });
  });

  it("200 bound:false → {bound:false}（非 throw，调用方判 403）", async () => {
    const client = makeClient();
    const r = await client.lookupDeviceBinding("u-1", "d-2");
    expect(r.bound).toBe(false);
  });

  // Fold-6：header 断言非 no-op——server 捕获请求头，逐字段断言
  it("请求带 x-service-token + x-service-name + x-trace-id 头", async () => {
    const client = makeClient();
    lastHeaders = {};
    const r = await client.lookupDeviceBinding("u-1", "d-3", "trace-1");
    expect(r.bound).toBe(true);
    expect(lastHeaders["x-service-token"]).toBe("tok-1");
    expect(lastHeaders["x-service-name"]).toBe("content-backend");
    expect(lastHeaders["x-trace-id"]).toBe("trace-1");
    expect(lastHeaders["accept"]).toBe("application/json");
  });

  it("500 → LookupError(503)", async () => {
    const client = makeClient();
    await expect(client.lookupDeviceBinding("u-1", "d-4")).rejects.toMatchObject({
      status: 503,
    });
  });

  // Fold-7：401/403 service-auth 失败 → LookupError(503)
  it("401 → LookupError(503)（service-auth 失败）", async () => {
    const client = makeClient();
    await expect(client.lookupDeviceBinding("u-1", "d-6")).rejects.toMatchObject({
      status: 503,
    });
  });

  it("403 → LookupError(503)（service-auth 失败）", async () => {
    const client = makeClient();
    await expect(client.lookupDeviceBinding("u-1", "d-7")).rejects.toMatchObject({
      status: 503,
    });
  });

  it("网络错 → LookupError(503)", async () => {
    // 指向未监听端口 → fetch 抛 → LookupError(503)
    const client = makeClient("http://127.0.0.1:65530");
    await expect(client.lookupDeviceBinding("u-1", "d-5")).rejects.toMatchObject({
      status: 503,
    });
  });

  // Fold-7：shape 无效（bound 非 boolean）→ LookupError(503)
  it("shape 无效（bound 非 boolean）→ LookupError(503)", async () => {
    const client = makeClient();
    await expect(client.lookupDeviceBinding("u-1", "d-8")).rejects.toMatchObject({
      status: 503,
    });
  });

  // Fix-1：200 + 非 JSON body（res.json 抛）→ LookupError(503)
  it("200 + 非 JSON body → LookupError(503)（res.json 兜底）", async () => {
    const client = makeClient();
    await expect(client.lookupDeviceBinding("u-1", "d-9")).rejects.toMatchObject({
      status: 503,
    });
  });
});
