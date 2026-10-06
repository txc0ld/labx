export function safeArtworkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  if (/^ipfs:\/\/[a-zA-Z0-9/._-]+$/.test(value)) return `https://ipfs.io/ipfs/${value.slice(7).replace(/^ipfs\//, "")}`;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(url.hostname) || /(^|\.)(localhost|local|internal|test)$/.test(url.hostname) || !url.hostname.includes(".")) return null;
    return url.href;
  } catch { return null; }
}
export function parseArtworkMetadata(value: unknown): { title: string; description: string; image: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid artwork metadata.");
  const text = (field: unknown, limit: number) => typeof field === "string" ? field.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit) : "";
  return { title: text("name" in value ? value.name : "", 160), description: text("description" in value ? value.description : "", 1200), image: safeArtworkUrl("image" in value ? value.image : null) };
}

export type ArtworkMetadata = { title: string; description: string; image: string | null };
const MAX_METADATA_BYTES = 65_536;
export function inlineArtworkMetadata(uri: string): ArtworkMetadata | null {
  if (uri.length > MAX_METADATA_BYTES * 2) return null;
  try {
    const encoded = uri.match(/^data:application\/json(?:;charset=utf-8)?(;base64)?,(.*)$/is);
    if (!encoded) return null;
    const value = encoded[1] ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded[2]), char => char.charCodeAt(0))) : decodeURIComponent(encoded[2]);
    if (new TextEncoder().encode(value).length > MAX_METADATA_BYTES) return null;
    return parseArtworkMetadata(JSON.parse(value));
  } catch { return null; }
}
// Remote metadata is fetched only by the visitor's browser, never by an application server.
export async function browserArtworkMetadata(uri: string): Promise<ArtworkMetadata | null> {
  const inline = inlineArtworkMetadata(uri); if (inline) return inline;
  const url = safeArtworkUrl(uri);
  if (!url) return null;
  if (/\.(?:png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(url)) return { title: "", description: "", image: url };
  if (typeof window === "undefined") return null;
  try {
    const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_METADATA_BYTES || !response.body) return null;
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_METADATA_BYTES) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return parseArtworkMetadata(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { return null; }
}
