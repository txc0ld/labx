"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { keccak256, toBytes, type Address } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { DEMO_ADDRESS, LAB_FEE, SEED_PIECES, type Entry, type PackName, type Piece } from "./seed";
import { pickWinner, snapshotLots } from "./draw";
import { receiptMessage } from "./email";
import { saltedPrivateHash } from "./reserve";
import { connectSepolia, onChainReady } from "./wallet";
import { pieceView } from "./piece-view";

type Agreement = { pieceId: string; at: string; terms: boolean; rules: boolean; age: boolean };
type State = {
  pieces: Piece[];
  entries: Entry[];
  wallet: string;
  email: string;
  agreements: Agreement[];
  banner?: { tone: "warning" | "error" | "ok"; text: string };
};

type BuyInput = { pieceId: string; pack: PackName; qty: number; terms: boolean; rules: boolean; age: boolean };

const KEY = "labx-bench-v1";
const BenchContext = createContext<Bench | null>(null);

export type Bench = State & {
  ready: boolean;
  address: string;
  buy: (input: BuyInput) => string | null;
  createPiece: (input: {
    title: string;
    publicSummary: string;
    privateCommitment: string;
    salesEnd: string;
    nft: string;
    tokenId: string;
  }) => Promise<string | null>;
  mark: (id: string, action: "escrow" | "open" | "close" | "snapshot" | "draw" | "reveal" | "settle" | "cancel" | "claim") => string | null;
  saveEmail: (email: string, piece: string, pack: string, entries: number, priceUsdc: number) => Promise<string | null>;
  connect: () => Promise<void>;
  useBenchWallet: () => void;
  recordComplimentary: (pieceId: string) => void;
  clearBanner: () => void;
};

function initial(): State {
  return { pieces: SEED_PIECES, entries: [], wallet: "", email: "", agreements: [] };
}

export function BenchProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(initial);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as State;
        parsed.pieces = (parsed.pieces || []).map((piece) => {
          const { salt: _salt, privateHash: _privateHash, ...rest } = piece as Piece & { salt?: string; privateHash?: string };
          void _salt;
          void _privateHash;
          const mark = rest.mark ?? (rest.id.includes("cable") ? "cable" : rest.id.includes("filter") ? "filter" : rest.id.includes("terminal") ? "terminal" : "junction");
          return { ...rest, mark };
        });
        setState({ ...initial(), ...parsed });
      }
    } catch {
      /* keep seed */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(KEY, JSON.stringify(state));
  }, [state, ready]);

  const api = useMemo<Bench>(() => {
    const address = state.wallet || DEMO_ADDRESS;
    return {
      ...state,
      ready,
      address,
      clearBanner: () => setState((current) => ({ ...current, banner: undefined })),
      useBenchWallet: () => setState((current) => ({ ...current, wallet: DEMO_ADDRESS, banner: { tone: "ok", text: "Bench wallet selected." } })),
      connect: async () => {
        try {
          const account = await connectSepolia();
          setState((current) => ({ ...current, wallet: account, banner: { tone: "ok", text: "Sepolia wallet connected." } }));
        } catch (error) {
          const text = error instanceof Error ? error.message : "Wallet connection failed.";
          setState((current) => ({ ...current, banner: { tone: "error", text } }));
        }
      },
      buy: (input) => {
        if (!input.terms || !input.rules || !input.age) return "All three agreements are required.";
        const offered = state.pieces.find((piece) => piece.id === input.pieceId);
        if (!offered || !pieceView(offered, Date.now()).isOpen) return "That pack is not open.";
        let message: string | null = null;
        setState((current) => {
          const pieces = current.pieces.map((piece) => ({ ...piece, packs: piece.packs.map((pack) => ({ ...pack })) }));
          const piece = pieces.find((item) => item.id === input.pieceId);
          const pack = piece?.packs.find((item) => item.name === input.pack);
          if (!piece || !pieceView(piece, Date.now()).isOpen || !pack) {
            message = "That pack is not open.";
            return current;
          }
          if (pack.remaining < input.qty) {
            message = "That pack is fully allocated.";
            return current;
          }
          pack.remaining -= input.qty;
          const entry: Entry = {
            id: `${piece.id}-${Date.now()}`,
            pieceId: piece.id,
            pieceTitle: piece.title,
            label: pack.name,
            count: pack.bonusEntries * input.qty,
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            kind: "pack",
            address
          };
          void fetch("/api/agreements", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address, pieceId: piece.id, terms: true, rules: true, age: true })
          });
          return {
            ...current,
            pieces,
            entries: [entry, ...current.entries],
            agreements: [{ pieceId: piece.id, at: new Date().toISOString(), terms: true, rules: true, age: true }, ...current.agreements],
            banner: { tone: "ok", text: `${pack.name} pack recorded. ${entry.count} bonus ${entry.count === 1 ? "entry" : "entries"}. Lab fee ${LAB_FEE * input.qty} USDC.` }
          };
        });
        return message;
      },
      createPiece: async (input) => {
        if (!input.title.trim() || !input.privateCommitment.trim()) return "Title and private commitment are required.";
        const wired = onChainReady();
        const benchSalt = keccak256(toBytes(generatePrivateKey()));
        let commit = saltedPrivateHash(benchSalt, input.privateCommitment.trim());
        let nonce: string | undefined;
        let publicHash: string | undefined;
        let publicSummary = input.publicSummary;
        if (wired) {
          const response = await fetch("/api/reserve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              seller: address,
              nft: input.nft,
              tokenId: input.tokenId,
              publicSummary: input.publicSummary,
              privateCommitment: input.privateCommitment
            })
          });
          const body = await response.json();
          if (!response.ok) return body.error || "Commitment was refused.";
          commit = body.commit;
          nonce = body.nonce;
          publicHash = body.publicHash;
          publicSummary = body.publicSummary;
        }
        const piece: Piece = {
          id: `piece-${Date.now()}`,
          title: input.title.trim(),
          artist: "Studio",
          mark: "filter",
          image: "/lab/filter-panel.jpg",
          imageAlt: "Glossy filter panel chosen for a new studio piece",
          phase: "draft",
          escrowed: false,
          salesEnd: input.salesEnd,
          packs: SEED_PIECES[0].packs.map((pack) => ({ ...pack, remaining: pack.supply })),
          commit,
          nonce,
          publicHash,
          publicSummary,
          nft: input.nft,
          tokenId: input.tokenId
        };
        setState((current) => ({
          ...current,
          pieces: [piece, ...current.pieces],
          banner: wired
            ? { tone: "ok", text: "Private commitment stored. Only the hash is public." }
            : { tone: "warning", text: "Sepolia contract is not wired. This commit stays on this bench." }
        }));
        return null;
      },
      mark: (id, action) => {
        const existing = state.pieces.find((item) => item.id === id);
        if (!existing) return "That piece is not on the bench.";
        if (action === "open" && !existing.escrowed) return "Escrow the piece first.";
        if (action === "draw") {
          const extra = existing as Piece & { holders?: { address: string }[] };
          if (existing.phase !== "closed" || !extra.holders || !existing.snapshotTotal) {
            return "Snapshot the closed piece before the draw.";
          }
        }
        if (action === "reveal" && !existing.commit) return "This piece has no commitment yet.";
        if (action === "settle" && existing.phase === "drawn" && !existing.revealed) {
          return "Reveal the commitment before settlement.";
        }
        if (action === "claim" && !(existing.escrowed && (existing.phase === "settled" || existing.phase === "cancelled"))) {
          return "Claim the piece after settlement or cancellation.";
        }
        setState((current) => {
          const pieces = current.pieces.map((piece) => ({ ...piece }));
          const piece = pieces.find((item) => item.id === id);
          if (!piece) return current;
          if (action === "escrow") piece.escrowed = true;
          if (action === "open") {
            if (!piece.escrowed) return current;
            piece.phase = "open";
          }
          if (action === "close" && piece.phase === "open") piece.phase = "closed";
          if (action === "snapshot" && piece.phase === "closed") {
            const lots = current.entries
              .filter((entry) => entry.pieceId === id)
              .map((entry) => ({ address: entry.address, weight: entry.count, expiresAt: Date.parse(entry.expiresAt) }));
            const snap = snapshotLots(lots, Date.now());
            piece.snapshotTotal = snap.total;
            piece.vrfNote = "Snapshot frozen. Demonstration draw uses the same cumulative weights as the contract.";
            (piece as Piece & { cumulative?: number[]; holders?: { address: string; weight: number }[] }).cumulative = snap.cumulative;
            (piece as Piece & { holders?: { address: string; weight: number }[] }).holders = snap.holders;
          }
          if (action === "draw") {
            const extra = piece as Piece & { cumulative?: number[]; holders?: { address: string; weight: number }[] };
            if (!extra.holders || !extra.cumulative || !piece.snapshotTotal) return current;
            const word = BigInt(Date.now());
            piece.randomWord = word.toString();
            piece.winner = pickWinner(extra.cumulative, extra.holders, word);
            piece.phase = "drawn";
            piece.vrfNote = "Demonstration result. Sepolia asks Chainlink VRF v2.5 only after this snapshot.";
          }
          if (action === "reveal" && piece.commit) piece.revealed = true;
          if (action === "settle" && piece.phase === "drawn" && piece.revealed) {
            piece.phase = "settled";
          }
          if (action === "cancel" && piece.phase !== "settled" && piece.phase !== "cancelled") {
            piece.phase = "cancelled";
          }
          if (action === "claim" && piece.escrowed && (piece.phase === "settled" || piece.phase === "cancelled")) {
            piece.escrowed = false;
          }
          return { ...current, pieces, banner: { tone: "ok", text: `${piece.title} updated.` } };
        });
        return null;
      },
      saveEmail: async (email, piece, pack, entries, priceUsdc) => {
        setState((current) => ({ ...current, email }));
        if (!state.wallet || state.wallet.toLowerCase() === DEMO_ADDRESS.toLowerCase()) {
          return "A Sepolia wallet signature is required before a receipt can be sent.";
        }
        const provider = window.ethereum;
        if (!provider) return "A Sepolia wallet signature is required before a receipt can be sent.";
        const deadline = BigInt(Math.trunc(Date.now() / 1000) + 10 * 60);
        const message = receiptMessage(state.wallet as Address, email, piece, pack, deadline);
        let signature: string;
        try {
          signature = (await provider.request({
            method: "personal_sign",
            params: [message, state.wallet]
          })) as string;
        } catch {
          return "The wallet refused the receipt signature.";
        }
        const response = await fetch("/api/email/receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: state.wallet,
            signature,
            deadline: deadline.toString(),
            to: email,
            piece,
            pack,
            entries,
            priceUsdc,
            feeUsdc: LAB_FEE
          })
        });
        const body = await response.json();
        if (!response.ok) return body.error || "Email was refused.";
        if (!body.delivered) return body.reason || "Receipt was not delivered.";
        return null;
      },
      recordComplimentary: (pieceId) => {
        const piece = state.pieces.find((item) => item.id === pieceId);
        if (!piece) return;
        const entry: Entry = {
          id: `amoe-${Date.now()}`,
          pieceId,
          pieceTitle: piece.title,
          label: "Complimentary",
          count: 1,
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          kind: "complimentary",
          address
        };
        setState((current) => ({
          ...current,
          entries: [entry, ...current.entries],
          banner: { tone: "ok", text: "Complimentary entry recorded on the bench." }
        }));
      }
    };
  }, [state, ready]);

  return <BenchContext.Provider value={api}>{children}</BenchContext.Provider>;
}

export function useBench(): Bench {
  const value = useContext(BenchContext);
  if (!value) throw new Error("Bench missing");
  return value;
}
