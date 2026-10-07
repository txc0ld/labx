import { browserPendingJournal, memoryPendingJournal, transactionIntent, type PendingJournal, type PendingIntent } from "./pending-journal";
import { decodeFunctionData, erc20Abi, erc721Abi, type Address, type Hex, type PublicClient } from "viem";
import { raffleAbi } from "./abi";
import { attestDeployment } from "./deployment";
import { createReader } from "./reader";
import { createSellerReader } from "./seller-reader";
import { actionBuilder } from "./actions";
import { MAX_MEMBERSHIP_TOTAL_USDC } from "./fees";
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
export function createRaffleService(client: PublicClient, manifest: DeploymentManifest, journal: PendingJournal = typeof window === "undefined" ? memoryPendingJournal() : browserPendingJournal(manifest)): RaffleService {
  const reader = createReader(client, manifest), build = actionBuilder(client, manifest, reader);
  const sellerReader = createSellerReader(client, manifest, reader);
  const reviews = new WeakMap<PreparedAction, { action: WorkflowAction; session: Extract<WalletSnapshot, { kind: "connected" }>; transaction: PreparedAction; used: boolean }>();
  const submitting = new Set<string>();
  const unresolved = "This wallet has an unresolved transaction. Reconcile its hash before another action.";
  async function prepare({ action, wallet }: Parameters<RaffleService["prepare"]>[0]) {
    const session = connected(wallet, manifest.chainId); await wallet.assertCurrent(session);
    const copy = structuredClone(action), result = await build(copy, session); await wallet.assertCurrent(session);
    const prepared = { ...result, action: structuredClone(copy) };
    reviews.set(prepared, { action: copy, session, transaction: result, used: false }); return prepared;
  }
  async function submit({ prepared, wallet }: Parameters<RaffleService["submit"]>[0]) {
    const entry = reviews.get(prepared);
    if (!entry || entry.used) throw new Error("This review is invalid or already submitted. Review again.");
    const account = entry.session.account, key = account.toLowerCase();
    if (submitting.has(key) || journal.read(account)) throw new Error(unresolved);
    submitting.add(key); entry.used = true;
    let intent: PendingIntent | null = null;
    let walletRequested = false;
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
      if (!walletRequested) throw new Error("Wallet adapter did not establish transaction recovery protection.");
      await journal.exclusive(account, async () => {
        const current = journal.read(account);
        if (!current || current.id !== intent?.id) throw new Error("Pending transaction record changed. Reconcile wallet activity.");
        journal.write(account, { ...current, hash: txHash });
      });
      return { hash: txHash, account, chainId: manifest.chainId, to: entry.transaction.to, data: entry.transaction.data, value: entry.transaction.value };
    } catch (error) {
      const refused = typeof error === "object" && error !== null && "code" in error && error.code === 4001;
      if (!walletRequested || refused) await journal.exclusive(account, async () => {
        const current = journal.read(account);
        if (current?.id === intent?.id) journal.remove(account);
      });
      if (walletRequested && !refused) throw new Error("The wallet response is uncertain. Check its activity and reconcile the transaction hash before retrying.");
      throw error;
    } finally { submitting.delete(key); }
  }

  async function confirm({ transaction, timeoutMs = 60_000 }: Parameters<RaffleService["confirm"]>[0]): ReturnType<RaffleService["confirm"]> {
    await reader.checkedBlock(); hash(transaction.hash);
    if (transaction.chainId !== manifest.chainId) throw new Error("Transaction network does not match this deployment.");
    let replacementSeen = false;
    try {
      const receipt = await client.waitForTransactionReceipt({ hash: transaction.hash, confirmations: 2, timeout: Math.max(1000, Math.min(timeoutMs, 120_000)), onReplaced: () => { replacementSeen = true; } });
      const actual = await client.getTransaction({ hash: receipt.transactionHash });
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash) throw new Error("The transaction block changed. Refresh its confirmation.");
      if (!sameAddress(actual.from, transaction.account)) throw new Error("Transaction sender does not match this wallet.");
      let expectedIntent = transactionIntent(transaction);
      await journal.exclusive(transaction.account, async () => {
        const current = journal.read(transaction.account);
        if (!current) return;
        if (actual.nonce !== current.nonce || receipt.blockNumber < BigInt(current.startedBlock) || current.hash !== null && current.hash !== transaction.hash && current.hash !== receipt.transactionHash) throw new Error("This transaction does not reconcile the unresolved wallet action.");
        expectedIntent = current.intentHash;
        journal.remove(transaction.account);
      });
      if (!actual.to || transactionIntent({ to: actual.to, data: actual.input, value: actual.value }) !== expectedIntent) return { kind: "replaced", hash: receipt.transactionHash, reason: "The wallet replaced this transaction with a different action." };
      if (receipt.status !== "success") return { kind: "reverted", hash: receipt.transactionHash, reason: "The transaction reverted. No successful action was recorded." };
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
    const existing = journal.read(session.account);
    if (existing && (tx.nonce !== existing.nonce || tx.blockNumber !== null && tx.blockNumber < BigInt(existing.startedBlock))) throw new Error("This hash is unrelated to the unresolved wallet action.");
    const target = tx.to;
    if (existing) {
      // A replacement/cancellation may use different calldata. Only the exact unresolved nonce can reconcile it.
    } else if (sameAddress(target, manifest.address)) {
      const decoded = decodeFunctionData({ abi: raffleAbi, data: tx.input });
      const allowed = new Set(["createRaffle", "updateDraft", "escrow", "openWithPolicy", "close", "snapshot", "requestRandomness", "reveal", "settle", "claimPrize", "claimProceeds", "claimFee", "cancel", "abortDrawing", "reclaimPrize", "refund", "buyPack", "buyPackWithEth"]);
      if (!allowed.has(decoded.functionName) || decoded.functionName !== "buyPackWithEth" && tx.value !== 0n) throw new Error("This is not a supported LABx workflow transaction.");
    } else if (sameAddress(tx.to, manifest.usdc)) {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.input });
      if (decoded.functionName !== "approve" || !sameAddress(decoded.args[0], manifest.address) || decoded.args[1] <= 0n || decoded.args[1] > MAX_MEMBERSHIP_TOTAL_USDC || tx.value !== 0n) throw new Error("This is not a bounded LABx payment approval.");
    } else {
      const decoded = decodeFunctionData({ abi: erc721Abi, data: tx.input });
      if (decoded.functionName !== "approve" || !sameAddress(decoded.args[0], manifest.address) || tx.value !== 0n) throw new Error("This is not a LABx NFT approval.");
      // Recovery has no stored draft ID. Resolve the exact NFT/token/seller against paginated chain records.
      let cursor: bigint | undefined = 1n, found = false;
      const at = await reader.checkedBlock();
      while (cursor !== undefined && !found) {
        const page = await reader.listRaffles({ cursor, limit: 24, block: at });
        found = page.items.some(item => sameAddress(item.raffle.seller, session.account) && sameAddress(item.raffle.nft, target) && item.raffle.tokenId === decoded.args[1]);
        cursor = page.nextCursor ?? undefined;
      }
      if (!found) throw new Error("No seller draft matches this NFT approval.");
    }
    await wallet.assertCurrent(session);
    const result: SubmittedAction = { hash: tx.hash, account: session.account, chainId: manifest.chainId, to: tx.to, data: tx.input, value: tx.value };
    await journal.exclusive(session.account, async () => {
      const current = journal.read(session.account);
      if (current?.id !== existing?.id) throw new Error("Pending wallet activity changed. Retry recovery.");
      journal.write(session.account, current ? { ...current, hash: tx.hash } : { id: crypto.randomUUID(), intentHash: transactionIntent(result), nonce: tx.nonce, startedBlock: (tx.blockNumber ?? await client.getBlockNumber()).toString(), hash: tx.hash });
    });
    return result;
  }
  async function pending({ wallet }: Parameters<RaffleService["pending"]>[0]) {
    const session = connected(wallet, manifest.chainId); await wallet.assertCurrent(session);
    const current = journal.read(session.account); return current ? { hash: current.hash, nonce: current.nonce } : null;
  }
  return { manifest, pending, attest: () => attestDeployment(client, manifest), ...reader, ...sellerReader, prepare, submit, confirm, resume };
}
