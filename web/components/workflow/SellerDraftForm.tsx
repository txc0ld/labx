"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAddress, type Address } from "viem";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { DraftInput, RaffleSnapshot } from "@/lib/chain/types";
import type { PublicReserve } from "@/lib/reserve";
import { automaticCommitmentKey, prepareAutomaticCommitment } from "@/lib/automatic-commitment";
import { TransactionFlow } from "./TransactionFlow";
import { formatDate, formatUsdc, formatUsdcInput, parseUsdc, shortAddress } from "./format";
import formStyles from "./SellerDraftForm.module.css";

type PackDraft = { id: string; name: string; price: string; bonusEntries: string; maxSupply: string };
type FormDraft = { nft: string; tokenId: string; title: string; closing: string; packs: PackDraft[] };
type CommitmentPreparation = { key: string; input: { publicSummary: string; privateCommitment: string } };
type DraftState =
  | { kind: "editing" }
  | { kind: "review"; action: Omit<DraftInput, "reserveNonce" | "reserveCommit"> }
  | { kind: "saving"; action: Omit<DraftInput, "reserveNonce" | "reserveCommit"> }
  | { kind: "committed"; action: Omit<DraftInput, "reserveNonce" | "reserveCommit">; reserve: PublicReserve }
  | { kind: "retained"; action: DraftInput }
  | { kind: "error"; message: string };

const EMPTY_PACK = { name: "", price: "", bonusEntries: "", maxSupply: "" };
const INITIAL: FormDraft = { nft: "", tokenId: "", title: "", closing: "", packs: [{ id: "initial-pack", ...EMPTY_PACK }] };

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
    packs: snapshot.packs.map((pack, index) => ({ id: `existing-pack-${index + 1}`, name: pack.name, price: formatUsdcInput(pack.priceUsdc), bonusEntries: pack.bonusEntries.toString(), maxSupply: pack.maxSupply.toString() }))
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
  const commitmentPreparation = useRef<CommitmentPreparation | null>(null);
  const commitmentInFlight = useRef(false);
  const focusAfterRender = useRef<"edit" | "review" | null>(null);
  const focusAddAfterPackChange = useRef(false);
  const editFocus = useRef<HTMLInputElement>(null);
  const editStage = useRef<HTMLFieldSetElement>(null);
  const reviewFocus = useRef<HTMLHeadingElement>(null);
  const addPackFocus = useRef<HTMLButtonElement>(null);
  const nextPackId = useRef(form.packs.length);

  useEffect(() => {
    const stage = focusAfterRender.current;
    const target = stage === "review" ? reviewFocus.current : stage === "edit" ? editFocus.current : null;
    if (!target) return;
    const scrollTarget = stage === "edit" ? editStage.current : target;
    if (!scrollTarget) return;
    focusAfterRender.current = null;
    const frame = requestAnimationFrame(() => {
      scrollTarget.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [state.kind]);

  useEffect(() => {
    if (!focusAddAfterPackChange.current) return;
    focusAddAfterPackChange.current = false;
    addPackFocus.current?.focus();
  }, [form.packs.length]);

  function update<K extends keyof Omit<FormDraft, "packs">>(key: K, value: FormDraft[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setState({ kind: "editing" });
  }

  function updatePack(id: string, key: keyof Omit<PackDraft, "id">, value: string) {
    setForm((current) => ({ ...current, packs: current.packs.map((pack) => pack.id === id ? { ...pack, [key]: value } : pack) }));
    setState({ kind: "editing" });
  }

  function removePack(id: string) {
    focusAddAfterPackChange.current = true;
    setForm((current) => ({ ...current, packs: current.packs.filter((pack) => pack.id !== id) }));
    setState({ kind: "editing" });
  }

  function addPack() {
    nextPackId.current += 1;
    const id = `added-pack-${nextPackId.current}`;
    setForm((current) => ({ ...current, packs: [...current.packs, { id, ...EMPTY_PACK }] }));
    setState({ kind: "editing" });
  }

  function review(event: FormEvent) {
    event.preventDefault();
    try {
      const action = actionFromForm(form);
      const key = automaticCommitmentKey(action.nft, action.tokenId);
      focusAfterRender.current = "review";
      if (existing && key === automaticCommitmentKey(existing.raffle.nft, existing.raffle.tokenId)) {
        setState({ kind: "retained", action: { ...action, reserveNonce: existing.raffle.reserveNonce, reserveCommit: existing.raffle.reserveCommit } });
        return;
      }
      let preparation = commitmentPreparation.current;
      if (!preparation || preparation.key !== key) {
        const generated = prepareAutomaticCommitment(action.nft, action.tokenId);
        preparation = generated;
        commitmentPreparation.current = preparation;
      }
      setState({ kind: "review", action });
    }
    catch (error) { setState({ kind: "error", message: error instanceof Error ? error.message : "Draft details are invalid." }); }
  }

  async function commit(action: Omit<DraftInput, "reserveNonce" | "reserveCommit">) {
    if (commitmentInFlight.current) return;
    commitmentInFlight.current = true;
    setState({ kind: "saving", action });
    try {
      const key = automaticCommitmentKey(action.nft, action.tokenId);
      const preparation = commitmentPreparation.current;
      if (!preparation || preparation.key !== key) throw new Error("The prepared draw setup no longer matches this NFT.");
      const reserve = await saveCommitment({ nft: action.nft, tokenId: action.tokenId.toString(), ...preparation.input });
      if (reserve.nft.toLowerCase() !== action.nft.toLowerCase() || reserve.tokenId !== action.tokenId.toString() || reserve.publicSummary !== preparation.input.publicSummary) throw new Error("Saved commitment does not match this NFT.");
      commitmentPreparation.current = null;
      setState({ kind: "committed", action, reserve });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "The commitment could not be saved durably." });
    } finally {
      commitmentInFlight.current = false;
    }
  }

  function returnToEdit() {
    focusAfterRender.current = "edit";
    setState({ kind: "editing" });
  }

  if (state.kind === "retained" && existing) return <div className={`${formStyles.review} studio-review stack`}><h2 className={formStyles.stageHeading} ref={reviewFocus} tabIndex={-1}>Prepare raffle draft</h2><p className="notice">The saved draw setup for this NFT will be retained. No additional storage signature is needed.</p><p className="notice warning" role="status">Any successful draft update advances the review revision. LABx must approve the edited draft again before it can open, even if you later restore the old values.</p><dl className="review-list"><div><dt>Title</dt><dd>{state.action.title}</dd></div><div><dt>Deadline</dt><dd>{formatDate(state.action.salesEnd)} UTC</dd></div>{state.action.packs.map((pack, index) => <div key={index}><dt>{pack.name}</dt><dd>{formatUsdc(pack.priceUsdc)} USDC · {pack.bonusEntries} bonus entries · {pack.maxSupply} supply</dd></div>)}</dl><TransactionFlow service={service} wallet={wallet} action={{ kind: "updateDraft", id: existing.id, draft: state.action }} label="Update raffle draft" formatUsdc={formatUsdc} onConfirmed={onConfirmed} /><button className="btn btn-dark" type="button" onClick={returnToEdit}>Edit draft</button></div>;

  if (state.kind === "review" || state.kind === "saving" || state.kind === "committed") {
    const { action } = state;
    return (
      <div className={`${formStyles.review} studio-review stack`}>
        <h2 className={formStyles.stageHeading} ref={reviewFocus} tabIndex={-1}>Prepare raffle draft</h2>
        <p className="notice warning" role="status">Check these raffle details. The next step asks your wallet to sign a request that saves the draw setup securely. This signature does not submit a transaction. Opening later fixes the economics and deadline.</p>
        <dl className="review-list"><div><dt>Title</dt><dd>{action.title}</dd></div><div><dt>NFT</dt><dd>{shortAddress(action.nft)} · token #{action.tokenId.toString()}</dd></div><div><dt>Sales deadline</dt><dd>{formatDate(action.salesEnd)} UTC</dd></div><div><dt>Memberships</dt><dd>{action.packs.length}</dd></div>{action.packs.map((pack, index) => <div key={`${index}-${pack.name}`}><dt>{pack.name}</dt><dd>{formatUsdc(pack.priceUsdc)} USDC · {pack.bonusEntries} bonus entries · {pack.maxSupply} supply</dd></div>)}</dl>
        {state.kind === "committed" ? (
          <>
            <div className="notice ok stack" role="status"><strong>Raffle prepared</strong><span>The draw setup is saved securely and can be recovered with your wallet when it is time to reveal.</span></div>
            <TransactionFlow service={service} wallet={wallet} action={existing ? { kind: "updateDraft", id: existing.id, draft: { ...action, reserveNonce: state.reserve.nonce, reserveCommit: state.reserve.commit } } : { kind: "createDraft", draft: { ...action, reserveNonce: state.reserve.nonce, reserveCommit: state.reserve.commit } }} label={existing ? "Update raffle draft" : "Create raffle draft"} formatUsdc={formatUsdc} onConfirmed={onConfirmed} />
          </>
        ) : <button className="btn" type="button" disabled={state.kind === "saving"} onClick={() => void commit(action)}>{state.kind === "saving" ? "Preparing raffle…" : "Sign to prepare raffle"}</button>}
        <button className="btn btn-dark" type="button" disabled={state.kind === "saving"} onClick={returnToEdit}>Edit draft</button>
      </div>
    );
  }

  return (
    <form className={`${formStyles.form} studio-form`} onSubmit={review}>
      <p className={`${formStyles.privacyNotice} notice warning`}>LABx creates and securely stores the draw setup when you prepare the raffle. Your wallet signs that storage request before any draft transaction.{existing ? " A successful edit invalidates the current LABx approval and requires a new owner review." : ""}</p>

      <fieldset className={formStyles.formSection} ref={editStage}>
        <legend><span>01</span> Raffle details</legend>
        <p className={formStyles.sectionHelp}>Name the public raffle and choose when membership sales close.</p>
        <div className={`${formStyles.fieldGrid} ${formStyles.detailsGrid}`}>
          <label htmlFor="draft-title">Raffle title<input ref={editFocus} id="draft-title" value={form.title} onChange={(event) => update("title", event.target.value)} required /></label>
          <div className={formStyles.describedField}><label htmlFor="draft-close">Sales deadline in UTC<input id="draft-close" type="datetime-local" value={form.closing} onChange={(event) => update("closing", event.target.value)} aria-describedby="deadline-note" required /></label><small id="deadline-note">Enter the deadline as UTC, not local time.</small></div>
        </div>
      </fieldset>

      <fieldset className={formStyles.formSection}>
        <legend><span>02</span> Prize NFT</legend>
        <p className={formStyles.sectionHelp}>Identify the exact collection contract and token placed into this raffle.</p>
        <div className={`${formStyles.fieldGrid} ${formStyles.nftGrid}`}>
          <label htmlFor="draft-nft">NFT contract<input id="draft-nft" spellCheck={false} autoCapitalize="none" autoCorrect="off" value={form.nft} disabled={existing?.raffle.escrowed} onChange={(event) => update("nft", event.target.value.trim())} required /></label>
          <label htmlFor="draft-token">Token ID<input id="draft-token" inputMode="numeric" value={form.tokenId} disabled={existing?.raffle.escrowed} onChange={(event) => update("tokenId", event.target.value.trim())} required /></label>
        </div>
      </fieldset>

      <fieldset className={`${formStyles.formSection} ${formStyles.packSection}`}>
        <legend><span>03</span> Membership packs</legend>
        <div className={formStyles.sectionIntro}><p className={formStyles.sectionHelp}>Configure 1–8 options. Price is charged in USDC; bonus entries and supply must be whole numbers.</p><span role="status" aria-live="polite" aria-atomic="true">{form.packs.length} of 8 configured</span></div>
        <div className={formStyles.packList}>{form.packs.map((pack, index) => <fieldset className={formStyles.packCard} key={pack.id}><legend>Membership {index + 1}</legend><div className={formStyles.packFields}><label>Name<input value={pack.name} onChange={(event) => updatePack(pack.id, "name", event.target.value)} required /></label><label>Price in USDC<input inputMode="decimal" value={pack.price} onChange={(event) => updatePack(pack.id, "price", event.target.value)} required /></label><label>Bonus entries<input inputMode="numeric" value={pack.bonusEntries} onChange={(event) => updatePack(pack.id, "bonusEntries", event.target.value)} required /></label><label>Supply<input inputMode="numeric" value={pack.maxSupply} onChange={(event) => updatePack(pack.id, "maxSupply", event.target.value)} required /></label></div>{form.packs.length > 1 ? <button className={`${formStyles.removePack} text-link`} type="button" onClick={() => removePack(pack.id)}>Remove membership {index + 1}</button> : null}</fieldset>)}</div>
        <button ref={addPackFocus} className="btn btn-dark" type="button" disabled={form.packs.length >= 8} onClick={addPack}>Add membership</button>
      </fieldset>

      {state.kind === "error" ? <p className={`${formStyles.formError} notice error`} role="alert">{state.message}</p> : null}
      <div className={formStyles.reviewAction}><div><strong>Ready to prepare your raffle?</strong><span>You will review the details, then sign the secure storage request before the draft transaction.</span></div><button className="btn" type="submit">Prepare raffle draft</button></div>
    </form>
  );
}
