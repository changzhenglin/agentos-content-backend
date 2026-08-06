// views.ts — eta SSR 模板（审核 UI，htmx 渐进增强）。
// 模板全文落 src/admin/templates/*.eta（fold design C2），renderString 自包含读取。
import { Eta } from "eta";
import { readFileSync } from "node:fs";

const eta = new Eta({ cache: false });

// 模板字符串（避免 eta views 路径配置，自包含）
const TEMPLATES: Record<string, string> = {
  login: readFileSync("src/admin/templates/login.eta", "utf8"),
  tracks: readFileSync("src/admin/templates/tracks.eta", "utf8"),
  queue: readFileSync("src/admin/templates/queue.eta", "utf8"),
  detail: readFileSync("src/admin/templates/detail.eta", "utf8"),
  "detail-main": readFileSync("src/admin/templates/detail-main.eta", "utf8"),
  "ingest-form": readFileSync("src/admin/templates/ingest-form.eta", "utf8"),
  error: readFileSync("src/admin/templates/error.eta", "utf8"),
  audio: readFileSync("src/admin/templates/audio.eta", "utf8"),
};

// layout 公共 partial（head htmx responseHandling 配置 + nav）：queue/detail/tracks
// 三页共享的单一源（fold T2 follow-up ③：原三页各自重复 head+nav，
// 4xx swap 配置变更需三处同步；现集中一处管理）。
// login 页 head 不同（带 title、无 responseHandling/nav），不走此 partial。
const LAYOUT_TOP = `<!doctype html><html><head><meta charset="utf-8"><script src="/public/htmx.min.js"></script><script>htmx.config.responseHandling = [{ code: ".*", swap: true }];</script></head><body>
<nav><a href="/admin/ingests">待审核</a> | <a href="/admin/tracks">已发布曲目</a></nav>
`;
const LAYOUT_BOTTOM = `</body></html>`;

function render(name: string, data: object): string {
  return eta.renderString(TEMPLATES[name], data);
}

// 整页 = layout partial 包裹页面主体（queue/tracks/detail 共用）
function renderPage(name: string, data: object): string {
  return LAYOUT_TOP + render(name, data) + LAYOUT_BOTTOM;
}

export const renderLogin = () => render("login", {});
export const renderTracksList = (tracks: any[]) => renderPage("tracks", { tracks });
export const renderQueuePage = (
  items: {
    id: string;
    track_id: string;
    state: string;
    title: string;
    artist: string;
    created_at: string;
  }[],
) => renderPage("queue", { items });

export interface DetailData {
  ingest: {
    id: string;
    track_id: string;
    state: string;
    meta: Record<string, unknown>;
  };
  history: { actor: string; action: string; reason: string | null; at: string }[];
}

// #detail-main 内部内容 partial：审核操作成功响应的 swap 载荷
//（fold T2 follow-up ③：htmx innerHTML swap 进详情页 #detail-main，
// 原地刷新不嵌套整页）。试听懒加载区在 partial 内，swap 后自动重触发。
export const renderDetailMain = (data: DetailData) => render("detail-main", data);
export const renderDetailPage = (data: DetailData) =>
  renderPage("detail", { ...data, main: renderDetailMain(data) });
export const renderIngestForm = (errs: string[] = []) =>
  render("ingest-form", { errs });
// 审核操作错误 partial（400/409，htmx swap 进 #detail-main；自包含：
// 400=可重试表单，409=返回链接。eta autoEscape 默认开，reason 回填安全）
export const renderTransitionError = (data: {
  message: string;
  reason?: string;
  retryAction?: string;
  backHref?: string;
}) => render("error", data);
// 试听 partial：有 url 出播放器，否则出提示（无音频/未配置/取失败）
export const renderAudio = (data: { url?: string; notice?: string }) =>
  render("audio", data);
