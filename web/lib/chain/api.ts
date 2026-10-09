"use client";
import { keccak256, toBytes, type Hex } from "viem";
import { PreparationNotDispatchedError } from "./submission-errors";
import { configuredBrowserService } from "./browser";
import { address, hash, sameAddress } from "./validation";
import { workflowMessage } from "./messages";
import { agreementMessage } from "../agreement-record";
import { receiptAuthorizationMessage } from "../receipt-delivery";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../published-terms";
import { hashCommitment } from "../commitment";
import type { WalletSessionPort } from "./ports";
import type { AgreementResult, CommitmentInput, PrivateRecords, PublicReserve, PreparationRecoveryInput, ReceiptInput, ReceiptResult, RecordsInput, ReserveRecord, WorkflowContext } from "./api-types";
export type { AgreementResult, CommitmentInput, PrivateRecords, PublicReserve, PreparationRecoveryInput, ReceiptInput, ReceiptResult, RecordsInput, ReserveRecord, WorkflowContext } from "./api-types";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workflow response.");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid workflow response."); return value; }
async function request(path: string, input?: unknown) {
  const response = await fetch(path, { method: input === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: input === undefined ? undefined : JSON.stringify(input) });
  const content = await response.text();
  if (content.length > 262_144) throw new Error("Workflow response was too large.");
  const body = record(JSON.parse(content));
  if (!response.ok || body.ok !== true) throw new Error(typeof body.error === "string" ? body.error : "The workflow request was not acknowledged.");
  return body;
}
async function contextFor(wallet: WalletSessionPort) {
  const expected = wallet.getSnapshot();
  if (expected.kind !== "connected") throw new Error("Connect the configured test network.");
  const browser = configuredBrowserService();
  if (browser.kind !== "configured") throw new Error(browser.reason);
  const raw = record((await request("/api/workflow/context")).context);
  const context: WorkflowContext = { origin: text(raw.origin), chainId: raw.chainId === 11155111 ? 11155111 : raw.chainId === 31337 ? 31337 : (() => { throw new Error("Invalid workflow network."); })(), contract: address(raw.contract), termsHash: hash(raw.termsHash), termsVersion: text(raw.termsVersion) };
  if (context.origin !== window.location.origin || context.chainId !== browser.service.manifest.chainId || !sameAddress(context.contract, browser.service.manifest.address) || context.termsHash !== PUBLISHED_TERMS_HASH || context.termsVersion !== TERMS_VERSION) throw new Error("The workflow origin, deployment or published terms do not match this website.");
  if (expected.chainId !== context.chainId) throw new Error("Connect the configured test network.");
  await wallet.assertCurrent(expected);
  return { context, expected, deadline: String(Math.floor(Date.now() / 1000) + 300) };
}
function publicReserve(body: Record<string, unknown>): PublicReserve {
  const tokenId = text(body.tokenId), chainId = text(body.chainId);
  if (!/^\d{1,78}$/.test(tokenId) || !["11155111", "31337"].includes(chainId)) throw new Error("Invalid commitment identifiers.");
  return { seller: address(body.seller), nft: address(body.nft), tokenId, chainId, labx: address(body.labx), publicSummary: text(body.publicSummary), publicHash: hash(body.publicHash), nonce: hash(body.nonce), commit: hash(body.commit) };
}
export async function createCommitment(wallet: WalletSessionPort, input: CommitmentInput, options?: { assertIntent: () => void; beforeRequest: (identity: Hex) => void }): Promise<PublicReserve> {
  let dispatched = false;
  try {
  const { context, expected, deadline } = await contextFor(wallet);
  const normalized = { nft: address(input.nft), tokenId: BigInt(input.tokenId).toString(), publicSummary: input.publicSummary.trim(), privateCommitment: input.privateCommitment.trim() };
  const identity = keccak256(toBytes(JSON.stringify([context.chainId, context.contract.toLowerCase(), expected.account.toLowerCase(), normalized])));
  options?.assertIntent();
  options?.beforeRequest(identity);
  const signature = await wallet.signMessage({ assertIntent: options?.assertIntent, message: workflowMessage("commitment", context, expected.account, normalized, deadline), expected });
  options?.assertIntent();
  dispatched = true;
  const result = publicReserve(await request("/api/reserve", { address: expected.account, input: normalized, deadline, signature }));
  await wallet.assertCurrent(expected);
  if (!sameAddress(result.seller, expected.account) || !sameAddress(result.labx, context.contract) || result.chainId !== String(context.chainId) || !sameAddress(result.nft, normalized.nft) || result.tokenId !== normalized.tokenId || result.publicSummary !== normalized.publicSummary || result.publicHash !== keccak256(toBytes(normalized.publicSummary))) throw new Error("Stored commitment does not match the reviewed request.");
  return result;  } catch (error) { if (!dispatched) throw new PreparationNotDispatchedError(error); throw error; }
}

export async function recoverCommitment(wallet: WalletSessionPort, input: { commit: Hex }): Promise<ReserveRecord> {
  const { context, expected, deadline } = await contextFor(wallet), normalized = { commit: hash(input.commit) };
  const signature = await wallet.signMessage({ message: workflowMessage("commitment recovery", context, expected.account, normalized, deadline), expected });
  const body = await request("/api/reserve/reveal", { address: expected.account, input: normalized, deadline, signature });
  await wallet.assertCurrent(expected);
  const result: ReserveRecord = { ...publicReserve(body), salt: hash(body.salt), privateHash: hash(body.privateHash) };
  if (!sameAddress(result.seller, expected.account) || !sameAddress(result.labx, context.contract) || result.chainId !== String(context.chainId) || result.commit !== normalized.commit || hashCommitment({ ...result, chainId: BigInt(result.chainId), tokenId: BigInt(result.tokenId) }) !== result.commit) throw new Error("Recovered commitment failed its integrity check.");
  return result;
}
const placeholderSignature: Hex = "0x";
export async function saveAgreement(wallet: WalletSessionPort, input: { raffleId: string; terms: true; rules: true; age: true }): Promise<AgreementResult> {
  const { context, expected, deadline } = await contextFor(wallet);
  if (!/^[1-9]\d{0,77}$/.test(input.raffleId) || input.terms !== true || input.rules !== true || input.age !== true) throw new Error("Confirm all membership agreements.");
  const body = { address: expected.account, pieceId: input.raffleId, terms: true, rules: true, age: true, termsHash: context.termsHash, deadline, signature: placeholderSignature };
  const signature = await wallet.signMessage({ message: agreementMessage(body, context), expected });
  const response = await request("/api/agreements", { ...body, signature }); await wallet.assertCurrent(expected);
  if (response.recorded !== true || response.termsHash !== context.termsHash || response.version !== context.termsVersion) throw new Error("Agreement storage was not acknowledged.");
  return { recorded: true, key: text(response.key), termsHash: context.termsHash, version: context.termsVersion };
}
export async function sendPurchaseReceipt(wallet: WalletSessionPort, input: ReceiptInput): Promise<ReceiptResult> {
  const { context, expected, deadline } = await contextFor(wallet);
  const body = { ...input, transactionHash: hash(input.transactionHash), address: expected.account, deadline, signature: placeholderSignature };
  const signature = await wallet.signMessage({ message: receiptAuthorizationMessage(body, context), expected });
  const response = await request("/api/email/receipt", { ...body, signature }); await wallet.assertCurrent(expected);
  if (typeof response.delivered !== "boolean") throw new Error("Receipt delivery was not acknowledged.");
  return { delivered: response.delivered, repeated: response.repeated === true, ...(typeof response.reason === "string" ? { reason: response.reason } : {}) };
}
export async function readPrivateRecords(wallet: WalletSessionPort, input: RecordsInput): Promise<PrivateRecords> {
  const { context, expected, deadline } = await contextFor(wallet);
  const signature = await wallet.signMessage({ message: workflowMessage("private records", context, expected.account, input, deadline), expected });
  const body = await request("/api/records", { address: expected.account, input, deadline, signature }); await wallet.assertCurrent(expected);
  if (!Array.isArray(body.agreements) || !Array.isArray(body.receipts)) throw new Error("Invalid private records response.");
  return {
    agreements: body.agreements.map((value: unknown) => { const row = record(value); if (typeof row.recorded !== "boolean" || row.at !== null && typeof row.at !== "string") throw new Error("Invalid agreement record."); return { raffleId: text(row.raffleId), recorded: row.recorded, at: row.at }; }),
    receipts: body.receipts.map((value: unknown) => { const row = record(value); if (typeof row.logIndex !== "number" || !Number.isSafeInteger(row.logIndex) || row.logIndex < 0 || row.status !== "missing" && row.status !== "pending" && row.status !== "delivered") throw new Error("Invalid receipt record."); return { transactionHash: hash(row.transactionHash), logIndex: row.logIndex, status: row.status }; })
  };
}

export async function recoverPreparation(wallet: WalletSessionPort, input: PreparationRecoveryInput, assertIntent: () => void): Promise<PublicReserve> {
  const { context, expected, deadline } = await contextFor(wallet);
  const normalized = { requestIdentity: hash(input.requestIdentity), nft: address(input.nft), tokenId: BigInt(input.tokenId).toString() };
  assertIntent();
  const signature = await wallet.signMessage({ message: workflowMessage("preparation recovery", context, expected.account, normalized, deadline), expected, assertIntent });
  assertIntent();
  const result = publicReserve(await request("/api/reserve/preparation", { address: expected.account, input: normalized, deadline, signature }));
  await wallet.assertCurrent(expected);
  if (!sameAddress(result.seller, expected.account) || !sameAddress(result.labx, context.contract) || result.chainId !== String(context.chainId) || !sameAddress(result.nft, normalized.nft) || result.tokenId !== normalized.tokenId) throw new Error("Recovered preparation does not match.");
  return result;
}
