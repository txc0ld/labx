import { isAddress, type Address } from "viem";

export type WalletConsent = { version: 1; connectorId: string; account: Address; chainId: number; id: string };
export function consentKey(projectId: string | undefined, scope: string) {
  return `labx:wallet-consent:v1:${typeof window === "undefined" ? "" : window.location.origin}:${projectId ?? "local"}:${scope}`;
}
export function readWalletConsent(key: string): WalletConsent | null {
  const raw = window.localStorage.getItem(key);
  if (raw === null || window.sessionStorage?.getItem(`${key}:revoked`) === raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("connectorId" in value) || typeof value.connectorId !== "string" || !value.connectorId || value.connectorId.length > 256 || !("account" in value) || typeof value.account !== "string" || !isAddress(value.account) || !("chainId" in value) || value.chainId !== 11155111 && value.chainId !== 31337 || !("id" in value) || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id)) throw new Error("Saved wallet connection is invalid. Connect your wallet again.");
  return { version: 1, connectorId: value.connectorId, account: value.account, chainId: value.chainId, id: value.id };
}
export function saveWalletConsent(key: string, value: Omit<WalletConsent, "id" | "version">) {
  const consent: WalletConsent = { ...value, version: 1, id: crypto.randomUUID() };
  const raw = JSON.stringify(consent);
  window.localStorage.setItem(key, raw);
  if (window.localStorage.getItem(key) !== raw) throw new Error("Wallet connection could not be saved.");
  return consent;
}
export function sameConsent(left: WalletConsent | null, right: WalletConsent | null) {
  return left !== null && right !== null && left.id === right.id && left.connectorId === right.connectorId && left.chainId === right.chainId && left.account.toLowerCase() === right.account.toLowerCase();
}

export function revokeWalletConsent(key: string) {
  let recorded = false;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) {
      window.sessionStorage?.setItem(`${key}:revoked`, raw);
      recorded = window.sessionStorage?.getItem(`${key}:revoked`) === raw;
    }
  } catch { /* Local deletion can still persist revocation. */ }
  try {
    window.localStorage.removeItem(key);
    if (window.localStorage.getItem(key) === null) return;
  } catch { /* Some browsers permit replacement but reject deletion. */ }
  try {
    window.localStorage.setItem(key, "null");
    if (window.localStorage.getItem(key) === "null") return;
  } catch { /* The per-generation tab record remains authoritative when available. */ }
  if (!recorded) throw new Error("Disconnected. Browser storage could not save this change. Close this tab before returning.");
}
