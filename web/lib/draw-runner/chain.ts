import { keccak256, parseAbi, parseGwei, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import { raffleAbi } from "../chain/abi";
import { actionBuilder } from "../chain/actions";
import { createReader } from "../chain/reader";
import { sameAddress } from "../chain/validation";
import type { DeploymentManifest } from "../chain/types";
import { mayNeedRunner, scanWindow } from "./decide";
import type { DrawChain } from "./run";

export const MAX_FEE_PER_GAS = parseGwei("50");
const safeAbi = parseAbi(["function getOwners() view returns (address[])"]);

type Client = Pick<PublicClient, "readContract" | "getCode">;

/** Addresses the runner key must never belong to. Throws when a Safe owner list cannot be read. */
export async function privilegedAddresses(client: Client, manifest: DeploymentManifest, blockNumber: bigint): Promise<Address[]> {
  const base = { address: manifest.address, abi: raffleAbi, blockNumber } as const;
  const [owner, treasury] = await Promise.all([
    client.readContract({ ...base, functionName: "owner" }),
    client.readContract({ ...base, functionName: "treasury" })
  ]);
  const result: Address[] = [owner, manifest.expectedOwner, treasury, manifest.expectedPolicy.treasury];
  for (const candidate of sameAddress(owner, manifest.expectedOwner) ? [owner] : [owner, manifest.expectedOwner]) {
    const code = await client.getCode({ address: candidate, blockNumber });
    if (code && code !== "0x") result.push(...await client.readContract({ address: candidate, abi: safeAbi, functionName: "getOwners", blockNumber }));
  }
  return result;
}

export function createDrawChain({ client, manifest, account }: { client: PublicClient; manifest: DeploymentManifest; account: PrivateKeyAccount }): DrawChain {
  const reader = createReader(client, manifest), build = actionBuilder(client, manifest, reader);
  const runner = account.address;
  const session = { kind: "connected", account: runner, chainId: manifest.chainId, revision: 0 } as const;
  return {
    runner,
    contract: manifest.address,
    async privilegedAddresses() {
      const at = await reader.checkedBlock();
      const result = await privilegedAddresses(client, manifest, at.number);
      await reader.checkedBlock(at);
      return result;
    },
    async scan(cursor, limit) {
      const at = await reader.checkedBlock();
      const base = { address: manifest.address, abi: raffleAbi, blockNumber: at.number } as const;
      const [nextId, drawStartGrace, revealGrace] = await Promise.all([
        client.readContract({ ...base, functionName: "nextId" }),
        client.readContract({ ...base, functionName: "DRAW_START_GRACE" }),
        client.readContract({ ...base, functionName: "REVEAL_GRACE" })
      ]);
      const window = scanWindow(cursor, nextId, limit);
      const raffles = await Promise.all(window.ids.map(id => client.readContract({ ...base, functionName: "getRaffle", args: [id] })));
      await reader.checkedBlock(at);
      const candidates = window.ids.filter((_, index) => mayNeedRunner(raffles[index], { now: at.timestamp, drawStartGrace, revealGrace }));
      return { candidates, nextCursor: window.nextCursor };
    },
    read: id => reader.readRaffle({ id }),
    prepare: action => build(action, session),
    balance: () => client.getBalance({ address: runner }),
    async nonces() {
      const [latest, pending] = await Promise.all([
        client.getTransactionCount({ address: runner, blockTag: "latest" }),
        client.getTransactionCount({ address: runner, blockTag: "pending" })
      ]);
      return { latest, pending };
    },
    async send(prepared, nonce) {
      let hash: Hex | null = null;
      try {
        const fees = await client.estimateFeesPerGas();
        if (fees.maxFeePerGas > MAX_FEE_PER_GAS) return { kind: "fee-cap" };
        const gas = await client.estimateGas({ account: runner, to: prepared.to, data: prepared.data, value: 0n });
        const signed = await account.signTransaction({
          type: "eip1559", chainId: manifest.chainId, to: prepared.to, data: prepared.data, value: 0n, nonce,
          gas: gas * 6n / 5n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas
        });
        hash = keccak256(signed);
        await client.sendRawTransaction({ serializedTransaction: signed });
        return { kind: "sent", hash };
      } catch {
        return { kind: "failed", hash };
      }
    },
    async wait(hash, timeoutMs) {
      if (timeoutMs <= 0) return "pending";
      try {
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
        return receipt.status === "success" ? "succeeded" : "reverted";
      } catch {
        return "pending";
      }
    }
  };
}
