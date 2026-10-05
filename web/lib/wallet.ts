import { createPublicClient, createWalletClient, custom, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import abi from "./LabxRaffle.abi.json";

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_HEX = "0xaa36a7";
export const MAINNET_HEX = "0x1";

export const labxAbi = abi;

export function raffleAddress(): Address | null {
  const value = process.env.NEXT_PUBLIC_RAFFLE_ADDRESS;
  if (!value || !value.startsWith("0x") || value.length !== 42) return null;
  return value as Address;
}

export function onChainReady(): boolean {
  return raffleAddress() !== null;
}

export function rpcUrl(): string {
  return process.env.NEXT_PUBLIC_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
}

export function publicClient() {
  return createPublicClient({ chain: sepolia, transport: http(rpcUrl()) });
}

export async function connectSepolia(): Promise<Address> {
  const ethereum = window.ethereum;
  if (!ethereum) throw new Error("No wallet was found in this browser.");
  const chainId = (await ethereum.request({ method: "eth_chainId" })) as string;
  if (chainId === MAINNET_HEX) throw new Error("Mainnet is disabled. Switch to Sepolia.");
  if (chainId !== SEPOLIA_HEX) {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_HEX }]
    });
  }
  const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("The wallet did not return an account.");
  return accounts[0] as Address;
}

export function walletClient() {
  if (!window.ethereum) throw new Error("No wallet was found in this browser.");
  return createWalletClient({ chain: sepolia, transport: custom(window.ethereum) });
}

export async function readRaffle(id: bigint) {
  const address = raffleAddress();
  if (!address) throw new Error("Sepolia raffle is not wired. NEXT_PUBLIC_RAFFLE_ADDRESS is not set.");
  return publicClient().readContract({ address, abi: labxAbi, functionName: "getRaffle", args: [id] });
}

export async function sendRaffle(functionName: string, args: unknown[], account: Address) {
  const address = raffleAddress();
  if (!address) throw new Error("Sepolia raffle is not wired. NEXT_PUBLIC_RAFFLE_ADDRESS is not set.");
  const hash = await walletClient().writeContract({
    address,
    abi: labxAbi,
    functionName,
    args,
    account,
    chain: sepolia
  } as never);
  return hash as Hex;
}
