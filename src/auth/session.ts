// session.ts — sim 简单认证（admin/operator, dev token + session cookie, M1c 未启动）。
// 内存 session store + 8h TTL（fold devex M3）。生产由 M1c 接 OIDC/idP 替换，接口不变。
import { randomUUID } from "node:crypto";

export interface SessionUser {
  role: "admin" | "operator";
  name: string;
}

// sim 内存 store（单进程；M1c 替换为外部 session store）
const SESSIONS = new Map<string, { user: SessionUser; ts: number }>();
const TTL_MS = 8 * 3600 * 1000; // 8h TTL（fold devex M3）

export function createSession(user: SessionUser): string {
  const id = randomUUID();
  SESSIONS.set(id, { user, ts: Date.now() });
  return id;
}

export function getSession(id: string): SessionUser | null {
  const e = SESSIONS.get(id);
  if (!e) return null;
  if (Date.now() - e.ts > TTL_MS) {
    SESSIONS.delete(id);
    return null;
  }
  return e.user;
}

// requireRole：preHandler，校验 session + 角色。
// admin 可执行所有操作（admin/operator 路由都放行）；operator 仅 operator 路由。
// 401 未登录 / 403 角色不足。
export function requireRole(role: "admin" | "operator") {
  return async (req: any, reply: any) => {
    const sid = req.headers?.cookie?.match(/sid=([^;]+)/)?.[1];
    const u = sid ? getSession(sid) : null;
    if (!u) {
      return reply
        .code(401)
        .send({ error_code: "UNAUTHORIZED", message: "login required" });
    }
    // admin 拥有所有角色权限；operator 仅当要求 operator 时放行
    if (u.role !== role && u.role !== "admin") {
      return reply.code(403).send({ error_code: "FORBIDDEN", message: "admin only" });
    }
    (req as any).user = u;
  };
}
