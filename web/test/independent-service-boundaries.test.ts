import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { agreementMessage, recordAgreement, type AgreementRequest } from "../lib/agreement-record";
import { browserArtworkMetadata, inlineArtworkMetadata, safeArtworkUrl } from "../lib/chain/metadata";
import { workflowMessage } from "../lib/chain/messages";
import { hash } from "../lib/chain/validation";
import { parseRecordsInput, privateRecords } from "../lib/private-records";
import { PUBLISHED_TERMS_HASH, TERMS_VERSION } from "../lib/published-terms";
import { MemoryStore } from "../lib/store";
import { recoverAuthenticatedCommitment, saveAuthenticatedCommitment } from "../lib/workflow-records";
import type { CommitmentInput, WorkflowContext } from "../lib/chain/api-types";
import type { Store } from "../lib/points";

const now = 1_791_100_000_000;
const seller = privateKeyToAccount(generatePrivateKey());
const outsider = privateKeyToAccount(generatePrivateKey());
const context: WorkflowContext = {
  origin: "https://labx.example",
  chainId: 11155111,
  contract: "0x1111111111111111111111111111111111111111",
  termsHash: PUBLISHED_TERMS_HASH,
  termsVersion: TERMS_VERSION
};
const deadline = String(Math.floor(now / 1000) + 120);
const commitment: CommitmentInput = {
  nft: "0x2222222222222222222222222222222222222222",
  tokenId: "9007199254740993",
  publicSummary: "Bounded public summary",
  privateCommitment: "Private seller material"
};

async function signed<T>(
  operation: Parameters<typeof workflowMessage>[0],
  input: T,
  account = seller,
  scoped = context
) {
  return {
    address: account.address,
    input,
    deadline,
    signature: await account.signMessage({ message: workflowMessage(operation, scoped, account.address, input, deadline) })
  };
}

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("independent authenticated record boundaries", () => {
  it("does not acknowledge failed durable commitment or agreement writes", async () => {
    const unavailable: Store = {
      get: async () => null,
      set: async () => {
        throw new Error("durable store unavailable");
      },
      setIfAbsent: async () => {
        throw new Error("durable store unavailable");
      }
    };
    await expect(
      saveAuthenticatedCommitment(
        unavailable,
        await signed("commitment", commitment),
        context,
        verifyMessage
      )
    ).rejects.toThrow(/durable store unavailable/);

    const agreement: AgreementRequest = {
      address: seller.address,
      pieceId: "1",
      terms: true,
      rules: true,
      age: true,
      termsHash: PUBLISHED_TERMS_HASH,
      deadline,
      signature: "0x"
    };
    agreement.signature = await seller.signMessage({ message: agreementMessage(agreement, context) });
    await expect(recordAgreement(unavailable, agreement, context, now, verifyMessage)).rejects.toThrow(
      /durable store unavailable/
    );
  });

  it("keeps private records wallet-bound, integrity-checked and selection-bounded", async () => {
    const store = new MemoryStore();
    const created = await saveAuthenticatedCommitment(
      store,
      await signed("commitment", commitment),
      context,
      verifyMessage
    );
    expect(await store.get(`reserve:${created.commit}`)).not.toContain(commitment.privateCommitment);
    await expect(
      recoverAuthenticatedCommitment(
        store,
        await signed("commitment recovery", { commit: created.commit }, outsider),
        context,
        verifyMessage
      )
    ).rejects.toThrow(/does not belong/);

    const agreement: AgreementRequest = {
      address: seller.address,
      pieceId: "9007199254740993",
      terms: true,
      rules: true,
      age: true,
      termsHash: PUBLISHED_TERMS_HASH,
      deadline,
      signature: "0x"
    };
    agreement.signature = await seller.signMessage({ message: agreementMessage(agreement, context) });
    const saved = await recordAgreement(store, agreement, context, now, verifyMessage);
    const selection = { raffleIds: [agreement.pieceId], purchases: [] };
    expect(
      await privateRecords(store, await signed("private records", selection), context, verifyMessage)
    ).toMatchObject({ agreements: [{ raffleId: agreement.pieceId, recorded: true }] });
    expect(
      await privateRecords(
        store,
        await signed("private records", selection, outsider),
        context,
        verifyMessage
      )
    ).toMatchObject({ agreements: [{ raffleId: agreement.pieceId, recorded: false }] });

    await store.set(saved.key, "{\"version\":2}");
    await expect(
      privateRecords(store, await signed("private records", selection), context, verifyMessage)
    ).rejects.toThrow(/invalid/);
    expect(() => parseRecordsInput({ raffleIds: Array.from({ length: 31 }, (_, index) => String(index + 1)), purchases: [] })).toThrow(
      /selection/
    );
    expect(() =>
      parseRecordsInput({
        raffleIds: [],
        purchases: [{ transactionHash: hash(`0x${"ab".repeat(32)}`), logIndex: Number.MAX_SAFE_INTEGER + 1 }]
      })
    ).toThrow(/identity/);
  });
});

describe("independent metadata and fetch bounds", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://example.com/art.png",
    "https://127.1/art.png",
    "https://0x7f000001/art.png",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/art.png",
    "https://user:pass@example.com/art.png",
    "https://example.com:444/art.png",
    "https://metadata.internal/art.png"
  ])("rejects unsafe metadata target %s", target => {
    expect(safeArtworkUrl(target)).toBeNull();
  });

  it("bounds inline and remote metadata and sends no ambient credentials", async () => {
    const oversizedInline = `data:application/json,${encodeURIComponent(
      JSON.stringify({ image: "https://example.com/a.png", description: "x".repeat(70_000) })
    )}`;
    expect(inlineArtworkMetadata(oversizedInline)).toBeNull();

    vi.stubGlobal("window", {});
    const remote = new Response(new Uint8Array(65_537), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    const fetchMock = vi.fn(async () => remote);
    vi.stubGlobal("fetch", fetchMock);
    await expect(browserArtworkMetadata("https://example.com/metadata.json")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/metadata.json",
      expect.objectContaining({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" })
    );
  });
});
