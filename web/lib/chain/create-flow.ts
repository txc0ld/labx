import { decodeFunctionData, encodeFunctionData, erc721Abi, type Hex } from "viem";
import { SubmissionNotDispatchedError } from "./submission-errors";
import { raffleAbi } from "./abi";
import { hash, sameAddress } from "./validation";
import { isWalletRequestRejected } from "./wallet-errors";
import type { RaffleService, WalletSessionPort } from "./ports";
import type { DraftInput, RaffleSnapshot, WorkflowAction } from "./types";

type Step = "createDraft" | "approvePrize" | "escrow";
type Pending = { step: Step; hash: Hex | null };
export type CreateRecord =
  | { kind: "preparing"; data: Hex; requestIdentity: Hex | null }
  | { kind: "draft"; data: Hex; creationHash: Hex | null; id: string | null; pending: Pending | null };
export function createStorageKey(service: RaffleService, seller: string) {
  const m = service.manifest;
  return `labx:create:v1:${m.chainId}:${m.address.toLowerCase()}:${m.runtimeCodeHash.toLowerCase()}:${seller.toLowerCase()}`;
}
export function encodeDraft(draft: DraftInput) {
  return encodeFunctionData({ abi: raffleAbi, functionName: "createRaffle", args: [draft.nft, draft.tokenId, draft.salesEnd, draft.reserveNonce, draft.reserveCommit, draft.title, draft.packs] });
}
export function decodeDraft(data: Hex): DraftInput {
  const call = decodeFunctionData({ abi: raffleAbi, data });
  if (call.functionName !== "createRaffle") throw new Error("Invalid saved draft.");
  const [nft, tokenId, salesEnd, reserveNonce, reserveCommit, title, packs] = call.args;
  return { nft, tokenId, salesEnd, reserveNonce, reserveCommit, title, packs };
}
export function readCreateRecord(storage: Storage, key: string): CreateRecord | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const v: unknown = JSON.parse(raw);
  if (!v || typeof v !== "object" || !("kind" in v)) throw new Error("Saved creation is invalid. Recover wallet activity before creating again.");
  if (v.kind === "preparing" && "data" in v && typeof v.data === "string" && /^0x[0-9a-f]+$/i.test(v.data) && "requestIdentity" in v) {
    const data: Hex = `0x${v.data.slice(2)}`;
    decodeDraft(data);
    return { kind: "preparing", data, requestIdentity: v.requestIdentity === null ? null : hash(v.requestIdentity) };
  }
  if (v.kind !== "draft" || !("data" in v) || typeof v.data !== "string" || !/^0x[0-9a-f]+$/i.test(v.data) || !("creationHash" in v) || !("id" in v) || !("pending" in v)) throw new Error("Saved creation is invalid.");
  const data: Hex = `0x${v.data.slice(2)}`;
  decodeDraft(data);
  if (v.id !== null && (typeof v.id !== "string" || !/^[1-9]\d{0,77}$/.test(v.id))) throw new Error("Invalid saved raffle ID.");
  let pending: Pending | null = null;
  if (v.pending !== null) {
    const p = v.pending;
    if (!p || typeof p !== "object" || !("step" in p) || !("hash" in p) || p.step !== "createDraft" && p.step !== "approvePrize" && p.step !== "escrow") throw new Error("Invalid saved creation step.");
    pending = { step: p.step, hash: p.hash === null ? null : hash(p.hash) };
  }
  return { kind: "draft", data, id: v.id, creationHash: v.creationHash === null ? null : hash(v.creationHash), pending };
}
export function writeCreateRecord(storage: Storage, key: string, record: CreateRecord) {
  const raw = JSON.stringify(record);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("Creation recovery could not be saved. No new wallet request is allowed.");
}
export async function finishCreate({ service, wallet, draft, record, save, assertIntent, onStep }: {
  service: RaffleService; wallet: WalletSessionPort; draft: DraftInput;
  record: Extract<CreateRecord, { kind: "draft" }>; save: (record: Extract<CreateRecord, { kind: "draft" }>) => void;
  assertIntent: () => void; onStep: (step: string) => void;
}): Promise<RaffleSnapshot> {
  const session = wallet.getSnapshot();
  if (session.kind !== "connected") throw new Error("Connect the seller wallet.");
  let current = record;
  const persist = (next: typeof current) => { save(next); current = next; };
  const check = async () => { assertIntent(); await wallet.assertCurrent(session); assertIntent(); };
  const canonical = async (txHash: Hex) => {
    const outcome = await service.inspectOutcome({ hash: txHash, account: session.account, timeoutMs: 120_000 });
    if (outcome.kind !== "confirmed" || outcome.replacedHash !== null) throw new Error("Creation stopped. The exact transaction needs canonical confirmation before continuing.");
    return outcome.receipt;
  };
  const exactReceipt = (receipt: Awaited<ReturnType<typeof canonical>>, action: WorkflowAction & { kind: Step }) => {
    const expected = action.kind === "createDraft" ? { to: service.manifest.address, data: encodeDraft(action.draft) }
      : action.kind === "approvePrize" ? { to: draft.nft, data: encodeFunctionData({ abi: erc721Abi, functionName: "approve", args: [service.manifest.address, draft.tokenId] }) }
      : { to: service.manifest.address, data: encodeFunctionData({ abi: raffleAbi, functionName: "escrow", args: [action.id] }) };
    if (!receipt.to || !sameAddress(receipt.to, expected.to) || receipt.data.toLowerCase() !== expected.data.toLowerCase() || receipt.value !== 0n) throw new Error("The recovered transaction differs from this creation step.");
    return receipt;
  };
  const validateSnapshot = (snapshot: RaffleSnapshot) => {
    const r = snapshot.raffle;
    if (!sameAddress(r.seller, session.account) || encodeDraft({ nft: r.nft, tokenId: r.tokenId, salesEnd: r.salesEnd, reserveNonce: r.reserveNonce, reserveCommit: r.reserveCommit, title: r.title, packs: snapshot.packs }) !== current.data || r.phase !== 0) throw new Error("The canonical draft changed. Review its current state before continuing.");
  };
  const send = async (action: WorkflowAction & { kind: Step }) => {
    await check();
    const journal = await service.pending({ wallet });
    let tx;
    if (current.pending) {
      if (current.pending.step !== action.kind) throw new Error("Recover the earlier creation step first.");
      const txHash = current.pending.hash ?? journal?.hash;
      if (!txHash) throw new Error("The wallet response is uncertain. Recover its transaction hash before continuing.");
      if (journal) tx = await service.resume({ hash: txHash, wallet, expectedJournal: journal });
      if (!tx) {
        const receipt = await canonical(txHash);
        return exactReceipt(receipt, action);
      }
    } else {
      if (journal) throw new Error("Recover the unresolved wallet transaction before creating.");
      const prepared = await service.prepare({ action, wallet, ...(action.kind === "createDraft" ? {} : { expectedDraft: draft }) });
      await check();
      persist({ ...current, pending: { step: action.kind, hash: null } });
      try { tx = await service.submit({ prepared, wallet, assertIntent }); }
      catch (error) {
        if (error instanceof SubmissionNotDispatchedError || isWalletRequestRejected(error) && !await service.pending({ wallet })) persist({ ...current, pending: null });
        throw error;
      }
      persist({ ...current, pending: { step: action.kind, hash: tx.hash } });
    }
    if (!tx) throw new Error("The pending transaction could not be recovered.");
    const outcome = await service.confirm({ transaction: tx, timeoutMs: 120_000, beforeJournalClear: ({ receipt }) => {
      persist({ ...current, pending: { step: action.kind, hash: receipt.hash } });
    } });
    if (outcome.kind !== "confirmed" || outcome.replacedHash !== null) throw new Error("Creation stopped. Confirm or recover the exact wallet transaction before continuing.");
    return exactReceipt(outcome.receipt, action);
  };
  await check();
  if (encodeDraft(draft) !== current.data) throw new Error("The saved draft differs from this creation intent.");
  let snapshot: RaffleSnapshot;
  if (current.creationHash) {
    snapshot = await service.resolveCreatedDraft({ receipt: await canonical(current.creationHash), draft });
  } else if (current.id) {
    snapshot = await service.readRaffle({ id: BigInt(current.id) });
  } else {
    onStep("Creating the on-chain draft…");
    const receipt = await send({ kind: "createDraft", draft });
    snapshot = await service.resolveCreatedDraft({ receipt, draft });
    persist({ ...current, creationHash: receipt.hash, id: snapshot.id.toString(), pending: null });
  }
  validateSnapshot(snapshot);
  await check();
  let account = await service.readAccount({ id: snapshot.id, account: session.account });
  validateSnapshot(account.snapshot);
  if (current.pending?.step === "approvePrize") {
    await send({ kind: "approvePrize", id: snapshot.id });
    persist({ ...current, pending: null });
    account = await service.readAccount({ id: snapshot.id, account: session.account });
    validateSnapshot(account.snapshot);
  }
  if (current.pending?.step === "escrow") {
    await send({ kind: "escrow", id: snapshot.id });
    persist({ ...current, pending: null });
    account = await service.readAccount({ id: snapshot.id, account: session.account });
    validateSnapshot(account.snapshot);
  }
  if (!account.snapshot.raffle.escrowed) {
    if (!account.nftApproved) {
      onStep("Approve this NFT in your wallet…");
      await send({ kind: "approvePrize", id: snapshot.id });
      persist({ ...current, pending: null });
      await check();
      account = await service.readAccount({ id: snapshot.id, account: session.account });
    validateSnapshot(account.snapshot);
      if (!account.nftApproved) throw new Error("The NFT approval could not be confirmed.");
    }
    onStep("Locking the NFT in raffle custody…");
    await send({ kind: "escrow", id: snapshot.id });
    persist({ ...current, pending: null });
  }
  await check();
  account = await service.readAccount({ id: snapshot.id, account: session.account });
  validateSnapshot(account.snapshot);
  if (!account.snapshot.raffle.escrowed || !account.nftOwner || !sameAddress(account.nftOwner, service.manifest.address)) throw new Error("NFT custody could not be confirmed.");
  return account.snapshot;
}
