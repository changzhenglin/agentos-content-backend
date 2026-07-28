// token-verify-hook.ts — #2 content 层 token 校验 preHandler（IAM §6.3 step3+4 编排）。
// 与 receiveAndAuthorize（transport 层）正交：本 hook 校验终端用户+设备绑定。
// 失败语义：JWT 无效 401 / JWKS 不可用 503 / lookup 不可用 503 / bound=false 403 / version 违例 400。
// 顺序：先 JWT(401) 后 lookup(403)——未持有效 token 者不应探测绑定。
// region/entitlement/mTLS caller：capability_mode=mock stub 放行 + log（defer 真校验）。
//
// Fold-8：失败响应用 wrapEnvelope（非裸 {error}），避 onSend AJV 500；
// 失败分支加 req.log.warn；traceId 下传 lookupBinding。
import type { preHandlerHookHandler, FastifyReply, FastifyRequest } from "fastify";
import type { TokenVerifier, VerifyError as VE } from "./jwt-verify.js";
import type { OpsLookupClient, LookupError as LE } from "./ops-lookup.js";
import type { AuditSink } from "../audit/audit-sink.js";
import { parseRequestEnvelope, wrapEnvelope, type Kind } from "../envelope.js";

export type EndUser = { id: string; deviceId: string; role: "owner" | "member" } | null;

declare module "fastify" {
  interface FastifyRequest {
    endUser: EndUser;
  }
}

function emitAudit(
  sink: AuditSink | undefined,
  actor: string,
  event: string,
  traceId: string | undefined,
): void {
  if (!sink) return;
  sink
    .emit({
      eventType: "tool_call",
      actorType: "service",
      actor,
      target: event,
      traceId: traceId ?? "unknown",
    })
    .catch((e) => console.warn("[token-verify-hook] audit emit failed (non-blocking):", e));
}

export function createTokenVerifyHook(deps: {
  verifyToken: TokenVerifier;
  lookupBinding: OpsLookupClient;
  auditSink: AuditSink | undefined;
  capabilityMode: string;
}): preHandlerHookHandler {
  const { verifyToken, lookupBinding, auditSink, capabilityMode } = deps;
  return async function tokenVerifyHook(req: FastifyRequest, reply: FastifyReply) {
    // 初始化 endUser
    req.endUser = null;
    const traceId = (req.headers["x-trace-id"] as string | undefined) ?? undefined;

    let parsed;
    try {
      parsed = parseRequestEnvelope(req.body);
    } catch (e) {
      req.log.warn({ err: e, traceId }, "token-verify: invalid envelope");
      emitAudit(auditSink, "^end_user:unknown", "token_verify:invalid_envelope", traceId);
      return reply
        .code(400)
        .send(
          wrapEnvelope(
            {},
            "content_query",
            "self_hosted",
            "unavailable",
            "blocked",
            "INVALID_ENVELOPE",
          ),
        );
    }

    // #2 final I3：失败响应的 wrapEnvelope kind 用 parsed.kind（透传入向 envelope 的 kind），
    // 非固定 "content_query"。parse 失败分支（parsed 不存在）才用 "content_query" 兜底。
    const kind = (parsed.kind as Kind | undefined) ?? "content_query";

    // 匿名短路：v1 或 v2 user_token=null
    if (parsed.version === 1 || parsed.userToken === null) {
      req.endUser = null;
      return;
    }

    // v2 + user_token≠null：先 JWT 自验
    let verified;
    try {
      verified = await verifyToken.verifyUserToken(parsed.userToken);
    } catch (e) {
      const status = (e as VE).status;
      if (status === 503) {
        req.log.warn({ err: e, traceId }, "token-verify: jwks unavailable");
        emitAudit(auditSink, "^end_user:unknown", "token_verify:jwks_unavailable", traceId);
        return reply
          .code(503)
          .send(
            wrapEnvelope(
              {},
              kind,
              "self_hosted",
              "unavailable",
              "blocked",
              "JWKS_UNAVAILABLE",
            ),
          );
      }
      req.log.warn({ err: e, traceId }, "token-verify: invalid token");
      emitAudit(auditSink, "^end_user:unknown", "token_verify:invalid_token", traceId);
      return reply
        .code(401)
        .send(
          wrapEnvelope(
            {},
            kind,
            "self_hosted",
            "unavailable",
            "blocked",
            "INVALID_TOKEN",
          ),
        );
    }

    // token 绑设备校验（step4），下传 traceId
    let binding;
    try {
      binding = await lookupBinding.lookupDeviceBinding(
        verified.end_user_id,
        parsed.deviceId!,
        traceId,
      );
    } catch (e) {
      req.log.warn(
        { err: e, traceId, endUserId: verified.end_user_id },
        "token-verify: lookup unavailable",
      );
      emitAudit(
        auditSink,
        `^end_user:${verified.end_user_id}`,
        "token_verify:lookup_unavailable",
        traceId,
      );
      return reply
        .code(503)
        .send(
          wrapEnvelope(
            {},
            kind,
            "self_hosted",
            "unavailable",
            "blocked",
            "LOOKUP_UNAVAILABLE",
          ),
        );
    }
    if (!binding.bound) {
      req.log.warn(
        { traceId, endUserId: verified.end_user_id, deviceId: parsed.deviceId },
        "token-verify: device not bound",
      );
      emitAudit(
        auditSink,
        `^end_user:${verified.end_user_id}`,
        "token_verify:device_not_bound",
        traceId,
      );
      return reply
        .code(403)
        .send(
          wrapEnvelope(
            {},
            kind,
            "self_hosted",
            "unavailable",
            "blocked",
            "DEVICE_NOT_BOUND",
          ),
        );
    }

    // mock passthrough 只记 debug 日志，不把 "mock" 写入响应 capability_mode（docs/capability-semantics.md）
    if (capabilityMode === "mock") {
      req.log.debug(
        { endUserId: verified.end_user_id, deviceId: parsed.deviceId },
        "token-verify: region/entitlement stub passthrough (mock)",
      );
    }

    req.endUser = {
      id: verified.end_user_id,
      deviceId: parsed.deviceId!,
      role: binding.role ?? "member",
    };
    emitAudit(
      auditSink,
      `^end_user:${verified.end_user_id}`,
      "token_verify:authorized",
      traceId,
    );
  };
}
