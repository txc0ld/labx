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
