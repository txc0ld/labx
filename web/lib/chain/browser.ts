"use client";
import { createPublicClient, http } from "viem";
import { APPROVED_DEPLOYMENTS, LEGACY_RAFFLE } from "./deployment";
import { createRaffleService } from "./service";
import { WalletSession } from "./wallet-session";
import { BrowserWalletSession } from "./wallet-connectors";

const loadChooser: ConstructorParameters<typeof BrowserWalletSession>[3] = async (projectId, scope) => {
  const { createAppKitProvider } = await import("./appkit-provider");
  return createAppKitProvider(projectId, scope);
};
import { sameAddress } from "./validation";
import { parseLocalManifest } from "./manifest";
import type { BrowserService } from "./ports";
import type { DeploymentManifest } from "./types";

export function localDevelopmentManifest(raw: string | undefined): DeploymentManifest | null {
  if (process.env.NODE_ENV !== "development" || !raw) return null;
  try { return parseLocalManifest(JSON.parse(raw)); }
  catch { throw new Error("Invalid local fixture manifest."); }
}
let configured: BrowserService | undefined;
export function configuredBrowserService(): BrowserService {
  if (typeof window === "undefined") return { kind: "unavailable", reason: "Connect a wallet in your browser.", wallet: new WalletSession(undefined) };
  if (configured) return configured;
  let manifest: DeploymentManifest | undefined;
  let rpc = process.env.NEXT_PUBLIC_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const selected = process.env.NEXT_PUBLIC_RAFFLE_ADDRESS;
  try {
    if (process.env.NODE_ENV === "development" && ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
      const local = localDevelopmentManifest(process.env.NEXT_PUBLIC_LOCAL_RAFFLE_MANIFEST);
      if (local) {
        const localRpc = new URL(process.env.NEXT_PUBLIC_LOCAL_RPC_URL || "http://127.0.0.1:8545");
        if (!["localhost", "127.0.0.1"].includes(localRpc.hostname)) throw new Error("Local fixtures require a loopback RPC.");
        manifest = local; rpc = localRpc.href;
      }
    }
    manifest ??= APPROVED_DEPLOYMENTS.find(item => selected && item.chainId === 11155111 && sameAddress(item.address, selected));
    const wallet = new BrowserWalletSession(window.ethereum, manifest?.chainId ?? 11155111, process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID, loadChooser, manifest ? `${manifest.version}:${manifest.chainId}:${manifest.address.toLowerCase()}:${manifest.runtimeCodeHash.toLowerCase()}` : undefined);
    if (manifest) void wallet.restore();
    if (!manifest) {
      configured = { kind: "unavailable", wallet, reason: selected && sameAddress(selected, LEGACY_RAFFLE) ? "The configured contract is historical. It does not support the current buyer protections." : "A reviewed raffle deployment has not been configured yet." };
    } else configured = { kind: "configured", wallet, service: createRaffleService(createPublicClient({ transport: http(rpc, { timeout: 15_000, retryCount: 1 }) }), manifest) };
  } catch { configured = { kind: "unavailable", reason: "Deployment configuration is invalid.", wallet: new BrowserWalletSession(window.ethereum, 11155111, process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID, loadChooser) }; }
  return configured;
}
