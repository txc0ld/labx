import { getAddress, isAddress, type Address } from "viem";
import { safeArtworkUrl } from "./chain/metadata";
import { MAX_RESPONSE_BYTES, boundedWalletNftText, isValidWalletNftCursor, normalizeTokenId, objectRecord, type WalletNft, type WalletNftPage } from "./wallet-nfts-shared";

const MAX_UPSTREAM_BYTES = 2 * 1_024 * 1_024;
type HandlerOptions = { apiKey?: string; fetcher?: typeof fetch; now?: () => number; timeoutMs?: number; trustedVercel?: boolean };
type RateEntry = { window: number; count: number };
type CacheEntry = { page: WalletNftPage; bytes: number; expiresAt: number };

class PublicFailure extends Error {
  constructor(readonly status: 400 | 429 | 502 | 503, readonly publicMessage: string) { super(publicMessage); }
}

function spamFlagged(item: Record<string, unknown>, contract: Record<string, unknown>): boolean {
  if (item.isSpam === true || contract.isSpam === true) return true;
  const info = objectRecord(item.spamInfo);
  return info?.isSpam === true || Array.isArray(contract.spamClassifications) && contract.spamClassifications.length > 0;
}

function previewUrl(item: Record<string, unknown>): string | null {
  const image = objectRecord(item.image);
  if (!image) return null;
  for (const key of ["cachedUrl", "thumbnailUrl", "pngUrl", "originalUrl"] as const) {
    const safe = safeArtworkUrl(image[key]);
    if (safe && safeArtworkUrl(safe) === safe) return safe;
  }
  return null;
}

function responseBytes(page: WalletNftPage): number {
  return new TextEncoder().encode(JSON.stringify({ ok: true, ...page })).length;
}

export function normalizeWalletNftPage(value: unknown): WalletNftPage {
  const root = objectRecord(value);
  if (!root || !Array.isArray(root.ownedNfts) || root.ownedNfts.length > 100) throw new PublicFailure(502, "Wallet NFT inventory is temporarily unavailable.");
  const nextCursor = root.pageKey === undefined || root.pageKey === null ? null : root.pageKey;
  if (nextCursor !== null && !isValidWalletNftCursor(nextCursor)) throw new PublicFailure(502, "Wallet NFT inventory is temporarily unavailable.");
  const items: WalletNft[] = [];
  const seen = new Set<string>();
  for (const raw of root.ownedNfts.slice(0, 24)) {
    const item = objectRecord(raw);
    if (!item || item.tokenType !== "ERC721") continue;
    const contract = objectRecord(item.contract);
    if (!contract || typeof contract.address !== "string" || !isAddress(contract.address) || /^0x0{40}$/i.test(contract.address)) continue;
    if (contract.tokenType !== undefined && contract.tokenType !== "ERC721" || spamFlagged(item, contract)) continue;
    const tokenId = normalizeTokenId(item.tokenId);
    if (tokenId === null) continue;
    const normalizedContract = getAddress(contract.address);
    const key = `${normalizedContract.toLowerCase()}:${tokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ contract: normalizedContract, tokenId, name: boundedWalletNftText(item.name ?? item.title, 160), collection: boundedWalletNftText(contract.name, 160), image: previewUrl(item) });
  }
  const page = { items, nextCursor, chainId: 11155111 } satisfies WalletNftPage;
  if (responseBytes(page) <= MAX_RESPONSE_BYTES) return page;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item.image) continue;
    items[index] = { ...item, image: null };
    if (responseBytes(page) <= MAX_RESPONSE_BYTES) return page;
  }
  if (responseBytes(page) > MAX_RESPONSE_BYTES) throw new PublicFailure(502, "Wallet NFT inventory is temporarily unavailable.");
  return page;
}

function requestInput(request: Request): { owner: Address; cursor: string | null } {
  if (request.url.length > 4_096) throw new PublicFailure(400, "The wallet NFT request is invalid.");
  let url: URL;
  try { url = new URL(request.url); } catch { throw new PublicFailure(400, "The wallet NFT request is invalid."); }
  const allowed = new Set(["owner", "cursor"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new PublicFailure(400, "The wallet NFT request is invalid.");
  if (url.searchParams.getAll("owner").length !== 1 || url.searchParams.getAll("cursor").length > 1) throw new PublicFailure(400, "The wallet NFT request is invalid.");
  const owner = url.searchParams.get("owner");
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner) || !isAddress(owner) || /^0x0{40}$/i.test(owner)) throw new PublicFailure(400, "The wallet NFT request is invalid.");
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !isValidWalletNftCursor(cursor)) throw new PublicFailure(400, "The wallet NFT request is invalid.");
  return { owner: getAddress(owner), cursor };
}

function clientBucket(request: Request, trustedVercel: boolean): string {
  if (!trustedVercel) return "local-or-unknown";
  const value = request.headers.get("x-vercel-forwarded-for");
  if (!value || value.length > 64 || value.includes(",") || !/^[0-9a-fA-F:.]+$/.test(value)) return "vercel-unknown";
  return value.toLowerCase();
}

async function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function cancelBody(body: ReadableStream<Uint8Array> | null, signal: AbortSignal) {
  if (body) await beforeAbort(body.cancel().catch(() => undefined), signal);
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await cancelBody(response.body, signal);
    throw new PublicFailure(502, "Wallet NFT inventory is temporarily unavailable.");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_UPSTREAM_BYTES)) {
    await cancelBody(response.body, signal);
    throw new PublicFailure(502, "Wallet NFT inventory is temporarily unavailable.");
  }
  if (!response.body) throw new PublicFailure(502, "Wallet NFT inventory is temporarily unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try { next = await beforeAbort(reader.read(), signal); }
    catch (error) { void reader.cancel().catch(() => undefined); throw error; }
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_UPSTREAM_BYTES) { await beforeAbort(reader.cancel().catch(() => undefined), signal); throw new PublicFailure(502, "Wallet NFT inventory is temporarily unavailable."); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new PublicFailure(502, "Wallet NFT inventory is temporarily unavailable."); }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

export function createWalletNftHandler(options: HandlerOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const trustedVercel = options.trustedVercel ?? false;
  const cache = new Map<string, CacheEntry>();
  const ipRates = new Map<string, RateEntry>();
  const ownerRates = new Map<string, RateEntry>();
  const upstreamRates = new Map<string, RateEntry>();
  const inFlight = new Map<string, Promise<WalletNftPage>>();
  let cacheBytes = 0;
  let active = 0;

  function checkRate(map: Map<string, RateEntry>, key: string, limit: number, current: number) {
    for (const [entryKey, entry] of map) if (entry.window + 60_000 <= current) map.delete(entryKey);
    while (map.size >= 1_024 && !map.has(key)) map.delete(map.keys().next().value ?? "");
    const window = Math.floor(current / 60_000) * 60_000;
    const entry = map.get(key);
    if (!entry || entry.window !== window) { map.set(key, { window, count: 1 }); return; }
    if (entry.count >= limit) throw new PublicFailure(429, "Wallet NFT requests are temporarily limited. Enter the NFT manually or try again later.");
    entry.count += 1;
    map.delete(key); map.set(key, entry);
  }

  function cached(key: string, current: number): WalletNftPage | null {
    for (const [entryKey, entry] of cache) if (entry.expiresAt <= current) { cache.delete(entryKey); cacheBytes -= entry.bytes; }
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key); cache.set(key, entry);
    return entry.page;
  }

  function remember(key: string, page: WalletNftPage, current: number) {
    const bytes = new TextEncoder().encode(JSON.stringify(page)).length;
    const prior = cache.get(key);
    if (prior) { cache.delete(key); cacheBytes -= prior.bytes; }
    cache.set(key, { page, bytes, expiresAt: current + 60_000 }); cacheBytes += bytes;
    while (cache.size > 128 || cacheBytes > 4 * 1_024 * 1_024) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      const removed = cache.get(oldest); cache.delete(oldest); cacheBytes -= removed?.bytes ?? 0;
    }
  }

  async function upstream(owner: Address, cursor: string | null): Promise<WalletNftPage> {
    if (!options.apiKey || !/^[A-Za-z0-9_-]{8,256}$/.test(options.apiKey)) throw new PublicFailure(503, "Wallet NFT inventory is unavailable. Enter the NFT contract and token ID manually.");
    const url = new URL("https://eth-sepolia.g.alchemy.com/nft/v3/getNFTsForOwner");
    url.searchParams.set("owner", owner); url.searchParams.set("withMetadata", "true"); url.searchParams.set("pageSize", "24"); url.searchParams.set("tokenUriTimeoutInMs", "0");
    if (cursor !== null) url.searchParams.set("pageKey", cursor);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { method: "GET", redirect: "error", credentials: "omit", headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` }, signal: controller.signal });
      return normalizeWalletNftPage(await readBoundedJson(response, controller.signal));
    } catch (error) {
      if (error instanceof PublicFailure) throw error;
      if (controller.signal.aborted) throw new PublicFailure(503, "Wallet NFT inventory timed out. Enter the NFT manually or try again.");
      throw new PublicFailure(502, "Wallet NFT inventory is temporarily unavailable.");
    } finally { clearTimeout(timer); }
  }

  return async function handle(request: Request): Promise<Response> {
    try {
      const input = requestInput(request);
      const current = now();
      checkRate(ipRates, clientBucket(request, trustedVercel), 30, current);
      checkRate(ownerRates, input.owner.toLowerCase(), 30, current);
      const key = `11155111:${input.owner.toLowerCase()}:${input.cursor ?? ""}`;
      const hit = cached(key, current);
      if (hit) return json({ ok: true, ...hit });
      const pending = inFlight.get(key);
      if (pending) return json({ ok: true, ...await pending });
      checkRate(upstreamRates, "global", 120, current);
      if (active >= 4) throw new PublicFailure(429, "Wallet NFT requests are busy. Enter the NFT manually or try again.");
      active += 1;
      const task = upstream(input.owner, input.cursor).then(page => { remember(key, page, now()); return page; });
      inFlight.set(key, task);
      try { return json({ ok: true, ...await task }); }
      finally { active -= 1; inFlight.delete(key); }
    } catch (error) {
      const failure = error instanceof PublicFailure ? error : new PublicFailure(503, "Wallet NFT inventory is unavailable. Enter the NFT manually.");
      return json({ ok: false, error: failure.publicMessage }, failure.status);
    }
  };
}
