import { decodeEventLog, erc20Abi, erc721Abi, keccak256, zeroAddress, zeroHash, type Address, type PublicClient } from "viem";
import { browserArtworkMetadata, type ArtworkMetadata } from "./metadata";
import { buyerFee } from "./fees";
import { requirePublishedTerms } from "../published-terms";
import { raffleAbi } from "./abi";
import { attestDeployment, blockRef } from "./deployment";
import type { AccountRaffleState, AdmissionReview, AdmissionStatus, BlockRef, DeploymentManifest, HistoryItem, MembershipQuote, Page, Raffle, RaffleSnapshot } from "./types";
import { CATALOG_PAGE_LIMIT } from "./types";
import { boundedNumber, positiveId, sameAddress } from "./validation";

export function createReader(client: PublicClient, manifest: DeploymentManifest) {
  let verified: BlockRef | null = null;
  async function checkedBlock(requested?: BlockRef): Promise<BlockRef> {
    const at = await blockRef(client, requested);
    if (verified?.hash !== at.hash) {
      const status = await attestDeployment(client, manifest, at);
      if (status.kind !== "verified") throw new Error(status.reason);
      verified = at;
    }
    if (await client.getChainId() !== manifest.chainId) throw new Error("RPC network changed.");
    return at;
  }

  type PageGlobals = Pick<RaffleSnapshot, "paused" | "owner" | "ethEnabled" | "drawStartGrace" | "randomnessGrace" | "revealGrace">;
  const baseAt = (at: BlockRef) => ({ address: manifest.address, abi: raffleAbi, blockNumber: at.number });
  async function readRaffleTuple(id: bigint, at: BlockRef): Promise<Raffle> {
    const value = await client.readContract({ ...baseAt(at), functionName: "getRaffle", args: [id] });
    if (value.seller === zeroAddress) throw new Error("Raffle not found.");
    if (value.packCount < 1 || value.packCount > 8 || value.phase > 6) throw new Error("Raffle data is invalid.");
    return value;
  }
  async function readPageGlobals(at: BlockRef): Promise<PageGlobals> {
    const base = baseAt(at);
    const [paused, owner, ethEnabled, drawStartGrace, randomnessGrace, revealGrace] = await Promise.all([
      client.readContract({ ...base, functionName: "paused" }),
      client.readContract({ ...base, functionName: "owner" }),
      client.readContract({ ...base, functionName: "ethPathEnabled" }),
      client.readContract({ ...base, functionName: "DRAW_START_GRACE" }),
      client.readContract({ ...base, functionName: "VRF_ABORT_AFTER" }),
      client.readContract({ ...base, functionName: "REVEAL_GRACE" })
    ]);
    return { paused, owner, ethEnabled, drawStartGrace, randomnessGrace, revealGrace };
  }
  async function assembleRaffle(id: bigint, at: BlockRef, raffle: Raffle, globals: PageGlobals): Promise<RaffleSnapshot> {
    const base = baseAt(at);
    const [policy, lotCount, accounting, packs, record, reviewHash] = await Promise.all([
      client.readContract({ ...base, functionName: "getRafflePolicy", args: [id] }),
      client.readContract({ ...base, functionName: "lotCount", args: [id] }),
      client.readContract({ ...base, functionName: "getRaffleAccounting", args: [id] }),
      Promise.all(Array.from({ length: raffle.packCount }, (_, packId) => client.readContract({ ...base, functionName: "getPack", args: [id, packId] }))),
      client.readContract({ ...base, functionName: "getRaffleAdmission", args: [id] }),
      raffle.phase === 0 ? client.readContract({ ...base, functionName: "draftReviewHash", args: [id] }) : Promise.resolve(null)
    ]);
    const admission: AdmissionStatus = reviewHash === null
      ? { status: record.approvedAtOpening ? "opened" : "not-opened", reviewHash: null, record }
      : { status: record.approvedReviewHash === zeroHash ? "pending" : record.approvedReviewHash === reviewHash && sameAddress(record.approvedBy, globals.owner) ? "approved" : "changed", reviewHash, record };
    return { id, block: at, raffle, packs, policy, lotCount, accounting, admission, ...globals };
  }
  async function readRaffle({ id, block }: { id: bigint; block?: BlockRef }): Promise<RaffleSnapshot> {
    positiveId(id); const at = await checkedBlock(block);
    const [raffle, globals] = await Promise.all([readRaffleTuple(id, at), readPageGlobals(at)]);
    const snapshot = await assembleRaffle(id, at, raffle, globals);
    await checkedBlock(at);
    return snapshot;
  }
  async function readArtwork({ id, block }: { id: bigint; block?: BlockRef }): Promise<ArtworkMetadata> {
    positiveId(id); const at = await checkedBlock(block);
    const raffle = await readRaffleTuple(id, at);
    const fallback = { title: raffle.title, description: "", image: null };
    let artwork: ArtworkMetadata = fallback;
    try {
      const uri = await client.readContract({ address: raffle.nft, abi: erc721Abi, functionName: "tokenURI", args: [raffle.tokenId], blockNumber: at.number });
      const metadata = await browserArtworkMetadata(uri);
      artwork = metadata ? { ...metadata, title: raffle.title } : fallback;
    } catch { /* Expected token and metadata failures use the recorded title. */ }
    await checkedBlock(at);
    return artwork;
  }
  async function paginateRaffles({ cursor = 1n, limit = 12, block, seller, draftOnly = false }: { cursor?: bigint; limit?: number; block?: BlockRef; seller?: Address; draftOnly?: boolean } = {}): Promise<Page<RaffleSnapshot>> {
    positiveId(cursor); boundedNumber(limit, 1, CATALOG_PAGE_LIMIT); const at = await checkedBlock(block);
    const nextId = await client.readContract({ address: manifest.address, abi: raffleAbi, functionName: "nextId", blockNumber: at.number });
    if (cursor > nextId) throw new Error("Catalog cursor is outside this block snapshot.");
    const end = cursor + BigInt(limit) < nextId ? cursor + BigInt(limit) : nextId;
    const ids: bigint[] = []; for (let id = cursor; id < end; id++) ids.push(id);
    const tuples = await Promise.all(ids.map(async id => ({ id, raffle: await readRaffleTuple(id, at) })));
    const selected = tuples.filter(item => (seller === undefined || sameAddress(item.raffle.seller, seller)) && (!draftOnly || item.raffle.phase === 0));
    const items = selected.length === 0
      ? []
      : await readPageGlobals(at).then(globals => Promise.all(selected.map(item => assembleRaffle(item.id, at, item.raffle, globals))));
    await checkedBlock(at);
    return { items, nextCursor: end < nextId ? end : null, block: at };
  }
  async function listRaffles(input: { cursor?: bigint; limit?: number; block?: BlockRef; seller?: Address } = {}) {
    return paginateRaffles(input);
  }
  async function readAccount({ id, account, block }: { id: bigint; account: Address; block?: BlockRef }): Promise<AccountRaffleState> {
    const snapshot = await readRaffle({ id, block }); const at = snapshot.block.number;
    const base = { address: manifest.address, abi: raffleAbi, blockNumber: at };
    const [principal, fee, usdcBalance, usdcAllowance, nftOwner, approved, operatorApproved] = await Promise.all([
      client.readContract({ ...base, functionName: "principalOf", args: [id, account] }),
      client.readContract({ ...base, functionName: "feeOf", args: [id, account] }),
      client.readContract({ address: manifest.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber: at }),
      client.readContract({ address: manifest.usdc, abi: erc20Abi, functionName: "allowance", args: [account, manifest.address], blockNumber: at }),
      client.readContract({ address: snapshot.raffle.nft, abi: erc721Abi, functionName: "ownerOf", args: [snapshot.raffle.tokenId], blockNumber: at }).catch(() => null),
      client.readContract({ address: snapshot.raffle.nft, abi: erc721Abi, functionName: "getApproved", args: [snapshot.raffle.tokenId], blockNumber: at }).catch(() => zeroAddress),
      client.readContract({ address: snapshot.raffle.nft, abi: erc721Abi, functionName: "isApprovedForAll", args: [account, manifest.address], blockNumber: at }).catch(() => false)
    ]);
    return { account, snapshot, principal, fee, usdcBalance, usdcAllowance, nftOwner, nftApproved: sameAddress(approved, manifest.address) || operatorApproved };
  }
  async function listLots({ id, cursor = 0n, limit = 50, block }: { id: bigint; cursor?: bigint; limit?: number; block?: BlockRef }) {
    if (cursor < 0n) throw new Error("Invalid cursor."); boundedNumber(limit, 1, 100);
    const snapshot = await readRaffle({ id, block });
    if (cursor > snapshot.lotCount) throw new Error("Entry cursor is outside this block snapshot.");
    const end = cursor + BigInt(limit) < snapshot.lotCount ? cursor + BigInt(limit) : snapshot.lotCount;
    const indexes: bigint[] = []; for (let i = cursor; i < end; i++) indexes.push(i);
    const items = await Promise.all(indexes.map(index => client.readContract({ address: manifest.address, abi: raffleAbi, functionName: "lotAt", args: [id, index], blockNumber: snapshot.block.number })));
    return { items, nextCursor: end < snapshot.lotCount ? end : null, block: snapshot.block };
  }
  async function history({ account, fromBlock = manifest.deploymentBlock, block }: { account: Address; fromBlock?: bigint; block?: BlockRef }) {
    const at = await checkedBlock(block);
    if (fromBlock < manifest.deploymentBlock || fromBlock > at.number) throw new Error("Invalid history block range.");
    const toBlock = fromBlock + 1_999n < at.number ? fromBlock + 1_999n : at.number;
    const logs = await client.getLogs({ address: manifest.address, fromBlock, toBlock });
    if (logs.length > 5_000) throw new Error("Too many events in this block range. Use a smaller range.");
    const items: HistoryItem[] = [];
    for (const log of logs) {
      if (log.removed || log.blockNumber === null || log.transactionHash === null || log.logIndex === null) continue;
      try {
        const event = decodeEventLog({ abi: raffleAbi, data: log.data, topics: log.topics, strict: true });
        let holder: Address; let principal = 0n; let fee = 0n; let quantity = 0; let bonusEntries = 0;
        switch (event.eventName) {
          case "PackPurchased": holder = event.args.buyer; principal = event.args.principal; fee = event.args.fee; quantity = event.args.qty; bonusEntries = event.args.bonusEntries; break;
          case "PrizeClaimed": holder = event.args.winner; break;
          case "PrizeReclaimed": holder = event.args.seller; break;
          case "ProceedsClaimed": holder = event.args.seller; principal = event.args.principal; break;
          case "FeeClaimed": holder = event.args.treasury; fee = event.args.fee; break;
          case "Refunded": holder = event.args.buyer; principal = event.args.amount; break;
          default: continue;
        }
        if (sameAddress(holder, account)) items.push({ raffleId: event.args.id, event: event.eventName, account: holder, principal, fee, quantity, bonusEntries, transactionHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber });
      } catch { throw new Error("Contract event data could not be decoded."); }
    }
    return { items, nextCursor: toBlock < at.number ? toBlock + 1n : null, block: at };
  }
  async function openingPolicy({ block }: { block?: BlockRef } = {}) {
    const at = await checkedBlock(block); const base = { address: manifest.address, abi: raffleAbi, blockNumber: at.number };
    const [coordinator, treasury, termsHash, keyHash, subscriptionId, callbackGasLimit, requestConfirmations, nativePayment, buyerFeeBps, sellerFeeBps, minBuyerFeeUsdc, hash] = await Promise.all([
      client.readContract({ ...base, functionName: "vrfCoordinator" }), client.readContract({ ...base, functionName: "treasury" }),
      client.readContract({ ...base, functionName: "termsHash" }), client.readContract({ ...base, functionName: "keyHash" }),
      client.readContract({ ...base, functionName: "subscriptionId" }), client.readContract({ ...base, functionName: "callbackGasLimit" }),
      client.readContract({ ...base, functionName: "requestConfirmations" }), client.readContract({ ...base, functionName: "nativePayment" }),
      client.readContract({ ...base, functionName: "BUYER_FEE_BPS" }),
      client.readContract({ ...base, functionName: "SELLER_FEE_BPS" }),
      client.readContract({ ...base, functionName: "MIN_BUYER_FEE_USDC" }),
      client.readContract({ ...base, functionName: "openingPolicyHash" })
    ]);
    await checkedBlock(at);
    return { policy: { coordinator, treasury, termsHash, keyHash, subscriptionId, callbackGasLimit, requestConfirmations, nativePayment, buyerFeeBps, sellerFeeBps, minBuyerFeeUsdc }, hash, block: at };
  }
  async function listOwnerQueue(input: { cursor?: bigint; limit?: number; block?: BlockRef } = {}) {
    return paginateRaffles({ ...input, limit: input.limit ?? CATALOG_PAGE_LIMIT, draftOnly: true });
  }
  async function readAdmission({ id, block }: { id: bigint; block?: BlockRef }): Promise<AdmissionReview> {
    const snapshot = await readRaffle({ id, block }); const at = snapshot.block;
    const [opening, ownerGeneration, openingPolicyGeneration, code, custodyOwner] = await Promise.all([
      snapshot.raffle.phase === 0 ? openingPolicy({ block: at }) : Promise.resolve(null),
      client.readContract({ ...baseAt(at), functionName: "ownerGeneration" }),
      client.readContract({ ...baseAt(at), functionName: "openingPolicyGeneration" }),
      client.getCode({ address: snapshot.raffle.nft, blockNumber: at.number }).catch(() => undefined),
      client.readContract({ address: snapshot.raffle.nft, abi: erc721Abi, functionName: "ownerOf", args: [snapshot.raffle.tokenId], blockNumber: at.number }).catch(() => null)
    ]);
    await checkedBlock(at);
    return { snapshot, policy: opening?.policy ?? snapshot.policy, policyHash: opening?.hash ?? null,
      ownerGeneration, openingPolicyGeneration, nftCodeHash: code && code !== "0x" ? keccak256(code) : null,
      custody: custodyOwner === null ? { kind: "unknown" } : { kind: sameAddress(custodyOwner, manifest.address) ? "held" : "not-held", owner: custodyOwner } };
  }
  async function quoteMembership({ id, packId, quantity, slippageBps = 100 }: { id: bigint; packId: number; quantity: number; slippageBps?: number }): Promise<MembershipQuote> {
    const snapshot = await readRaffle({ id }); boundedNumber(packId, 0, snapshot.packs.length - 1); boundedNumber(quantity, 1, 20); boundedNumber(slippageBps, 0, 1000);
    if (snapshot.raffle.phase !== 1 || snapshot.paused || snapshot.block.timestamp >= snapshot.raffle.salesEnd) throw new Error("Membership sales are not open.");
    requirePublishedTerms(snapshot.policy.termsHash);
    const pack = snapshot.packs[packId];
    if (!pack.active || pack.maxSupply - pack.sold < quantity) throw new Error("This membership quantity is unavailable.");
    const principal = pack.priceUsdc * BigInt(quantity), fee = buyerFee(principal, snapshot.policy.buyerFeeBps, snapshot.policy.minBuyerFeeUsdc), totalUsdc = principal + fee;
    const basic = { principal, fee, totalUsdc, bonusEntries: BigInt(pack.bonusEntries) * BigInt(quantity), block: snapshot.block };
    if (!snapshot.ethEnabled) return { ...basic, eth: { kind: "unavailable", reason: "ETH payment is disabled for this deployment." } };
    try {
      const requiredEth = await client.readContract({ address: manifest.address, abi: raffleAbi, functionName: "quoteEthForUsdc", args: [totalUsdc], blockNumber: snapshot.block.number });
      return { ...basic, eth: { kind: "available", requiredEth, maxEth: (requiredEth * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n, slippageBps, deadline: snapshot.block.timestamp + 300n } };
    } catch { return { ...basic, eth: { kind: "unavailable", reason: "A valid ETH price quote is currently unavailable." } }; }
  }
  return { checkedBlock, readAdmission, listOwnerQueue, readRaffle, readArtwork, listRaffles, readAccount, listLots, history, openingPolicy, quoteMembership };
}
