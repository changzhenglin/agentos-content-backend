// views.ts — eta SSR 模板（审核 UI，htmx 渐进增强）。
// 模板全文落 src/admin/templates/*.eta（fold design C2），renderString 自包含读取。
import { Eta } from "eta";
import { readFileSync } from "node:fs";

const eta = new Eta({ cache: false });

// 模板字符串（避免 eta views 路径配置，自包含）
const TEMPLATES: Record<string, string> = {
  login: readFileSync("src/admin/templates/login.eta", "utf8"),
  tracks: readFileSync("src/admin/templates/tracks.eta", "utf8"),
  "ingest-detail": readFileSync("src/admin/templates/ingest-detail.eta", "utf8"),
  "ingest-form": readFileSync("src/admin/templates/ingest-form.eta", "utf8"),
  error: readFileSync("src/admin/templates/error.eta", "utf8"),
};

function render(name: string, data: object): string {
  return eta.renderString(TEMPLATES[name], data);
}

export const renderLogin = () => render("login", {});
export const renderTracksList = (tracks: any[]) => render("tracks", { tracks });
export const renderIngestDetail = (ingest: any) =>
  render("ingest-detail", { ingest });
export const renderIngestForm = (errs: string[] = []) =>
  render("ingest-form", { errs });
// htmx partial：审核动作后原地替换 ingest 行（与 renderIngestDetail 同模板）
export const renderIngestRow = (ingest: any) =>
  render("ingest-detail", { ingest });
// 审核操作错误 partial（400/409，htmx swap 进 body；自包含：
// 400=可重试表单，409=返回链接。eta autoEscape 默认开，reason 回填安全）
export const renderTransitionError = (data: {
  message: string;
  reason?: string;
  retryAction?: string;
  backHref?: string;
}) => render("error", data);
