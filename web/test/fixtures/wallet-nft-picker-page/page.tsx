"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SellerDraftForm } from "@/components/workflow/SellerDraftForm";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { RaffleSnapshot, WalletSnapshot } from "@/lib/chain/types";
import type { Address } from "viem";

const SELLER = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x9999999999999999999999999999999999999999" as Address;
const OLD_NFT = "0x4444444444444444444444444444444444444444" as Address;

declare global {
  interface Window {
    __verifyResolveNextOwner?: (owner?: Address) => void;
    __verifySetEscrowed?: (locked: boolean) => void;
  }
}

function fakeWallet(): WalletSessionPort {
  const snapshot: WalletSnapshot = { kind: "connected", account: SELLER, chainId: 11155111, revision: 1 };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    connect: async () => snapshot,
    refresh: async () => snapshot,
    disconnect: () => undefined,
    assertCurrent: async expected => {
      if (expected.account !== SELLER || expected.chainId !== 11155111 || expected.revision !== 1) throw new Error("stale-wallet");
    },
    requestTransaction: async () => { throw new Error("unexpected transaction"); },
    signMessage: async () => { throw new Error("unexpected signature"); }
  };
}

function existingSnapshot(escrowed: boolean): RaffleSnapshot {
  return {
    raffle: {
      nft: OLD_NFT,
      tokenId: 9n,
      title: "Existing title",
      salesEnd: 4_102_444_800n,
      escrowed,
      reserveNonce: `0x${"1".repeat(64)}`,
      reserveCommit: `0x${"2".repeat(64)}`
    },
    packs: [{ name: "Existing membership", priceUsdc: 1_000_000n, bonusEntries: 1, maxSupply: 10 }]
  } as unknown as RaffleSnapshot;
}

export default function VerifyPickerPage() {
  const [escrowed, setEscrowed] = useState(false);
  const wallet = useMemo(fakeWallet, []);
  const pending = useRef<Array<(owner: Address) => void>>([]);
  const service = useMemo(() => {
    return {
      manifest: { chainId: 11155111 },
      readNftOwner: async ({ tokenId }: { tokenId: bigint }) => {
        if (tokenId === 2n) return { owner: OTHER, block: { number: 1n, hash: `0x${"a".repeat(64)}`, timestamp: 1n } };
        if (tokenId === 3n) {
          const owner = await new Promise<Address>(resolve => pending.current.push(resolve));
          return { owner, block: { number: 1n, hash: `0x${"a".repeat(64)}`, timestamp: 1n } };
        }
        return { owner: SELLER, block: { number: 1n, hash: `0x${"a".repeat(64)}`, timestamp: 1n } };
      }
    } as unknown as RaffleService;
  }, []);
  useEffect(() => {
    window.__verifyResolveNextOwner = (owner = SELLER) => pending.current.shift()?.(owner);
    window.__verifySetEscrowed = setEscrowed;
    return () => { delete window.__verifyResolveNextOwner; delete window.__verifySetEscrowed; };
  }, []);
  const saveCommitment = async () => { throw new Error("unexpected save"); };
  return <main className="section stack page-frame">
    <section aria-label="New draft picker"><h1 className="page-title">Picker verification</h1><SellerDraftForm service={service} wallet={wallet} saveCommitment={saveCommitment} /></section>
    <section aria-label="Existing draft picker"><h2>Existing draft</h2><SellerDraftForm service={service} wallet={wallet} saveCommitment={saveCommitment} existing={existingSnapshot(escrowed)} /></section>
  </main>;
}
