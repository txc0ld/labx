import { describe, expect, it, vi } from "vitest";
import { browserArtworkMetadata, inlineArtworkMetadata, parseArtworkMetadata, safeArtworkUrl } from "../lib/chain/metadata";
describe("untrusted NFT metadata boundary", () => {
  it.each(["javascript:alert(1)", "data:image/svg+xml,<svg onload=alert(1)>", "http://example.com/a.png", "https://localhost/a", "https://127.0.0.1/a", "https://2130706433/a", "https://[::1]/a", "https://user:pass@example.com/a", "https://example.com:8080/a", "https://a.internal/a"])("rejects unsafe artwork URL %s", value => expect(safeArtworkUrl(value)).toBeNull());
  it("uses bounded plain text and public HTTPS/IPFS image URLs", () => {
    const data = parseArtworkMetadata({ name: "a\u0000b", description: "x".repeat(3000), image: "ipfs://bafy123/image.png" });
    expect(data.title).toBe("a b"); expect(data.description.length).toBe(1200); expect(data.image).toBe("https://ipfs.io/ipfs/bafy123/image.png");
  });
  it("decodes bounded inline JSON and refuses scripts, malformed and oversized values", () => {
    const value = JSON.stringify({ name: "Artwork", image: "https://example.com/art.png" });
    expect(inlineArtworkMetadata(`data:application/json;base64,${btoa(value)}`)?.image).toBe("https://example.com/art.png");
    expect(inlineArtworkMetadata(`data:application/json,${encodeURIComponent(value)}`)?.title).toBe("Artwork");
    expect(inlineArtworkMetadata("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(inlineArtworkMetadata(`data:application/json,${"x".repeat(140000)}`)).toBeNull();
  });
  it("never fetches arbitrary remote metadata from the server", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await browserArtworkMetadata("https://example.com/metadata.json")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore();
  });
});
