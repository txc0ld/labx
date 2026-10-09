"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CompleteCreate } from "@/components/workflow/CompleteCreate";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { RaffleSnapshot, WalletSnapshot } from "@/lib/chain/types";
import type { Address } from "viem";

const SELLER = "0x1111111111111111111111111111111111111111" as Address;
const RAFFLE = "0x2222222222222222222222222222222222222222" as Address;
const NFT = "0x3333333333333333333333333333333333333333" as Address;
const snapshotFixture = (): RaffleSnapshot => ({
  id: 1n,
  raffle: {
    seller: SELLER,
    nft: NFT,
    tokenId: 1n,
    salesEnd: 4_102_444_800n,
    reserveNonce: `0x${"1".repeat(64)}`,
    reserveCommit: `0x${"2".repeat(64)}`,
    title: "Complete Create race",
    phase: 0,
    escrowed: false
  },
  packs: [{ name: "Membership", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 }]
}) as unknown as RaffleSnapshot;

declare global {
  interface Window {
    __independentCompletePrepareStarted?: boolean;
    __independentCompleteRefreshIdentity?: () => void;
    __independentCompleteReleasePrepare?: () => void;
    __independentCompleteSubmitCalls?: number;
  }
}

function walletFixture(): WalletSessionPort {
  const current: WalletSnapshot = { kind: "connected", account: SELLER, chainId: 11155111, revision: 1 };
  return {
    getSnapshot: () => current,
    subscribe: () => () => undefined,
    connect: async () => current,
    refresh: async () => current,
    disconnect: () => undefined,
    assertCurrent: async expected => {
      if (expected.kind !== "connected" || expected.account !== SELLER || expected.revision !== 1) throw new Error("stale wallet");
    },
    requestTransaction: async () => { throw new Error("unexpected wallet request"); },
    signMessage: async () => { throw new Error("unexpected signature"); }
  };
}

export default function IndependentCompleteCreateRacePage() {
  const [snapshot, setSnapshot] = useState(snapshotFixture);
  const releasePrepare = useRef<(() => void) | null>(null);
  const wallet = useMemo(walletFixture, []);
  const service = useMemo(() => ({
    manifest: { chainId: 11155111, address: RAFFLE, runtimeCodeHash: `0x${"a".repeat(64)}` },
    readRaffle: async () => snapshotFixture(),
    readAccount: async () => ({ snapshot: snapshotFixture(), nftApproved: true, nftOwner: SELLER }),
    pending: async () => null,
    prepare: async () => {
      window.__independentCompletePrepareStarted = true;
      await new Promise<void>(resolve => { releasePrepare.current = resolve; });
      return {};
    },
    submit: async () => {
      window.__independentCompleteSubmitCalls = (window.__independentCompleteSubmitCalls ?? 0) + 1;
      throw new Error("A stale operation reached submit.");
    }
  }) as unknown as RaffleService, []);
  useEffect(() => {
    window.__independentCompleteSubmitCalls = 0;
    window.__independentCompleteRefreshIdentity = () => setSnapshot(current => ({ ...current }));
    window.__independentCompleteReleasePrepare = () => releasePrepare.current?.();
    return () => {
      delete window.__independentCompletePrepareStarted;
      delete window.__independentCompleteRefreshIdentity;
      delete window.__independentCompleteReleasePrepare;
      delete window.__independentCompleteSubmitCalls;
    };
  }, []);
  return <main className="section"><CompleteCreate service={service} wallet={wallet} snapshot={snapshot} disabled={false} onConfirmed={async () => {}} /></main>;
}
