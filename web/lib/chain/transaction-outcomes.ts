import { bytesToHex, decodeFunctionData, isHex, type Address, type Hex } from "viem";
import { raffleAbi } from "./abi";
import type { RaffleService, WalletSessionPort } from "./ports";
import type { Confirmation, PreparedAction, SubmittedAction, ObservedTransaction, OutcomeLineage } from "./types";
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
export function sameSubmittedIntent(left: SubmittedAction, right: SubmittedAction) {
  return left.chainId === right.chainId && sameAddress(left.account, right.account)
    && (left.to === null ? right.to === null : right.to !== null && sameAddress(left.to, right.to))
    && left.data.toLowerCase() === right.data.toLowerCase() && left.value === right.value;
}
function outcomeHash(outcome: TransactionOutcome): Hex | null {
  return "submitted" in outcome ? outcome.submitted?.hash ?? null : "hash" in outcome ? outcome.hash : null;
}
type OutcomeService = Pick<RaffleService, "manifest" | "submit" | "resume" | "confirm" | "inspectOutcome" | "pending" | "captureOutcomeLineage" | "retainOutcome" | "acknowledgeOutcome">;
export function createTransactionOutcomes(service: OutcomeService, storage: () => OutcomeStorage = () => window.localStorage) {
  const prefix = `labx:outcome:v1:${service.manifest.chainId}:${service.manifest.address.toLowerCase()}:${service.manifest.runtimeCodeHash.toLowerCase()}:`;
  const listeners = new Set<() => void>();
  const records = new Map<string, readonly TransactionOutcome[]>();
  const loaded = new Set<string>(), refreshed = new Set<string>(), submitting = new Set<string>();
  const acknowledged = new Map<string, string>();
  const checking = new Map<string, Promise<TransactionOutcome>>(), inspections = new Map<string, Promise<TransactionOutcome>>();
  const redirects = new Map<string, string>();
  const recoveries = new Map<string, Promise<void>>();
  const verified = new Map<string, { id: string; nonce: number; observed: ObservedTransaction | null }>();
  const lineages = new Map<string, OutcomeLineage>();
  const handledPointers = new Map<string, string>();
  const rescan = new Set<string>();
  const observed = new Map<Address, number>();
  let sequence = 0;
  const accountKey = (account: Address) => account.toLowerCase();
  const checkpointKey = (account: Address, id: string) => `${prefix}${accountKey(account)}:${id.toLowerCase()}`;
  const getSnapshot = (account: Address) => records.get(accountKey(account)) ?? EMPTY;
  function identity(account: Address, id: string): string {
    let current = id.toLowerCase();
    for (let next = redirects.get(checkpointKey(account, current)); next && next !== current; next = redirects.get(checkpointKey(account, current))) current = next;
    return current;
  }
  function findHash(account: Address, hash: Hex) {
    return getSnapshot(account).find(item => outcomeHash(item)?.toLowerCase() === hash.toLowerCase());
  }
  function findKnown(account: Address, hash: Hex) {
    const direct = findHash(account, hash), known = verified.get(checkpointKey(account, hash));
    return direct ?? (known ? getSnapshot(account).find(item => item.id === identity(account, known.id)) : undefined);
  }
  function remember(transaction: ObservedTransaction, id: string) {
    verified.set(checkpointKey(transaction.account, transaction.hash), { id, nonce: transaction.nonce, observed: transaction });
  }
  function stored(account: Address) {
    const target = storage(), accountPrefix = `${prefix}${accountKey(account)}:`;
    const hints: { id: Hex; hash: Hex }[] = [];
    if (target.length > 10_000) throw new Error("Browser recovery storage is too large to read safely.");
    for (let index = 0; index < target.length; index++) {
      const key = target.key(index);
      if (!key?.startsWith(accountPrefix)) continue;
      const id = key.slice(accountPrefix.length), hash = target.getItem(key)?.toLowerCase();
      if (id.length !== 66 || !isHex(id, { strict: true }) || id !== id.toLowerCase() || !hash || hash.length !== 66 || !isHex(hash, { strict: true })) throw new Error("A transaction recovery checkpoint is invalid. Check wallet activity.");
      hints.push({ id, hash });
    }
    return hints;
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
  // A prior hash is authorized only by service-validated journal lineage.
  function retain(account: Address, requestedId: string, canonicalHash: Hex, nonce: number, persistence: { create: boolean; expectedHash: Hex }, priorHash: Hex | null = null) {
    if (priorHash && verified.has(checkpointKey(account, priorHash)) && verified.get(checkpointKey(account, priorHash))?.nonce !== nonce) priorHash = null;
    const hints = stored(account);
    const prior = priorHash ? findHash(account, priorHash) : undefined;
    const durable = priorHash ? hints.find(item => item.hash === priorHash.toLowerCase()) : undefined;
    const id = identity(account, prior?.id ?? durable?.id ?? requestedId);
    if (acknowledged.has(checkpointKey(account, id))) return id;
    const expected = [...verified.entries()].find(([key, entry]) => key.startsWith(`${prefix}${accountKey(account)}:`) && identity(account, entry.id) === id);
    if (expected && expected[1].nonce !== nonce) throw new Error("The saved pointer does not match this operation's verified nonce.");
    const related = getSnapshot(account).filter(item => {
      const hash = outcomeHash(item), known = hash ? verified.get(checkpointKey(account, hash)) : undefined;
      return item.id !== id && (hash?.toLowerCase() === canonicalHash.toLowerCase() || priorHash !== null && hash?.toLowerCase() === priorHash.toLowerCase() || known?.nonce === nonce);
    });
    const saved = storage().getItem(checkpointKey(account, id));
    if (saved !== null && saved.toLowerCase() !== canonicalHash.toLowerCase() && saved.toLowerCase() !== persistence.expectedHash.toLowerCase()
      && saved.toLowerCase() !== priorHash?.toLowerCase()) throw new Error("The recovery checkpoint changed during reconciliation.");
    const persisted = persistence.create || saved !== null;
    if (persisted) save(account, id, canonicalHash);
    for (const hint of persisted ? hints : []) {
      if (hint.id === id || hint.hash !== canonicalHash.toLowerCase() && (!priorHash || hint.hash !== priorHash.toLowerCase()) && verified.get(checkpointKey(account, hint.hash))?.nonce !== nonce) continue;
      const target = storage(), key = checkpointKey(account, hint.id);
      if (target.getItem(key)?.toLowerCase() !== hint.hash) throw new Error("The recovery checkpoint changed during reconciliation.");
      target.removeItem(key);
      if (target.getItem(key) !== null) throw new Error("The previous recovery checkpoint could not be updated.");
      const original = getSnapshot(account).find(item => item.id === hint.id), originalHash = original ? outcomeHash(original) : null;
      if (!originalHash || verified.get(checkpointKey(account, originalHash))?.nonce === nonce) redirects.set(key, id);
    }
    for (const item of related) redirects.set(checkpointKey(account, item.id), id);
    redirects.set(checkpointKey(account, requestedId), id);
    verified.set(checkpointKey(account, canonicalHash), { id, nonce, observed: verified.get(checkpointKey(account, canonicalHash))?.observed ?? null });
    if (priorHash) verified.set(checkpointKey(account, priorHash), { id, nonce, observed: verified.get(checkpointKey(account, priorHash))?.observed ?? null });
    if (related.length) records.set(accountKey(account), getSnapshot(account).filter(item => !related.includes(item)));
    return id;
  }
  function captureLineage(account: Address, hash: Hex) {
    const key = checkpointKey(account, hash);
    if (!lineages.has(key)) {
      const lineage = service.captureOutcomeLineage({ account, hash });
      if (lineage) lineages.set(key, lineage);
    }
  }
  function observeHint(account: Address, hint: { id: string; hash: Hex }) {
    const acknowledgedHash = acknowledged.get(checkpointKey(account, hint.id));
    if (acknowledgedHash) {
      if (acknowledgedHash !== hint.hash) throw new Error("An acknowledged checkpoint changed to unknown activity. Check wallet activity before continuing.");
      return;
    }
    captureLineage(account, hint.hash);
    const existing = getSnapshot(account).find(item => item.id === hint.id), previousHash = existing ? outcomeHash(existing) : null;
    if (previousHash && previousHash.toLowerCase() !== hint.hash) {
      const lineage = lineages.get(checkpointKey(account, previousHash));
      if (lineage) lineages.set(checkpointKey(account, hint.hash), lineage);
    }
    if (previousHash && previousHash.toLowerCase() !== hint.hash && (existing?.kind === "terminal" || !verified.has(checkpointKey(account, previousHash)))) {
      const fork = findHash(account, hint.hash);
      if (!fork || fork.kind === "unverified") put({ id: fork?.id ?? operationId(account, hint.hash), hash: hint.hash, account, kind: "recovery" });
    } else if (!existing || existing.kind !== "terminal" && (previousHash?.toLowerCase() !== hint.hash || existing.kind === "unverified")) put({ ...hint, account, kind: "recovery" });
  }
  function hydrate(account: Address) {
    const key = accountKey(account);
    if (loaded.has(key)) return;
    try {
      const hints = stored(account);
      loaded.add(key);
      for (const hint of hints.slice(0, 100)) observeHint(account, hint);
      if (hints.length > 100) put({ id: "overflow", account, kind: "overflow", message: "More saved transactions need verification. Acknowledge verified receipts to load the next batch before submitting another action." });
      else if (getSnapshot(account).some(item => item.kind === "overflow")) {
        records.set(key, getSnapshot(account).filter(item => item.kind !== "overflow")); notify();
      }
    } catch (error) {
      put({ id: "storage-error", account, kind: "error", submitted: null, message: error instanceof Error ? error.message : "Transaction recovery storage is unavailable." });
    }
  }
  function terminalOutcome(account: Address, id: string, confirmation: TerminalConfirmation) {
    const original = [...verified.entries()].find(([key, entry]) => key.startsWith(`${prefix}${accountKey(account)}:`)
      && identity(account, entry.id) === identity(account, id) && entry.nonce === confirmation.receipt.nonce && entry.observed !== null)?.[1].observed;
    const canonical: TerminalConfirmation = original && !sameSubmittedIntent(original, confirmation.receipt)
      ? { kind: "replaced", hash: confirmation.receipt.hash, receipt: confirmation.receipt, reason: "The wallet replaced the original transaction with a different action." }
      : confirmation;
    return put({ id, account, kind: "terminal", submitted: canonical.receipt, confirmation: canonical });
  }
  async function inspect(account: Address, hash: Hex, requestedId = operationId(account, hash), manual = false): Promise<TransactionOutcome> {
    const key = checkpointKey(account, hash), existing = inspections.get(key);
    if (existing) return existing;
    const owned = getSnapshot(account).some(item => item.id === requestedId);
    function advanced() {
      const current = getSnapshot(account).find(item => item.id === identity(account, requestedId));
      return current && outcomeHash(current)?.toLowerCase() !== hash.toLowerCase() ? current : undefined;
    }
    const work = (async () => {
      try {
        captureLineage(account, hash);
        const confirmation = await service.inspectOutcome({ hash, account, timeoutMs: manual ? 60_000 : 0 });
        if (confirmation.kind === "pending") remember(confirmation.transaction, requestedId);
        else if (confirmation.kind !== "unknown") remember(confirmation.receipt, requestedId);
        const newer = advanced();
        if (newer) return newer;
        const pointer = storage().getItem(checkpointKey(account, requestedId));
        if (pointer && pointer.toLowerCase() !== hash.toLowerCase()) {
          const result: TransactionOutcome = { id: requestedId, account, kind: "unverified", hash, message: "The recovery checkpoint changed. Its current transaction needs verification." };
          const retained = owned ? put(result) : result;
          const pointerKey = checkpointKey(account, requestedId);
          if (handledPointers.get(pointerKey) !== pointer.toLowerCase()) {
            handledPointers.set(pointerKey, pointer.toLowerCase());
            void synchronize(account);
          }
          return retained;
        }
        if (confirmation.kind === "pending" || confirmation.kind === "unknown") {
          const message = confirmation.kind === "unknown" ? confirmation.reason : confirmation.reason === "unmined" ? "The transaction was unmined at the last check." : "The receipt needs two canonical confirmations.";
          const result: TransactionOutcome = { id: requestedId, account, kind: "unverified", hash, message };
          return owned ? put(result) : result;
        }
        let result: TransactionOutcome | undefined;
        await service.retainOutcome({ receipt: confirmation.receipt, lineage: lineages.get(key), retain: ({ priorHash }) => {
          const newer = advanced();
          if (newer) { result = newer; return; }
          const id = retain(account, requestedId, confirmation.receipt.hash, confirmation.receipt.nonce,
            { create: manual && !owned && !findKnown(account, hash), expectedHash: hash }, priorHash);
          result = terminalOutcome(account, id, confirmation);
        } });
        if (!result) throw new Error("Canonical receipt retention did not complete.");
        return result;
      } catch (error) {
        const newer = advanced();
        if (newer) return newer;
        const result: TransactionOutcome = { id: requestedId, account, kind: "unverified", hash, message: error instanceof Error ? error.message : "The saved transaction could not be verified." };
        return owned ? put(result) : result;
      }
    })();
    inspections.set(key, work);
    try { return await work; }
    finally { if (inspections.get(key) === work) inspections.delete(key); }
  }
  async function recover(account: Address) {
    const key = accountKey(account), existing = recoveries.get(key);
    if (existing) return existing;
    const job = (async () => {
      do {
        rescan.delete(key); hydrate(account);
        const queue = getSnapshot(account).filter(item => item.kind === "recovery").slice(0, 100);
        async function work() {
          for (let item = queue.shift(); item; item = queue.shift()) if (item.kind === "recovery") await inspect(account, item.hash, item.id);
        }
        await Promise.all([work(), work()]);
      } while (rescan.has(key));
    })();
    recoveries.set(key, job);
    try { await job; }
    finally { if (recoveries.get(key) === job) recoveries.delete(key); }
  }
  function synchronize(account: Address) {
    loaded.delete(accountKey(account)); rescan.add(accountKey(account));
    return recover(account);
  }
  function storageChanged(event: StorageEvent) {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    for (const account of observed.keys()) {
      const accountPrefix = `${prefix}${accountKey(account)}:`;
      if (event.key && !event.key.startsWith(accountPrefix)) continue;
      if (event.key && event.newValue) {
        const id = event.key.slice(accountPrefix.length), hash = event.newValue.toLowerCase();
        if (id.length === 66 && isHex(id, { strict: true }) && id === id.toLowerCase() && hash.length === 66 && isHex(hash, { strict: true })) {
          try { observeHint(account, { id, hash }); }
          catch (error) { put({ id: "storage-error", account, kind: "error", submitted: null, message: error instanceof Error ? error.message : "Recovery storage changed." }); }
        }
      }
      void synchronize(account);
    }
  }
  function focused() { for (const account of observed.keys()) void synchronize(account); }
  function observe(account: Address) {
    if (typeof window === "undefined") return () => {};
    if (!observed.size) { window.addEventListener("storage", storageChanged); window.addEventListener("focus", focused); }
    observed.set(account, (observed.get(account) ?? 0) + 1);
    void recover(account);
    return () => {
      const count = observed.get(account) ?? 1;
      if (count > 1) observed.set(account, count - 1); else observed.delete(account);
      if (!observed.size) { window.removeEventListener("storage", storageChanged); window.removeEventListener("focus", focused); }
    };
  }
  async function watch(submitted: SubmittedAction, requestedId = operationId(submitted.account, submitted.hash), freshSubmission = false): Promise<TransactionOutcome> {
    const key = checkpointKey(submitted.account, submitted.hash), existing = checking.get(key);
    if (existing) return existing;
    const work = (async () => {
      let id = identity(submitted.account, requestedId), registered = verified.has(key);
      function current() { return getSnapshot(submitted.account).find(item => item.id === identity(submitted.account, id)); }
      function finish(result: TransactionOutcome) {
        const pointer = storage().getItem(checkpointKey(submitted.account, identity(submitted.account, id)));
        if (pointer && pointer.toLowerCase() !== submitted.hash.toLowerCase()) { loaded.delete(accountKey(submitted.account)); hydrate(submitted.account); void recover(submitted.account); }
        const advanced = current();
        if (advanced && (advanced.kind === "terminal" || outcomeHash(advanced)?.toLowerCase() !== submitted.hash.toLowerCase())) return advanced;
        return registered || freshSubmission ? put(result) : result;
      }
      try {
        const confirmation = await service.confirm({ transaction: submitted, beforeJournalWatch: ({ transaction, pending }) => {
          id = retain(submitted.account, id, transaction.hash, transaction.nonce, { create: true, expectedHash: transaction.hash }, pending.hash);
          remember(transaction, id); registered = true;
          put({ id, account: submitted.account, kind: "checking", submitted: transaction });
        }, beforeJournalClear: ({ receipt, pending }) => {
          id = retain(submitted.account, id, receipt.hash, receipt.nonce, { create: pending !== null, expectedHash: submitted.hash }, pending?.hash ?? null);
          remember(receipt, id);
        } });
        return confirmation.kind === "pending"
          ? finish({ id, account: submitted.account, kind: "pending", submitted })
          : terminalOutcome(submitted.account, id, confirmation);
      } catch (error) {
        return finish({ id, account: submitted.account, kind: "error", submitted, message: error instanceof Error ? error.message : "Confirmation could not be checked. The recovery record is retained." });
      }
    })();
    checking.set(key, work);
    try { return await work; }
    finally { if (checking.get(key) === work) checking.delete(key); }
  }
  async function submit(prepared: PreparedAction, wallet: WalletSessionPort, onSubmitted?: (submitted: SubmittedAction) => void): Promise<TransactionOutcome> {
    const key = accountKey(prepared.account);
    if (submitting.has(key)) throw new Error("A wallet request is already in progress.");
    submitting.add(key);
    const id = `request-${++sequence}`;
    put({ id, account: prepared.account, kind: "submitting" });
    try {
      const submitted = await service.submit({ prepared, wallet });
      records.set(key, getSnapshot(prepared.account).filter(item => item.id !== id));
      const submittedId = operationId(submitted.account, submitted.hash);
      put({ id: submittedId, account: submitted.account, kind: "checking", submitted });
      try { onSubmitted?.(Object.freeze({ ...submitted })); } catch { /* A detached UI cannot interrupt the owned confirmation. */ }
      return await watch(submitted, submittedId, true);
    } catch (error) {
      return isWalletRequestRejected(error)
        ? put({ id, account: prepared.account, kind: "rejected", message: "The wallet request was rejected. No transaction was submitted." })
        : put({ id, account: prepared.account, kind: "error", submitted: null, message: error instanceof Error ? error.message : "The wallet response could not be checked. Review wallet activity before retrying." });
    } finally { submitting.delete(key); }
  }
  async function resume(hash: Hex, wallet: WalletSessionPort): Promise<TransactionOutcome> {
    const snapshot = wallet.getSnapshot();
    if (snapshot.kind !== "connected" || snapshot.chainId !== service.manifest.chainId) throw new Error("Connect the transaction's wallet on the verified network.");
    const owned = findKnown(snapshot.account, hash), pending = await service.pending({ wallet });
    await wallet.assertCurrent(snapshot);
    const assertScope = (transaction?: SubmittedAction) => {
      const current = wallet.getSnapshot();
      if (current.kind !== "connected" || current.revision !== snapshot.revision || current.chainId !== snapshot.chainId || !sameAddress(current.account, snapshot.account)) throw new Error("Wallet changed. Check the transaction from its original wallet session.");
      if (transaction && (transaction.chainId !== snapshot.chainId || !sameAddress(transaction.account, snapshot.account))) throw new Error("Recovered transaction does not match the original wallet and network.");
    };
    assertScope();
    if (!pending) return owned?.kind === "terminal" ? owned : inspect(snapshot.account, owned ? outcomeHash(owned) ?? hash : hash, owned?.id, true);
    let id = owned?.id ?? operationId(snapshot.account, hash);
    const submitted = await service.resume({ hash, wallet, expectedJournal: pending, beforeJournalUpdate: ({ transaction, pending, nonce }) => {
      assertScope(transaction);
      id = retain(snapshot.account, id, transaction.hash, nonce, { create: true, expectedHash: transaction.hash }, pending.hash);
      remember({ ...transaction, nonce }, id);
      put({ id, account: snapshot.account, kind: "checking", submitted: transaction });
    } });
    if (!submitted) {
      assertScope();
      await synchronize(snapshot.account);
      assertScope();
      const current = findKnown(snapshot.account, hash);
      const result = current?.kind === "terminal" ? current : await inspect(snapshot.account, current ? outcomeHash(current) ?? hash : hash, current?.id, true);
      assertScope();
      return result;
    }
    assertScope(submitted);
    return watch(submitted, id);
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
      const saved = target.getItem(key);
      if (saved !== null && saved.toLowerCase() !== record.submitted.hash.toLowerCase()) throw new Error("The recovery checkpoint changed. Check its transaction again.");
      target.removeItem(key);
      if (target.getItem(key) !== null) throw new Error("The recovery checkpoint could not be acknowledged.");
      acknowledged.set(key, record.submitted.hash.toLowerCase());
      records.set(accountKey(record.account), getSnapshot(record.account).filter(item => item !== record));
      notify();
      loaded.delete(accountKey(record.account));
    } });
    const recovering = recoveries.get(accountKey(record.account));
    if (recovering) await recovering;
    void recover(record.account);
  }
  function claimRefresh(key: string) { if (refreshed.has(key)) return false; refreshed.add(key); return true; }
  return { getSnapshot, claimRefresh, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, hydrate, recover, synchronize, observe, submit, resume, acknowledge };
}
export type TransactionOutcomes = ReturnType<typeof createTransactionOutcomes>;
const owners = new WeakMap<RaffleService, TransactionOutcomes>();
export function transactionOutcomes(service: RaffleService) {
  let owner = owners.get(service);
  if (!owner) { owner = createTransactionOutcomes(service); owners.set(service, owner); }
  return owner;
}
