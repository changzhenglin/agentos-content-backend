// jwt-verify.ts — #2 终端用户 JWT 自验（IAM §6.3 step3）。
// jose createRemoteJWKSet + kid 精确路由 + iss/aud/exp/nbf + alg RS256 pinned。
// VerifyError(401)：签名/iss/aud/exp/kid/alg/claim 无效或缺失；VerifyError(503)：JWKS 端点不可达/超时/5xx。
// content-backend 自建（跨 repo 不复用 ops web/lib/jwt-verify.ts）。
// Fold-3：catch 用 jose error.code switch（无 JWKSSigningEndpointNotFound）。
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface VerifiedToken {
  end_user_id: string; // JWT sub
  jti: string;
  exp: number;
}

export class VerifyError extends Error {
  constructor(public status: 401 | 503, message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

export interface TokenVerifier {
  verifyUserToken(rawJwt: string): Promise<VerifiedToken>;
}

export function createTokenVerifier(opts: {
  jwksUrl: string;
  issuer: string;
  audience: string;
}): TokenVerifier {
  const jwksUrl = new URL("/.well-known/jwks.json", opts.jwksUrl).href;
  const remoteJwks = createRemoteJWKSet(new URL(jwksUrl));

  return {
    async verifyUserToken(rawJwt: string): Promise<VerifiedToken> {
      try {
        const { payload } = await jwtVerify(rawJwt, remoteJwks, {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms: ["RS256"],
        });
        const sub = payload.sub;
        if (typeof sub !== "string" || sub.length === 0) {
          throw new VerifyError(401, "jwt missing sub (end_user_id)");
        }
        const jti =
          typeof payload.jti === "string" && payload.jti.length > 0 ? payload.jti : undefined;
        const exp =
          typeof payload.exp === "number" && payload.exp > 0 ? payload.exp : undefined;
        // Fold-3：jti/exp 缺失 → 401（claim 校验失败）
        if (!jti || !exp) {
          throw new VerifyError(401, "jwt missing required jti/exp claim");
        }
        return { end_user_id: sub, jti, exp };
      } catch (e) {
        if (e instanceof VerifyError) throw e;
        const code = (e as { code?: string }).code ?? "";
        // 401：签名/iss/aud/exp/kid/alg/claim/格式 无效
        if (
          code === "ERR_JWKS_NO_MATCHING_KEY" ||
          code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" ||
          code === "ERR_JWT_CLAIM_VALIDATION_FAILED" ||
          code === "ERR_JWT_EXPIRED" ||
          code === "ERR_JOSE_ALG_NOT_ALLOWED" ||
          code === "ERR_JWT_INVALID" ||
          code === "ERR_JWS_INVALID"
        ) {
          throw new VerifyError(401, `invalid token: ${(e as Error).message}`);
        }
        // 503：JWKS 端点不可达/超时/无效响应（含 fetch/network/5xx）
        // 注：jose 5 node runtime 用 node:http.get，对非 200 / JSON parse 失败抛 JOSEError
        //（code="ERR_JOSE"，message 含 "JSON Web Key Set HTTP response"）→ 归 503（JWKS 端点问题）
        const msg = e instanceof Error ? e.message : "";
        if (
          code === "ERR_JWKS_TIMEOUT" ||
          code === "ERR_JWKS_INVALID" ||
          code === "ERR_JOSE_GENERIC" && /JSON Web Key Set HTTP response/i.test(msg) ||
          /fetch|network|timeout|ECONNREFUSED|failed to fetch|getaddrinfo/i.test(msg)
        ) {
          throw new VerifyError(503, `jwks unavailable: ${msg}`);
        }
        // 兜底：未知 JOSE error 视为 401（无效 token）
        throw new VerifyError(401, `invalid token: ${(e as Error).message}`);
      }
    },
  };
}
