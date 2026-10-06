"use client";

import { useState, type FormEvent } from "react";
import { isAddress, type Address } from "viem";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { DraftInput, RaffleSnapshot } from "@/lib/chain/types";
import type { PublicReserve } from "@/lib/reserve";
import { TransactionFlow } from "./TransactionFlow";
import { formatDate, formatUsdc, parseUsdc, shortAddress } from "./format";

type PackDraft = { name: string; price: string; bonusEntries: string; maxSupply: string };
type FormDraft = { nft: string; tokenId: string; title: string; closing: string; publicSummary: string; privateCommitment: string; packs: PackDraft[] };
type DraftState =
  | { kind: "editing" }
  | { kind: "review"; action: Omit<DraftInput, "reserveNonce" | "reserveCommit"> }
  | { kind: "saving"; action: Omit<DraftInput, "reserveNonce" | "reserveCommit"> }
  | { kind: "committed"; action: Omit<DraftInput, "reserveNonce" | "reserveCommit">; reserve: PublicReserve }
  | { kind: "error"; message: string };

const EMPTY_PACK: PackDraft = { name: "", price: "", bonusEntries: "", maxSupply: "" };
const INITIAL: FormDraft = { nft: "", tokenId: "", title: "", closing: "", publicSummary: "", privateCommitment: "", packs: [{ ...EMPTY_PACK }] };

export type SaveCommitment = (input: { nft: Address; tokenId: string; publicSummary: string; privateCommitment: string }) => Promise<PublicReserve>;

function positiveInteger(value: string, label: string, maximum: number) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} is outside the supported range.`);
  return parsed;
}

function actionFromForm(form: FormDraft): Omit<DraftInput, "reserveNonce" | "reserveCommit"> {
  if (!isAddress(form.nft)) throw new Error("Enter a valid NFT contract address.");
  if (!/^\d{1,78}$/.test(form.tokenId) || BigInt(form.tokenId) >= 2n ** 256n) throw new Error("Enter a valid NFT token ID.");
  const title = form.title.trim();
  if (!title || new TextEncoder().encode(title).length > 80) throw new Error("Title must contain 1–80 UTF-8 bytes.");
  const closeMilliseconds = Date.parse(`${form.closing}Z`);
  if (!Number.isFinite(closeMilliseconds) || closeMilliseconds <= Date.now()) throw new Error("Choose a future closing date.");
  if (!form.publicSummary.trim()) throw new Error("Add a public commitment note without disclosing the private number.");
  if (!form.privateCommitment.trim()) throw new Error("Add the private commitment that will be recovered for reveal.");
  if (form.packs.length < 1 || form.packs.length > 8) throw new Error("Configure 1–8 memberships.");
  return {
    nft: form.nft,
    tokenId: BigInt(form.tokenId),
    title,
    salesEnd: BigInt(Math.floor(closeMilliseconds / 1000)),
    packs: form.packs.map((pack) => {
      const name = pack.name.trim();
      if (!name || new TextEncoder().encode(name).length > 32) throw new Error("Each membership name must contain 1–32 UTF-8 bytes.");
      return { name, priceUsdc: parseUsdc(pack.price), bonusEntries: positiveInteger(pack.bonusEntries, `${name} bonus entries`, 10_000), maxSupply: positiveInteger(pack.maxSupply, `${name} supply`, 4_294_967_295) };
    })
  };
}

function formFromSnapshot(snapshot?: RaffleSnapshot): FormDraft {
  if (!snapshot) return INITIAL;
  return {
    nft: snapshot.raffle.nft,
    tokenId: snapshot.raffle.tokenId.toString(),
    title: snapshot.raffle.title,
    closing: new Date(Number(snapshot.raffle.salesEnd) * 1000).toISOString().slice(0, 16),
    publicSummary: "",
    privateCommitment: "",
    packs: snapshot.packs.map((pack) => ({ name: pack.name, price: formatUsdc(pack.priceUsdc), bonusEntries: pack.bonusEntries.toString(), maxSupply: pack.maxSupply.toString() }))
  };
}

export function SellerDraftForm({ service, wallet, saveCommitment, existing, onConfirmed }: {
  service: RaffleService;
  wallet: WalletSessionPort;
  saveCommitment: SaveCommitment;
  existing?: RaffleSnapshot;
  onConfirmed?: () => void | Promise<void>;
}) {
  const [form, setForm] = useState<FormDraft>(() => formFromSnapshot(existing));
  const [state, setState] = useState<DraftState>({ kind: "editing" });

  function update<K extends keyof Omit<FormDraft, "packs">>(key: K, value: FormDraft[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setState({ kind: "editing" });
  }

  function updatePack(index: number, key: keyof PackDraft, value: string) {
    setForm((current) => ({ ...current, packs: current.packs.map((pack, packIndex) => packIndex === index ? { ...pack, [key]: value } : pack) }));
    setState({ kind: "editing" });
  }

  function review(event: FormEvent) {
    event.preventDefault();
    try { setState({ kind: "review", action: actionFromForm(form) }); }
    catch (error) { setState({ kind: "error", message: error instanceof Error ? error.message : "Draft details are invalid." }); }
  }

  async function commit(action: Omit<DraftInput, "reserveNonce" | "reserveCommit">) {
    setState({ kind: "saving", action });
    try {
      const reserve = await saveCommitment({ nft: action.nft, tokenId: action.tokenId.toString(), publicSummary: form.publicSummary.trim(), privateCommitment: form.privateCommitment.trim() });
      if (reserve.nft.toLowerCase() !== action.nft.toLowerCase() || reserve.tokenId !== action.tokenId.toString()) throw new Error("Saved commitment does not match this NFT.");
      setForm((current) => ({ ...current, privateCommitment: "" }));
      setState({ kind: "committed", action, reserve });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "The commitment could not be saved durably." });
    }
  }

  if (state.kind === "review" || state.kind === "saving" || state.kind === "committed") {
    const { action } = state;
    return (
      <div className="studio-review stack">
        <p className="notice warning" role="status">Review every public value before requesting a wallet signature. Opening later fixes the economics and deadline.</p>
        <dl className="review-list"><div><dt>Title</dt><dd>{action.title}</dd></div><div><dt>NFT</dt><dd>{shortAddress(action.nft)} · token #{action.tokenId.toString()}</dd></div><div><dt>Sales deadline</dt><dd>{formatDate(action.salesEnd)} UTC</dd></div><div><dt>Memberships</dt><dd>{action.packs.length}</dd></div>{action.packs.map((pack, index) => <div key={`${index}-${pack.name}`}><dt>{pack.name}</dt><dd>{formatUsdc(pack.priceUsdc)} USDC · {pack.bonusEntries} bonus entries · {pack.maxSupply} supply</dd></div>)}</dl>
        {state.kind === "committed" ? (
          <>
            <div className="notice ok stack" role="status"><strong>Commitment saved</strong><span>Keep this recovery hash. The private value is not shown or placed on-chain.</span><span className="hash">{state.reserve.commit}</span></div>
            <TransactionFlow service={service} wallet={wallet} action={existing ? { kind: "updateDraft", id: existing.id, draft: { ...action, reserveNonce: state.reserve.nonce, reserveCommit: state.reserve.commit } } : { kind: "createDraft", draft: { ...action, reserveNonce: state.reserve.nonce, reserveCommit: state.reserve.commit } }} label={existing ? "Update raffle draft" : "Create raffle draft"} formatUsdc={formatUsdc} onConfirmed={onConfirmed} />
          </>
        ) : <button className="btn" type="button" disabled={state.kind === "saving"} onClick={() => void commit(action)}>{state.kind === "saving" ? "Saving commitment…" : "Sign and save commitment"}</button>}
        <button className="text-link" type="button" onClick={() => setState({ kind: "editing" })}>Edit draft</button>
      </div>
    );
  }

  return (
    <form className="studio-form stack" onSubmit={review}>
      <p className="notice warning">The private commitment is signed for durable storage. It is never included in the public draft transaction.</p>
      <label htmlFor="draft-title">Raffle title<input id="draft-title" value={form.title} onChange={(event) => update("title", event.target.value)} required /></label>
      <div className="form-pair"><label htmlFor="draft-nft">NFT contract<input id="draft-nft" spellCheck={false} value={form.nft} disabled={existing?.raffle.escrowed} onChange={(event) => update("nft", event.target.value.trim())} required /></label><label htmlFor="draft-token">Token ID<input id="draft-token" inputMode="numeric" value={form.tokenId} disabled={existing?.raffle.escrowed} onChange={(event) => update("tokenId", event.target.value.trim())} required /></label></div>
      <label htmlFor="draft-close">Sales deadline in UTC<input id="draft-close" type="datetime-local" value={form.closing} onChange={(event) => update("closing", event.target.value)} required /></label>
      <label htmlFor="draft-public">Public commitment note<textarea id="draft-public" rows={3} maxLength={2000} value={form.publicSummary} onChange={(event) => update("publicSummary", event.target.value)} placeholder="A public description with no private number" required /></label>
      <label htmlFor="draft-private">Private commitment<textarea id="draft-private" rows={3} maxLength={8000} value={form.privateCommitment} onChange={(event) => update("privateCommitment", event.target.value)} aria-describedby="private-note" required /></label><p className="muted" id="private-note">Do not enter a wallet key, seed phrase or account password.</p>
      <fieldset className="pack-builder stack"><legend>Membership packs</legend>{form.packs.map((pack, index) => <div className="pack-builder-row" key={index}><label>Name<input value={pack.name} onChange={(event) => updatePack(index, "name", event.target.value)} required /></label><label>Price in USDC<input inputMode="decimal" value={pack.price} onChange={(event) => updatePack(index, "price", event.target.value)} required /></label><label>Bonus entries<input inputMode="numeric" value={pack.bonusEntries} onChange={(event) => updatePack(index, "bonusEntries", event.target.value)} required /></label><label>Supply<input inputMode="numeric" value={pack.maxSupply} onChange={(event) => updatePack(index, "maxSupply", event.target.value)} required /></label>{form.packs.length > 1 ? <button className="text-link" type="button" onClick={() => { setForm((current) => ({ ...current, packs: current.packs.filter((_, packIndex) => packIndex !== index) })); setState({ kind: "editing" }); }}>Remove</button> : null}</div>)}</fieldset>
      <div className="btn-row"><button className="btn" type="submit">Review raffle draft</button><button className="btn btn-dark" type="button" disabled={form.packs.length >= 8} onClick={() => { setForm((current) => ({ ...current, packs: [...current.packs, { ...EMPTY_PACK }] })); setState({ kind: "editing" }); }}>Add membership</button></div>
      {state.kind === "error" ? <p className="notice error" role="alert">{state.message}</p> : null}
    </form>
  );
}
