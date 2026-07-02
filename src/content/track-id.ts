const PROVIDERS = ["self", "qq", "netease", "kugou"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ParsedTrackId {
  provider: Provider;
  id: string;
}

export function parseTrackId(trackId: string): ParsedTrackId {
  const sep = trackId.indexOf(":");
  if (sep === -1) throw new Error("NO_RESULT: missing provider prefix");
  const p = trackId.slice(0, sep);
  const id = trackId.slice(sep + 1);
  if (!PROVIDERS.includes(p as Provider)) {
    throw new Error(`NO_RESULT: unknown provider prefix '${p}'`);
  }
  if (id.length === 0) throw new Error("NO_RESULT: empty id");
  return { provider: p as Provider, id };
}
