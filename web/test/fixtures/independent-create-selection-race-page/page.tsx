"use client";

import { useEffect, useMemo, useRef } from "react";
import { SellerDraftForm, type SaveCommitment } from "@/components/workflow/SellerDraftForm";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { WalletSnapshot } from "@/lib/chain/types";
import type { Address } from "viem";

const SELLER = "0x1111111111111111111111111111111111111111" as Address;

declare global {
  interface Window {
    __independentResolveOwner?: () => void;
    __independentReleasePreparation?: () => void;
    __independentPreparationStarted?: boolean;
  }
}

function walletFixture(): WalletSessionPort {
  const snapshot: WalletSnapshot = { kind: "connected", account: SELLER, chainId: 11155111, revision: 1 };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    connect: async () => snapshot,
    refresh: async () => snapshot,
    disconnect: () => undefined,
    assertCurrent: async expected => {
      if (expected.kind !== "connected" || expected.account !== SELLER || expected.chainId !== 11155111 || expected.revision !== 1) throw new Error("stale wallet");
    },
    requestTransaction: async () => { throw new Error("unexpected transaction"); },
    signMessage: async () => { throw new Error("unexpected signature"); }
  };
}

export default function IndependentCreateSelectionRacePage() {
  const wallet = useMemo(walletFixture, []);
  const ownerRelease = useRef<(() => void) | null>(null);
  const preparationRelease = useRef<(() => void) | null>(null);
  const service = useMemo(() => ({
    manifest: {
      chainId: 11155111,
      address: "0x2222222222222222222222222222222222222222",
      runtimeCodeHash: `0x${"a".repeat(64)}`
    },
    pending: async () => false,
    readNftOwner: async () => {
      await new Promise<void>(resolve => { ownerRelease.current = resolve; });
      return { owner: SELLER, block: { number: 1n, hash: `0x${"b".repeat(64)}`, timestamp: 1n } };
    }
  }) as unknown as RaffleService, []);
  const saveCommitment: SaveCommitment = async (input, options) => {
    window.__independentPreparationStarted = true;
    await new Promise<void>(resolve => { preparationRelease.current = resolve; });
    options?.assertIntent();
    return {
      nft: input.nft,
      tokenId: input.tokenId,
      seller: SELLER,
      labx: service.manifest.address,
      chainId: String(service.manifest.chainId),
      publicSummary: input.publicSummary,
      nonce: `0x${"c".repeat(64)}`,
      commit: `0x${"d".repeat(64)}`
    } as Awaited<ReturnType<SaveCommitment>>;
  };
  useEffect(() => {
    window.__independentResolveOwner = () => ownerRelease.current?.();
    window.__independentReleasePreparation = () => preparationRelease.current?.();
    return () => {
      delete window.__independentResolveOwner;
      delete window.__independentReleasePreparation;
      delete window.__independentPreparationStarted;
    };
  }, []);
  return <main className="section"><section aria-label="Create selection race"><SellerDraftForm service={service} wallet={wallet} saveCommitment={saveCommitment} /></section></main>;
}
