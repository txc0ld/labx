import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import type { DeploymentManifest } from "./types";
import { hash } from "./validation";

export type PendingIntent = { id: string; intentHash: Hex; nonce: number; startedBlock: string; hash: Hex | null };
export interface PendingJournal {
  read(account: Address): PendingIntent | null;
  write(account: Address, intent: PendingIntent): void;
  remove(account: Address): void;
  exclusive<T>(account: Address, run: () => Promise<T>): Promise<T>;
}
export function transactionIntent(tx: { to: Address; data: Hex; value: bigint }): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "uint256" }], [tx.to, keccak256(tx.data), tx.value]));
}
function parse(raw: string | null): PendingIntent | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !("intentHash" in value) || !("nonce" in value) || typeof value.nonce !== "number" || !Number.isSafeInteger(value.nonce) || value.nonce < 0 || !("startedBlock" in value) || typeof value.startedBlock !== "string" || !/^\d+$/.test(value.startedBlock) || !("hash" in value)) throw new Error("Pending transaction record is invalid. Reconcile wallet activity before continuing.");
  return { id: value.id, intentHash: hash(value.intentHash), nonce: value.nonce, startedBlock: value.startedBlock, hash: value.hash === null ? null : hash(value.hash) };
}
export function memoryPendingJournal(): PendingJournal {
  const records = new Map<string, string>(), locks = new Map<string, Promise<unknown>>();
  return {
    read: account => parse(records.get(account.toLowerCase()) ?? null),
    write: (account, intent) => { records.set(account.toLowerCase(), JSON.stringify(intent)); },
    remove: account => { records.delete(account.toLowerCase()); },
    exclusive(account, run) { const key = account.toLowerCase(); const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(run); locks.set(key, next); return next; }
  };
}
export function browserPendingJournal(manifest: DeploymentManifest): PendingJournal {
  const scope = `labx:pending:v1:${manifest.chainId}:${manifest.address.toLowerCase()}:${manifest.runtimeCodeHash.toLowerCase()}`;
  const key = (account: Address) => `${scope}:${account.toLowerCase()}`;
  function storage() {
    if (typeof window === "undefined" || !window.navigator.locks) throw new Error("Safe transaction recovery requires browser storage and Web Locks. Use a supported secure wallet browser.");
    return window.localStorage;
  }
  return {
    read: account => parse(storage().getItem(key(account))),
    write(account, intent) { const data = JSON.stringify(intent); storage().setItem(key(account), data); if (storage().getItem(key(account)) !== data) throw new Error("Pending transaction could not be saved. No new transaction is allowed."); },
    remove: account => { storage().removeItem(key(account)); },
    async exclusive(account, run) { storage(); return await window.navigator.locks.request(key(account), run); }
  };
}
