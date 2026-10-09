import { decodeFunctionData, encodeFunctionData, erc721Abi, type Hex } from "viem";
import { transactionIntent } from "./pending-journal";
import { raffleAbi } from "./abi";
import { hash, sameAddress } from "./validation";
import type { RaffleService, WalletSessionPort } from "./ports";
import type { CanonicalReceipt, DraftInput, RaffleSnapshot, SubmissionCheckpoint, SubmittedAction, WorkflowAction } from "./types";

type Step = "createDraft" | "approvePrize" | "escrow";
type Pending = { step: Step; hash: Hex | null; checkpoint?: SubmissionCheckpoint };
type Failure = { step: Step; hash: Hex; nonce: number; blockNumber: string };
export type CreateRecord =
  | { kind: "preparing"; data: Hex; requestIdentity: Hex | null }
  | { kind: "draft"; data: Hex; creationHash: Hex | null; id: string | null; pending: Pending | null; lastFailure?: Failure };
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
    pending = { step: p.step, hash: p.hash === null ? null : hash(p.hash), ...("checkpoint" in p ? { checkpoint: parseCheckpoint(p.checkpoint) } : {}) };
  }
  let lastFailure: Failure | undefined;
  if ("lastFailure" in v) {
    const f = v.lastFailure;
    if (!f || typeof f !== "object" || !("step" in f) || f.step !== "createDraft" && f.step !== "approvePrize" && f.step !== "escrow" || !("hash" in f) || !("nonce" in f) || typeof f.nonce !== "number" || !Number.isSafeInteger(f.nonce) || f.nonce < 0 || !("blockNumber" in f) || typeof f.blockNumber !== "string" || !/^\d+$/.test(f.blockNumber)) throw new Error("Invalid creation failure receipt.");
    lastFailure = { step: f.step, hash: hash(f.hash), nonce: f.nonce, blockNumber: f.blockNumber };
  }
  return { kind: "draft", data, id: v.id, creationHash: v.creationHash === null ? null : hash(v.creationHash), pending, ...(lastFailure ? { lastFailure } : {}) };
}
function parseCheckpoint(value: unknown): SubmissionCheckpoint {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !value.id || !("nonce" in value) || typeof value.nonce !== "number" || !Number.isSafeInteger(value.nonce) || value.nonce < 0 || !("intentHash" in value) || !("startedBlock" in value) || typeof value.startedBlock !== "string" || !/^\d+$/.test(value.startedBlock)) throw new Error("Invalid creation transaction checkpoint.");
  return { id: value.id, nonce: value.nonce, intentHash: hash(value.intentHash), startedBlock: value.startedBlock };
}
export function captureCreateGeneration(storage: Storage, key: string) {
  return { raw: storage.getItem(key), generation: storage.getItem(`${key}:generation`) };
}
export function assertCreateGeneration(storage: Storage, key: string, expected: ReturnType<typeof captureCreateGeneration>) {
  const current = captureCreateGeneration(storage, key);
  if (current.raw !== expected.raw || current.generation !== expected.generation) throw new Error("Creation changed in another tab. Review its saved state before clicking Create again.");
}
export function advanceCreateGeneration(storage: Storage, key: string) {
  const generation = crypto.randomUUID();
  storage.setItem(`${key}:generation`, generation);
  if (storage.getItem(`${key}:generation`) !== generation) throw new Error("Creation recovery could not be saved.");
}
export async function retireUnsentCreate({ service, wallet, storage, key, expected, assertIntent }: {
  service: RaffleService; wallet: WalletSessionPort; storage: Storage; key: string; expected: CreateRecord; assertIntent: () => void;
}) {
  assertIntent();
  const raw = storage.getItem(key);
  const saved = readCreateRecord(storage, key);
  if (raw === null || saved === null || serializeCreateRecord(saved) !== serializeCreateRecord(expected)) throw new Error("The saved creation changed. Reload before editing.");
  if (expected.kind === "draft" && (expected.id !== null || expected.creationHash !== null || expected.pending !== null)) throw new Error("Recover the on-chain creation before editing.");
  if (await service.pending({ wallet })) throw new Error("Recover the unresolved wallet transaction before editing.");
  assertIntent();
  if (storage.getItem(key) !== raw) throw new Error("The saved creation changed. Reload before editing.");
  const archive = `${key}:retired:${crypto.randomUUID()}`;
  storage.setItem(archive, raw);
  if (storage.getItem(archive) !== raw) throw new Error("Creation recovery could not be retained.");
  advanceCreateGeneration(storage, key);
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("The saved creation could not be retired.");
}
export function serializeCreateRecord(record: CreateRecord) {
  if (record.kind === "preparing") return JSON.stringify({ kind: record.kind, data: record.data, requestIdentity: record.requestIdentity });
  const p = record.pending, checkpoint = p?.checkpoint, f = record.lastFailure;
  return JSON.stringify({ kind: record.kind, data: record.data, id: record.id, creationHash: record.creationHash,
    pending: p ? { step: p.step, hash: p.hash, ...(checkpoint ? { checkpoint: { id: checkpoint.id, nonce: checkpoint.nonce, intentHash: checkpoint.intentHash, startedBlock: checkpoint.startedBlock } } : {}) } : null,
    ...(f ? { lastFailure: { step: f.step, hash: f.hash, nonce: f.nonce, blockNumber: f.blockNumber } } : {}) });
}
export function writeCreateRecord(storage: Storage, key: string, record: CreateRecord) {
  const raw = serializeCreateRecord(record);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("Creation recovery could not be saved. No new wallet request is allowed.");
}
export function retireCompletedCreate(storage: Storage, key: string, expected: Extract<CreateRecord, { kind: "draft" }>, id: bigint) {
  const saved = readCreateRecord(storage, key);
  if (saved?.kind !== "draft" || saved.id !== id.toString() || saved.pending !== null || serializeCreateRecord(saved) !== serializeCreateRecord(expected)) throw new Error("Creation recovery changed before completion.");
  const raw = JSON.stringify({ id: id.toString(), creationHash: saved.creationHash });
  const historyKey = `${key}:completed:${id}`;
  storage.setItem(historyKey, raw);
  if (storage.getItem(historyKey) !== raw) throw new Error("The completed creation receipt could not be retained.");
  advanceCreateGeneration(storage, key);
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("The completed creation could not be retired.");
}
type DraftRecord = Extract<CreateRecord, { kind: "draft" }>;
function stepTransaction(service: RaffleService, draft: DraftInput, step: Step, id: string | null) {
  if (step === "createDraft") return { to: service.manifest.address, data: encodeDraft(draft), value: 0n };
  if (!id) throw new Error("Recover the created raffle before its custody transaction.");
  return step === "approvePrize"
    ? { to: draft.nft, data: encodeFunctionData({ abi: erc721Abi, functionName: "approve", args: [service.manifest.address, draft.tokenId] }), value: 0n }
    : { to: service.manifest.address, data: encodeFunctionData({ abi: raffleAbi, functionName: "escrow", args: [BigInt(id)] }), value: 0n };
}
async function settleCreateStep({ service, wallet, record, save, assertIntent, transaction, recoveryHash }: {
  service: RaffleService; wallet: WalletSessionPort; record: DraftRecord; save: (record: DraftRecord) => void;
  assertIntent: () => void; transaction?: SubmittedAction; recoveryHash?: Hex;
}): Promise<CanonicalReceipt> {
  const session = wallet.getSnapshot();
  if (session.kind !== "connected" || !record.pending) throw new Error("Recover the saved creation transaction first.");
  let current = record;
  let pending = record.pending;
  const expected = stepTransaction(service, decodeDraft(record.data), pending.step, record.id);
  const intentHash = transactionIntent(expected);
  const journal = await service.pending({ wallet, expectedIntent: intentHash });
  assertIntent();
  if (pending.checkpoint && (pending.checkpoint.intentHash !== intentHash || journal && journal.id !== pending.checkpoint.id)) throw new Error("The unresolved wallet transaction differs from this creation checkpoint.");
  if (!pending.checkpoint && journal) {
    if (!journal.checkpoint) throw new Error("The pending wallet transaction has no verified creation checkpoint.");
    pending = { ...pending, checkpoint: journal.checkpoint };
    current = { ...current, pending }; save(current);
  }
  if (recoveryHash && !pending.checkpoint && pending.step !== "createDraft") throw new Error("This older saved custody send has no nonce checkpoint. Recover its original wallet transaction before continuing.");
  const txHash = recoveryHash ?? pending.hash ?? journal?.hash;
  if (!txHash) throw new Error("The wallet response is uncertain. Open Advanced recovery and enter its Ethereum transaction hash. An unknown send cannot be discarded.");
  const persistHash = (receipt: CanonicalReceipt) => {
    if (pending.checkpoint && (receipt.nonce !== pending.checkpoint.nonce || receipt.blockNumber < BigInt(pending.checkpoint.startedBlock))) throw new Error("This receipt does not match the saved creation nonce.");
    pending = { ...pending, hash: receipt.hash };
    current = { ...current, pending }; save(current);
  };
  let tx: SubmittedAction | null | undefined = transaction;
  if (!tx && journal) tx = await service.resume({ hash: txHash, wallet, expectedJournal: journal });
  const outcome = tx
    ? await service.confirm({ transaction: tx, timeoutMs: 120_000, beforeJournalClear: ({ receipt }) => persistHash(receipt) })
    : await service.inspectOutcome({ hash: txHash, account: session.account, timeoutMs: 120_000 });
  if (outcome.kind === "pending" || outcome.kind === "unknown") throw new Error("Creation stopped. Wait for canonical confirmation, then click Create to resume.");
  const receipt = outcome.receipt;
  if (receipt.chainId !== service.manifest.chainId || !sameAddress(receipt.account, session.account)) throw new Error("The creation receipt belongs to another wallet or network.");
  if (pending.checkpoint && (receipt.nonce !== pending.checkpoint.nonce || receipt.blockNumber < BigInt(pending.checkpoint.startedBlock))) throw new Error("This receipt does not match the saved creation nonce.");
  const exact = receipt.to !== null && sameAddress(receipt.to, expected.to) && receipt.data.toLowerCase() === expected.data.toLowerCase() && receipt.value === expected.value;
  if (receipt.status !== "success" || !exact) {
    if (!pending.checkpoint) throw new Error("This older saved send has no nonce checkpoint. Recover its original transaction or matching creation receipt before continuing.");
    await service.acknowledgeOutcome({ receipt, acknowledge: () => save({ ...current, pending: null, lastFailure: { step: pending.step, hash: receipt.hash, nonce: receipt.nonce, blockNumber: receipt.blockNumber.toString() } }) });
    throw new Error("The creation transaction reverted or was cancelled. Nothing else was sent. Click Create to retry this stage.");
  }
  persistHash(receipt);
  return receipt;
}
export async function recoverCreateTransaction({ service, wallet, record, save, assertIntent, hash: recoveryHash }: {
  service: RaffleService; wallet: WalletSessionPort; record: DraftRecord; save: (record: DraftRecord) => void; assertIntent: () => void; hash: Hex;
}) {
  let current = record;
  const persist = (next: DraftRecord) => { save(next); current = next; };
  const step = record.pending?.step;
  if (!step) throw new Error("There is no saved creation transaction to recover.");
  const receipt = await settleCreateStep({ service, wallet, record, save: persist, assertIntent, recoveryHash });
  assertIntent();
  if (step === "createDraft") {
    const snapshot = await service.resolveCreatedDraft({ receipt, draft: decodeDraft(record.data) });
    assertIntent();
    persist({ ...current, creationHash: receipt.hash, id: snapshot.id.toString(), pending: null });
  } else persist({ ...current, pending: null });
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
    if (outcome.kind !== "confirmed") throw new Error("Creation stopped. The exact transaction needs canonical confirmation before continuing.");
    return outcome.receipt;
  };
  const validateSnapshot = (snapshot: RaffleSnapshot) => {
    const r = snapshot.raffle;
    if (!sameAddress(r.seller, session.account) || encodeDraft({ nft: r.nft, tokenId: r.tokenId, salesEnd: r.salesEnd, reserveNonce: r.reserveNonce, reserveCommit: r.reserveCommit, title: r.title, packs: snapshot.packs }) !== current.data || r.phase !== 0) throw new Error("The canonical draft changed. Review its current state before continuing.");
  };
  const send = async (action: WorkflowAction & { kind: Step }) => {
    await check();
    const journal = await service.pending({ wallet, expectedIntent: transactionIntent(stepTransaction(service, draft, action.kind, current.id)) });
    await check();
    let tx: SubmittedAction | undefined;
    if (current.pending && current.pending.step !== action.kind) throw new Error("Recover the earlier creation step first.");
    if (!current.pending && journal) {
      if (!journal.checkpoint) throw new Error("The pending wallet transaction has no verified creation checkpoint.");
      persist({ ...current, pending: { step: action.kind, hash: journal.hash, checkpoint: journal.checkpoint } });
    }
    if (!current.pending) {
      const prepared = await service.prepare({ action, wallet, ...(action.kind === "createDraft" ? {} : { expectedDraft: draft }) });
      await check();
      let requested: SubmissionCheckpoint | null = null;
      tx = await service.submit({ prepared, wallet, assertIntent,
        beforeRequest: checkpoint => {
          assertIntent(); requested = checkpoint;
          persist({ ...current, pending: { step: action.kind, hash: null, checkpoint } });
        },
        onNotDispatched: checkpoint => {
          if (requested?.id !== checkpoint.id) return;
          persist({ ...current, pending: null });
        }
      });
      persist({ ...current, pending: { step: action.kind, hash: tx.hash, ...(requested ? { checkpoint: requested } : {}) } });
    }
    return settleCreateStep({ service, wallet, record: current, save: persist, assertIntent, transaction: tx });
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
