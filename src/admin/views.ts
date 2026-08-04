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
  "ingest-form": readFileSync("src/admin/templates/ingest-form.eta", "utf8"),
  error: readFileSync("src/admin/templates/error.eta", "utf8"),
  audio: readFileSync("src/admin/templates/audio.eta", "utf8"),
};

function render(name: string, data: object): string {
  return eta.renderString(TEMPLATES[name], data);
}

export const renderLogin = () => render("login", {});
export const renderTracksList = (tracks: any[]) => render("tracks", { tracks });
export const renderQueuePage = (
  items: {
    id: string;
    track_id: string;
    state: string;
    title: string;
    artist: string;
    created_at: string;
  }[],
) => render("queue", { items });
export const renderDetailPage = (data: {
  ingest: {
    id: string;
    track_id: string;
    state: string;
    meta: Record<string, unknown>;
  };
  history: { actor: string; action: string; reason: string | null; at: string }[];
}) => render("detail", data);
export const renderIngestForm = (errs: string[] = []) =>
  render("ingest-form", { errs });
// 审核操作错误 partial（400/409，htmx swap 进 body；自包含：
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
