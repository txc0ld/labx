import { browserPendingJournal, memoryPendingJournal, transactionIntent, type PendingJournal, type PendingIntent } from "./pending-journal";
import { BaseError, HttpRequestError, InternalRpcError, LimitExceededRpcError, SocketClosedError, TimeoutError, TransactionNotFoundError, WebSocketRequestError, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { attestDeployment } from "./deployment";
import { createReader } from "./reader";
import { createSellerReader } from "./seller-reader";
import { ownerExecutionConfirmer } from "./owner-execution";
import { isWalletRequestRejected } from "./wallet-errors";
import { actionBuilder } from "./actions";
import { hash, sameAddress } from "./validation";
import type { RaffleService, WalletSessionPort } from "./ports";
import type { CanonicalReceipt, OutcomeLineage, DeploymentManifest, OwnerExecutionIntent, PreparedAction, SubmittedAction, WalletSnapshot, WorkflowAction } from "./types";
function connected(wallet: WalletSessionPort, chainId: number) {
  const session = wallet.getSnapshot();
  if (session.kind !== "connected" || session.chainId !== chainId) throw new Error("Connect the approved test network before continuing.");
  return session;
}
function sameTransaction(a: { to: Address; data: Hex; value: bigint }, b: { to: Address; data: Hex; value: bigint }) {
  return sameAddress(a.to, b.to) && a.data.toLowerCase() === b.data.toLowerCase() && a.value === b.value;
}
export function createRaffleService(client: PublicClient, manifest: DeploymentManifest, journal: PendingJournal = typeof window === "undefined" ? memoryPendingJournal() : browserPendingJournal(manifest)): RaffleService {
  const reader = createReader(client, manifest), build = actionBuilder(client, manifest, reader);
  const sellerReader = createSellerReader(client, manifest, reader);
  const reviews = new WeakMap<PreparedAction, { action: WorkflowAction; session: Extract<WalletSnapshot, { kind: "connected" }>; transaction: PreparedAction; used: boolean }>();
  const submitting = new Set<string>();
  const canonicalReceipts = new WeakMap<CanonicalReceipt, { account: Address; nonce: number }>();
  const outcomeLineages = new WeakMap<OutcomeLineage, { account: Address; journal: Readonly<PendingIntent> }>();
  const unresolved = "This wallet has an unresolved transaction. Reconcile its hash before another action.";
  async function prepare({ action, wallet }: Parameters<RaffleService["prepare"]>[0]) {
    const session = connected(wallet, manifest.chainId); await wallet.assertCurrent(session);
    const copy = structuredClone(action), result = await build(copy, session); await wallet.assertCurrent(session);
    const prepared = { ...result, action: structuredClone(copy) };
    reviews.set(prepared, { action: copy, session, transaction: result, used: false }); return prepared;
  }
  async function exportOwnerExecution({ prepared, wallet }: Parameters<RaffleService["exportOwnerExecution"]>[0]): Promise<OwnerExecutionIntent> {
    const entry = reviews.get(prepared);
    if (!entry || entry.used || (entry.action.kind !== "approveRaffle" && entry.action.kind !== "revokeRaffleApproval")) throw new Error("Review an owner approval action first.");
    await wallet.assertCurrent(entry.session);
    const fresh = await build(entry.action, entry.session);
    if (!sameTransaction(fresh, entry.transaction)) throw new Error("Owner execution changed. Review again.");
    const review = await reader.readAdmission({ id: entry.action.id, block: fresh.block });
    await wallet.assertCurrent(entry.session);
    entry.used = true;
    return { action: structuredClone(entry.action), runtimeCodeHash: manifest.runtimeCodeHash, chainId: manifest.chainId, from: entry.session.account, to: manifest.address,
      value: 0n, data: fresh.data, reviewBlock: fresh.block, ownerGeneration: review.ownerGeneration,
      openingPolicyGeneration: review.openingPolicyGeneration, reviewRevision: review.snapshot.admission.record.reviewRevision };
  }
  async function submit({ prepared, wallet }: Parameters<RaffleService["submit"]>[0]) {
    const entry = reviews.get(prepared);
    if (!entry || entry.used) throw new Error("This review is invalid or already submitted. Review again.");
    const account = entry.session.account, key = account.toLowerCase();
    await wallet.assertCurrent(entry.session);
    const accountCode = await client.getCode({ address: account });
    if (accountCode && accountCode !== "0x") throw new Error("Direct transactions from contract wallets are unsupported. Owner approval and revocation require the reviewed payload for external execution and its executed Ethereum transaction hash.");
    if (entry.used) throw new Error("This review is invalid or already submitted. Review again.");
    if (submitting.has(key) || journal.read(account)) throw new Error(unresolved);
    submitting.add(key); entry.used = true;
    let intent: PendingIntent | null = null;
    let walletRequested = false;
    let broadcastHash: Hex | null = null;
    try {
      await wallet.assertCurrent(entry.session);
      const fresh = await build(entry.action, entry.session);
      if (!sameTransaction(fresh, entry.transaction) || fresh.amountUsdc !== entry.transaction.amountUsdc || !sameAddress(fresh.recipient, entry.transaction.recipient)) throw new Error("Amounts or recipients changed. Review this action again.");
      const nonce = await client.getTransactionCount({ address: account, blockTag: "pending" });
      await wallet.assertCurrent(entry.session);
      const txHash = await wallet.requestTransaction(entry.session, { ...entry.transaction, nonce }, async () => {
        await journal.exclusive(account, async () => {
          if (journal.read(account)) throw new Error(unresolved);
          intent = { id: crypto.randomUUID(), intentHash: transactionIntent(entry.transaction), nonce, startedBlock: fresh.block.number.toString(), hash: null };
          journal.write(account, intent);
        });
      }, () => { walletRequested = true; });
      broadcastHash = txHash;
      if (!walletRequested) throw new Error("Wallet adapter did not establish transaction recovery protection.");
      await journal.exclusive(account, async () => {
        const current = journal.read(account);
        if (!current || current.id !== intent?.id) throw new Error("Pending transaction record changed. Reconcile wallet activity.");
        journal.write(account, { ...current, hash: txHash });
      });
      return { hash: txHash, account, chainId: manifest.chainId, to: entry.transaction.to, data: entry.transaction.data, value: entry.transaction.value };
    } catch (error) {
      let refused = broadcastHash === null && isWalletRequestRejected(error);
      if (!walletRequested || refused) await journal.exclusive(account, async () => {
        const current = journal.read(account);
        if (current && current.id === intent?.id) {
          if (current.hash !== null || broadcastHash !== null) refused = false;
          else journal.remove(account);
        }
      });
      if (walletRequested && !refused) throw new Error("The wallet response is uncertain. Check its activity and reconcile the transaction hash before retrying.");
      throw error;
    } finally { submitting.delete(key); }
  }

  async function validateReceipt(receipt: TransactionReceipt, account: Address): Promise<CanonicalReceipt> {
    const [actual, block, latest] = await Promise.all([
      client.getTransaction({ hash: receipt.transactionHash }),
      client.getBlock({ blockNumber: receipt.blockNumber }),
      client.getBlockNumber({ cacheTime: 0 })
    ]);
    if (actual.hash.toLowerCase() !== receipt.transactionHash.toLowerCase() || actual.blockNumber !== receipt.blockNumber || actual.blockHash !== receipt.blockHash || block.hash !== receipt.blockHash) throw new Error("The transaction block changed. Refresh its confirmation.");
    if (latest < receipt.blockNumber + 1n) throw new Error("The receipt does not yet have two canonical confirmations.");
    if (!sameAddress(actual.from, account) || !sameAddress(receipt.from, account)) throw new Error("Transaction sender does not match this wallet.");
    const result: CanonicalReceipt = { hash: receipt.transactionHash, account: actual.from, chainId: manifest.chainId, to: actual.to, data: actual.input, value: actual.value,
      nonce: actual.nonce, blockNumber: receipt.blockNumber, status: receipt.status };
    canonicalReceipts.set(result, { account: actual.from, nonce: actual.nonce });
    return Object.freeze(result);
  }
  async function canonicalReceipt(txHash: Hex, account: Address, timeoutMs: number, onReplaced?: () => void): Promise<CanonicalReceipt> {
    return validateReceipt(await client.waitForTransactionReceipt({ hash: txHash, confirmations: 2, timeout: Math.max(1, Math.min(timeoutMs, 120_000)), onReplaced }), account);
  }
  function timedOut(error: unknown) {
    return error instanceof Error && /Timeout|timed out/i.test(error.name + error.message);
  }
  async function inspectOutcome({ hash: txHash, account, timeoutMs = 0 }: Parameters<RaffleService["inspectOutcome"]>[0]): ReturnType<RaffleService["inspectOutcome"]> {
    hash(txHash);
    try {
      await reader.checkedBlock();
      const requested = await client.getTransaction({ hash: txHash });
      if (requested.hash.toLowerCase() !== txHash.toLowerCase() || !sameAddress(requested.from, account)) throw new Error("Transaction sender or hash does not match this wallet request.");
      const observed = { hash: requested.hash, account: requested.from, chainId: manifest.chainId, to: requested.to, data: requested.input, value: requested.value, nonce: requested.nonce };
      let receipt: CanonicalReceipt;
      if (requested.blockNumber === null) {
        if (!timeoutMs) return { kind: "pending", hash: txHash, reason: "unmined", transaction: observed };
        receipt = await canonicalReceipt(txHash, account, timeoutMs);
      } else {
        const mined = await client.getTransactionReceipt({ hash: txHash });
        if (mined.transactionHash.toLowerCase() !== txHash.toLowerCase() || mined.blockNumber !== requested.blockNumber || mined.blockHash !== requested.blockHash) throw new Error("The receipt does not match the requested transaction's canonical block.");
        if (await client.getBlockNumber({ cacheTime: 0 }) < mined.blockNumber + 1n) return { kind: "pending", hash: txHash, reason: "confirmations", transaction: observed };
        receipt = await validateReceipt(mined, account);
      }
      if (receipt.nonce !== requested.nonce) throw new Error("The canonical receipt does not match the requested transaction nonce.");
      return receipt.status === "success"
        ? { kind: "confirmed", hash: receipt.hash, blockNumber: receipt.blockNumber, replacedHash: receipt.hash.toLowerCase() === txHash.toLowerCase() ? null : txHash, receipt }
        : { kind: "reverted", hash: receipt.hash, reason: "The transaction reverted. No successful action was recorded.", receipt };
    } catch (error) {
      return { kind: "unknown", hash: txHash, reason: error instanceof Error ? error.message : "The transaction could not be verified. Check again when the RPC is available." };
    }
  }
  function retryableObservation(error: unknown) {
    const transient = (cause: unknown) => cause instanceof TransactionNotFoundError || cause instanceof TimeoutError
      || cause instanceof SocketClosedError || cause instanceof WebSocketRequestError || cause instanceof InternalRpcError || cause instanceof LimitExceededRpcError
      || cause instanceof HttpRequestError && (cause.status === undefined || cause.status === 408 || cause.status === 429 || cause.status >= 500);
    return transient(error) || error instanceof BaseError && transient(error.walk(transient));
  }
  async function observeBroadcast(txHash: Hex, deadline: number) {
    while (Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          client.getTransaction({ hash: txHash }),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())); })
        ]);
      } catch (error) {
        if (!retryableObservation(error)) throw error;
      } finally { if (timer) clearTimeout(timer); }
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)));
    }
    return null;
  }
  async function confirm({ transaction, timeoutMs = 60_000, beforeJournalWatch, beforeJournalClear }: Parameters<RaffleService["confirm"]>[0]): ReturnType<RaffleService["confirm"]> {
    await reader.checkedBlock(); hash(transaction.hash);
    if (transaction.chainId !== manifest.chainId) throw new Error("Transaction network does not match this deployment.");
    const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 120_000));
    let replacementSeen = false;
    try {
      if (beforeJournalWatch) {
        const actual = await observeBroadcast(transaction.hash, deadline);
        if (!actual) return { kind: "pending", hash: transaction.hash };
        if (actual.hash.toLowerCase() !== transaction.hash.toLowerCase() || !sameAddress(actual.from, transaction.account)) throw new Error("Transaction sender or hash does not match this wallet request.");
        await journal.exclusive(transaction.account, async () => {
          const current = journal.read(transaction.account);
          if (!current) return;
          if (actual.nonce !== current.nonce || actual.blockNumber !== null && actual.blockNumber < BigInt(current.startedBlock) || current.hash !== null && current.hash.toLowerCase() !== actual.hash.toLowerCase()) throw new Error("This transaction does not match the current unresolved wallet action.");
          beforeJournalWatch({ transaction: { hash: actual.hash, account: actual.from, chainId: manifest.chainId, to: actual.to, data: actual.input, value: actual.value, nonce: actual.nonce }, pending: { id: current.id, hash: current.hash, nonce: current.nonce } });
        });
      }
      if (Date.now() >= deadline) return { kind: "pending", hash: transaction.hash };
      const receipt = await canonicalReceipt(transaction.hash, transaction.account, deadline - Date.now(), () => { replacementSeen = true; });
      let expectedIntent = transaction.to ? transactionIntent({ ...transaction, to: transaction.to }) : null;
      await journal.exclusive(transaction.account, async () => {
        const current = journal.read(transaction.account);
        if (current) {
          if (receipt.nonce !== current.nonce || receipt.blockNumber < BigInt(current.startedBlock) || current.hash !== null && current.hash !== transaction.hash && current.hash !== receipt.hash) throw new Error("This transaction does not reconcile the unresolved wallet action.");
          expectedIntent = current.intentHash;
        }
        beforeJournalClear?.({ receipt, pending: current ? { id: current.id, hash: current.hash, nonce: current.nonce } : null });
        if (current) journal.remove(transaction.account);
      });
      if (!receipt.to || transactionIntent({ ...receipt, to: receipt.to }) !== expectedIntent) return { kind: "replaced", hash: receipt.hash, reason: "The wallet replaced this transaction with a different action.", receipt };
      if (receipt.status !== "success") return { kind: "reverted", hash: receipt.hash, reason: "The transaction reverted. No successful action was recorded.", receipt };
      return { kind: "confirmed", hash: receipt.hash, blockNumber: receipt.blockNumber, replacedHash: replacementSeen ? transaction.hash : null, receipt };
    } catch (error) {
      if (timedOut(error)) return { kind: "pending", hash: transaction.hash };
      throw error;
    }
  }
  async function resume({ hash: txHash, wallet, expectedJournal, beforeJournalUpdate }: Parameters<RaffleService["resume"]>[0]) {
    hash(txHash);
    const session = connected(wallet, manifest.chainId);
    const existing = journal.read(session.account), expected = expectedJournal ?? existing;
    const matches = (current: ReturnType<PendingJournal["read"]>) => current !== null && expected != null
      && current.id === expected.id && current.hash === expected.hash && current.nonce === expected.nonce;
    if (!matches(existing)) return null;
    await wallet.assertCurrent(session);
    await reader.checkedBlock();
    const tx = await client.getTransaction({ hash: txHash });
    if (tx.hash.toLowerCase() !== txHash.toLowerCase() || !sameAddress(tx.from, session.account)) throw new Error("This transaction is not from the connected wallet.");
    await wallet.assertCurrent(session);
    const result: SubmittedAction = { hash: tx.hash, account: session.account, chainId: manifest.chainId, to: tx.to, data: tx.input, value: tx.value };
    return journal.exclusive(session.account, async () => {
      await wallet.assertCurrent(session);
      const current = journal.read(session.account);
      if (!current || !matches(current)) return null;
      if (tx.nonce !== current.nonce || tx.blockNumber !== null && tx.blockNumber < BigInt(current.startedBlock)) throw new Error("This hash is unrelated to the unresolved wallet action.");
      beforeJournalUpdate?.({ transaction: result, nonce: tx.nonce, pending: { id: current.id, hash: current.hash, nonce: current.nonce } });
      journal.write(session.account, { ...current, hash: tx.hash });
      return result;
    });
  }
  function captureOutcomeLineage({ account, hash: txHash }: Parameters<RaffleService["captureOutcomeLineage"]>[0]) {
    hash(txHash);
    const current = journal.read(account);
    if (!current?.hash || current.hash.toLowerCase() !== txHash.toLowerCase()) return null;
    const token = Object.freeze({ hash: txHash });
    outcomeLineages.set(token, { account, journal: Object.freeze({ ...current }) });
    return token;
  }
  async function retainOutcome({ receipt, lineage, retain }: Parameters<RaffleService["retainOutcome"]>[0]) {
    const canonical = canonicalReceipts.get(receipt);
    if (!canonical) throw new Error("Verify the canonical receipt before retaining it.");
    await journal.exclusive(canonical.account, async () => {
      const captured = lineage ? outcomeLineages.get(lineage) : undefined;
      const priorHash = captured && sameAddress(captured.account, canonical.account)
        && captured.journal.nonce === canonical.nonce && receipt.blockNumber >= BigInt(captured.journal.startedBlock)
        ? captured.journal.hash : null;
      retain({ priorHash });
    });
  }
  async function acknowledgeOutcome({ receipt, acknowledge }: Parameters<RaffleService["acknowledgeOutcome"]>[0]) {
    const canonical = canonicalReceipts.get(receipt);
    if (!canonical) throw new Error("Verify the canonical receipt before acknowledging it.");
    await journal.exclusive(canonical.account, async () => {
      const current = journal.read(canonical.account);
      if (current && current.nonce <= canonical.nonce) throw new Error("Reconcile pending wallet activity before acknowledging this receipt.");
      acknowledge();
    });
  }
  async function pending({ wallet }: Parameters<RaffleService["pending"]>[0]) {
    const session = connected(wallet, manifest.chainId); await wallet.assertCurrent(session);
    const current = journal.read(session.account); return current ? { id: current.id, hash: current.hash, nonce: current.nonce } : null;
  }
  return { manifest, pending, captureOutcomeLineage, retainOutcome, acknowledgeOutcome, attest: () => attestDeployment(client, manifest), ...reader, ...sellerReader, inspectOutcome, prepare, exportOwnerExecution, confirmOwnerExecution: ownerExecutionConfirmer(client, manifest, reader), submit, confirm, resume };
}
