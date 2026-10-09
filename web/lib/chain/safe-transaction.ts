import { encodeFunctionData, getAddress, isAddress, isHex, keccak256, toBytes, type Address, type Hex } from "viem";
import { raffleAbi } from "./abi";
import type { DeploymentManifest, OwnerExecutionIntent } from "./types";
import { positiveId, sameAddress } from "./validation";

type SafeTransaction = { to: Address; value: "0"; data: Hex };
type SafeTransactionMeta = {
  name: string;
  description: string;
  txBuilderVersion: "2.0.1";
  createdFromSafeAddress: Address;
  createdFromOwnerAddress: "";
  checksum: Hex;
};

export type SafeTransactionBatch = {
  version: "1.0";
  chainId: string;
  createdAt: number;
  meta: SafeTransactionMeta;
  transactions: [SafeTransaction];
};

export type SafeTransactionFile = {
  filename: string;
  content: string;
  batch: SafeTransactionBatch;
};

function object(value: unknown, message = "Invalid Safe Transaction Builder file."): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return Object.fromEntries(Object.entries(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("Safe transaction file contains unsupported fields.");
}

function canonicalHex(value: unknown, bytes?: number): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || bytes !== undefined && value.length !== 2 + bytes * 2) throw new Error("Safe transaction file contains invalid hex data.");
  return `0x${value.slice(2).toLowerCase()}`;
}

function exactCalldata(intent: OwnerExecutionIntent): Hex {
  positiveId(intent.action.id);
  canonicalHex(intent.action.expectedReviewHash, 32);
  if (intent.action.kind === "approveRaffle") {
    const attestations = intent.action.attestations;
    if (!attestations.canonicalProvenance || !attestations.transferRestrictions || !attestations.drawFunding) throw new Error("Owner approval attestations are incomplete.");
  } else if (intent.action.kind !== "revokeRaffleApproval") throw new Error("Unsupported owner action.");
  return encodeFunctionData({ abi: raffleAbi, functionName: intent.action.kind, args: [intent.action.id, intent.action.expectedReviewHash] });
}

function validateIntent(intent: OwnerExecutionIntent, manifest: DeploymentManifest): Hex {
  const data = exactCalldata(intent);
  if (intent.chainId !== manifest.chainId || !sameAddress(intent.to, manifest.address) || intent.value !== 0n
    || canonicalHex(intent.runtimeCodeHash, 32) !== canonicalHex(manifest.runtimeCodeHash, 32)
    || !isAddress(intent.from) || /^0x0{40}$/i.test(intent.from)
    || canonicalHex(intent.data) !== canonicalHex(data)) throw new Error("Owner execution intent does not match this Safe transaction file.");
  return data;
}

function serializeChecksumValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(serializeChecksumValue).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort();
    return `{${JSON.stringify(keys)}${keys.map(key => `${serializeChecksumValue(source[key])},`).join("")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function safeTransactionChecksum(batch: Record<string, unknown>): Hex {
  const meta = object(batch.meta);
  const { checksum: _checksum, ...metaWithoutChecksum } = meta;
  const serialized = serializeChecksumValue({ ...batch, meta: { ...metaWithoutChecksum, name: null } });
  return keccak256(toBytes(serialized));
}

export function safeTransactionFile({ intent, manifest, createdAt }: {
  intent: OwnerExecutionIntent;
  manifest: DeploymentManifest;
  createdAt: number;
}): SafeTransactionFile {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("Safe transaction creation time is invalid.");
  const data = validateIntent(intent, manifest);
  const action = intent.action.kind === "approveRaffle" ? "Approve" : "Revoke approval for";
  const digest = canonicalHex(intent.action.expectedReviewHash, 32);
  const withoutChecksum = {
    version: "1.0" as const,
    chainId: manifest.chainId.toString(),
    createdAt,
    meta: {
      name: `LABx ${action.toLowerCase()} raffle #${intent.action.id.toString()} · ${digest}`,
      description: `${action} LABx raffle #${intent.action.id.toString()} for review digest ${digest}. Zero ETH.`,
      txBuilderVersion: "2.0.1" as const,
      createdFromSafeAddress: getAddress(intent.from),
      createdFromOwnerAddress: "" as const
    },
    transactions: [{ to: getAddress(manifest.address), value: "0" as const, data }] as [SafeTransaction]
  };
  const batch: SafeTransactionBatch = {
    ...withoutChecksum,
    meta: { ...withoutChecksum.meta, checksum: safeTransactionChecksum(withoutChecksum) }
  };
  const verb = intent.action.kind === "approveRaffle" ? "approve" : "revoke";
  const filename = `labx-${verb}-raffle-${intent.action.id.toString()}-${digest.slice(2, 14)}.json`;
  return { filename, content: JSON.stringify(batch, null, 2), batch };
}

export function parseSafeTransactionFile(raw: string, { intent, manifest }: {
  intent: OwnerExecutionIntent;
  manifest: DeploymentManifest;
}): SafeTransactionBatch {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 32_768) throw new Error("Invalid Safe Transaction Builder file.");
  const root = object(JSON.parse(raw));
  exactKeys(root, ["version", "chainId", "createdAt", "meta", "transactions"]);
  const meta = object(root.meta);
  exactKeys(meta, ["name", "description", "txBuilderVersion", "createdFromSafeAddress", "createdFromOwnerAddress", "checksum"]);
  if (!Array.isArray(root.transactions) || root.transactions.length !== 1) throw new Error("Safe transaction file must contain exactly one call.");
  const transaction = object(root.transactions[0]);
  exactKeys(transaction, ["to", "value", "data"]);
  const expectedData = validateIntent(intent, manifest);
  if (root.version !== "1.0" || root.chainId !== manifest.chainId.toString()
    || !Number.isSafeInteger(root.createdAt) || (root.createdAt as number) < 0
    || typeof meta.name !== "string" || typeof meta.description !== "string" || meta.txBuilderVersion !== "2.0.1"
    || meta.createdFromOwnerAddress !== "" || typeof meta.createdFromSafeAddress !== "string" || !isAddress(meta.createdFromSafeAddress)
    || !sameAddress(meta.createdFromSafeAddress, intent.from)
    || typeof transaction.to !== "string" || !isAddress(transaction.to) || !sameAddress(transaction.to, manifest.address)
    || transaction.value !== "0" || canonicalHex(transaction.data) !== canonicalHex(expectedData)
    || canonicalHex(meta.checksum, 32) !== canonicalHex(safeTransactionChecksum(root), 32)) throw new Error("Safe transaction file does not match the reviewed owner call.");
  return root as SafeTransactionBatch;
}
