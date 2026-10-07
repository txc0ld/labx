import { decodeFunctionData, isHex, type Address, type Hex } from "viem";
import { raffleAbi } from "./abi";
import type { RaffleService, WalletSessionPort } from "./ports";
import type { Confirmation, PreparedAction, SubmittedAction } from "./types";
import { sameAddress } from "./validation";
import { isWalletRequestRejected } from "./wallet-errors";

type TerminalConfirmation = Exclude<Confirmation, { kind: "pending" }>;
export type TransactionOutcome = { id: string; account: Address } & (
  | { kind: "submitting" }
  | { kind: "rejected"; message: string }
  | { kind: "recovery"; hash: Hex }
  | { kind: "checking" | "pending"; submitted: SubmittedAction }
  | { kind: "terminal"; submitted: SubmittedAction; confirmation: TerminalConfirmation }
  | { kind: "error"; message: string; submitted: SubmittedAction | null }
);
export type OutcomeStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
const EMPTY: readonly TransactionOutcome[] = [];

/** Labels are derived only from the service-validated transaction, never a button or saved hint. */
export function transactionMeaning(service: Pick<RaffleService, "manifest">, submitted: SubmittedAction) {
  if (submitted.chainId !== service.manifest.chainId || !sameAddress(submitted.to, service.manifest.address)) return null;
  try {
    const decoded = decodeFunctionData({ abi: raffleAbi, data: submitted.data });
    const id = decoded.args?.[0];
    if (typeof id !== "bigint") return null;
    return { raffleId: id, purchase: decoded.functionName === "buyPack" || decoded.functionName === "buyPackWithEth", action: decoded.functionName };
  } catch { return null; }
}

export function createTransactionOutcomes(service: Pick<RaffleService, "manifest" | "submit" | "resume" | "confirm">, storage: () => OutcomeStorage = () => window.localStorage) {
  const prefix = `labx:outcome:v1:${service.manifest.chainId}:${service.manifest.address.toLowerCase()}:${service.manifest.runtimeCodeHash.toLowerCase()}:`;
  const listeners = new Set<() => void>();
  const records = new Map<string, readonly TransactionOutcome[]>();
  const loaded = new Set<string>();
  const checking = new Map<string, Promise<TransactionOutcome>>();
  const submitting = new Set<string>();
  const refreshed = new Set<string>();
  let sequence = 0;
  const accountKey = (account: Address) => account.toLowerCase();
  const checkpointKey = (account: Address, hash: Hex) => `${prefix}${accountKey(account)}:${hash.toLowerCase()}`;
  const getSnapshot = (account: Address) => records.get(accountKey(account)) ?? EMPTY;
  function put(record: TransactionOutcome) {
    const current = getSnapshot(record.account);
    const index = current.findIndex(item => item.id === record.id);
    records.set(accountKey(record.account), index < 0 ? [...current, record] : current.map(item => item.id === record.id ? record : item));
    for (const listener of listeners) listener();
    return record;
  }
  function save(submitted: SubmittedAction) {
    const target = storage();
    const key = checkpointKey(submitted.account, submitted.hash);
    target.setItem(key, submitted.hash.toLowerCase());
    if (target.getItem(key) !== submitted.hash.toLowerCase()) throw new Error("Transaction recovery checkpoint could not be saved.");
  }
  function hydrate(account: Address) {
    const identity = accountKey(account);
    if (loaded.has(identity)) return;
    try {
      const target = storage();
      const accountPrefix = `${prefix}${identity}:`;
      const hints: Hex[] = [];
      // Limit hostile or unexpectedly large browser storage before scanning or parsing it.
      if (target.length > 10_000) throw new Error("Browser recovery storage is too large to read safely.");
      for (let index = 0; index < target.length; index++) {
        const key = target.key(index);
        if (!key?.startsWith(accountPrefix)) continue;
        const hash = target.getItem(key)?.toLowerCase();
        if (!hash || hash.length !== 66 || !isHex(hash, { strict: true }) || key !== checkpointKey(account, hash)) throw new Error("A transaction recovery checkpoint is invalid. Check wallet activity.");
        hints.push(hash);
        if (hints.length > 100) throw new Error("Too many transaction recovery checkpoints. Review wallet activity.");
      }
      loaded.add(identity);
      for (const hash of hints) if (!getSnapshot(account).some(item => item.id === hash)) put({ id: hash, account, kind: "recovery", hash });
    } catch (error) {
      put({ id: "storage-error", account, kind: "error", submitted: null, message: error instanceof Error ? error.message : "Transaction recovery storage is unavailable." });
    }
  }
  async function confirm(submitted: SubmittedAction): Promise<TransactionOutcome> {
    const key = checkpointKey(submitted.account, submitted.hash);
    const existing = checking.get(key);
    if (existing) return existing;
    const terminal = getSnapshot(submitted.account).find(item => item.id === submitted.hash.toLowerCase() && item.kind === "terminal");
    if (terminal) return terminal;
    const work = (async () => {
      const base = { id: submitted.hash.toLowerCase(), account: submitted.account, submitted };
      try {
        // Persist before confirm: the service may clear its nonce journal on a terminal receipt.
        save(submitted);
        put({ ...base, kind: "checking" });
        const confirmation = await service.confirm({ transaction: submitted });
        return confirmation.kind === "pending"
          ? put({ ...base, kind: "pending" })
          : put({ ...base, kind: "terminal", confirmation });
      } catch (error) {
        return put({ ...base, kind: "error", message: error instanceof Error ? error.message : "Confirmation could not be checked. The recovery record is retained." });
      }
    })();
    checking.set(key, work);
    try { return await work; }
    finally { if (checking.get(key) === work) checking.delete(key); }
  }
  async function submit(prepared: PreparedAction, wallet: WalletSessionPort): Promise<TransactionOutcome> {
    const identity = accountKey(prepared.account);
    if (submitting.has(identity)) throw new Error("A wallet request is already in progress.");
    submitting.add(identity);
    const id = `request-${++sequence}`;
    put({ id, account: prepared.account, kind: "submitting" });
    try {
      const submitted = await service.submit({ prepared, wallet });
      // Replace only this request. Other account operations and recovery hints remain intact.
      records.set(identity, getSnapshot(prepared.account).filter(item => item.id !== id));
      return await confirm(submitted);
    } catch (error) {
      return isWalletRequestRejected(error)
        ? put({ id, account: prepared.account, kind: "rejected", message: "The wallet request was rejected. No transaction was submitted." })
        : put({ id, account: prepared.account, kind: "error", submitted: null, message: error instanceof Error ? error.message : "The wallet response could not be checked. Review wallet activity before retrying." });
    } finally { submitting.delete(identity); }
  }
  async function resume(hash: Hex, wallet: WalletSessionPort): Promise<TransactionOutcome> {
    const snapshot = wallet.getSnapshot();
    if (snapshot.kind !== "connected" || snapshot.chainId !== service.manifest.chainId) throw new Error("Connect the transaction's wallet on the verified network.");
    const existing = getSnapshot(snapshot.account).find(item => item.id === hash.toLowerCase() && item.kind === "terminal");
    if (existing) return existing;
    const submitted = await service.resume({ hash, wallet });
    return confirm(submitted);
  }
  function acknowledge(record: TransactionOutcome) {
    // Object identity prevents an old acknowledgment from removing a newer outcome.
    if (record.kind !== "terminal" || !getSnapshot(record.account).includes(record)) return;
    const target = storage();
    const key = checkpointKey(record.account, record.submitted.hash);
    if (target.getItem(key) !== record.submitted.hash.toLowerCase()) throw new Error("The recovery checkpoint changed. Check its transaction again.");
    target.removeItem(key);
    if (target.getItem(key) !== null) throw new Error("The recovery checkpoint could not be acknowledged.");
    records.set(accountKey(record.account), getSnapshot(record.account).filter(item => item !== record));
    for (const listener of listeners) listener();
  }
  function claimRefresh(key: string) {
    if (refreshed.has(key)) return false;
    refreshed.add(key);
    return true;
  }
  return { getSnapshot, claimRefresh, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, hydrate, submit, confirm, resume, acknowledge };
}
export type TransactionOutcomes = ReturnType<typeof createTransactionOutcomes>;
const owners = new WeakMap<RaffleService, TransactionOutcomes>();
export function transactionOutcomes(service: RaffleService) {
  let owner = owners.get(service);
  if (!owner) { owner = createTransactionOutcomes(service); owners.set(service, owner); }
  return owner;
}
