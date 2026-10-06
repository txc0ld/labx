import type { Address, Hex, PublicClient } from "viem";
import { attestDeployment } from "./deployment";
import { createReader } from "./reader";
import { actionBuilder } from "./actions";
import { hash, sameAddress } from "./validation";
import type { RaffleService, WalletSessionPort } from "./ports";
import type { DeploymentManifest, PreparedAction, SubmittedAction, WalletSnapshot, WorkflowAction } from "./types";
function connected(wallet: WalletSessionPort, chainId: number) {
  const session = wallet.getSnapshot();
  if (session.kind !== "connected" || session.chainId !== chainId) throw new Error("Connect the approved test network before continuing.");
  return session;
}
function sameTransaction(a: { to: Address; data: Hex; value: bigint }, b: { to: Address; data: Hex; value: bigint }) {
  return sameAddress(a.to, b.to) && a.data.toLowerCase() === b.data.toLowerCase() && a.value === b.value;
}
export function createRaffleService(client: PublicClient, manifest: DeploymentManifest): RaffleService {
  const reader = createReader(client, manifest), build = actionBuilder(client, manifest, reader);
  const reviews = new WeakMap<PreparedAction, { action: WorkflowAction; session: Extract<WalletSnapshot, { kind: "connected" }>; transaction: PreparedAction; used: boolean }>();
  const pending = new Map<string, SubmittedAction | "submitting">();
  async function prepare({ action, wallet }: Parameters<RaffleService["prepare"]>[0]) {
    const session = connected(wallet, manifest.chainId); await wallet.assertCurrent(session);
    const copy = structuredClone(action), result = await build(copy, session); await wallet.assertCurrent(session);
    const prepared = { ...result, action: structuredClone(copy) };
    reviews.set(prepared, { action: copy, session, transaction: result, used: false }); return prepared;
  }
  async function submit({ prepared, wallet }: Parameters<RaffleService["submit"]>[0]) {
    const entry = reviews.get(prepared);
    if (!entry || entry.used) throw new Error("This review is invalid or already submitted. Review again.");
    const key = entry.session.account.toLowerCase();
    if (pending.has(key)) throw new Error("This wallet already has an action awaiting confirmation.");
    pending.set(key, "submitting"); entry.used = true;
    let walletRequested = false;
    try {
      await wallet.assertCurrent(entry.session);
      const fresh = await build(entry.action, entry.session);
      if (!sameTransaction(fresh, entry.transaction) || fresh.amountUsdc !== entry.transaction.amountUsdc || !sameAddress(fresh.recipient, entry.transaction.recipient)) throw new Error("Amounts or recipients changed. Review this action again.");
      await wallet.assertCurrent(entry.session); walletRequested = true;
      const txHash = await wallet.requestTransaction(entry.session, entry.transaction);
      const transaction: SubmittedAction = { hash: txHash, account: entry.session.account, chainId: manifest.chainId, to: entry.transaction.to, data: entry.transaction.data, value: entry.transaction.value };
      pending.set(key, transaction); return transaction;
    } catch (error) {
      const refused = typeof error === "object" && error !== null && "code" in error && error.code === 4001;
      if (!walletRequested || refused) pending.delete(key);
      if (walletRequested && !refused) throw new Error("The wallet response is uncertain. Check its activity and resume the transaction hash before retrying.");
      throw error;
    }
  }
  async function confirm({ transaction, timeoutMs = 60_000 }: Parameters<RaffleService["confirm"]>[0]): ReturnType<RaffleService["confirm"]> {
    await reader.checkedBlock(); hash(transaction.hash);
    if (transaction.chainId !== manifest.chainId) throw new Error("Transaction network does not match this deployment.");
    let replacementSeen = false;
    try {
      const receipt = await client.waitForTransactionReceipt({ hash: transaction.hash, confirmations: 2, timeout: Math.max(1000, Math.min(timeoutMs, 120_000)), onReplaced: () => { replacementSeen = true; } });
      const actual = await client.getTransaction({ hash: receipt.transactionHash });
      const current = pending.get(transaction.account.toLowerCase());
      if (current !== "submitting" && current?.hash === transaction.hash) pending.delete(transaction.account.toLowerCase());
      if (!actual.to || !sameAddress(actual.from, transaction.account) || !sameTransaction({ to: actual.to, data: actual.input, value: actual.value }, transaction)) return { kind: "replaced", hash: receipt.transactionHash, reason: "The wallet replaced this transaction with a different action." };
      if (receipt.status !== "success") return { kind: "reverted", hash: receipt.transactionHash, reason: "The transaction reverted. No successful action was recorded." };
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash) throw new Error("The transaction block changed. Refresh its confirmation.");
      return { kind: "confirmed", hash: receipt.transactionHash, blockNumber: receipt.blockNumber, replacedHash: replacementSeen ? transaction.hash : null };
    } catch (error) {
      if (error instanceof Error && /Timeout|timed out/i.test(error.name + error.message)) return { kind: "pending", hash: transaction.hash };
      throw error;
    }
  }
  async function resume({ hash: txHash, wallet }: Parameters<RaffleService["resume"]>[0]) {
    await reader.checkedBlock(); hash(txHash); const session = connected(wallet, manifest.chainId); await wallet.assertCurrent(session);
    const tx = await client.getTransaction({ hash: txHash });
    if (!tx.to || !sameAddress(tx.from, session.account)) throw new Error("This transaction is not from the connected wallet.");
    const result: SubmittedAction = { hash: tx.hash, account: session.account, chainId: manifest.chainId, to: tx.to, data: tx.input, value: tx.value };
    pending.set(session.account.toLowerCase(), result); return result;
  }
  return { manifest, attest: () => attestDeployment(client, manifest), ...reader, prepare, submit, confirm, resume };
}
