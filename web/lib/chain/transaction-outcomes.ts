import { bytesToHex, decodeFunctionData, isHex, type Address, type Hex } from "viem";
import { raffleAbi } from "./abi";
import type { RaffleService, WalletSessionPort } from "./ports";
import type { Confirmation, PreparedAction, SubmittedAction } from "./types";
import { sameAddress } from "./validation";
import { isWalletRequestRejected } from "./wallet-errors";

type TerminalConfirmation = Exclude<Confirmation, { kind: "pending" }>;
export type TransactionOutcome = { id: string; account: Address } & (
  | { kind: "submitting" }
  | { kind: "rejected"; message: string }
  | { kind: "overflow"; message: string }
  | { kind: "recovery"; hash: Hex }
  | { kind: "unverified"; hash: Hex; message: string }
  | { kind: "checking" | "pending"; submitted: SubmittedAction }
  | { kind: "terminal"; submitted: SubmittedAction; confirmation: TerminalConfirmation }
  | { kind: "error"; message: string; submitted: SubmittedAction | null }
);
export type OutcomeStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
const EMPTY: readonly TransactionOutcome[] = [];
export function transactionMeaning(service: Pick<RaffleService, "manifest">, submitted: SubmittedAction) {
  if (submitted.chainId !== service.manifest.chainId || !submitted.to || !sameAddress(submitted.to, service.manifest.address)) return null;
  try {
    const decoded = decodeFunctionData({ abi: raffleAbi, data: submitted.data });
    const id = decoded.args?.[0];
    return typeof id === "bigint" ? { raffleId: id, purchase: decoded.functionName === "buyPack" || decoded.functionName === "buyPackWithEth", action: decoded.functionName } : null;
  } catch { return null; }
}
function outcomeHash(outcome: TransactionOutcome): Hex | null {
  return "submitted" in outcome ? outcome.submitted?.hash ?? null : "hash" in outcome ? outcome.hash : null;
}
type OutcomeService = Pick<RaffleService, "manifest" | "submit" | "resume" | "confirm" | "inspectOutcome" | "pending" | "acknowledgeOutcome">;
export function createTransactionOutcomes(service: OutcomeService, storage: () => OutcomeStorage = () => window.localStorage) {
  const prefix = `labx:outcome:v1:${service.manifest.chainId}:${service.manifest.address.toLowerCase()}:${service.manifest.runtimeCodeHash.toLowerCase()}:`;
  const listeners = new Set<() => void>();
  const records = new Map<string, readonly TransactionOutcome[]>();
  const loaded = new Set<string>(), acknowledged = new Set<string>(), refreshed = new Set<string>(), submitting = new Set<string>();
  const checking = new Map<string, Promise<TransactionOutcome>>(), inspections = new Map<string, Promise<TransactionOutcome>>();
  const redirects = new Map<string, string>();
  const recoveries = new Map<string, Promise<void>>();
  let sequence = 0;
  const accountKey = (account: Address) => account.toLowerCase();
  const checkpointKey = (account: Address, id: string) => `${prefix}${accountKey(account)}:${id.toLowerCase()}`;
  const getSnapshot = (account: Address) => records.get(accountKey(account)) ?? EMPTY;
  function identity(account: Address, id: string): string {
    return redirects.get(checkpointKey(account, id)) ?? id.toLowerCase();
  }
  function findHash(account: Address, hash: Hex) {
    return getSnapshot(account).find(item => outcomeHash(item)?.toLowerCase() === hash.toLowerCase());
  }
  function operationId(account: Address, hash: Hex) {
    const owned = findHash(account, hash);
    if (owned) return owned.id;
    let id = hash.toLowerCase();
    while (getSnapshot(account).some(item => item.id === id) || acknowledged.has(checkpointKey(account, id))) id = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    return id;
  }
  function notify() { for (const listener of listeners) listener(); }
  function put(record: TransactionOutcome) {
    const id = identity(record.account, record.id), current = getSnapshot(record.account);
    const previous = current.find(item => item.id === id);
    if (acknowledged.has(checkpointKey(record.account, id))) return record;
    if (previous?.kind === "terminal") return previous;
    const next = { ...record, id };
    records.set(accountKey(record.account), previous ? current.map(item => item.id === id ? next : item) : [...current, next]);
    notify();
    return next;
  }
  function save(account: Address, id: string, hash: Hex) {
    const stableId = identity(account, id);
    if (acknowledged.has(checkpointKey(account, stableId))) return;
    const terminal = getSnapshot(account).find(item => item.id === stableId && item.kind === "terminal");
    if (terminal && outcomeHash(terminal)?.toLowerCase() !== hash.toLowerCase()) return;
    const target = storage(), key = checkpointKey(account, id), value = hash.toLowerCase();
    target.setItem(key, value);
    if (target.getItem(key) !== value) throw new Error("Transaction recovery checkpoint could not be saved.");
  }
  // Only callers holding service-validated journal lineage may supply a prior hash.
  function retain(account: Address, requestedId: string, canonicalHash: Hex, priorHash: Hex | null = null, verifiedNonce?: number) {
    const candidate = priorHash ? findHash(account, priorHash) : undefined;
    const previous = candidate?.kind === "terminal" && candidate.confirmation.receipt.nonce !== verifiedNonce ? undefined : candidate;
    const id = identity(account, previous?.id ?? requestedId);
    if (acknowledged.has(checkpointKey(account, id))) return id;
    save(account, id, canonicalHash);
    const related = getSnapshot(account).filter(item => item.id !== id && (item.id === identity(account, requestedId) || outcomeHash(item)?.toLowerCase() === canonicalHash.toLowerCase()));
    for (const item of related) {
      const hash = outcomeHash(item), target = storage(), key = checkpointKey(account, item.id);
      if (hash && target.getItem(key)?.toLowerCase() === hash.toLowerCase()) {
        target.removeItem(key);
        if (target.getItem(key) !== null) throw new Error("The previous recovery checkpoint could not be updated.");
      }
      redirects.set(key, id);
    }
    redirects.set(checkpointKey(account, requestedId), id);
    if (related.length) records.set(accountKey(account), getSnapshot(account).filter(item => !related.includes(item)));
    return id;
  }
  function hydrate(account: Address) {
    const key = accountKey(account);
    if (loaded.has(key)) return;
    try {
      const target = storage(), accountPrefix = `${prefix}${key}:`;
      const hints: { id: Hex; hash: Hex }[] = [];
      let count = 0;
      if (target.length > 10_000) throw new Error("Browser recovery storage is too large to read safely.");
      for (let index = 0; index < target.length; index++) {
        const key = target.key(index);
        if (!key?.startsWith(accountPrefix)) continue;
        const id = key.slice(accountPrefix.length), hash = target.getItem(key)?.toLowerCase();
        if (id.length !== 66 || !isHex(id, { strict: true }) || id !== id.toLowerCase() || !hash || hash.length !== 66 || !isHex(hash, { strict: true })) throw new Error("A transaction recovery checkpoint is invalid. Check wallet activity.");
        count++;
        if (hints.length < 100) hints.push({ id, hash });
      }
      loaded.add(accountKey(account));
      for (const hint of hints) if (!getSnapshot(account).some(item => item.id === hint.id)) put({ ...hint, account, kind: "recovery" });
      if (count > 100) put({ id: "overflow", account, kind: "overflow", message: "More saved transactions need verification. Acknowledge verified receipts to load the next batch before submitting another action." });
      else if (getSnapshot(account).some(item => item.kind === "overflow")) {
        records.set(key, getSnapshot(account).filter(item => item.kind !== "overflow"));
        notify();
      }
    } catch (error) {
      put({ id: "storage-error", account, kind: "error", submitted: null, message: error instanceof Error ? error.message : "Transaction recovery storage is unavailable." });
    }
  }
  async function inspect(account: Address, hash: Hex, requestedId = operationId(account, hash)): Promise<TransactionOutcome> {
    const key = checkpointKey(account, hash), existing = inspections.get(key);
    if (existing) return existing;
    const work = (async () => {
      try {
        const confirmation = await service.inspectOutcome({ hash, account, timeoutMs: 1000 });
        if (confirmation.kind === "pending") return put({ id: requestedId, account, kind: "unverified", hash, message: "The transaction is still pending. Check again after it confirms." });
        const id = retain(account, requestedId, confirmation.receipt.hash);
        return put({ id, account, kind: "terminal", submitted: confirmation.receipt, confirmation });
      } catch (error) {
        return put({ id: requestedId, account, kind: "unverified", hash, message: error instanceof Error ? error.message : "The saved transaction could not be verified." });
      }
    })();
    inspections.set(key, work);
    try { return await work; }
    finally { if (inspections.get(key) === work) inspections.delete(key); }
  }
  async function recover(account: Address) {
    const key = accountKey(account), existing = recoveries.get(key);
    if (existing) return existing;
    hydrate(account);
    const queue = getSnapshot(account).filter(item => item.kind === "recovery").slice(0, 100);
    async function work() {
      for (let item = queue.shift(); item; item = queue.shift()) if (item.kind === "recovery") await inspect(account, item.hash, item.id);
    }
    const job = Promise.all([work(), work()]).then(() => {});
    recoveries.set(key, job);
    try { await job; }
    finally { if (recoveries.get(key) === job) recoveries.delete(key); }
  }
  async function confirm(submitted: SubmittedAction, requestedId = operationId(submitted.account, submitted.hash), reconcile = false): Promise<TransactionOutcome> {
    const key = checkpointKey(submitted.account, submitted.hash), existing = checking.get(key);
    if (existing) return existing;
    const terminal = getSnapshot(submitted.account).find(item => item.id === identity(submitted.account, requestedId) && item.kind === "terminal");
    if (terminal && !reconcile) return terminal;
    const work = (async () => {
      let id = identity(submitted.account, requestedId);
      try {
        save(submitted.account, id, submitted.hash);
        put({ id, account: submitted.account, kind: "checking", submitted });
        const confirmation = await service.confirm({ transaction: submitted, beforeJournalClear: ({ receipt, pending }) => {
          id = retain(submitted.account, id, receipt.hash, pending?.hash ?? null, receipt.nonce);
        } });
        return confirmation.kind === "pending"
          ? put({ id, account: submitted.account, kind: "pending", submitted })
          : put({ id, account: submitted.account, kind: "terminal", submitted: confirmation.receipt, confirmation });
      } catch (error) {
        return put({ id, account: submitted.account, kind: "error", submitted, message: error instanceof Error ? error.message : "Confirmation could not be checked. The recovery record is retained." });
      }
    })();
    checking.set(key, work);
    try { return await work; }
    finally { if (checking.get(key) === work) checking.delete(key); }
  }
  async function submit(prepared: PreparedAction, wallet: WalletSessionPort): Promise<TransactionOutcome> {
    const key = accountKey(prepared.account);
    if (submitting.has(key)) throw new Error("A wallet request is already in progress.");
    submitting.add(key);
    const id = `request-${++sequence}`;
    put({ id, account: prepared.account, kind: "submitting" });
    try {
      const submitted = await service.submit({ prepared, wallet });
      records.set(key, getSnapshot(prepared.account).filter(item => item.id !== id));
      return await confirm(submitted);
    } catch (error) {
      return isWalletRequestRejected(error)
        ? put({ id, account: prepared.account, kind: "rejected", message: "The wallet request was rejected. No transaction was submitted." })
        : put({ id, account: prepared.account, kind: "error", submitted: null, message: error instanceof Error ? error.message : "The wallet response could not be checked. Review wallet activity before retrying." });
    } finally { submitting.delete(key); }
  }
  async function resume(hash: Hex, wallet: WalletSessionPort): Promise<TransactionOutcome> {
    const snapshot = wallet.getSnapshot();
    if (snapshot.kind !== "connected" || snapshot.chainId !== service.manifest.chainId) throw new Error("Connect the transaction's wallet on the verified network.");
    const owned = findHash(snapshot.account, hash), pending = await service.pending({ wallet });
    await wallet.assertCurrent(snapshot);
    const assertScope = (transaction?: SubmittedAction) => {
      const current = wallet.getSnapshot();
      if (current.kind !== "connected" || current.revision !== snapshot.revision || current.chainId !== snapshot.chainId || !sameAddress(current.account, snapshot.account)) throw new Error("Wallet changed. Check the transaction from its original wallet session.");
      if (transaction && (transaction.chainId !== snapshot.chainId || !sameAddress(transaction.account, snapshot.account))) throw new Error("Recovered transaction does not match the original wallet and network.");
    };
    assertScope();
    if (!pending && owned) return owned.kind === "terminal" ? owned : inspect(snapshot.account, hash, owned.id);
    let id = owned?.id ?? operationId(snapshot.account, hash);
    const submitted = await service.resume({ hash, wallet, beforeJournalUpdate: ({ transaction, pending, nonce }) => {
      assertScope(transaction);
      id = retain(snapshot.account, id, transaction.hash, pending?.hash ?? null, nonce);
    } });
    assertScope(submitted);
    return confirm(submitted, id, true);
  }
  async function acknowledge(record: TransactionOutcome, wallet?: WalletSessionPort) {
    if (record.kind !== "terminal" || !getSnapshot(record.account).includes(record)) return;
    const snapshot = wallet?.getSnapshot();
    if (snapshot && (snapshot.kind !== "connected" || snapshot.chainId !== service.manifest.chainId || !sameAddress(snapshot.account, record.account))) throw new Error("Connect the receipt’s original wallet before acknowledging it.");
    await service.acknowledgeOutcome({ receipt: record.confirmation.receipt, acknowledge() {
      if (!getSnapshot(record.account).includes(record)) throw new Error("The receipt changed. Check it again.");
      if (wallet && snapshot) {
        const current = wallet.getSnapshot();
        if (current.kind !== "connected" || current.revision !== snapshot.revision || current.chainId !== service.manifest.chainId || !sameAddress(current.account, record.account)) throw new Error("Wallet changed. Check the receipt from its original wallet session.");
      }
      const target = storage(), key = checkpointKey(record.account, record.id);
      if (target.getItem(key)?.toLowerCase() !== record.submitted.hash.toLowerCase()) throw new Error("The recovery checkpoint changed. Check its transaction again.");
      target.removeItem(key);
      if (target.getItem(key) !== null) throw new Error("The recovery checkpoint could not be acknowledged.");
      acknowledged.add(key);
      records.set(accountKey(record.account), getSnapshot(record.account).filter(item => item !== record));
      notify();
      loaded.delete(accountKey(record.account));
    } });
    const recovering = recoveries.get(accountKey(record.account));
    if (recovering) await recovering;
    void recover(record.account);
  }
  function claimRefresh(key: string) { if (refreshed.has(key)) return false; refreshed.add(key); return true; }
  return { getSnapshot, claimRefresh, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, hydrate, recover, submit, confirm, resume, acknowledge };
}
export type TransactionOutcomes = ReturnType<typeof createTransactionOutcomes>;
const owners = new WeakMap<RaffleService, TransactionOutcomes>();
export function transactionOutcomes(service: RaffleService) {
  let owner = owners.get(service);
  if (!owner) { owner = createTransactionOutcomes(service); owners.set(service, owner); }
  return owner;
}
