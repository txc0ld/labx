import type { Chain } from "viem";
import { foundry, mainnet, sepolia } from "viem/chains";

export type SupportedChainId = 1 | 11155111 | 31337;
/** A chain a reviewed public deployment can be on. 31337 is only the isolated local fixture chain. */
export type PublicChainId = Exclude<SupportedChainId, 31337>;
/** A public RPC that keeps every log, and the refusal by which the configured RPC says it has dropped a range's logs. */
export type FullHistory = { rpc: string; refusal: RegExp };
export type Network = {
  /** Display name, as in "Switch your wallet to Ethereum Sepolia". */
  name: string;
  /** Short name for copy, as in "Recorded on Sepolia". */
  shortName: string;
  explorer: string | null;
  /** Network prefix in Safe app links, as in "safe=sep:0x…". */
  safePrefix: string | null;
  /** Public RPC used when NEXT_PUBLIC_RPC_URL is unset. */
  rpc: string;
  history: FullHistory | null;
  /** The viem chain. @reown/appkit/networks re-exports these same objects, so it is also the AppKit network. */
  chain: Chain;
  /** Alchemy NFT API subdomain for wallet NFT discovery. */
  nftApiHost: string | null;
};

export const NETWORKS: Readonly<Record<SupportedChainId, Network>> = {
  1: {
    name: "Ethereum",
    shortName: "Ethereum",
    explorer: "https://etherscan.io",
    safePrefix: "eth",
    rpc: "https://ethereum-rpc.publicnode.com",
    // publicnode answers older log ranges with HTTP 403 and this message; this public gateway keeps all of mainnet.
    history: { rpc: "https://mainnet.gateway.tenderly.co", refusal: /archive requests require a personal token/i },
    chain: mainnet,
    nftApiHost: "eth-mainnet"
  },
  11155111: {
    name: "Ethereum Sepolia",
    shortName: "Sepolia",
    explorer: "https://sepolia.etherscan.io",
    safePrefix: "sep",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    // publicnode's US servers keep only about 25,000 blocks of logs ("pruned history unavailable"); this public gateway keeps all of Sepolia.
    history: { rpc: "https://sepolia.gateway.tenderly.co", refusal: /pruned history/i },
    chain: sepolia,
    nftApiHost: "eth-sepolia"
  },
  31337: {
    name: "Isolated local chain",
    shortName: "the local chain",
    explorer: null,
    safePrefix: null,
    rpc: "http://127.0.0.1:8545",
    history: null,
    chain: foundry,
    nftApiHost: null
  }
};

export function isSupportedChainId(value: unknown): value is SupportedChainId {
  return value === 1 || value === 11155111 || value === 31337;
}

/** Whether a decimal string, as stored commitments carry their chain, is exactly a supported chain ID. */
export function isSupportedChainText(value: string): boolean {
  return isSupportedChainId(Number(value)) && String(Number(value)) === value;
}

/** The public chain a NEXT_PUBLIC_CHAIN_ID value names exactly, or null. */
export function publicChainId(value: string | undefined): PublicChainId | null {
  return value === "1" ? 1 : value === "11155111" ? 11155111 : null;
}

/**
 * The chain this build serves. NEXT_PUBLIC_CHAIN_ID=1 selects Ethereum; any other value, or none, keeps Sepolia as before
 * mainnet support. A deployment is still selected only when it is registered on exactly this chain.
 */
export function configuredChainId(): PublicChainId {
  return publicChainId(process.env.NEXT_PUBLIC_CHAIN_ID) ?? 11155111;
}

/** The display name of a chain, or its number when LABx does not support it. */
export function chainName(chainId: number): string {
  return isSupportedChainId(chainId) ? NETWORKS[chainId].name : `Chain ${chainId}`;
}

export function explorerAddress(chainId: number, address: string): string | null {
  const explorer = isSupportedChainId(chainId) ? NETWORKS[chainId].explorer : null;
  return explorer && `${explorer}/address/${address}`;
}

export function explorerToken(chainId: number, address: string, tokenId: bigint): string | null {
  const explorer = isSupportedChainId(chainId) ? NETWORKS[chainId].explorer : null;
  return explorer && `${explorer}/token/${address}?a=${tokenId.toString()}`;
}

export function safeQueue(chainId: number, safe: string): string | null {
  const prefix = isSupportedChainId(chainId) ? NETWORKS[chainId].safePrefix : null;
  return prefix && `https://app.safe.global/transactions/queue?safe=${prefix}:${safe}`;
}
