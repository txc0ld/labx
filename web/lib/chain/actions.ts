import { encodeFunctionData, erc20Abi, erc721Abi, type Hex, type PublicClient } from "viem";
import { buyerFee } from "./fees";
import { raffleAbi } from "./abi";
import { createReader } from "./reader";
import { availableActions } from "./workflow";
import { address, boundedNumber, hash, positiveId, sameAddress } from "./validation";
import { requirePublishedTerms } from "../published-terms";
import type { DeploymentManifest, DraftInput, PreparedAction, WalletSnapshot, WorkflowAction } from "./types";

function validateDraft(draft: DraftInput, now: bigint) {
  address(draft.nft);
  if (typeof draft.tokenId !== "bigint" || draft.tokenId < 0n || draft.tokenId >= 2n ** 256n) throw new Error("Invalid NFT token ID.");
  if (typeof draft.salesEnd !== "bigint" || draft.salesEnd <= now || draft.salesEnd > now + 180n * 86400n) throw new Error("Choose a future closing time within 180 days.");
  for (const value of [draft.reserveNonce, draft.reserveCommit]) if (/^0x0+$/.test(hash(value))) throw new Error("Save a valid commitment first.");
  if (typeof draft.title !== "string" || !draft.title.trim() || new TextEncoder().encode(draft.title).length > 80) throw new Error("A title must contain 1–80 UTF-8 bytes.");
  if (!Array.isArray(draft.packs) || draft.packs.length < 1 || draft.packs.length > 8) throw new Error("Configure 1–8 memberships.");
  for (const pack of draft.packs) {
    if (typeof pack.name !== "string" || !pack.name.trim() || new TextEncoder().encode(pack.name).length > 32) throw new Error("Membership names must contain 1–32 UTF-8 bytes.");
    if (typeof pack.priceUsdc !== "bigint" || pack.priceUsdc <= 0n || pack.priceUsdc > 1_000_000_000_000n) throw new Error("Membership price is outside the contract limit.");
    boundedNumber(pack.bonusEntries, 1, 10_000); boundedNumber(pack.maxSupply, 1, 4_294_967_295);
  }
}
export function actionBuilder(client: PublicClient, manifest: DeploymentManifest, reader: ReturnType<typeof createReader>) {
  return async function build(action: WorkflowAction, session: Extract<WalletSnapshot, { kind: "connected" }>): Promise<PreparedAction> {
    const at = await reader.checkedBlock();
    let to = manifest.address, recipient = manifest.address, data: Hex, value = 0n, amountUsdc = 0n;
    let title = action.kind.replace(/([A-Z])/g, " $1");
    if (action.kind === "createDraft" || action.kind === "updateDraft") {
      const draft = action.draft; validateDraft(draft, at.timestamp);
      const owner = await client.readContract({ address: draft.nft, abi: erc721Abi, functionName: "ownerOf", args: [draft.tokenId], blockNumber: at.number });
      if (action.kind === "createDraft") {
        if (!sameAddress(owner, session.account)) throw new Error("The connected seller must own the NFT.");
        data = encodeFunctionData({ abi: raffleAbi, functionName: "createRaffle", args: [draft.nft, draft.tokenId, draft.salesEnd, draft.reserveNonce, draft.reserveCommit, draft.title, draft.packs] });
      } else {
        positiveId(action.id); const state = await reader.readRaffle({ id: action.id, block: at });
        if (!sameAddress(state.raffle.seller, session.account) || state.raffle.phase !== 0) throw new Error("Only the seller can edit an unopened draft.");
        if (!sameAddress(owner, session.account) && !(state.raffle.escrowed && sameAddress(owner, manifest.address) && sameAddress(draft.nft, state.raffle.nft) && draft.tokenId === state.raffle.tokenId)) throw new Error("This NFT is not owned or escrowed by the seller.");
        data = encodeFunctionData({ abi: raffleAbi, functionName: "updateDraft", args: [action.id, draft.nft, draft.tokenId, draft.salesEnd, draft.reserveNonce, draft.reserveCommit, draft.title, draft.packs] });
      }
    } else if (action.kind === "approveRaffle" || action.kind === "revokeRaffleApproval") {
      const review = await reader.readAdmission({ id: action.id, block: at });
      const { snapshot } = review;
      if (!sameAddress(snapshot.owner, session.account) || snapshot.raffle.phase !== 0) throw new Error("Only the current owner can review a draft.");
      if (hash(action.expectedReviewHash) !== snapshot.admission.reviewHash) throw new Error("Draft review changed. Review it again.");
      if (action.kind === "approveRaffle") {
        if (action.attestations?.canonicalProvenance !== true || action.attestations?.transferRestrictions !== true || action.attestations?.drawFunding !== true) throw new Error("Review canonical provenance, transfer restrictions and draw funding first.");
        if (!snapshot.raffle.escrowed || review.custody.kind !== "held" || review.nftCodeHash === null || at.timestamp >= snapshot.raffle.salesEnd) throw new Error("Approval requires current NFT custody and a future closing time.");
        requirePublishedTerms(review.policy.termsHash);
      }
      data = encodeFunctionData({ abi: raffleAbi, functionName: action.kind, args: [action.id, action.expectedReviewHash] });
      title = action.kind === "approveRaffle" ? "Approve prize and draw funding" : "Revoke draft approval";
    } else {
      positiveId(action.id); const state = await reader.readAccount({ id: action.id, account: session.account, block: at });
      const snapshot = state.snapshot, r = snapshot.raffle;
      if (action.kind === "approveUsdc" || action.kind === "buyMembership") {
        if (r.phase !== 1 || snapshot.paused || at.timestamp >= r.salesEnd) throw new Error("Membership sales are not open.");
        requirePublishedTerms(snapshot.policy.termsHash);
        boundedNumber(action.packId, 0, snapshot.packs.length - 1); boundedNumber(action.quantity, 1, 20);
        const pack = snapshot.packs[action.packId];
        if (!pack.active || pack.maxSupply - pack.sold < action.quantity) throw new Error("The selected membership quantity is no longer available.");
        const principal = pack.priceUsdc * BigInt(action.quantity);
        amountUsdc = principal + buyerFee(principal, snapshot.policy.buyerFeeBps, snapshot.policy.minBuyerFeeUsdc);
        if (action.kind === "approveUsdc") {
          to = manifest.usdc; title = "Approve exact membership total";
          data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [manifest.address, amountUsdc] });
        } else {
          if (action.acceptedTerms !== snapshot.policy.termsHash || action.agreements.terms !== true || action.agreements.rules !== true || action.agreements.age !== true) throw new Error("Review and accept the published membership terms and eligibility requirements.");
          if (action.payment.kind === "usdc") {
            if (state.usdcBalance < amountUsdc || state.usdcAllowance < amountUsdc) throw new Error("The wallet needs enough USDC and approval for this total.");
            data = encodeFunctionData({ abi: raffleAbi, functionName: "buyPack", args: [action.id, action.packId, action.quantity, action.acceptedTerms] });
          } else {
            if (!snapshot.ethEnabled) throw new Error("ETH payment is disabled.");
            const payment = action.payment; boundedNumber(payment.slippageBps, 0, 1000);
            if (payment.deadline <= at.timestamp || payment.deadline > at.timestamp + 600n) throw new Error("The ETH quote expired. Request a new quote.");
            const quote = await client.readContract({ address: manifest.address, abi: raffleAbi, functionName: "quoteEthForUsdc", args: [amountUsdc], blockNumber: at.number });
            const cap = (quote * BigInt(10_000 + payment.slippageBps) + 9999n) / 10_000n;
            if (payment.maxEth !== cap) throw new Error("The ETH price changed. Review a new quote.");
            value = cap;
            data = encodeFunctionData({ abi: raffleAbi, functionName: "buyPackWithEth", args: [action.id, action.packId, action.quantity, action.acceptedTerms, payment.slippageBps, payment.deadline] });
          }
          title = "Purchase membership";
        }
      } else {
        const availability = availableActions(snapshot, state).find(item => item.kind === action.kind);
        if (!availability?.enabled) throw new Error(availability?.reason || "This action is unavailable for this wallet and raffle phase.");
        title = availability.label;
        switch (action.kind) {
          case "approvePrize": to = r.nft; data = encodeFunctionData({ abi: erc721Abi, functionName: "approve", args: [manifest.address, r.tokenId] }); break;
          case "open": {
            const policy = await reader.openingPolicy({ block: at }); requirePublishedTerms(policy.policy.termsHash);
            if (hash(action.expectedPolicyHash) !== policy.hash) throw new Error("Opening policy changed. Review it again.");
            data = encodeFunctionData({ abi: raffleAbi, functionName: "openWithPolicy", args: [action.id, action.expectedPolicyHash] }); break;
          }
          case "snapshot": if (action.maxSteps < 1n || action.maxSteps > 300n) throw new Error("Snapshot batches must contain 1–300 lots."); data = encodeFunctionData({ abi: raffleAbi, functionName: "snapshot", args: [action.id, action.maxSteps] }); break;
          case "reveal": data = encodeFunctionData({ abi: raffleAbi, functionName: "reveal", args: [action.id, hash(action.publicHash), hash(action.privateHash), hash(action.salt)] }); break;
          case "claimPrize": recipient = r.winner; data = encodeFunctionData({ abi: raffleAbi, functionName: "claimPrize", args: [action.id] }); break;
          case "claimProceeds": recipient = r.seller; amountUsdc = r.principalEscrow; data = encodeFunctionData({ abi: raffleAbi, functionName: "claimProceeds", args: [action.id] }); break;
          case "claimFee": recipient = snapshot.policy.treasury; amountUsdc = r.feeEscrow; data = encodeFunctionData({ abi: raffleAbi, functionName: "claimFee", args: [action.id] }); break;
          case "refund": recipient = session.account; amountUsdc = state.principal; data = encodeFunctionData({ abi: raffleAbi, functionName: "refund", args: [action.id] }); break;
          case "reclaimPrize": recipient = r.seller; data = encodeFunctionData({ abi: raffleAbi, functionName: "reclaimPrize", args: [action.id] }); break;
          case "escrow": case "close": case "requestRandomness": case "settle": case "cancel": case "abortDrawing": data = encodeFunctionData({ abi: raffleAbi, functionName: action.kind, args: [action.id] }); break;
          default: { const exhaustive: never = action; throw new Error(`Unsupported action: ${exhaustive}`); }
        }
      }
    }
    const simulated = await client.call({ account: session.account, to, data, value, blockNumber: at.number });
    if (action.kind === "approveUsdc" && simulated.data && BigInt(simulated.data) === 0n) throw new Error("USDC approval was refused.");
    return { action, account: session.account, chainId: manifest.chainId, to, data, value, title, amountUsdc, recipient, block: at, walletRevision: session.revision };
  };
}
