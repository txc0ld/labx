import { describe, expect, it, vi } from "vitest";
import { nftTitle } from "../lib/wallet-nfts-shared";
import { createWalletNftHandler, normalizeWalletNftPage } from "../lib/wallet-nfts-server";

const OWNER = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0x2222222222222222222222222222222222222222";
const API_KEY = "test_key_never_real";

function request(query: string, headers?: HeadersInit) {
  return new Request(`https://labx.example/api/wallet-nfts?${query}`, { headers });
}

function upstream(body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } });
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    ownedNfts: [{
      contract: { address: CONTRACT, name: "Collection" },
      tokenId: "0x01",
      tokenType: "ERC721",
      name: "Token one",
      image: { cachedUrl: "https://cdn.example/token.png" }
    }],
    pageKey: "next page/+?",
    ...overrides
  };
}

describe("wallet NFT inventory boundary", () => {
  it("uses the fixed Sepolia endpoint and request policy, then returns only normalized fields", async () => {
    const fetcher: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(`https://eth-sepolia.g.alchemy.com/nft/v3/${API_KEY}/getNFTsForOwner?owner=${OWNER}&withMetadata=true&pageSize=24&tokenUriTimeoutInMs=0&pageKey=opaque+%2F%2B`);
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", headers: { Accept: "application/json" } });
      return upstream(page());
    };
    const handle = createWalletNftHandler({ apiKey: API_KEY, fetcher });
    const response = await handle(request(`owner=${OWNER}&cursor=${encodeURIComponent("opaque /+")}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      items: [{ contract: CONTRACT, tokenId: "1", name: "Token one", collection: "Collection", image: "https://cdn.example/token.png" }],
      nextCursor: "next page/+?",
      chainId: 11155111
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it.each([
    `owner=${OWNER}&owner=${CONTRACT}`,
    `owner=${OWNER}&unknown=1`,
    "owner=0x0000000000000000000000000000000000000000",
    "owner=name.eth",
    `owner=${OWNER}&cursor=`,
    `owner=${OWNER}&cursor=${encodeURIComponent("bad\nvalue")}`
  ])("rejects an invalid strict query without an upstream call: %s", async query => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await createWalletNftHandler({ apiKey: API_KEY, fetcher })(request(query));
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ ok: false, error: "The wallet NFT request is invalid." });
  });

  it("filters invalid, contradictory, duplicate and spam records while normalizing uint256 and text", () => {
    const normalized = normalizeWalletNftPage(page({
      ownedNfts: [
        { contract: { address: CONTRACT, name: "Clean\u0000 collection" }, tokenId: "0x0a", tokenType: "ERC721", name: "Named\nNFT", image: { thumbnailUrl: "https://cdn.example/a.png" } },
        { contract: { address: CONTRACT }, tokenId: "10", tokenType: "ERC721" },
        { contract: { address: CONTRACT }, tokenId: "11", tokenType: "ERC1155" },
        { contract: { address: CONTRACT, tokenType: "ERC1155" }, tokenId: "12", tokenType: "ERC721" },
        { contract: { address: CONTRACT, isSpam: true }, tokenId: "13", tokenType: "ERC721" },
        { contract: { address: "bad" }, tokenId: "14", tokenType: "ERC721" },
        { contract: { address: CONTRACT }, tokenId: (2n ** 256n).toString(), tokenType: "ERC721" }
      ],
      pageKey: null
    }));
    expect(normalized).toEqual({
      items: [{ contract: CONTRACT, tokenId: "10", name: "Named NFT", collection: "Clean collection", image: "https://cdn.example/a.png" }],
      nextCursor: null,
      chainId: 11155111
    });
    expect(nftTitle({ name: "", collection: "", tokenId: "10" })).toBe("NFT #10");
    expect(new TextEncoder().encode(nftTitle({ name: "😀".repeat(30), collection: "", tokenId: "1" })).length).toBeLessThanOrEqual(80);
  });

  it.each([
    new Response("<html>secret upstream error</html>", { status: 500, headers: { "Content-Type": "text/html" } }),
    new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }),
    upstream({ ownedNfts: "bad" }),
    upstream(page({ pageKey: "bad\u0000cursor" }))
  ])("returns a generic secret-safe failure for malformed upstream responses", async providerResponse => {
    const fetcher: typeof fetch = async () => providerResponse.clone();
    const response = await createWalletNftHandler({ apiKey: API_KEY, fetcher })(request(`owner=${OWNER}`));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("temporarily unavailable");
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain("secret upstream error");
  });

  it("cancels a streamed body once it exceeds two MiB", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1_024 * 1_024 + 1)); },
      cancel() { cancelled = true; }
    });
    const fetcher: typeof fetch = async () => new Response(body, { headers: { "Content-Type": "application/json" } });
    const response = await createWalletNftHandler({ apiKey: API_KEY, fetcher })(request(`owner=${OWNER}`));
    expect(response.status).toBe(502);
    expect(cancelled).toBe(true);
  });

  it("times out without retrying and releases the concurrency slot", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    };
    const handle = createWalletNftHandler({ apiKey: API_KEY, fetcher, timeoutMs: 5 });
    const first = await handle(request(`owner=${OWNER}`));
    const second = await handle(request(`owner=${OWNER}&cursor=retry`));
    expect([first.status, second.status]).toEqual([503, 503]);
    expect(calls).toBe(2);
  });

  it("coalesces identical misses, caches for sixty seconds, and refetches after expiry", async () => {
    let current = 10_000;
    let release: (() => void) | undefined;
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      await new Promise<void>(resolve => { release = resolve; });
      return upstream(page({ pageKey: null }));
    };
    const handle = createWalletNftHandler({ apiKey: API_KEY, fetcher, now: () => current });
    const first = handle(request(`owner=${OWNER}`));
    const second = handle(request(`owner=${OWNER}`));
    await vi.waitFor(() => expect(calls).toBe(1));
    release?.();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await handle(request(`owner=${OWNER}`))).status).toBe(200);
    expect(calls).toBe(1);
    current += 60_001;
    const expired = handle(request(`owner=${OWNER}`));
    await vi.waitFor(() => expect(calls).toBe(2));
    release?.();
    expect((await expired).status).toBe(200);
  });

  it("enforces per-owner request limits before a cached response", async () => {
    const fetcher: typeof fetch = async () => upstream(page({ pageKey: null }));
    const handle = createWalletNftHandler({ apiKey: API_KEY, fetcher });
    for (let index = 0; index < 30; index += 1) expect((await handle(request(`owner=${OWNER}`))).status).toBe(200);
    const limited = await handle(request(`owner=${OWNER}`));
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain("manually");
  });

  it("allows at most four distinct upstream requests and does not queue a fifth", async () => {
    const releases: Array<() => void> = [];
    const fetcher: typeof fetch = async () => {
      await new Promise<void>(resolve => releases.push(resolve));
      return upstream(page({ pageKey: null }));
    };
    const handle = createWalletNftHandler({ apiKey: API_KEY, fetcher });
    const requests = Array.from({ length: 4 }, (_, index) => handle(request(`owner=${OWNER}&cursor=${index}`)));
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    const refused = await handle(request(`owner=${OWNER}&cursor=fifth`));
    expect(refused.status).toBe(429);
    expect(releases).toHaveLength(4);
    releases.forEach(resolve => resolve());
    expect((await Promise.all(requests)).map(response => response.status)).toEqual([200, 200, 200, 200]);
    const after = handle(request(`owner=${OWNER}&cursor=after`));
    await vi.waitFor(() => expect(releases).toHaveLength(5));
    releases.at(-1)?.();
    expect((await after).status).toBe(200);
  });

  it("keeps the server key unavailable when configuration is missing or invalid", async () => {
    for (const apiKey of [undefined, "bad/key"]) {
      const response = await createWalletNftHandler({ apiKey })(request(`owner=${OWNER}`));
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).not.toContain(String(apiKey));
      expect(text).toContain("manually");
    }
  });
});
