import {
  BaseError, decodeFunctionResult, encodeFunctionData, ExecutionRevertedError, keccak256, parseAbi, zeroAddress,
  type Address, type Hex, type PrivateKeyAccount, type PublicClient
} from "viem";
import { raffleAbi } from "../chain/abi";
import { actionBuilder } from "../chain/actions";
import { createReader } from "../chain/reader";
import { sameAddress } from "../chain/validation";
import type { DeploymentManifest } from "../chain/types";
import { mayNeedRunner, scanRaffles } from "./decide";
import { broadcastRefused, errorCategory, within } from "./errors";
import type { DrawChain } from "./run";

/** Safe's module list starts and ends at this sentinel. */
export const SAFE_SENTINEL: Address = "0x0000000000000000000000000000000000000001";
const SAFE_MODULE_PAGE = 50n;
/** The base addresses are depth 0. Owners and modules of a contract at depth 0 or 1 are read; addresses at depth 2 are listed but not expanded. */
const SAFE_DEPTH = 2;
const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)"
]);

type Client = Pick<PublicClient, "readContract" | "getCode" | "call">;
const EIP7702_MARKER = /^0xef0100[0-9a-f]{40}$/i;

/**
 * Addresses the runner key must never belong to: the owner, pending owner, expected owner, current and pinned treasury,
 * and the Safe owners and modules of any of them that has code, two levels down. Throws when a read gets no answer,
 * when a contract without an EIP-7702 marker is not a readable Safe, or when a module list does not fit in one page.
 */
export async function privilegedAddresses(client: Client, manifest: DeploymentManifest, blockNumber: bigint): Promise<Address[]> {
  const base = { address: manifest.address, abi: raffleAbi, blockNumber } as const;
  const [owner, pendingOwner, treasury] = await Promise.all([
    client.readContract({ ...base, functionName: "owner" }),
    client.readContract({ ...base, functionName: "pendingOwner" }),
    client.readContract({ ...base, functionName: "treasury" })
  ]);
  const found: Address[] = [];
  let level: readonly Address[] = [owner, pendingOwner, manifest.expectedOwner, treasury, manifest.expectedPolicy.treasury];
  for (let depth = 0; ; depth++) {
    const fresh: Address[] = [];
    for (const candidate of level) {
      if (!sameAddress(candidate, zeroAddress) && ![...found, ...fresh].some(item => sameAddress(item, candidate))) fresh.push(candidate);
    }
    found.push(...fresh);
    if (depth === SAFE_DEPTH) return found;
    level = (await Promise.all(fresh.map(candidate => safeControllers(client, candidate, blockNumber)))).flat();
  }
}

/**
 * Owners and modules of an address with code. A plain contract must answer both Safe calls. An account with an
 * EIP-7702 delegation marker runs its delegate's code, which may be a multisig or a module-enabled account, so it is
 * asked too: every list it answers is added, and it counts as a wallet controlled by its own key only when neither
 * call answers with data that decodes. An address without code has no controllers to add.
 */
async function safeControllers(client: Client, address: Address, blockNumber: bigint): Promise<readonly Address[]> {
  const code = await client.getCode({ address, blockNumber });
  if (!code || code === "0x") return [];
  const [owners, modules] = await Promise.all([
    safeCall(client, address, blockNumber, encodeFunctionData({ abi: safeAbi, functionName: "getOwners" }),
      data => decodeFunctionResult({ abi: safeAbi, functionName: "getOwners", data })),
    safeCall(client, address, blockNumber, encodeFunctionData({ abi: safeAbi, functionName: "getModulesPaginated", args: [SAFE_SENTINEL, SAFE_MODULE_PAGE] }),
      data => decodeFunctionResult({ abi: safeAbi, functionName: "getModulesPaginated", data }))
  ]);
  if ((!owners || !modules) && !EIP7702_MARKER.test(code)) throw new Error("A contract is not a readable Safe.");
  if (modules && !sameAddress(modules[1], SAFE_SENTINEL) && !sameAddress(modules[1], zeroAddress)) throw new Error("A Safe has more modules than the runner reads.");
  return [...owners ?? [], ...modules?.[0] ?? []];
}

/**
 * One Safe read. Null when the node says the call reverted, or its result is empty or does not decode. Throws when
 * the node gives no answer or another error, so a failed read never makes an account look like a wallet.
 */
async function safeCall<T>(client: Client, address: Address, blockNumber: bigint, data: Hex, decode: (result: Hex) => T): Promise<T | null> {
  let result: Hex | undefined;
  try {
    ({ data: result } = await client.call({ to: address, data, blockNumber }));
  } catch (error) {
    if (error instanceof BaseError && error.walk(cause => cause instanceof ExecutionRevertedError)) return null;
    throw error;
  }
  try {
    return decode(result ?? "0x");
  } catch {
    return null;
  }
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
    async scan(cursor, limit, timeoutMs) {
      const at = await reader.checkedBlock();
      const base = { address: manifest.address, abi: raffleAbi, blockNumber: at.number } as const;
      const [nextId, drawStartGrace, revealGrace] = await Promise.all([
        client.readContract({ ...base, functionName: "nextId" }),
        client.readContract({ ...base, functionName: "DRAW_START_GRACE" }),
        client.readContract({ ...base, functionName: "REVEAL_GRACE" })
      ]);
      const result = await scanRaffles({
        cursor, nextId, limit, timeoutMs,
        read: id => client.readContract({ ...base, functionName: "getRaffle", args: [id] }),
        keep: raffle => mayNeedRunner(raffle, { now: at.timestamp, drawStartGrace, revealGrace })
      });
      await reader.checkedBlock(at);
      return result;
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
    async quote(prepared) {
      const [fees, gas] = await Promise.all([
        client.estimateFeesPerGas(),
        client.estimateGas({ account: runner, to: prepared.to, data: prepared.data, value: 0n })
      ]);
      return { gasLimit: gas * 6n / 5n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    },
    async send(prepared, nonce, quote, timeoutMs) {
      const serializedTransaction = await account.signTransaction({
        type: "eip1559", chainId: manifest.chainId, to: prepared.to, data: prepared.data, value: 0n, nonce,
        gas: quote.gasLimit, maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas
      });
      const hash = keccak256(serializedTransaction);
      try {
        await within(client.sendRawTransaction({ serializedTransaction }), timeoutMs);
        return { kind: "sent", hash };
      } catch (error) {
        return broadcastRefused(error) ? { kind: "refused", error: errorCategory(error) } : { kind: "unknown", hash, error: errorCategory(error) };
      }
    },
    async wait(hash, timeoutMs) {
      const receipt = await within(client.waitForTransactionReceipt({ hash, timeout: timeoutMs }), timeoutMs);
      return receipt.status === "success" ? "succeeded" : "reverted";
    }
  };
}
